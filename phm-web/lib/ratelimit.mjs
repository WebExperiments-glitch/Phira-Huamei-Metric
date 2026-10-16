/* ============================================================
 * lib/ratelimit.mjs —— 进程内限流（**不碰文件系统**）
 * ============================================================
 * 【为什么重写】
 *   原先的限流把计数存进 `server-store.json`（`withStore` → `storeLoad` /
 *   `storeSave`），而 `storeSave` 是 `try { writeFileSync } catch {}` ——
 *   失败被静默吞掉。线上沙箱的部署目录**不可写**，于是每一次请求都从
 *   空计数开始：30 次/分/IP 这个上限**从来没触发过一次**。
 *
 *   2026-10-13 授权渗透审计实测：连发 70 个 `/api/stats` 全部 200
 *   （源码写的上限是 60/分），连发 35 个 `/api/contribute` 也全部 200。
 *   也就是说所有"限流兜底"形同虚设 —— 这不是阈值定得松，是**计数根本没存下来**。
 *
 * 【现在的做法】
 *   计数放进程内存，读改写用一条 promise 队列串行化（并发请求不会互相
 *   覆盖丢计数 —— 那正是 `bfccd91` 修过一次的老 bug，不能退回去）。
 *
 *   ⚠ 代价说清楚：进程重启后计数清零。对"每分钟 N 次"这个量级可接受 ——
 *     重启本身就把并发压力切断了。
 *   ⚠ 多实例部署时各实例各算各的（沙箱若多实例/滚动发布）。这仍然比
 *     "完全不限"强：单实例内的洪水被挡住了。要跨实例，得上 Redis 这类
 *     共享存储 —— 那是另一个量级的工程，本项目先不做，但要知道边界在哪。
 *
 * 【键的设计】
 *   `limit([key1, key2, …], max)` 对**每个键独立**套同一个 max。
 *   于是"每 IP"和"全局"可以一把梭：
 *       limit([`w:ip:${ip}`, 'w:g'], 30)
 *   两个键各自的 30 上限谁先撞谁拒。
 * ============================================================ */

const buckets = new Map();      // key → number[]（毫秒时间戳，升序）
let queue = Promise.resolve();  // 串行化读改写
let lastPrune = 0;

/** 窗口外的计数丢掉的阈值：早于 now - windowMs 的整段丢掉。 */
function trim(arr, now, windowMs) {
  let i = 0;
  while (i < arr.length && arr[i] <= now - windowMs) i++;
  if (i > 0) arr.splice(0, i);
}

/** 定期清空桶，避免 Map 随 IP 无限膨胀。 */
function maybePrune(now) {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, arr] of buckets) {
    if (!arr.length) buckets.delete(k);
  }
}

/**
 * @param keys   要检查的键。可以是字符串（统一用 max），
 *               也可以是 `{k, max}` —— 用于**每个键不同上限**的场景
 *               （典型：登录要 per-IP 5/分 但 per-邮箱 3/分）。
 * @param max    默认上限（字符串键用它）
 * @param windowMs 窗口（毫秒），默认 60_000
 * @returns Promise<{ok, remaining, resetMs}>
 *   `ok`        true = 放行（**并已记一次数**）
 *   `remaining` 最紧的那个键还剩几次（-1 表示被拒）
 *   `resetMs`   还要等多少毫秒最早的计数才滑出窗口（被拒时才有意义）
 *
 * ⚠ 语义：全部键都通过才记数。被拒的请求**不消耗配额**。
 *   这是刻意和 express-rate-limit 等库不同的地方：它们记每一次请求，
 *   于是撞限后桶会一直满到窗口结束。这里不记，好处是**恢复更快** ——
 *   用户第 4 次撞限后，等最早那一条计时戳滑出窗口就能重试，不必干等满一分钟。
 *   对"每分钟 N 次"这个量级，两种做法的防护效果相同（攻击者每窗口都只有 N 次）。
 *
 * ⚠ 为什么返回 resetMs：429 必须带 `Retry-After`（RFC 6585）。
 *   没有它，客户端只会立刻重试，把拒绝本身变成又一轮压力。 */
export function limit(keys, max, windowMs = 60_000) {
  const specs = keys.map(k => (typeof k === 'string' ? { k, max } : { k: k.k, max: k.max }));
  const run = queue.then(() => {
    const now = Date.now();
    maybePrune(now);
    let remaining = Infinity;
    let resetMs = 0;
    for (const { k, max: m } of specs) {
      let arr = buckets.get(k);
      if (!arr) {
        arr = [];
        buckets.set(k, arr);
      }
      trim(arr, now, windowMs);
      if (arr.length >= m) {
        /* 被拒：最早的计时戳还要多久才滑出去 */
        const wait = Math.max(0, (arr[0] || now) + windowMs - now);
        return { ok: false, remaining: -1, resetMs: wait };
      }
      /* ⚠ `- 1`：remaining 报的是**这一发之后**还能发几次
         （RateLimit-Remaining 的标准语义）。不减 1 就会多报一次 ——
         客户端据此退避会慢一拍。 */
      remaining = Math.min(remaining, m - arr.length - 1);
      if (arr.length) resetMs = Math.max(resetMs, arr[0] + windowMs - now);
    }
    for (const { k } of specs) buckets.get(k).push(now);
    return { ok: true, remaining, resetMs };
  });
  queue = run.catch(() => {});
  return run;
}

