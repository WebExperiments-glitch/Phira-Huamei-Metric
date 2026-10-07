/* ============================================================
 * js/settings.js —— 用户设置的**单一真源**
 * ============================================================
 * 【为什么会有这个文件】
 *   在这之前，「设置」不是一个东西，是散在 7 个 localStorage 键里的一堆
 *   裸读写：app.html 里 5 个、user.html 里 1 个，各自的默认值还写在不同地方。
 *   只有一两个开关时没问题；设置项一多，必然长出
 *   「A 页写了 B 页读不到」和「同一个键两处默认值不一样」。
 *
 *   所以定下规矩：**键名 / 默认值 / 读写 / 清理只在本文档定义**，
 *   其余页面一律 import，不再出现裸的 localStorage.getItem('phm_...')。
 *
 * 【三条硬约束】
 *   1. **键名不能改** —— 改了等于把老用户的设置悄悄清空。
 *      KEYS 是唯一清单，将来只增不改，历史键名也留在里面。
 *   2. **读失败一律返回默认值**，绝不抛异常。隐私模式 / 禁用存储时，
 *      整站的原则是「设置读不到 = 用默认」，而不是页面崩掉。
 *   3. **clearAll() 只清本站自己的键**（白名单）。
 *      同源下还住着云 SDK 的会话（`workbuddy-cloud.session.*`），
 *      那是别人的数据 —— 顺手清掉会把用户从账号里踢出去。
 *
 * 【和别的文件的分工】
 *   engine.js  纯计算（解析谱面 → 定数），不碰浏览器 API
 *   ui.js      纯展示（数字 → 字），无状态
 *   settings.js 纯状态（读/写/通知），不渲染任何东西
 * ============================================================ */

/* ══════════════════════════════════════════════════════════════
 * 键名清单 —— 唯一真源，只增不改
 * ══════════════════════════════════════════════════════════════ */
export const KEYS = Object.freeze({
  optin:     'phm_optin',        /* 上传总开关："1" / "0" */
  notice:    'phm_notice_v1',    /* 数据飞轮告知已读："1"（带 _v1：将来换文案要重新征求同意） */
  cid:       'phm_cid',          /* 假名化会话 id（把同一人的多次贡献归组用） */
  phiraName: 'phm_phira_name',   /* Phira 用户名 —— 仅用于下次自动填充 */
  phiraUid:  'phm_phira_uid',
  lastUid:   'phm_last_uid',     /* 上次查询过的玩家 uid */
  ownPrefix: 'phm_own_',         /* + uid =「我声明这是本人的账号」 */
});

/** 固定键（不含 own 前缀键）—— 用于清空与导出。 */
export const PLAIN_KEYS = Object.freeze([
  KEYS.optin, KEYS.notice, KEYS.cid, KEYS.phiraName, KEYS.phiraUid, KEYS.lastUid,
]);

/** 给人看的名字。设置页直接渲染这张表，不再各处手写文案。 */
export const LABELS = Object.freeze({
  [KEYS.optin]:     '登录后自动上传成绩',
  [KEYS.notice]:    '数据飞轮告知已确认',
  [KEYS.cid]:       '匿名标识（用于把同一人的贡献归组）',
  [KEYS.phiraName]: 'Phira 用户名（自动填充）',
  [KEYS.phiraUid]:  'Phira UID（自动填充）',
  [KEYS.lastUid]:   '上次查询的玩家',
});

/* ══════════════════════════════════════════════════════════════
 * 底座：安全读写（永不抛）
 * ══════════════════════════════════════════════════════════════ */

function store() {
  try { return window.localStorage; } catch (e) { return null; }
}

/** 存储是否真的可用。不可用时设置页要如实说，而不是假装写成功了。 */
export const available = (function () {
  try {
    const s = window.localStorage;
    s.setItem('__phm_probe', '1');
    s.removeItem('__phm_probe');
    return true;
  } catch (e) { return false; }
})();

function isOurs(k) {
  return PLAIN_KEYS.indexOf(k) >= 0 || String(k).indexOf(KEYS.ownPrefix) === 0;
}

export function get(key, dflt) {
  const s = store();
  if (!s) return dflt;
  try {
    const v = s.getItem(key);
    return v === null ? dflt : v;
  } catch (e) { return dflt; }
}

/** 写：`null` / `undefined` 表示删除该键。返回是否真的写成功。 */
export function set(key, val) {
  const s = store();
  if (!s) return false;
  try {
    if (val === null || val === undefined) s.removeItem(key);
    else s.setItem(key, String(val));
    emit(key);
    return true;
  } catch (e) { return false; }
}

function bool(key, dflt) {
  const v = get(key, null);
  return v === null ? dflt : v === '1';
}

/* ── 变更通知 ──
   同一个页面里可能有多个地方关心同一个键（例如页脚的开关与状态条）。
   另外：用户开了两个标签页时，一个页签改了设置，另一个页签要跟上 ——
   那是 `storage` 事件，只有**别的**页签会收到（本页不会），正好互补。 */
const watchers = new Set();

function emit(key) {
  for (const fn of watchers) { try { fn(key); } catch (e) { /* 订阅者自己的错不该影响写入 */ } }
}

/** 订阅任意设置变更。返回取消订阅函数。 */
export function subscribe(fn) {
  watchers.add(fn);
  return function () { watchers.delete(fn); };
}

