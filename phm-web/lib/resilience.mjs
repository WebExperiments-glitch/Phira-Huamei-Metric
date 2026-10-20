/* ============================================================
 * lib/resilience.mjs —— 最后一层兜底：单个请求再离谱也不许打掉进程
 * ============================================================
 * 【为什么需要这一层】
 *   这个服务是**单进程**的：没有 PM2、没有多实例、没有健康检查重启。
 *   于是「一个请求抛了没接住的异常」= 整站下线。真实踩过三次：
 *     ① 畸形百分号编码（`/%`）让 decodeURIComponent 抛 URIError
 *     ② 下载路由漏接 `res` 的 `close`，用户点「取消」→ 未捕获事件 → 进程退出
 *     ③ 路由工厂某个分支漏了 `return ..., true`，响应已发出后又走 send404
 *        → `ERR_HTTP_HEADERS_SENT` → 进程退出
 *   前两个已各自在源头修掉，但**这类 bug 会一直有新变种**。
 *   所以除了逐个修，还要有一层兜底：把「单请求故障」和「进程存活」解耦。
 *
 * 【三条设计约束】
 *   ① **兜底自己绝不能抛** —— 它跑在所有 catch 之外，这里再抛就真没救了。
 *      所以内部全 try/catch，连 console.error 都包起来。
 *   ② **不能假装成功**：头还没发就回 500；头已发就只能收尾（写干净地结束连接），
 *      绝不试图改状态码 —— 那正是 ERR_HTTP_HEADERS_SENT 的来源。
 *   ③ **兜底不能掩盖持续故障**：短时间内兜太多次，说明状态已经不可信，
 *      主动退出让平台重启比在坏状态里空转更好。
 *
 * 【和 lib/guard.js 的分工】
 *   `public/js/guard.js` 是**浏览器端**的（给用户看 toast）；
 *   这里是**服务端**的（保住进程 + 打日志）。两件事，别混。
 * ============================================================ */

/** 兜底次数上限：窗口内超过就主动退出，交给平台重启。 */
const MAX_FAULTS = 50;
/** 计数的滑动窗口（毫秒）。 */
const WINDOW_MS = 60_000;

/** 把任意抛出物拍成一行可读信息。**不抛**。 */
function describe(e) {
  try {
    if (e == null) return String(e);
    if (typeof e === 'string') return e.slice(0, 500);
    const name = e.name || 'Error';
    const msg = e.message || '';
    const first = String(e.stack || '').split('\n').slice(1, 3).join(' | ');
    return (name + ': ' + msg + (first ? ' @ ' + first : '')).slice(0, 800);
  } catch (_) {
    return '<无法序列化的异常>';
  }
}

/** 安全打日志：console 自己也可能因为管道断开而抛 EPIPE。 */
function log(line) {
  try { console.error(line); } catch (_) { /* 真的没辙了 */ }
}

/**
 * 装进程级兜底。**必须在 listen 之前调用**。
 * @returns `softFault(tag, e)` —— 也导出给别处手动上报
 */
export function installFaultGuards() {
  const stamps = [];

  function softFault(tag, e) {
    try {
      const now = Date.now();
      /* 只保留窗口内的记录 —— 否则跑一个月攒够 50 次就无故重启 */
      while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
      stamps.push(now);
      log('[phm] ' + tag + '（已兜住，进程继续）：' + describe(e));
      if (stamps.length > MAX_FAULTS) {
        log('[phm] 60 秒内兜底 ' + stamps.length + ' 次 —— 状态已不可信，主动退出让平台重启');
        process.exit(1);
      }
    } catch (_) { /* 兜底自己不许抛 */ }
  }

  /* ⚠ 这两条的意义不是"忽略异常"，是**把异常从"杀进程"降级成"一条日志"**。
     真正的修法仍然是在源头 try/catch；这里只是保证漏网的那些不致命。 */
  process.on('uncaughtException', e => softFault('未捕获异常', e));
  process.on('unhandledRejection', e => softFault('未处理的 Promise 拒绝', e));

  /* 连被拒绝的 socket 都记一条 —— 排查"线上偶发 502"时这条常常是关键 */
  process.on('warning', w => {
    if (w && w.name === 'MaxListenersExceededWarning') softFault('监听器泄漏', w);
  });

  return softFault;
}

/** 兜底回复：头没发就 500，头已发就干净收尾。**不抛**。 */
function failResponse(res, e, softFault) {
  if (typeof softFault === 'function') softFault('请求处理异常', e);
  else log('[phm] 请求处理异常：' + describe(e));
  try {
    if (!res || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'internal' }));
    } else if (!res.writableEnded) {
      /* ⚠ 头已经发出去了，**不能再 writeHead**（那正是 ERR_HTTP_HEADERS_SENT）。
         只能结束响应体，让客户端拿到一个截断的响应 —— 比整站下线好。 */
      res.end();
    }
  } catch (_) { /* 连收尾都失败就断掉，别再抛 */ }
}

/**
 * 包住 http 请求处理函数：同步抛与异步 reject 都接住。
 * @param fn `(req, res) => any`（可以是 async）
 * @param softFault 可选，来自 installFaultGuards()
 */
export function guardRequest(fn, softFault) {
  return function guarded(req, res) {
    /* ⚠ 必须自己接 `error`：客户端提前断开时 res/req 会 emit 'error'，
       没有监听器就是**未捕获事件**（Node 会直接抛）。下载路由那次事故就是它。 */
    try {
      if (res && typeof res.on === 'function') res.on('error', () => {});
      if (req && typeof req.on === 'function') req.on('error', () => {});
    } catch (_) {}

    let out;
    try {
      out = fn(req, res);
    } catch (e) {
      return failResponse(res, e, softFault);
    }
    if (out && typeof out.then === 'function') {
      out.then(null, e => failResponse(res, e, softFault));
    }
  };
}
