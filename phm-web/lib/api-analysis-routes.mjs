/* ============================================================
 * lib/api-analysis-routes.mjs —— 分析相关的两个端点
 * ============================================================
 *   POST /api/v1/analyses   触发分析（持 Key 同步；匿名凭 PoW 换，走后台队列）
 *   GET  /api/v1/pow        领一道「分析用途」的 PoW 挑战
 *
 * 【为什么单独一个模块】
 *   `api-routes.mjs` 撞到 900 行上限（lint-slop）。这不是第一次 ——
 *   `makeLookupRoutes` / `makeVoteRoutes` / `api-stats.mjs` 都是同一个原因拆出去的。
 *
 * 【两条路径的语义差别（不要合并）】
 *   持 Key：同步返回结果，20~40 秒也等 —— 调用方是脚本/服务端，能等。
 *   匿名：**立刻 202**，后台算 —— 调用方是游戏客户端，网关 30 秒就断，
 *         同步等必 504（成绩上传踩过同一个坑，见 lib/hm-queue.mjs 顶部）。
 * ============================================================ */

export function makeAnalysisRoutes(deps) {
  const {
    readBody, dbFetch, dbPutChart, recompute, requireScope, gateApi,
    apiErr, json, logUsage, formatRow, formatReport, tryEnter, leave,
    analysisQueue, issueAnalysisChallenge,
  } = deps;

  async function handleAnalyses(req, res, who, ip) {
    const body = await readBody(req, 16 * 1024);
    const id = Number(body && body.chart_id);
    if (!Number.isInteger(id) || id < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_chart_id', 'chart_id must be a positive integer');
    }
    if (!requireScope(res, who, 'analyses:write')) return;

    const t0 = Date.now();
    /* ⚠ 缓存检查必须在 PoW 之前。
       否则客户端为了查一张**早就缓存好**的谱，要先白解一道 20 bit 的题 ——
       既浪费玩家 1~3 秒，也把「已缓存不消耗」这句话变成假的。
       命中时按普通读放行（仍走限流，但不需要 `analysis` 那一档）。 */
    const ex = await dbFetch('/phm_charts?chart_id=eq.' + id + '&select=*');
    const hit = ex.ok && ex.body && ex.body !== '[]';
    if (!(await gateApi(res, who, ip, {
      analysis: !hit, endpoint: '/analyses', bodyText: JSON.stringify(body || {}),
    }))) return;
    if (hit) {
      const row = JSON.parse(ex.body)[0];
      logUsage(who, '/analyses', 200, id, t0);
      return json(res, 200, formatRow(row));
    }

    /* ── 匿名（算对 PoW 换来的）：入队 + 202 ── */
    if (who.kind !== 'key') {
      const q = await analysisQueue.anonQuota(ip);
      if (!q.ok) {
        return apiErr(res, 429, 'rate_limit_error', 'analysis_quota_exceeded',
          'anonymous analysis daily quota reached; retry tomorrow or supply an API key');
      }
      const e = analysisQueue.requestAnalysis(id);
      if (!e.ok) {
        return apiErr(res, 503, 'server_error', 'analysis_busy',
          'analysis queue is full; retry shortly', { 'retry-after': '5' });
      }
      return json(res, 202, {
        chart_id: id, queued: true, dedup: e.dedup,
        poll: '/api/v1/charts/' + id,
        note: 'analysis runs in the background; poll the poll URL until analyzed is true',
        /* 默认不限次，此时不返回这个字段 —— 回一个 -1 会让客户端以为"还剩 -1 次" */
        ...(q.unlimited ? {} : { quota_remaining: q.remaining }),
      });
    }

    /* ── 持 Key：保持原样，同步等结果 ── */
    if (!tryEnter('api-analyze', 2)) {
      return apiErr(res, 503, 'server_error', 'analysis_busy', 'analysis is busy; retry shortly', { 'retry-after': '3' });
    }
    let trusted;
    try {
      trusted = await recompute(id);
    } catch (e) {
      /* ⚠ 不要把异常原文回给调用方（2026-10-24 审计）：里面可能带上游主机名、
         文件路径、甚至凭据片段。细节只写服务端日志，对外给稳定错误码。 */
      console.warn('[phm] recompute failed chart=' + id + ': ' + String(e && (e.stack || e.message) || e));
      return apiErr(res, 502, 'server_error', 'analysis_failed',
        'analysis failed; the chart may be unavailable upstream');
    } finally {
      leave('api-analyze');
    }
    let cacheWrite = { ok: true };
    try {
      const wr = await dbPutChart(trusted);
      if (!wr.ok) cacheWrite = { ok: false, detail: String(wr.fail && wr.fail[0] || '').slice(0, 120) };
    } catch (e) {
      cacheWrite = { ok: false, detail: String(e.message || e).slice(0, 120) };
    }
    logUsage(who, '/analyses', 200, id, t0);
    return json(res, 200, Object.assign(formatReport(trusted), { cacheWrite }));
  }

  /**
   * 主动领一道「分析用途」的挑战。
   * 没有它，PoW 只能被动拦人（428），客户端没法「我要做一次分析，给我道题」。
   * GET 而不是 POST：签发可重复、无副作用，客户端也好实现。
   */
  async function handlePow(req, res, who, ip) {
    if (!requireScope(res, who, 'analyses:write')) return;
    if (!(await gateApi(res, who, ip, { endpoint: '/pow' }))) return;
    return json(res, 200, issueAnalysisChallenge(req, who, ip));
  }

  return { handleAnalyses, handlePow };
}
