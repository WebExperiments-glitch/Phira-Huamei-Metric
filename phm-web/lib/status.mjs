/* ============================================================
 * lib/status.mjs —— 服务状态探测（自监控）
 * ============================================================
 * 【为什么自己探自己，而不是像 Uptime Kuma 那样从外面 ping】
 *   外部探针测的是「网络路径 + 服务」。我们只关心后者：
 *   线上沙箱的入站流量走平台网关，从容器内打不出去是常态，
 *   拿外部探针的结果只会得到一片假红。
 *   所以探针打**回环地址**：127.0.0.1:PORT，走的是和真实请求
 *   完全相同的路由 → 测出来的延迟就是真实的处理耗时。
 *
 * 【探测哪些东西】
 *   不是「ping 一下根路径」糊弄过去，而是把**用户真会碰的东西**分三组：
 *     page  静态页面（走白名单 + sendFile + 缓存头那一整条路）
 *     api   接口（走各自的鉴权 / 配额 / DB 分支）
 *     data  大文件（参照集 750KB，测的是读盘与传输）
 *   根路径绿了不代表 /api/v1/charts 绿 —— 后者要过 DB。
 *
 * 【存储：内存 + DB 双轨】
 *   ⚠ 部署目录**不可写**（见 ratelimit.mjs 顶部那段），
 *     所以历史不能落文件。分两层：
 *       近24h  进程内环形缓冲，每分钟一点 —— 零延迟，重启即失
 *       30天   DB 表phm_status_hour，每小时一行 —— 跨重启留存
 *   DB 没迁移或调不通时**只降级不报错**：状态页是锦上添花，
 *     它自己挂了绝不能连带影响主服务（这正是本文件不 throw 的原因）。
 *
 * 【为什么不用现成的 Uptime Kuma / node-ping-monitor】
 *   两个都要额外常驻进程 + 自己的存储，而这个项目只有**一个** Node 进程
 *   （沙箱托管），加进程等于加一整套部署依赖。
 *   自带的代价是约 300 行，收益是零新依赖、零新部署面。
 * ============================================================ */

import { dbFetch, WRITE_SECRET } from './cloud.mjs';

/* ── 探测目标 ──
 * ⚠ path 一律用**干净 URL**（不带 .html）：线上由路由改写，
 *   探真实路径才知道用户点导航会不会 404。 */
export const TARGETS = [
  /* ── 页面：静态与路由 ── */
  { id: 'page-home',    group: 'page', path: '/',           label: '首页' },
  { id: 'page-app',     group: 'page', path: '/app',        label: '算谱面' },
  { id: 'page-data',    group: 'page', path: '/data',       label: '查定数' },
  { id: 'page-user',    group: 'page', path: '/user',     label: '玩家页' },

  /* ── 接口：真会走 DB 的那些 ── */
  { id: 'api-health',   group: 'api',  path: '/api/health',        label: '健康检查' },
  { id: 'api-meta',     group: 'api',  path: '/api/v1/meta',       label: 'API 元信息' },
  { id: 'api-stats',    group: 'api',  path: '/api/v1/stats',      label: 'API 统计' },
  { id: 'api-charts',   group: 'api',  path: '/api/v1/charts?limit=1', label: 'API 查谱' },

  /* ── 数据：大文件传输 ── */
  { id: 'data-ref',     group: 'data', path: '/data/ref-com.json', label: '参照集' },
];

/* 探测周期。60s 是权衡：太短会给自造压力（每个探测都是一次真实请求，
 * 而/api/v1/* 走限流），太长则「一分钟检查一次」的承诺不成立。 */
const INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/* 近24h 每分钟一点 = 1440。环形缓冲就是这个长度。 */
const RING_LEN = 1440;

/* ── 环形缓冲 ──
 * 每格 {t: 时间戳, ok: 0/1, ms: 延迟}。用定长数组 + 指针，
 * 不做 splice —— 每分钟 splice 一次在长跑下会攒出可观的GC 压力。 */
function newRing() {
  return {
    buf: new Array(RING_LEN),
    /* 指针指向**下一个写入位**。满了就绕回，覆盖最老的。 */
    head: 0,
    len: 0,
  };
}

