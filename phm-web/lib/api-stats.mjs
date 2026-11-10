/* ============================================================
 * lib/api-stats.mjs —— GET /stats 的处理
 * ============================================================
 * 【为什么单独一个文件】
 *   api-routes.mjs 已经到 900 行上限。拆它不能靠"压注释"，
 *   要按职责切：全站统计是一个独立能力（查库 + 缓存 + 错误兜底），
 *   和路由分发没关系。
 *
 * 【为什么做成工厂函数】
 *   它要用 requireScope / gateApi / dbFetch / logUsage 这些 api-routes
 *   的闭包。与其把它们变成全局，不如显式注入 —— 依赖一眼可见，
 *   也方便单测时替换。
 * ============================================================ */

/**
 * @param {object} deps 由 api-routes 注入的依赖
 * @returns {(req:any,res:any,who:any,ip:string)=>Promise<void>}
 */
export function makeStatsHandler(deps) {
  const { requireScope, gateApi, dbFetch, logUsage, apiErr, json, withCache } = deps;

  return async function handleStats(req, res, who, ip) {
    if (!requireScope(res, who, 'charts:read')) return;
    if (!(await gateApi(res, who, ip))) return;

    const t0 = Date.now();
    const url = String((res && res.req && res.req.url) || '');
    let out = { data: null, hit: false, cached: false };

    try {
      /* 缓存 60 秒：全站统计是全站共享的，一分钟内变化没人会察觉，
         而每查一次库要付 ~190ms 的跨境往返（DB 在 AWS 新加坡）。 */
      out = await withCache(url, '/stats', async () => {
        const r = await dbFetch('/rpc/phm_stats', { method: 'POST', body: '{}' });
        if (!r.ok) throw new Error('upstream ' + r.status);
        return JSON.parse(r.body);
      });
    } catch (e) {
      /* 查库失败或 JSON 解析失败都走到这里 —— 统一按"统计暂不可用"返回，
         不要让异常冒到外层变成 500（前端只需要知道"现在没数据"）。 */
      out = { data: null, hit: false, cached: false };
    }

    if (out.cached) res.setHeader('x-cache', out.hit ? 'hit' : 'miss');
    const ok = out.data != null;
    logUsage(who, '/stats', ok ? 200 : 502, null, t0);
    if (!ok) {
      return apiErr(res, 502, 'server_error', 'stats_unavailable', 'statistics temporarily unavailable');
    }
    return json(res, 200, out.data);
  };
}
