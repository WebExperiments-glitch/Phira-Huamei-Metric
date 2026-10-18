/* ============================================================
 * js/cloud.js —— 云 SDK 的**单一初始化入口**
 * ============================================================
 *  存在理由（不是"顺手抽出来的"）：
 *    云 SDK 是 `<script defer src="…cdn…">`，而页面主逻辑是
 *    `<script type="module">`。两者都 defer、都按文档顺序，但
 *    **内联 module 没有依赖图可以等** —— CDN 慢一点、或被网络抖动拖一下，
 *    module 就先跑完了。那时 `window.WorkBuddyCloud` 还是 undefined，
 *    于是：
 *      · app.html  `if(!cloudDB) return;`  → 会话恢复整段被跳过，
 *        用户**每次刷新都要重新登录**，而且界面上看不出任何异常；
 *      · platform/settings 直接显示"云 SDK 加载失败"。
 *    这个坑的表现是"偶发、且像用户操作问题"，极难定位。
 *
 *  所以：统一等 SDK 就绪（带上限），就绪后创建实例，并**如实汇报结果** ——
 *  失败要说失败，不要静默降级成"未登录"，那是把系统故障说成用户没登录。
 *
 *  ⚠ 本模块**不碰 i18n**（settings.js 的约束同样适用于这里）：
 *    错误文案由调用方翻，���里只给 kind。
 * ============================================================ */

/** SDK 最多等这么久。CDN 正常在 300ms 内，等 6s 足够；再久就是真出问题了。 */
const SDK_WAIT_MS = 6000;
const SDK_POLL_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等云 SDK 就绪并创建实例。
 * @param {object} cfg      { endpoint, publishableKey }
 * @param {number} waitMs   等待上限
 * @returns {Promise<{cloud:object|null, db:any, waited:number, error:string|null}>}
 *   error 取值：'timeout'（等太久）、'missing'（SDK 没来）、'init'（创建抛错）。
 *   三者分开报，便于区分「网络问题」和「配置问题」。
 */
export async function initCloud(cfg, waitMs = SDK_WAIT_MS) {
  const t0 = Date.now();
  while (!(window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud)) {
    if (Date.now() - t0 >= waitMs) {
      return { cloud: null, db: null, waited: Date.now() - t0, error: 'timeout' };
    }
    await sleep(SDK_POLL_MS);
  }
  if (Date.now() - t0 >= waitMs) return { cloud: null, db: null, waited: Date.now() - t0, error: 'timeout' };
  try {
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud(cfg);
    return { cloud, db: cloud ? cloud.database : null, waited: Date.now() - t0, error: null };
  } catch (e) {
    return {
      cloud: null, db: null, waited: Date.now() - t0, error: 'init',
      detail: String((e && e.message) || e).slice(0, 160),
    };
  }
}

/**
 * 读当前会话（不抛异常）。
 * ⚠ 拿不到时**必须区分**「没登录」与「SDK 不可用」——
 *   两者对用户是完全不同的下一步动作（一个是去登录，一个是去刷新/换网络）。
 *
 * @returns {Promise<{user:object|null, session:any, reason:string|null}>}
 *   reason: null=已登录且拿到用户；'anon'=确实没登录；'unavailable'=读不出来。
 */
export async function currentUser(cloud, timeoutMs = 8000) {
  if (!cloud || !cloud.auth) return { user: null, session: null, reason: 'unavailable' };
  try {
    const s = await Promise.race([
      cloud.auth.getSession(),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ]);
    if (s && s.__timeout) return { user: null, session: null, reason: 'unavailable' };
    const user = (s && s.data && s.data.user) || null;
    return { user, session: s || null, reason: user ? null : 'anon' };
  } catch (e) {
    return { user: null, session: null, reason: 'unavailable' };
  }
}