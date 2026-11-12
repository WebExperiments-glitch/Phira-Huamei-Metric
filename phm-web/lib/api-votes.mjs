/* lib/api-votes.mjs —— 人类难度标注（投票）
 *
 * 三个端点：
 *   GET  /votes/next?lo=&hi=   抽一张你没投过的谱
 *   POST /votes                投一票（可改）
 *   GET  /votes/today          今日进度
 *
 * 【为什么要「打不过」这个选项】
 *   用户抽到一张远超自己水平的谱，真实反应是关掉页面。
 *   如果不把这个行为收成数据，结果就是**难谱永远没票、样本严重偏向简单谱**。
 *   「我打不过」和「我觉得 16.0」一样是判断，而且更难伪造。
 *
 * 【为什么不强制注册】
 *   投票要的是量。让用户先注册再投票，等于没人投。
 *   主体用 cid:<浏览器UUID>（与查询历史同一套），绑账号后自然合并。
 */
export function makeVoteRoutes(deps) {
  const { requireScope, gateApi, callApiRpc, logUsage, apiErr, json, readBody } = deps;

  const rpcJson = (r) => { try { return JSON.parse(r && r.body) || {}; } catch { return {}; } };

  const cidOf = (req) => {
    const raw = String((req.headers && req.headers['x-phm-cid']) || '').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return 'cid:' + raw.toLowerCase();
    }
    return '';
  };

  return async function handleVotes(req, res, who, ip, p, qp) {
    const subject = (who && who.kind === 'account' && who.id ? 'acct:' + who.id : '') || cidOf(req);

    if (req.method === 'GET' && p === '/votes/next') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip))) return true;
      if (!subject) { json(res, 200, { ok: true, item: null, reason: 'no_subject' }); return true; }

      const lo = Number(qp.get('lo')) || 8;
      const hi = Number(qp.get('hi')) || 18;
      const band = Number(qp.get('band')) || null;
      const t0 = Date.now();
      const r = await callApiRpc('hm_vote_pick', { p_subject: subject, p_lo: lo, p_hi: hi, p_band: band });
      logUsage(who, '/votes/next', r && r.ok ? 200 : 502, null, t0);
      if (!r || !r.ok) { apiErr(res, 502, 'server_error', 'pick_failed', 'could not pick a chart'); return true; }
      const item = rpcJson(r);
      json(res, 200, { ok: true, item: (item && item.chart_id) ? item : null });
      return true;
    }

    if (req.method === 'GET' && p === '/votes/today') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip))) return true;
      if (!subject) { json(res, 200, { ok: true, today: 0 }); return true; }
      const r = await callApiRpc('hm_vote_today', { p_subject: subject });
      json(res, 200, { ok: true, today: rpcJson(r).today || 0 });
      return true;
    }

    if (req.method === 'POST' && p === '/votes') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip, { endpoint: '/votes' }))) return true;
      if (!subject) { json(res, 200, { ok: false, reason: 'no_subject' }); return true; }

      const body = await readBody(req, 2 * 1024);
      const chartId = Number((body && body.chart_id) || 0);
      if (!chartId || chartId < 1) {
        apiErr(res, 400, 'invalid_request_error', 'bad_chart_id', 'chart_id must be a positive integer');
        return true;
      }
      const verdict = String((body && body.verdict) || 'rated');
      const value = body && body.value != null ? Number(body.value) : null;
      if (verdict === 'rated' && (!Number.isFinite(value) || value < 1 || value > 25)) {
        apiErr(res, 400, 'invalid_request_error', 'bad_value', 'value must be between 1 and 25');
        return true;
      }
      const t0 = Date.now();
      const r = await callApiRpc('hm_vote_put', {
        p_subject: subject,
        p_chart_id: chartId,
        p_verdict: verdict,
        p_value: verdict === 'rated' ? value : null,
        p_played: !!(body && body.played),
        p_band: body && body.band != null ? Number(body.band) : null,
      });
      logUsage(who, '/votes', r && r.ok ? 200 : 502, null, t0);
      if (!r || !r.ok) { apiErr(res, 502, 'server_error', 'vote_failed', 'could not record vote'); return true; }
      json(res, 200, rpcJson(r));
      return true;
    }

    return false;
  };
}
