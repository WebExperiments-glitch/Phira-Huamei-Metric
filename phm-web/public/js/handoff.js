/* ══════════════════════════════════════════════════════════════
 * 跨页面交接一个 File —— 首页拖进来，算定数页接着算
 * ══════════════════════════════════════════════════════════════
 * 【为什么需要这个东西】
 *   评审说首页那个「算定数 →」按钮"多了一步"：用户已经把谱面拖到
 *   浏览器窗口上了，还得先松手、再点一次按钮、再拖一次。
 *
 * 【为什么不能把解析搬到首页】
 *   /app 首次绘制要拉 730KB 参照集（9,508 + 1,037 条）。为了一个体
 *   验优化把这块搬到落地页，等于让每个只看首页的人也付这份流量，
 *   首屏会明显变慢。所以只搬**接力**，不搬**引擎**。
 *
 * 【为什么用 IndexedDB 而不是 sessionStorage】
 *   sessionStorage 只能存字符串，File/Blob 塞不进去（序列化会变成
 *   "[object File]"）。IndexedDB 能直接存 Blob，且同样不出浏览器、
 *   不上传、关标签页就该被清掉 —— 所以取出来之后**立刻删**。
 *
 * 【失败必须静默降级】
 *   无痕模式 / 存储被禁 / 配额满 都会让 IDB 抛错。任何一步失败都
 *   返回 null，调用方退回到"跳过去让用户再拖一次"的老路 —— 不能因为
 *   一个可选优化把主流程卡死。
 */
const DB_NAME = 'phm-handoff';
const STORE = 'files';
const KEY = 'pending';

function openDb() {
  return new Promise(function (res, rej) {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function () { res(req.result); };
    req.onerror = function () { rej(req.error); };
    req.onblocked = function () { rej(new Error('blocked')); };
  });
}

/**
 * 把 File 暂存起来。成功返回 true，失败返回 false（调用方照常跳转即可）。
 * @param {File} file
 */
export async function stash(file) {
  if (!file) return false;
  let db;
  try { db = await openDb(); } catch (e) { return false; }
  try {
    await new Promise(function (res, rej) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ name: file.name, type: file.type, blob: file }, KEY);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error); };
    });
    return true;
  } catch (e) {
    return false;
  } finally {
    try { db.close(); } catch (e) { /* 关不掉也不影响结果 */ }
  }
}

/**
 * 取出并删除。没有残留返回 null。
 * @returns {Promise<File|null>}
 */
export async function claim() {
  let db;
  try { db = await openDb(); } catch (e) { return null; }
  try {
    const rec = await new Promise(function (res, rej) {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      const g = os.get(KEY);
      g.onsuccess = function () {
        const v = g.result;
        /* 立刻删 —— 这份东西的语义是"一次性接力棒"，留在盘上只会变成
           一个说不清来历的残留文件。 */
        try { os.delete(KEY); } catch (e) { /* ignore */ }
        res(v || null);
      };
      g.onerror = function () { rej(g.error); };
    });
    if (!rec || !rec.blob) return null;
    /* 存进去是 File，读出来可能是 Blob（Safari 老版本会丢 name）。
       统一包成 File，下游按 name 判断扩展名。 */
    return new File([rec.blob], rec.name || 'chart.pez', { type: rec.type || 'application/zip' });
  } catch (e) {
    return null;
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

/** 当前 URL 是否带着"上一页交接过来"的标记 */
export function handedOver() {
  try {
    return new URLSearchParams(location.search).get('drop') === '1';
  } catch (e) {
    return false;
  }
}
