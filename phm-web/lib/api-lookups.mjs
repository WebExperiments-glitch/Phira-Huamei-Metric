/* lib/api-lookups.mjs —— 查询历史（留存的地基）
 *
 * 用户查完一张谱就关掉，没有回来的理由。有了历史，下次能看到
 * 「你查过这些」+「这张的参考定数变了 0.12」—— 后者才是回访钩子。
 *
 * 主体：acct:<账号id>，否则 cid:<浏览器UUID>（localStorage 的 phm_cid）。
 * ⚠ 匿名主体由前端上报、可伪造，但能看到的只是公开的 chart_id，危害有限；
 *   账号路径由服务端从 token 派生，不可伪造。
 *
 * 不做防抖：同一张谱反复查是信号（times），不是噪音。
 */

const MAX_SUBJECT_LEN = 64;
const CID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* 把请求方归一成一个 subject。返回 null 表示"没法识别，不记录"。 */
export function lookupSubjectOf(who, rawCid) {
  if (who && who.kind === 'account' && who.id) return 'acct:' + String(who.id).slice(0, MAX_SUBJECT_LEN);
  if (who && who.kind === 'key' && who.keyId) return 'key:' + String(who.keyId).slice(0, MAX_SUBJECT_LEN);
  const cid = String(rawCid || '').trim();
  /* 只接受标准 UUID —— 别让任意字符串变成 subject，否则等于开放任意写 */
  if (CID_RE.test(cid)) return 'cid:' + cid.toLowerCase();
  return null;
}

/**
 * @param {object} deps 由 api-routes 注入
 */
export function makeLookupRoutes(deps) {
  const { requireScope, gateApi, callApiRpc, logUsage, apiErr, json, readBody } = deps;

  /* ⚠ 不要从 api-routes 注入"解析 RPC 返回值"的工具 —— 那个函数是 api-admin.mjs
     的**私有函数**，api-routes 里根本没有。第一版就是注入了它，导致
     `ReferenceError: readRpcJson is not defined`，整个服务起不来（线上挂了几分钟）。
     这里自己写三行，不欠别人的。 */
  const rpcJson = (r) => { try { return JSON.parse(r && r.body) || {}; } catch { return {}; } };

  const rpc = async (name, args) => {
    const r = await callApiRpc(name, args);
    return { ok: r && r.ok, j: rpcJson(r) };
  };

  /* 从请求里取 cid：header 优先，其次 query */
  const cidOf = (req) => String(
    (req.headers && (req.headers['x-phm-cid'] || req.headers['x-phm-cid'.toLowerCase()]))
    || (() => { try { return new URL(req.url, 'http://x').searchParams.get('cid') || ''; } catch { return ''; } })(),
  ).trim();

  return async function handleLookup(req, res, who, ip, p, qp) {
    const subject = lookupSubjectOf(who, cidOf(req));

    /* ── GET /lookups —— 列最近查过的谱 ── */
    if (req.method === 'GET' && p === '/lookups') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip))) return true;
      if (!subject) { json(res, 200, { ok: true, count: 0, items: [], reason: 'no_subject' }); return true; }

      const t0 = Date.now();
      const limit = Math.min(Math.max(Number(qp.get('limit')) || 30, 1), 100);
      const { ok, j } = await rpc('hm_lookup_list', { p_subject: subject, p_limit: limit });
      logUsage(who, '/lookups', ok ? 200 : 502, null, t0);
      if (!ok) { apiErr(res, 502, 'server_error', 'lookups_unavailable', 'history temporarily unavailable'); return true; }
      json(res, 200, { ok: true, count: j.count || 0, items: j.items || [] });
      return true;
    }

    /* ── POST /lookups —— 记一次查询（前端在打开谱面详情时调用）── */
    if (req.method === 'POST' && p === '/lookups') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip, { endpoint: '/lookups' }))) return true;
      if (!subject) { json(res, 200, { ok: true, recorded: false, reason: 'no_subject' }); return true; }

      const body = await readBody(req, 2 * 1024);
      const chartId = Number((body && body.chart_id) || 0);
      if (!chartId || chartId < 1) {
        apiErr(res, 400, 'invalid_request_error', 'bad_chart_id', 'chart_id must be a positive integer');
        return true;
      }
      const t0 = Date.now();
      const { ok, j } = await rpc('hm_lookup_touch', { p_subject: subject, p_chart_id: chartId });
      logUsage(who, '/lookups', ok ? 200 : 502, null, t0);
      if (!ok) { apiErr(res, 502, 'server_error', 'lookup_write_failed', 'could not record'); return true; }
      /* prev_ref 让前端能立刻提示「你上次看到的是 15.30，现在是 15.42」 */
      json(res, 200, { ok: true, recorded: true, times: j.times || 1, prev_ref: j.prev_ref ?? null });
      return true;
    }

    /* ── DELETE /lookups —— 用户权利：清空自己的历史 ── */
    if (req.method === 'DELETE' && p === '/lookups') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip, { endpoint: '/lookups' }))) return true;
      if (!subject) { json(res, 200, { ok: true, deleted: 0 }); return true; }

      const t0 = Date.now();
      const { ok, j } = await rpc('hm_lookup_clear', { p_subject: subject });
      logUsage(who, '/lookups', ok ? 200 : 502, null, t0);
      if (!ok) { apiErr(res, 502, 'server_error', 'lookup_clear_failed', 'could not clear'); return true; }
      json(res, 200, { ok: true, deleted: j.deleted || 0 });
      return true;
    }

    return false;   /* 不归我管 */
  };
}
