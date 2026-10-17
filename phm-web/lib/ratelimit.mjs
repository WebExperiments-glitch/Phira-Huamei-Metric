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

/* ══════════════════════════════════════════════════════════════
 * 为什么有 DB 兜底这条路径
 * ══════════════════════════════════════════════════════════════
 * 进程内计数在**无状态托管环境**里必然失效 —— 实测（2026-10-16）：
 * 同一出口 IP 连发 200 个 /api/stats，零 429；换 250 个 XFF 也是零 429。
 * 不是多实例分裂（那至少会有零星 429），而是**每个请求都落在新进程上**，
 * 桶活了不到一个请求的寿命。
 *
 * 所以：进程内计数当**快速预筛**（免费挡住同进程内的突发），
 * 真正的 authoritative 计数走数据库 `hm_rate_hit()` RPC ——
 * 它带写入凭据、SECURITY DEFINER、表开了 RLS 且不给 anon 直连权限，
 * 和 `hm_put_play` 是同一条防线。
 *
 * ⚠ DB 调不通时**退回进程内**并打日志：宁可限流松一点，
 *   也不能因为数据库抖一下就把全站 API 关掉。
 * ⚠ 代价：每个被限流的请求多一次 DB 往返（实测约几十毫秒）。
 *   对本站量级可接受；真要省，可以给热点路径加本地 TTL 缓存。 */
import { dbFetch, WRITE_SECRET } from './cloud.mjs';

