/* 成绩上传的异步队列。
 *
 * 【要解决什么】
 *   Neon 免费档空闲 5 分钟把 compute 缩到零，下一个请求要等 10~13 秒唤醒。
 *   玩家打完一局才上传一次，中间隔几分钟不打 —— 正好每次都撞上冷启动，
 *   叠上 30s 连接超时就是网关 504（2026-11-15 真机复现，stgw 返回的 HTML）。
 *
 *   客户端不该为「数据库在睡觉」这件事付出代价。所以：
 *     收到请求 → 校验（纯计算）→ 入队 → **立刻返回 202**
 *                                ↓
 *                        后台 worker 慢慢写，失败重试
 *
 * 【为什么不落 SQLite】
 *   托管平台的项目目录不保证持久（重新部署会重置）。写本地文件等于给自己
 *   一个「看起来持久其实不持久」的假象，比诚实的内存队列更危险。
 *
 * 【诚实地说清楚代价】
 *   内存队列 = 进程重启就没了。丢数据的窗口是「入队 → 落库」这段，
 *   正常情况毫秒级。缓解靠两件事：
 *     1. 客户端收到 202 才认为提交成功，本地记录不删 —— 服务端丢了它能重传
 *     2. 服务端按 (chart_id, played_at, score) 幂等去重 —— 重传不会插两条
 *   第 2 条是关键，它让「丢了重传」变成安全操作。
 *
 * 【为什么上限 2000 而不是无界】
 *   DB 长时间写不进去时，无界队列会吃光内存把进程搞死（OOM 比丢几条数据糟得多）。
 *   满了就返回 503 —— 让客户端知道「现在不行，等会儿重试」，
 *   这比「假装收了然后悄悄丢」诚实。
 */

import { randomUUID } from 'node:crypto';

/* ── 队列本体 ───────────────────────────────────────────── */
const QUEUE_MAX = 2000;
/** @type {{ id: string, row: object, tries: number, nextAt: number, enqueuedAt: number }[]} */
const queue = [];

/* 统计，用于 /api/hm/queue-stats */
const stats = {
  received: 0,   // 累计入队
  written: 0,    // 累计成功落库
  dropped: 0,    // 重试耗尽被丢弃
  lastError: null,
};

let running = false;
/** @type {null | ((row: object) => Promise<any>) } */
let writer = null;

/* ── chart_plays：按 digest 归并的本谱累计局数 ───────────────
   客户端结算页要显示「本谱累计第 N 局」，靠 /api/hm/play 的响应带回去。

   ⚠ 绝不能在响应路径同步查库 —— 那会把刚用队列修好的 504 带回来
     （Neon 空闲缩零 → 唤醒 10~13s → 30s 超时 → stgw 504）。
   所以走内存：
     · 启动时从 hm_plays 预热一次**基线**（只写 baseline，不碰 delta）
     · enqueue 成功即 delta +1（本局算进去，不管 worker 什么时候写）
     · 重试耗尽被丢弃时 delta -1（回滚，避免虚高）
     · 进程重启后重新预热；队列里丢的局由客户端重传补回（幂等去重兜底）

   为什么分 baseline / delta 两层：预热是异步的，若第一个请求在预热完成前
   入队，直接写同一个 Map 会被随后完成的预热覆盖 —— 分成两层就不会。 */
const baseline = new Map();   // digest -> 已落库局数（启动快照）
const delta = new Map();      // digest -> 本进程入队净增
let chartFetch = null;

async function prewarmChartPlays() {
  if (!chartFetch) return;
  try {
    const r = await chartFetch('/hm_plays?select=chart_digest&limit=100000', undefined, 30000, 8 * 1024 * 1024);
    if (!r.ok) {
      console.warn('[hm-queue] chart_plays 预热失败（显示从本局起算）：' + r.status);
      return;
    }
    for (const row of JSON.parse(r.body)) {
      const d = row.chart_digest;
      if (d) baseline.set(d, (baseline.get(d) || 0) + 1);
    }
  } catch (e) {
    console.warn('[hm-queue] chart_plays 预热异常：' + e.message);
  }
}

/**
 * 生成响应里要展开的字段：无 digest 时返回空对象（客户端 serde(default) 自动不显示），
 * 有则返回 `{ chart_plays: N }`，N 含本局。
 * 返回对象而非数字，是为了 server.mjs 只加一行展开就能用（它有 900 行硬上限）。
 */
