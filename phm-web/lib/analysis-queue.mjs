/* ============================================================
 * lib/analysis-queue.mjs —— 谱面分析的后台队列
 * ============================================================
 * 【为什么必须异步】
 *   一次分析要下载谱面 + 算特征 + 跑模型，实测 20~40 秒。
 *   而部署平台的网关约 30 秒超时 —— 同步等就是 **504**
 *   （成绩上传踩过同一个坑，见 lib/hm-queue.mjs 顶部）。
 *   所以：校验通过 → 入队 → **立刻 202** → worker 慢慢算 → 客户端轮询结果。
 *
 * 【为什么要去重】
 *   一张热门谱可能被几十个人同时点「查定数」。不去重就是几十次
 *   完全相同的 20~40 秒计算 —— 既浪费 CPU，又会让队列排在后面的人饿死。
 *   `inflight` 以 chart_id 为键：同一张谱在算的时候，后来的请求直接返回
 *   `dedup: true`，不重复排队。
 *
 * 【为什么并发 1】
 *   分析是纯 CPU 的重活，Node 单线程。开 2 个只会让两个都变慢，
 *   还会把同进程里的普通请求拖住（事件循环被特征计算占满）。
 *   排队慢一点，比整站卡顿好。
 *
 * 【诚意说明代价】
 *   内存队列 = 进程重启就丢。丢的后果很轻：客户端轮询拿不到结果，
 *   下次再点一次就是了 —— 不像成绩丢一条就少一条。
 * ============================================================ */

const QUEUE_MAX = 64;          // 积压上限，超了让调用方稍后重试
/* 匿名每日上限。**默认 0 = 不限次**（2026-11-16 用户决定）：
   游戏端本来就在给我们供数据，再按天卡它没有道理。
   护栏改为「每一次都要过服务器校验」（PoW 一次性核销）+ 队列拥塞保护，
   而不是「今天用完明天再来」。
   ⚠ 想临时收紧可以用 PHM_ANON_ANALYSIS_DAILY=20 之类，不必改代码。 */
const ANON_DAILY = Math.max(0, Number(process.env.PHM_ANON_ANALYSIS_DAILY) || 0);
const DAY_MS = 86_400_000;

export function createAnalysisQueue({ recompute, dbPutChart, limit, log = console }) {
  /** @type {Set<number>} 正在算或排队中的 chart_id（去重靠它） */
  const inflight = new Set();
  /** @type {number[]} 待算的 chart_id，FIFO */
  const pending = [];
  const stats = { queued: 0, done: 0, failed: 0, deduped: 0, lastError: null };
  let busy = false;

  async function runOne(chartId) {
    try {
      const trusted = await recompute(chartId);
      /* 写缓存失败不影响「算出来了」这件事本身，但要记下来：
         下一次请求会重新走一遍，否则就是「每次都在算、永远查不到」。 */
      const wr = await dbPutChart(trusted).catch((e) => ({ ok: false, detail: e && e.message }));
      if (!wr || !wr.ok) {
        stats.lastError = 'cacheWrite: ' + String((wr && wr.detail) || '').slice(0, 120);
        log.warn('[analysis-queue] 缓存写入失败 chart=' + chartId + ': ' + stats.lastError);
      }
      stats.done++;
    } catch (e) {
      stats.failed++;
      stats.lastError = String(e && e.message || e).slice(0, 200);
      log.warn('[analysis-queue] 分析失败 chart=' + chartId + ': ' + stats.lastError);
    } finally {
      inflight.delete(chartId);
    }
  }

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (pending.length) {
        await runOne(pending.shift());
      }
    } finally {
      busy = false;
      /* 退出前若有新任务进来（kick 时 busy 还是 true 会直接 return），补一次 */
      if (pending.length) drain();
    }
  }

  /** 提交一张谱。返回 `{ok, dedup}`；积压满返回 `{ok:false}`。 */
  function requestAnalysis(chartId) {
    if (inflight.has(chartId)) {
      stats.deduped++;
      return { ok: true, dedup: true };
    }
    if (inflight.size >= QUEUE_MAX) return { ok: false, dedup: false };
    inflight.add(chartId);
    pending.push(chartId);
    stats.queued++;
    drain();
    return { ok: true, dedup: false };
  }

  /**
   * 匿名按 IP 的日配额。用数据库原子计数（`hm_rate_hit`），
   * 不用进程内计数 —— 无状态托管下每个请求可能落到新进程，内存计数等于没数。
   * failClosed: 库不通时**拒绝**。这里必须 fail-closed：放行等于把
   * 20~40 秒的 CPU 免费送出去，而这正是配额要防的东西。
   */
  async function anonQuota(ip) {
    if (ANON_DAILY <= 0) return { ok: true, remaining: -1, unlimited: true };
    const r = await limit([{ k: 'apow:' + String(ip || 'unknown'), max: ANON_DAILY }], ANON_DAILY, DAY_MS, { failClosed: true });
    return { ok: r.ok, remaining: r.remaining, resetMs: r.resetMs, unlimited: false };
  }

  return {
    requestAnalysis,
    anonQuota,
    stats: () => Object.assign({}, stats, { pending: pending.length, busy, cap: QUEUE_MAX, anonDaily: ANON_DAILY }),
  };
}
