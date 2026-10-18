/* ============================================================
 * js/guard.js —— 全局兜底：让失败**看得见**，而不是静默死掉
 * ============================================================
 *  存在理由（2026-10-18 审计出来的真缺口）：
 *    全站 15 个页面里，只有 app.html 接了 `unhandledrejection`，
 *    其余 9 个页面**一个都没接**。后果：
 *      · 一个没被 catch 的 Promise 拒绝 → 静默无痕，用户看到的
 *        是「点了没反应」「按钮坏了」，而控制台之外无从查起。
 *      · `error` 事件（脚本抛错、资源加载失败）更是完全没人听。
 *    这些恰恰是「抗打性」的定义：**系统出问题时要说出来**，
 *    而不是把用户晾在那儿猜。
 *
 *  三条铁律：
 *  ① **绝不自己再抛**。兜底里任何一步失败都要静默吞掉 ——
 *     一个会抛异常的兜底会把原来的错误吃掉，还多送一个新的。
 *  ② **不依赖任何页面元素 id**。app.html 那版写死了 `#pfmsg`，
 *     换个页面就没有这个元素，兜底直接失效。这里只用自己创建的节点。
 *  ③ **同源去重**。同一个错误只报一次，别让一次故障刷出一屏提示。
 * ============================================================ */

const SEEN = new Set();
const MAX_LEN = 160;

function cut(s) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > MAX_LEN ? v.slice(0, MAX_LEN) + '…' : v;
}

/* 语言只从 <html lang> 与 i18n 字典里取，**不在这里维护第二套文案** ——
   两份翻译必然漂移。拿不到词条时退回英文短句（比显示 key 名好）。 */
function say(key, fallback, vars) {
  try {
    if (window.__PHM_T) {
      /* ⚠ vars 必须一起传：文案里有 `{e}` 占位符，
         不传的话用户会看到字面的 "{e}" —— 那比没有提示更糟。 */
      const v = window.__PHM_T(key, vars);
      if (v && v !== key) return v;
    }
  } catch (e) { /* 兜底不许再抛 */ }
  return fallback;
}

let host = null;
let timer = null;

function ensureHost() {
  if (host && host.isConnected) return host;
  try {
    host = document.createElement('div');
    host.className = 'phm-guard';
    host.setAttribute('role', 'status');       /* 屏幕阅读器能念出来 */
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  } catch (e) { host = null; }
  return host;
}

/**
 * 弹一条兜底提示。同一 key 只弹一次（去重窗口 10 秒）。
 * ⚠ 不 export —— lint-slop 的「未使用的导出」会拦（没人 import 的死接口）。
 *   页面要主动上报错误时，用 installGuard() 返回的这个函数。
 * @param {string} key  稳定标识（同一个错误应传同一个 key）
 * @param {string} text 给人看的话
 */
function reportOnce(key, text) {
  try {
    const k = String(key || 'x');
    if (SEEN.has(k)) return;
    SEEN.add(k);
    setTimeout(() => { try { SEEN.delete(k); } catch (e) {} }, 10000);

    const el = ensureHost();
    if (!el) return;

    const item = document.createElement('div');
    item.className = 'phm-guard-item';
    item.textContent = cut(text);
    el.appendChild(item);

    /* 最多留 3 条：一次故障可能连带好几处报错，
       全堆出来会把页面糊住，反而看不见内容。 */
    while (el.children.length > 3) el.removeChild(el.firstChild);

    clearTimeout(timer);
    timer = setTimeout(() => {
      try { el.innerHTML = ''; } catch (e) {}
    }, 9000);
  } catch (e) { /* 兜底不许再抛 */ }
}

/**
 * 装全局兜底。幂等 —— 重复调用不会叠两层监听。
 * @param {object} opts { t: (key)=>string, onReport:(key,text)=>void }
 */
export function installGuard(tFn) {
  /* ⚠ 收一个 t 函数而不是 {t:fn} 对象 —— 调用方直接 `installGuard(t)` 更短，
     且少一层属性名拼错的空间（写成 opts.tFn 之类就静默失效）。 */
  window.__PHM_T = (typeof tFn === 'function') ? tFn : null;

  if (window.__PHM_GUARD_ON) return window.__PHM_REPORT;
  window.__PHM_GUARD_ON = true;
  window.__PHM_REPORT = reportOnce;   /* 页面 catch 到错误时可主动上报 */

  /* ① 同步抛错（脚本错误、资源加载失败）。
       只在**用户能看到的页面**报：<script> 自身报错也走这里，
       不区分的话自己会被自己吵死。 */
  window.addEventListener('error', function (ev) {
    try {
      const msg = (ev && ev.message) || 'script error';
      const short = cut(msg);
      reportOnce('err:' + short, say('guard.err', '页面出了点问题，部分功能可能不可用：' + short, { e: short }));
    } catch (e) {}
  }, true);

  /* ② 未处理的 Promise 拒绝 —— 这是 9 个页面原本完全没接的那一类。 */
  window.addEventListener('unhandledrejection', function (ev) {
    try {
      const r = ev && ev.reason;
      const msg = (r && (r.message || r)) || 'rejected';
      const short = cut(msg);
      reportOnce('rej:' + short, say('guard.rej', '请求没完成，可能是网络问题：' + short, { e: short }));
    } catch (e) {}
  });

  /* ③ 断网 / 恢复。在线状态变化时用户常常毫无感知，
       然后发现"怎么什么都刷不出来"——主动告诉他。 */
  window.addEventListener('offline', function () {
    reportOnce('offline', say('guard.offline', '你已经离线，联网后自动恢复'));
  });
  window.addEventListener('online', function () {
    reportOnce('online', say('guard.online', '网络已恢复'));
  });

  /* ④ Service Worker / 资源白屏级别的兜底。
       不自动 reload（那会造成刷新风暴），只告知。 */
  window.addEventListener('unload', function () { try { window.__PHM_GUARD_ON = false; } catch (e) {} });

  return reportOnce;   /* 给调用方一个句柄：catch 到错误时可主动上报 */
}

export default installGuard;