const rings = new Map(TARGETS.map(t => [t.id, newRing()]));

function ringPush(ring, sample) {
  ring.buf[ring.head] = sample;
  ring.head = (ring.head + 1) % RING_LEN;
  if (ring.len < RING_LEN) ring.len++;
}

/* 环形缓冲读出来是**乱序**的（绕回过），必须按时间排。 */
function ringRead(ring, sinceMs) {
  const out = [];
  for (let i = 0; i < ring.len; i++) {
    const s = ring.buf[i];
    if (!s) continue;
    if (sinceMs && s.t < sinceMs) continue;
    out.push(s);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* ── 单次探测 ──
 * ⚠ 打回环地址。**不用**外部域名：容器出站常被网关限制，
 *   探外部会得到「全红」这种完全误导的结论。 */
async function probe(target, basePort) {
  const t0 = process.hrtime.bigint();
  const url = `http://127.0.0.1:${basePort}${target.path}`;
  let ok = false, status = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      status = r.status;
      /* 3xx 不算故障：干净 URL → index.html 是**设计如此**，
       * 探针若把 302 判成红，等于给自己造一个永远修不好的假故障。 */
      ok = r.status >= 200 && r.status < 400;
      /* 读掉 body 才会真正走完传输路径；不读的话 keep-alive 上
       * 延迟只测到「响应头已发」，数字会好看得不真实。 */
      await r.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    ok = false;
    status = 0;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    t: Date.now(),
    ok: ok ? 1 : 0,
    ms: Math.round(ms),
    status,
  };
}

/* ── 统计 ──
 * 可用率按**采样点**算，不是按时间加权。两者只在探测间隔不均匀时有别，
 * 而我们的间隔是固定的 60s，取样即等价。 */
function summarize(samples) {
  if (!samples.length) return null;
  let good = 0, sumMs = 0;
  for (const s of samples) {
    if (s.ok) { good++; sumMs += s.ms; }
  }
  return {
    n: samples.length,
    up: samples.length ? (good / samples.length) * 100 : 0,
    lastMs: samples[samples.length - 1].ms,
    avgMs: good ? sumMs / good : null,
  };
}

/* ── 探测循环 ──
 * 串行而非并发：9 个目标并发打过去等于给刚启动的服务一记闷棍，
 * 那会让「探测」本身成为故障原因。串行最坏也不到 9×10s，
 * 而周期是 60s，仍有余量。 */
let timer = null;
let lastRunAt = 0;
let running = false;

async function tick(basePort) {
  if (running) return;/* 上一轮还没跑完（慢探测时不叠加） */
  running = true;
  try {
    for (const t of TARGETS) {
      const s = await probe(t, basePort);
      ringPush(rings.get(t.id), s);
    }
    lastRunAt = Date.now();
    /* 有失败才写 DB：健康时不产生任何写入。
     * 状态页数据的价值全在「出过事的时候」——那才有东西可查。 */
    await persistHourly();
  } catch (e) {
    /* 这一层**绝不能抛**：探测器崩了不该把主服务带下去。 */
    console.warn('[status] 探测轮次异常（已忽略）：', e && e.message || e);
  } finally {
    running = false;
  }
}

/* ── 30 天：每小时一行 ──
 * ⚠ 只在「本小时已有失败」或「这是本小时第一次跑」时写，
 *   否则 9 个目标 × 60 次/小时 = 540 次写入/小时，纯烧。
 *   做法：以小时为桶，内存里记住「这个桶写过没有」。
 *   重启会丢这个记忆 → 最多重复写一行，幂等（同桶覆盖），无害。 */
const hourSeen = new Map();

async function persistHourly() {
  if (!WRITE_SECRET) return;
  const hour = Math.floor(Date.now() / 3600_000);
  let dirty = false;
  for (const t of TARGETS) {
    const samples = ringRead(rings.get(t.id));
    if (!samples.length) continue;
    const bad = samples.some(s => !s.ok);
    const key = t.id + ':' + hour;
    if (!bad && hourSeen.get(key)) continue;
    if (!bad && !samples.some(s => s.t >= hour * 3600_000)) continue;
    hourSeen.set(key, true);
    dirty = true;
  }
  if (!dirty) return;

  const rows = TARGETS.map(t => {
    const samples = ringRead(rings.get(t.id), hour * 3600_000);
    const sum = summarize(samples);
    if (!sum) return null;
    return {
      target: t.id,
      hour,
      /* 用该小时内**最后一个**采样点的延迟代表这一小时 */
      ms: sum.lastMs,
      ok: sum.up >= 99.5 ? 1 : 0,
      /* 可用率存百分比的千分比整数，避免浮点往返误差 */
      up_milli: Math.round(sum.up * 1000),
      n: sum.n,
    };
  }).filter(Boolean);
  if (!rows.length) return;

  const r = await dbFetch('/rpc/hm_status_put', {
    method: 'POST',
    body: JSON.stringify({ p_secret: WRITE_SECRET, p_rows: rows }),
  }, 8000, 4096);
  if (!r.ok) {
    /* 降级不报错：没迁移过、或库抖了 → 状态页只剩内存里的近 24h。
     * 这不影响主服务，所以只打一行日志。 */
    if (!hourSeen.get('__warned')) {
      hourSeen.set('__warned', true);
      console.warn('[status] 30 天历史写入失败（降级为仅近 24h）：', r.status);
    }
  }
}

/* 从 DB 取 30 天历史。失败返回空数组而不是抛——
 * 页面照常渲染近 24h，只是 30 天那栏空着。 */
async function loadHistory(sinceMs) {
  if (!WRITE_SECRET) return [];
  const r = await dbFetch('/rpc/hm_status_get', {
    method: 'POST',
    body: JSON.stringify({
      p_secret: WRITE_SECRET,
      p_since: Math.floor(sinceMs / 3600_000),
    }),
  }, 8000, 256 * 1024);
  if (!r.ok) return [];
  try {
    const v = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    return Array.isArray(v) ? v : (v && Array.isArray(v.rows) ? v.rows : []);
  } catch {
    return [];
  }
}

/* ── 对外：生成快照 ──
 * range = '24h' | '30d'，与页面两个按钮一一对应。 */
export async function buildStatusSnapshot(range) {
  const days = range === '30d' ? 30 : 1;
  const since = Date.now() - days * 86400_000;
  /* 内存那一层始终是「近 24h」的最大值，30 天要靠 DB 补。 */
  const memSince = Date.now() - 24 * 3600_000;
  const hist = days > 1 ? await loadHistory(since) : [];

  const byTarget = new Map();
  for (const h of hist) {
    if (!h || !h.target) continue;
    if (!byTarget.has(h.target)) byTarget.set(h.target, []);
    byTarget.get(h.target).push({
      t: (h.hour ?? 0) * 3600_000,
      ok: h.ok ? 1 : 0,
      ms: typeof h.ms === 'number' ? h.ms : null,
    });
  }

  const monitors = TARGETS.map(t => {
    const mem = ringRead(rings.get(t.id), memSince);
    /* 30 天视图 = 内存点 + DB 小时点。⚠ 必须去重合并：
     * 同一小时既在内存里（近 1 小时）又在 DB 里，重复画会鼓包。 */
    let samples;
    if (days > 1 && byTarget.has(t.id)) {
      const seen = new Set();
      samples = mem.concat(byTarget.get(t.id))
        .filter(s => {
          if (s.ms == null) return false;
          const k = Math.floor(s.t / 3600_000);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.t - b.t);
    } else {
      samples = mem;
    }
    const sum = summarize(samples);
    return {
      id: t.id,
      group: t.group,
      label: t.label,
      path: t.path,
      up: sum ? Number(sum.up.toFixed(3)) : null,
      n: sum ? sum.n : 0,
      lastMs: sum ? sum.lastMs : null,
      avgMs: sum && sum.avgMs != null ? Math.round(sum.avgMs) : null,
      series: samples.map(s => [s.t, s.ok, s.ms]),
    };
  });

  /* 总体结论。⚠ **必须看样本数**：没有样本时 `every` 会返回 true，
   * 那样「刚启动、还没探测到」会被报成「全部正常」—— 谎报健康。 */
  const withData = monitors.filter(m => m.up != null && m.n > 0);
  let overall = 'unknown';
  if (withData.length) {
    if (withData.every(m => m.up === 100)) overall = 'operational';
    else if (withData.every(m => m.up >= 99)) overall = 'degraded';
    else overall = 'outage';
  }

  return {
    range: days > 1 ? '30d' : '24h',
    overall,
    updatedAt: lastRunAt || Date.now(),
    intervalMs: INTERVAL_MS,
    targets: TARGETS.length,
    monitors,
  };
}

/* ── 启动 ──
 * ⚠ 立刻跑一轮（不等第一个 60s）：刚部署完就想看到数据。
 *   同时给 server.mjs 一个自监控的「本进程活着吗」信号。 */
export function startStatusMonitor(port) {
  if (timer) return;
  /* 先测一轮再挂定时器，避免启动瞬间的探测与首个请求撞车。 */
  setTimeout(() => {
    tick(port).finally(() => {
      timer = setInterval(() => tick(port), INTERVAL_MS);
      /* unref：这个定时器不该拖住进程退出（测试脚本要能干净地停）。 */
      if (timer.unref) timer.unref();
    });
  }, 1500);
}

/* ── HTTP 处理器 ──
 * 为什么不放server.mjs：那个文件有 900 行上限（lint-slop 第 6 条守着），
 * 而状态页的降级逻辑有十几行，塞进去正好把它顶过线。
 * server.mjs 只留一行 `return statusRoutes(req, res, url)`。
 *
 * ⚠ 做成工厂（而不是直接导出一个函数）是为了拿到 SEC_HEADERS：
 *   全站的安全响应头定义在 server.mjs 里，状态页也得带上 ——
 *   少一个 nosniff 等于给内容嗅探开一扇窗。
 *   跟 makeApiRoutes / makeCodeRoutes 是同一套装配惯例。
 *
 * ⚠ 降级必须回**结构完整**的 JSON，不能回 500 也不能回 undefined：
 *   前端拿到 undefined 会在 .monitors 上崩，一崩整页白屏 ——
 *   而状态页恰恰是「服务已经出问题时」被打开的页面，
 *   那时它最不能崩。回 unknown + 空数组，页面显示「暂无数据」。 */
export function makeStatusRoutes(secHeaders) {
  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      /* 状态数据每分钟才变一次，但探测刚跑完时是最新的 ——
         给 30 秒短缓存，既避免刷一次打一次探测，
         又不至于让人盯着看到过期数据。 */
      'cache-control': 'public, max-age=30',
    }, secHeaders || {}));
    res.end(body);
  };

  return function statusRoutes(req, res, url) {
    const range = url.searchParams.get('range') === '30d' ? '30d' : '24h';
    return buildStatusSnapshot(range)
      .then(d => sendJson(res, 200, d))
      .catch(e => {
        console.warn('[status] 快照失败（降级为空数据）：', e && e.message || e);
        sendJson(res, 200, {
          range, overall: 'unknown', updatedAt: Date.now(),
          intervalMs: INTERVAL_MS, targets: 0, monitors: [],
        });
      });
  };
}

/* 测试缝：停止循环。生产代码不调。 */
export function _stop() {
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
}

/* 测试缝：直接灌入样本，避免单测去真发HTTP。 */
export function _inject(targetId, sample) {
  const r = rings.get(targetId);
  if (r) ringPush(r, sample);
}

/* 测试缝：把环形缓冲读出来（排序后）。 */
export function _read(targetId, sinceMs) {
  const r = rings.get(targetId);
  return r ? ringRead(r, sinceMs) : [];
}

/* 测试缝：清空全部样本。
 * ⚠ 没有它的话，各组断言的样本会**累积进同一个环形缓冲** ——
 *   「10 绿 + 1 坏 = 90%」在上一组已经灌过 10 个绿时会算成 90.9%，
 *   测试就会因为自己的记账错误而红。生产代码不调。 */
export function _reset() {
  for (const r of rings.values()) {
    r.buf = new Array(RING_LEN);
    r.head = 0;
    r.len = 0;
  }
  lastRunAt = 0;
}