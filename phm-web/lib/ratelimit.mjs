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

/** DB 侧计数。返回 `{ok, remaining, resetMs}`，失败返回 null
 *  （调用方按 `failClosed` 决定是拒绝还是退回内存）。 */
async function dbHit(key, max, windowMs) {
  /* 测试缝：单测要验「DB 打不通时的行为」，不能真去把线上库弄挂。
     只在显式设了这个环境变量时生效，且会在日志里留痕。 */
  if (process.env.PHM_RL_FORCE_DB_DOWN === '1') {
    console.warn('[ratelimit] PHM_RL_FORCE_DB_DOWN=1 —— 模拟 DB 不可用（仅测试）');
    return null;
  }
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

/* ══════════════════════════════════════════════════════════════
 * 限流键怎么选（对齐 GitHub / Stripe / Cloudflare 的做法）
 * ══════════════════════════════════════════════════════════════
 * 原则：**身份优先，IP 兜底**。IP 在 NAT / CDN / 反代后面本来就不可信，
 * 大厂都是先按 token / 账号限，IP 只做粗粒度兜底，并且**永远有一层全局上限**。
 *
 * ⚠⚠ 为什么不采信 X-Forwarded-For（2026-10-17 定案，实测两次）：
 *   · 客户端可以随便写这个头 → 拿它当键等于把钥匙交给攻击方
 *     （白帽实测：伪造 XFF 换个 IP 就能接着打，旧版确实被绕穿）。
 *   · 平台网关对这个头的处理**不保证**（实测同一秒内它给每个请求塞了
 *     不同的值 125.94.247.208 / 125.94.248.102 / 1.71.146.239 …），
 *     所以「取第一段」「取最后一段」在这里都不可靠。
 *   · 唯一能确定的是 `req.socket.remoteAddress` —— 那是真实的 TCP 对端。
 *     它可能被网关收敛成一个地址（实测线上是 127.0.0.1），那也只是
 *     "所有人共用一个桶"（偏严、可被 DoS），**不是"能绕过"**。
 *
 * 所以本模块的键分三层，调用方按需组合：
 *   `id:<sub>`  身份（我们自己签发的 JWT，伪造不了）—— 最优先
 *   `ip:<addr>` 真实对端 —— 仅当它不是网关/内网地址时才有区分意义
 *   `g:<scope>` 全局 —— 永远挂，防"换键绕过"的最后一层
 */
const LOOPBACK_OR_PRIVATE = /^(127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:127\.)/;

/** 归一化「限流主体」。
 *  ⚠ 为什么要它：早先的签名是 `gateWrite(ip)`（字符串），改成 `{sub, ip}` 之后
 *    传字符串会静默变成「谁都不是」→ 只剩全局桶 → 看起来"还能用"，
 *    实际 per-IP 那一维**悄悄消失了**。这种退化不会报错，最难查。
 *    所以两种形态都收：字符串按 ip 处理，对象照常。 */
const asWho = w => (typeof w === 'string' ? { ip: w } : (w || {}));

/** 对端是不是「网关/内网」—— 是的话 per-IP 桶没有区分意义，要跳过。
 *  说清楚后果：跳过之后靠全局桶兜底（偏严）。这比"所有人共用一个 20/分
 *  的桶、一个人就能把全站堵死"要好，也比"用 XFF 换 IP 随便绕"安全得多。 */
export function isSharedPeer(addr) {
  return !addr || addr === 'unknown' || LOOPBACK_OR_PRIVATE.test(addr);
}

/** 把「身份 / 对端 / 全局」组装成一组键。
 *
 *  ⚠⚠ 三条分支的**上限必须各自明确**，尤其第三条：
 *    · 有身份      → 身份桶（perId）+ 全局桶（global）
 *    · 有公网对端  → per-IP 桶（perIp）+ 全局桶（global）
 *    · 共享对端    → **只有全局桶，且它必须用 perIp 这一档**
 *
 *  第三条是 2026-10-17 实测踩出来的坑：网关把所有人收敛成 127.0.0.1，
 *  per-IP 键被丢掉之后只剩 `global`，于是「20 次/分」悄悄变成了「120 次/分」——
 *  38 连发全部 200。**这种放宽不会报错，只会让限流静默失效**，
 *  所以在代码层面把它钉死：共享对端下全局桶就是唯一防线，必须用严格档。
 */
export function buildKeys(scope, who, limits = {}) {
  const { perIp = 20, perId = 60, global = 120 } = limits;
  const w = asWho(who);
  if (w.sub) {
    return [
      { k: `${scope}:id:${w.sub}`, max: perId },
      { k: `${scope}:g`, max: global },
    ];
  }
  if (w.ip && !isSharedPeer(w.ip)) {
    return [
      { k: `${scope}:ip:${w.ip}`, max: perIp },
      { k: `${scope}:g`, max: global },
    ];
  }
  /* 共享对端：没有任何维度能区分客户端 → 全局桶就是唯一的限流，
     必须用 perIp（严格档）而不是 global（宽松档）。 */
  return [{ k: `${scope}:g`, max: perIp }];
}

export async function limit(keys, max, windowMs = 60_000, opts = {}) {
  /* 测试旁路：见文件里 NO_RL 的说明。默认不进来。
     ⚠ 必须返回 `{ok:true}` 而不是 `true` —— 调用方 makeGate 判的是 `r.ok`，
       传布尔值会让它读到 undefined 而当成「没过头」，直接回 429。
       （这个坑真实发生过：旁路看起来"设了"，结果 429 照旧。） */
  if (NO_RL) return { ok: true, via: 'bypass', n: 0, resetMs: 0 };
  /* 允许调用方传 `{k, max: undefined}` —— 这时用默认 max 补上，
     省得每个调用点都重复写一遍数字。 */
  const specs = keys.map(k => {
    if (typeof k === 'string') return { k, max };
    return { k: k.k, max: k.max == null ? max : k.max };
  });
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
        /* ⚠⚠ DB 调不通，两条路要**分开**处理：
           `failClosed: true`（登录/注册/写入）→ **拒绝**。这些路径本来就要
             读写库，库不通时无论如何都做不成事；放行只会让「限流在库抖动时
             静默消失」—— 2026-10-13 审计暴露的正是这种形态
             （一度实测到 70 连发全 200，就是这条路走出来的）。
           `failClosed` 没开（只读统计/charts/代理）→ **放行**。便宜的读，
             为了库抖一下把全站只读接口全关掉不值得。退回内存结果（已过预筛）。 */
        if (opts.failClosed) {
          return { ok: false, remaining: -1, resetMs: windowMs, via: 'db-down' };
        }
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
  writeIp: 20, writeGlobal: 120, writeId: 60,
  loginIp: 5, loginGlobal: 20, loginEmail: 3,
  statsIp: 60, statsId: 120, statsGlobal: 400,
  /* 发验证码：每封都是真邮件，per-邮箱 1 分钟 1 封是硬底线 ——
     否则就成了给别人邮箱灌垃圾的工具（白帽报告发现 7）。 */
  codeIp: 3, codeEmail: 1, codeGlobal: 30,
  analyzeIp: 10, analyzeId: 60, analyzeGlobal: 60,
  proxyIp: 60, proxyId: 120, proxyGlobal: 300,
  /* API v1（/api/v1/*）：匿名按小时，key 按小时；分析另有每日上限。 */
  apiAnonHour: 100, apiAnonGlobal: 2000,
  apiKeyHour: 1000, apiAnalyzeDay: 200,
};
export const RL_WINDOW = 60_000;

/* ⚠⚠ **只给自动化测试用的旁路，生产绝对不许开**。
 *
 * 为什么需要：限流是**按真实 IP** 计的，而浏览器测试把所有页面都从
 * 127.0.0.1 打一遍 —— 谱师页 / 玩家页 / 谱面包各自都要拉 Phira 谱面，
 * 十几页加起来轻松撞掉 proxyIp=60 的配额，于是排在后面的页面
 * 拿到 429、卡片渲染成 0，测试报「功能坏了」而功能其实好的。
 * （2026-10-18 实测：只有 `/packs` 红，其他页全绿 —— 典型的配额被前面吃光。）
 *
 * ⚠ 为什么不能用「放宽阈值」解决：那等于为了让测试过而降低线上防线。
 * 这里反过来 —— **只在显式设了环境变量时放行**，默认行为一字不变，
 * 忘了设也只是回到「测试撞限流」这个吵闹但安全的状态。
 *
 * ⚠ 它绕过的**只有配额**，不绕过路径白名单、不绕过方法限制。
 * ⚠ 生产若误设 PHM_TEST_NO_RATELIMIT=1，限流就静默失效了 ——
 *   所以部署检查里必须确保它**不在**环境变量里。 */
const NO_RL = process.env.PHM_TEST_NO_RATELIMIT === '1';

/** 各路径的过闸句柄 —— 消息文案跟着配额走，改 RL 不用翻遍全文件找 429。
 *  `opts` 会透传给 limit()，测试用 `{db:false}` 只测内存路径。 */
/* 写入与登录走 failClosed：库不通时它们本来就做不成事，放行等于限流静默消失。 */
/* 写入：身份优先（有 sub 就按 sub），否则用真实对端；全局键永远挂。
   ⚠ 网关把对端收敛成 127.0.0.1 时，per-IP 桶会被 buildKeys 丢掉 ——
     留着它只会让全站共用一个桶，一个人就能把所有人堵死。 */
export const gateWrite = (who, opts) =>
  limit(buildKeys('w', who, { perIp: RL.writeIp, perId: RL.writeId, global: RL.writeGlobal }),
    RL.writeIp, RL_WINDOW, Object.assign({ failClosed: true }, opts));

/** 身份维度的第二道闸：**只按 sub 计**，不挂全局键 ——
 *  否则同一次请求会把全局桶扣两遍，等于把全站上限砍半。
 *  用在「已经验明身份」之后（例如成绩上报），挡的是「一个账号刷爆」。 */
export const gateWriteId = (sub, opts) =>
  limit([{ k: `w:id:${sub}`, max: RL.writeId }], RL.writeId, RL_WINDOW,
    Object.assign({ failClosed: true }, opts));

/* 读：同样身份优先，但配额宽松，且**不做 fail-closed**（便宜的读）。 */
export const gateStats = (who, opts) =>
  limit(buildKeys('S', who, { perIp: RL.statsIp, perId: RL.statsId, global: RL.statsGlobal }),
    RL.statsIp, RL_WINDOW, opts);
export const gateProxy = (who, opts) =>
  limit(buildKeys('A', who, { perIp: RL.proxyIp, perId: RL.proxyId, global: RL.proxyGlobal }),
    RL.proxyIp, RL_WINDOW, opts);
export const gateAnalyze = (who, opts) =>
  limit(buildKeys('A', who, { perIp: RL.analyzeIp, perId: RL.analyzeId, global: RL.analyzeGlobal }),
    RL.analyzeIp, RL_WINDOW, opts);

/** 登录/注册：per-IP + per-邮箱 + 全局 三重，**各自不同上限**。
 *  per-邮箱那一维最关键 —— 否则攻击者换 XFF 就能对同一个目标全速爆破
 *  （实测：per-IP 撞限后换一个 XFF，per-邮箱键仍然把它挡住了）。 */
export function gateAuth(who, email, opts) {
  const ip = asWho(who).ip;
  const e = String(email || '').trim().toLowerCase();
  const keys = [
    { k: `a:ip:${ip}`, max: RL.loginIp },
    { k: 'a:g', max: RL.loginGlobal },
  ];
  if (e) keys.push({ k: `a:e:${e}`, max: RL.loginEmail });
  return limit(keys, null, RL_WINDOW, Object.assign({ failClosed: true }, opts));
}

/** 发验证码的闸：per-IP 3/分 + **per-邮箱 1/分** + 全局 30/分。
 *  每发一封都是真邮件（成本 + 发件域声誉），所以比登录还严。 */
export function gateCode(who, email, opts) {
  const ip = asWho(who).ip;
  const e = String(email || '').trim().toLowerCase();
  const keys = [
    { k: `c:ip:${ip}`, max: RL.codeIp },
    { k: 'c:g', max: RL.codeGlobal },
  ];
  if (e) keys.push({ k: `c:e:${e}`, max: RL.codeEmail });
  return limit(keys, null, RL_WINDOW, Object.assign({ failClosed: true }, opts));
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

/* ══════════════════════════════════════════════════════════════
 * 过闸 —— 把「检查 → 拒绝时发响应」这一步封起来
 * ══════════════════════════════════════════════════════════════
 * ⚠⚠ 为什么必须包这一层：`limit()` 返回的是**对象**（带 remaining / resetMs /
 *   via），而 `if (!obj)` 永远为真 —— 这正是本项目 2026-10-13 那次
 *   「限流 70 连发全 200」的同类 bug（当时是 Promise 恒真值）。
 *   包一层之后调用点只能写
 *       if (!(await gate(res, gateWrite(ip), '…'))) return;
 *   结构上没法拉胯。
 *
 * ⚠ `secHeaders` 由调用方注入（server.mjs 的 SEC_HEADERS）——
 *   模块本身不该知道站点的安全头长什么样。
 */
export function makeGate(secHeaders) {
  function sendRl429(res, msg, r) {
    res.writeHead(429, Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, secHeaders, rlHeaders(r)));
    res.end(JSON.stringify({ error: msg }));
  }
  /** 没过头就在这里把响应发掉并返回 false；调用方只管 `if (!ok) return;`。
   *  ⚠ 库不通（fail-closed 拒了）回 **503** 而不是 429 ——
   *    「服务端故障」和「你发太快」是两回事，混在一起两边都会查错方向。 */
  return async function gate(res, promise, msg) {
    const r = await promise;
    if (r.ok) return true;
    if (r.via === 'db-down') {
      res.writeHead(503, Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }, secHeaders, { 'retry-after': '5' }));
      res.end(JSON.stringify({
        error: '服务端暂时不可用（数据库不通），请几秒后重试', retryAfter: 5,
      }));
      return false;
    }
    sendRl429(res, msg, r);
    return false;
  };
}