try {
  window.addEventListener('storage', function (e) {
    if (e && e.key && isOurs(e.key)) emit(e.key);
  });
} catch (e) { /* 无 window 时（极端情况）静默 */ }

/* ══════════════════════════════════════════════════════════════
 * 分组 API
 * ══════════════════════════════════════════════════════════════ */

/* ── 上传偏好 ──
   默认 **true**。产品定位是「随走即用」：登录 Phira 后自动贡献成绩，
   定数飞轮才转得起来。但「自动」≠「静默」—— 首次上传前会弹一次明确告知
   （见 app.html 的 ensureNotice()），用户不同意就直接把它关成 false。
   ⚠ 默认值只在这里写一次。历史上 app.html 与文档各写过一遍。 */
export const optin = {
  get() { return bool(KEYS.optin, true); },
  set(on) { return set(KEYS.optin, on ? '1' : '0'); },
};

export const notice = {
  agreed() { return bool(KEYS.notice, false); },
  agree() { return set(KEYS.notice, '1'); },
  /** 撤回：下次上传前会重新征求一次同意。 */
  forget() { return set(KEYS.notice, null); },
};

/* ── Phira 连接信息 ──
   只用于「下次自动填充」。**不含密码，也不接受密码**（见 SECURITY.md）。
   独立成组是为了设置页能一次性展示与清除。 */
export const phira = {
  get() {
    return { name: get(KEYS.phiraName, ''), uid: get(KEYS.phiraUid, '') };
  },
  set(name, uid) {
    set(KEYS.phiraName, name || null);
    set(KEYS.phiraUid, uid || null);
  },
  clear() { set(KEYS.phiraName, null); set(KEYS.phiraUid, null); },
};

export const lastUid = {
  get() { return get(KEYS.lastUid, ''); },
  set(uid) { return set(KEYS.lastUid, uid || null); },
};

/* ── 「本人账号」声明 ──
   Phira 没有给第三方 OAuth，无法做真正的所有权验证；退一步要求用户
   **明确声明一次**。否则任何访问者都能把某个公开 Phira 用户的成绩
   复制进数据集，来源真实性归零。
   声明只存在本地，不依赖账号系统。 */
export const own = {
  is(uid) { return bool(KEYS.ownPrefix + uid, false); },
  mark(uid) { return set(KEYS.ownPrefix + uid, '1'); },
  unmark(uid) { return set(KEYS.ownPrefix + uid, null); },
  list() {
    const s = store();
    if (!s) return [];
    const out = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.indexOf(KEYS.ownPrefix) === 0) out.push(k.slice(KEYS.ownPrefix.length));
      }
    } catch (e) { /* 枚举失败就当没有 */ }
    return out;
  },
};

/* ── 匿名会话 id ──
   只用来把同一个人的多次贡献归到一组（**假名化**，不是严格匿名 ——
   文档里一直这么写，别改成「匿名」）。不携带任何身份信息。 */
export const cid = {
  get() {
    let v = get(KEYS.cid, null);
    if (v) return v;
    v = Math.random().toString(36).slice(2, 10);
    set(KEYS.cid, v);
    return v;
  },
  /** 换一个新身份：之后再贡献的数据不会被归到之前那组。 */
  reset() { set(KEYS.cid, null); return cid.get(); },
};

/* ══════════════════════════════════════════════════════════════
 * 盘点 / 导出 / 清空 —— 设置页的「数据」区块用
 * ══════════════════════════════════════════════════════════════ */

/** 列出本站实际存在哪些键（含 own 声明）。设置页据此展示「存了什么」。 */
export function inventory() {
  const rows = [];
  for (const k of PLAIN_KEYS) {
    const v = get(k, null);
    if (v !== null) rows.push({ key: k, value: v, label: LABELS[k] || k });
  }
  for (const uid of own.list()) {
    rows.push({ key: KEYS.ownPrefix + uid, value: '1', label: '本人账号声明 · UID ' + uid });
  }
  return rows;
}

/** 导出快照（JSON 对象）。只含设置，**不含任何凭据**。 */
export function exportAll() {
  const o = {
    _note: 'P.H.M. 本地设置快照 —— 只含浏览器里存的那几项，不含账号凭据',
    _exportedAt: new Date().toISOString(),
    settings: {},
  };
  for (const r of inventory()) o.settings[r.key] = r.value;
  return o;
}

/** 清空本站设置。⚠ 见文件头的第 3 条约束：**不碰别的键**。 */
export function clearAll() {
  for (const k of PLAIN_KEYS) set(k, null);
  for (const uid of own.list()) set(KEYS.ownPrefix + uid, null);
  emit('*');
  return true;
}

/* ══════════════════════════════════════════════════════════════
 * 只读测试钩子
 * ══════════════════════════════════════════════════════════════
 * 让 tools/verify-pages.mjs 能断言**真身**的行为，而不是 grep 源码。
 * 纯读写封装，不含任何凭据，暴露出来没有额外风险。 */
try {
  window.PHM_SETTINGS = Object.freeze({
    KEYS, PLAIN_KEYS, LABELS, available,
    optin, notice, phira, lastUid, own, cid,
    inventory, exportAll, clearAll,
  });
} catch (e) { /* 无 window 时跳过 */ }