export function chartPlaysField(digest) {
  if (!digest) return {};
  return { chart_plays: (baseline.get(digest) || 0) + (delta.get(digest) || 0) };
}

/**
 * 由 server.mjs 在启动时调用，把「怎么连数据库」这件事交进来。
 *
 * 为什么带实现而不是只收一个函数：这段逻辑（RPC 名、超时、错误格式）
 * 属于写库契约的一部分，放在 server.mjs 里会让那个文件过 900 行上限。
 * 队列拿到 dbFetch 与 secret，写库细节自己管。
 *
 * @param {(path: string, init: object, timeoutMs?: number, maxBody?: number) => Promise<{ok: boolean, status?: number, body?: string, error?: string}>} dbFetch
 * @param {string} writeSecret
 */
export function initWriter(dbFetch, writeSecret) {
  chartFetch = dbFetch;
  prewarmChartPlays();
  writer = async (row) => {
    const r = await dbFetch('/rpc/hm_put_play_dedup', {
      method: 'POST',
      body: JSON.stringify({ p_secret: writeSecret, p_row: row }),
    }, 25_000, 4096);
    if (!r.ok) {
      /* 抛出去让队列重试。message 带状态与响应片段，落在 stats.lastError 里。 */
      throw new Error('hm_put_play_dedup ' + (r.status || '') + ' ' + String(r.body || r.error || '').slice(0, 120));
    }
    return r;
  };
}

/** 入队。返回临时 id；队列满返回 null。 */
export function enqueue(row) {
  if (queue.length >= QUEUE_MAX) {
    stats.lastError = 'queue_full';
    return null;
  }
  const id = randomUUID();
  stats.received++;
  /* 入队即计数：本局进响应，不必等 worker 落库。按 digest 归并，无 digest 不计。 */
  const d = row.chart_digest;
  if (d) delta.set(d, (delta.get(d) || 0) + 1);
  queue.push({ id, row, tries: 0, nextAt: 0, enqueuedAt: Date.now() });
  kick();
  return id;
}

export function getStats() {
  return { ...stats, pending: queue.length, capacity: QUEUE_MAX };
}

/* ── worker ─────────────────────────────────────────────── */

/* 重试间隔：1s, 2s, 4s, 8s, 16s —— 最多 5 次。
   为什么不用更长：一条成绩等 30 秒还没写进去，多半不是瞬时抖动，
   继续拖着只是占内存。丢给客户端重传更干净（它有幂等保护）。 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_TRIES = BACKOFF_MS.length;

function kick() {
  if (running) return;
  running = true;
  /* setImmediate：不阻塞当前请求的响应。接完 202 再说。 */
  setImmediate(drainQueue);
}

async function drainQueue() {
  try {
    while (queue.length > 0) {
      const now = Date.now();
      const head = queue[0];
      if (head.nextAt > now) {
        /* 队首还在退避期，等它到点。用 setTimeout 而不是忙等。 */
        await new Promise(r => setTimeout(r, Math.min(head.nextAt - now, 2000)));
        continue;
      }
      if (!writer) {
        /* 还没注入写库函数 —— 不该发生（server 启动时会设），
           但真发生了就原地等，不要静默丢数据。 */
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      queue.shift();
      try {
        await writer(head.row);
        stats.written++;
      } catch (e) {
        head.tries++;
        const msg = e && e.message ? e.message : String(e);
        stats.lastError = msg.slice(0, 200);
        if (head.tries >= MAX_TRIES) {
          stats.dropped++;
          /* 丢弃的局不能留在累计里 —— 回滚 delta，否则显示虚高且永远不对。 */
          const d = head.row.chart_digest;
          if (d) delta.set(d, Math.max(0, (delta.get(d) || 0) - 1));
          /* 只记一行，不抛 —— 队列里还有别的数据等着写。 */
          console.error('[hm-queue] 重试 %d 次仍失败，丢弃 play_id=%s: %s', MAX_TRIES, head.id, msg);
        } else {
          head.nextAt = Date.now() + BACKOFF_MS[head.tries - 1];
          queue.unshift(head);   // 放回队首，保持顺序
        }
      }
    }
  } finally {
    running = false;
    /* 退出前如果又有新数据进来（kick 时 running 还是 true 会直接 return），
       这里补一次，避免「最后一条没人处理」。 */
    if (queue.length > 0) kick();
  }
}