/** 给 429 响应补上标准头（RFC 6585 + IETF Rate Limit 草案）。
 *  `Retry-After` 是必须的（秒，向上取整，至少 1）；
 *  `RateLimit-*` 让守规矩的客户端能自己退避，而不是撞了才知道。 */
export function tooManyHeaders(r, windowMs = 60_000) {
  const secs = Math.max(1, Math.ceil((r && r.resetMs || windowMs) / 1000));
  return {
    'retry-after': String(secs),
    'ratelimit-limit': String(r && r.limit != null ? r.limit : ''),
    'ratelimit-remaining': '0',
    'ratelimit-reset': String(secs),
  };
}
/* ── 在途并发上限 ──
 * 限流管"频率"，这个管"同时有几个"。
 * `/api/analyze` 和 `/api/contribute` 都会让服务端下载 ≤60MB 谱面并
 * **同步**跑引擎 —— 同步跑会卡住整个 Node 事件循环，所以在途数必须封顶。 */
const inflight = new Map();

/** 尝试进入。满员返回 false（调用方回 503，**不要** leave）。 */
export function tryEnter(scope, max) {
  const n = inflight.get(scope) || 0;
  if (n >= max) return false;
  inflight.set(scope, n + 1);
  return true;
}

export function leave(scope) {
  const n = inflight.get(scope) || 0;
  if (n <= 1) inflight.delete(scope);
  else inflight.set(scope, n - 1);
}

/** 诊断/测试用：当前桶与在途数的快照。 */
export function snapshot() {
  const out = {};
  for (const [k, arr] of buckets) out[k] = arr.length;
  return { buckets: out, inflight: Object.fromEntries(inflight) };
}

/** 测试用：清空。 */
export function reset() {
  buckets.clear();
  inflight.clear();
}

/* ══════════════════════════════════════════════════════════════
 * 各路径的配额与「过闸」句柄
 * ══════════════════════════════════════════════════════════════
 * 集中放在这里而不是散在 server.mjs：配额是**一份策略**，
 * 散在路由里就会出现「同一路径两处限额还不一样」这种事。
 * 改配额只改这一处。
 *
 * 键分三类，互不挤占：
 *   `w:` 写入(contribute/scores/hm-play) · `S:` 只读统计/charts · `A:` analyze/代理
 * 每类同时挂 per-IP 与全局两个键，谁先撞谁拒。
 * 全局键是对付 X-Forwarded-For 伪造的后手 —— 换 IP 绕得开 per-IP，绕不开全局。 */
export const RL = {
  writeIp: 20, writeGlobal: 120,
  loginIp: 5, loginGlobal: 20, loginEmail: 3,
  statsIp: 60,
  analyzeIp: 10, analyzeGlobal: 60,
  proxyIp: 60,
};
export const RL_WINDOW = 60_000;

/** 各路径的过闸句柄 —— 消息文案跟着配额走，改 RL 不用翻遍全文件找 429。 */
export const gateWrite = (ip) => limit([`w:ip:${ip}`, 'w:g'], RL.writeIp);
export const gateStats = (ip) => limit([`S:ip:${ip}`], RL.statsIp);
export const gateProxy = (ip) => limit([`A:ip:${ip}`], RL.proxyIp);
export const gateAnalyze = (ip) => limit([`A:ip:${ip}`, 'A:g'], RL.analyzeIp);
/** 登录/注册：per-IP + per-邮箱 + 全局 三重，**各自不同上限**。
 *  per-邮箱那一维最关键 —— 否则攻击者换 XFF 就能对同一个目标全速爆破
 *  （实测：per-IP 撞限后换一个 XFF，per-邮箱键仍然把它挡住了）。 */
export function gateAuth(ip, email) {
  const e = String(email || '').trim().toLowerCase();
  const keys = [
    { k: `a:ip:${ip}`, max: RL.loginIp },
    { k: 'a:g', max: RL.loginGlobal },
  ];
  if (e) keys.push({ k: `a:e:${e}`, max: RL.loginEmail });
  return limit(keys, null);
}

/** 429 的标准响应头（RFC 6585 + IETF Rate Limit 草案）。
 *  `retry-after` 是必须的（秒，向上取整，至少 1）—— 没有它客户端只会立刻重试，
 *  把拒绝本身变成又一轮压力。
 *  `ratelimit-*` 让守规矩的客户端能自己退避，而不是撞了才知道。 */
export function rlHeaders(r) {
  const secs = Math.max(1, Math.ceil((r && r.resetMs || RL_WINDOW) / 1000));
  return {
    'retry-after': String(secs),
    'ratelimit-remaining': '0',
    'ratelimit-reset': String(secs),
  };
}