/** DB 侧计数。返回 `{ok, remaining, resetMs}`，失败返回 null（调用方退回内存）。 */
async function dbHit(key, max, windowMs) {
  if (!WRITE_SECRET) return null;
  const r = await dbFetch('/rpc/hm_rate_hit', {
    method: 'POST',
    body: JSON.stringify({
      p_secret: WRITE_SECRET, p_key: key, p_max: max, p_window_ms: windowMs,
    }),
  }, 8000, 2048);
  if (!r.ok) {
    console.warn('[ratelimit] DB 计数失败，退回进程内：', r.status,
      String(r.body || r.error || '').slice(0, 160));
    return null;
  }
  try {
    const j = JSON.parse(r.body || '{}');
    return {
      ok: j.ok === true,
      remaining: typeof j.remaining === 'number' ? j.remaining : -1,
      resetMs: Number(j.reset_ms) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param keys   要检查的键。可以是字符串（统一用 max），
 *               也可以是 `{k, max}` —— 用于**每个键不同上限**的场景
 *               （典型：登录要 per-IP 5/分 但 per-邮箱 3/分）。
 * @param max    默认上限（字符串键用它）
 * @param windowMs 窗口（毫秒），默认 60_000
 * @param opts   `{db:false}` 可强制只用进程内（测试用）
 * @returns Promise<{ok, remaining, resetMs, via}>
 *   `ok`        true = 放行
 *   `remaining` 最紧的那个键还剩几次（-1 表示被拒）
 *   `resetMs`   还要等多少毫秒（被拒时才有意义）
 *   `via`       'db' 或 'memory' —— 便于排查"到底哪条路在生效"
 *
 * ⚠ 语义：全部键都通过才放行。被拒的请求**不消耗配额**。
 *   这是刻意和 express-rate-limit 等库不同的地方：它们记每一次请求，
 *   于是撞限后桶会一直满到窗口结束。这里不记，好处是**恢复更快** ——
 *   用户第 4 次撞限后，等最早那一条计时戳滑出窗口就能重试，不必干等满一分钟。
 *   对"每分钟 N 次"这个量级，两种做法的防护效果相同（攻击者每窗口都只有 N 次）。
 */
/* ── 全局限流队列 ──
 * ⚠⚠ 为什么需要它：`hm_rate_hit` 的「数 → 插」是两步。50 个并发同时打过去时，
 *   第 3 个请求的 count(*) 会把前两个已经插进去的行也数进来 ——
 *   于是前几个调用就把 50 个额度用光，剩下的全被拒（实测：50 并发放行 0 个）。
 *   这不是 DB 的错，是**调用方没有串行化**。
 *
 * ⚠⚠ 两个踩过的坑（都实测复现过）：
 *   ① `rlQueue = run.catch(...)` 看着在串行化，但同一个 tick 里发起的 N 个调用
 *      会读到**同一个** rlQueue 值 —— 它们全挂在第一个后面，彼此之间却没顺序。
 *   ② 「同步自增拿号 + while 等号」更糟：后到的调用会覆盖 rlTail，
 *      前一个号还没完成就被跳过。
 *    正解就是最朴素的 promise 链：**每次调用都把自己挂到当前队尾**，
 *    挂的动作本身是同步的，所以同一个 tick 内的顺序由调用先后决定。
 *    代价：限流检查在全进程内排队。本站量级无所谓，换来计数准确。 */
let rlTail = Promise.resolve();

export async function limit(keys, max, windowMs = 60_000, opts = {}) {
  const specs = keys.map(k => (typeof k === 'string' ? { k, max } : { k: k.k, max: k.max }));
  /* 同步挂到队尾 —— 这一行就是顺序的来源，必须写在任何 await 之前 */
  const mine = rlTail.then(() => runLimit(specs, windowMs, opts));
  rlTail = mine.catch(() => {});
  return mine;
}

async function runLimit(specs, windowMs, opts) {
  {
    /* ① 进程内快速预筛：同进程内的突发先挡掉，省一次 DB 往返。 */
    const mem = memLimitSync(specs, windowMs);
    if (!mem.ok) return Object.assign({}, mem, { via: 'memory' });
    if (opts.db === false) return Object.assign({}, mem, { via: 'memory' });

    /* ② DB 权威计数。任一键超限就整体拒。 */
    let remaining = Infinity, resetMs = 0;
    for (const { k, max: m } of specs) {
      const r = await dbHit(k, m, windowMs);
      if (r === null) {
        /* DB 不可用 → 退回内存结果（已经预筛过） */
        return Object.assign({}, mem, { via: 'memory' });
      }
      if (!r.ok) return { ok: false, remaining: -1, resetMs: r.resetMs, via: 'db' };
      remaining = Math.min(remaining, r.remaining);
      resetMs = Math.max(resetMs, r.resetMs);
    }
    return { ok: true, remaining, resetMs, via: 'db' };
  }
}

/* ── 进程内计数（快速预筛 + DB 不可用时的兜底）──
 * ⚠ **纯同步、没有自己的队列** —— 串行化由 limit() 的 rlTail 统一负责。
 *   早先这里还有第二把队列，两把队列嵌套正是并发测试偶发失败的原因：
 *   外层的 then 回调里再 await 内层队列，同一个 tick 的多个调用读到同一个内层
 *   队尾，彼此间依然没有顺序。 */
const buckets = new Map();      // key → number[]（毫秒时间戳，升序）
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

function memLimitSync(specs, windowMs) {
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
  statsIp: 60, statsGlobal: 400,
  analyzeIp: 10, analyzeGlobal: 60,
  proxyIp: 60,
};
export const RL_WINDOW = 60_000;

/** 各路径的过闸句柄 —— 消息文案跟着配额走，改 RL 不用翻遍全文件找 429。
 *  `opts` 会透传给 limit()，测试用 `{db:false}` 只测内存路径。 */
export const gateWrite = (ip, opts) => limit([`w:ip:${ip}`, 'w:g'], RL.writeIp, RL_WINDOW, opts);
/* 读路径同时挂 per-IP 与**全局**两个键 —— 全局是对付"IP 键失效"的后手。
   2026-10-16 实测：平台每次请求注入不同 XFF，per-IP 形同虚设；
   改用 socket 地址后 per-IP 恢复，但全局桶留着更稳（换 IP 也绕不开）。 */
export const gateStats = (ip, opts) => limit([`S:ip:${ip}`, 'S:g'], RL.statsIp, RL_WINDOW, opts);
export const gateProxy = (ip, opts) => limit([`A:ip:${ip}`], RL.proxyIp, RL_WINDOW, opts);
export const gateAnalyze = (ip, opts) => limit([`A:ip:${ip}`, 'A:g'], RL.analyzeIp, RL_WINDOW, opts);
/** 登录/注册：per-IP + per-邮箱 + 全局 三重，**各自不同上限**。
 *  per-邮箱那一维最关键 —— 否则攻击者换 XFF 就能对同一个目标全速爆破
 *  （实测：per-IP 撞限后换一个 XFF，per-邮箱键仍然把它挡住了）。 */
export function gateAuth(ip, email, opts) {
  const e = String(email || '').trim().toLowerCase();
  const keys = [
    { k: `a:ip:${ip}`, max: RL.loginIp },
    { k: 'a:g', max: RL.loginGlobal },
  ];
  if (e) keys.push({ k: `a:e:${e}`, max: RL.loginEmail });
  return limit(keys, null, RL_WINDOW, opts);
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
