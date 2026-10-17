/* ============================================================
 * lib/api-routes.mjs —— P.H.M. API v1
 * ============================================================
 * 形态对齐 DeepSeek / OpenAI：
 *   base_url  https://phm.app.workbuddy.host/api/v1
 *   auth      Authorization: Bearer sk-<32 hex>
 *
 * 路由：/charts/{id} · /analyses · /usage · /keys · /openapi.json
 * 认证：匿名（100/小时）或 API Key（1000/小时；分析 200/天）
 * 额度与用量都走 lib/ratelimit.mjs + hm_* RPC；本模块只做编排。
 * ============================================================ */
import {
  limit, buildKeys, tryEnter, leave, rlHeaders, RL,
} from './ratelimit.mjs';
import { generateApiKey, hashApiKey } from './api-keys.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-hm-token',
  'access-control-max-age': '86400',
};

function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }, CORS, extra || {}));
  res.end(body);
}

function apiErr(res, status, type, code, message, extra) {
  return json(res, status, { error: { type, code, message } }, extra);
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}

function accountToken(req) {
  const custom = String(req.headers['x-hm-token'] || '').trim();
  if (custom) return custom;
  const b = bearer(req);
  return b && !b.startsWith('sk-') ? b : '';
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function formatRow(r) {
  return {
    chart_id: r.chart_id, name: r.name, level: r.level,
    difficulty: r.difficulty, ref_const: r.ref_const, ref_official: r.ref_official,
    ps_score: r.ps_score, nps: r.nps, hold_ratio: r.hold_ratio, notes: r.notes,
    stair_avg: r.stair_avg, speed_peak: r.speed_peak,
    engine_ver: r.engine_ver, engine_build: r.engine_build,
    analyzed: true, cached: true,
  };
}

function formatReport(r) {
  return {
    chart_id: r.chart_id, name: r.name, level: r.level,
    difficulty: r.difficulty, ref_const: r.ref_const, ref_official: r.ref_official,
    ps_score: r.ps_score, nps: r.nps, hold_ratio: r.hold_ratio, notes: r.notes,
    stair_avg: r.stair_avg, speed_peak: r.speed_peak,
    engine_ver: r.engine_ver, engine_build: r.engine_build,
    analyzed: true, cached: false,
  };
}

export function makeApiRoutes(deps) {
  const {
    send, readBody, dbFetch, dbPutChart, recompute, hmWhoami,
    writeSecret, engineVer,
  } = deps;

  async function callApiRpc(name, args) {
    return dbFetch('/rpc/' + name, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ p_secret: writeSecret }, args)),
    }, 15000, 65536);
  }

  async function identify(req) {
    const key = bearer(req);
    if (!key) return { kind: 'anon' };
    if (!/^sk-[0-9a-f]{32}$/.test(key)) return { error: 'invalid_api_key' };
    const hash = hashApiKey(key);
    const r = await callApiRpc('hm_api_key_lookup', { p_hash: hash });
    if (!r.ok) return { error: 'key_lookup_failed' };
    let j;
    try { j = JSON.parse(r.body); } catch { return { error: 'key_lookup_failed' }; }
    if (!j || !j.ok) return { error: 'invalid_api_key' };
    if (j.revoked) return { error: 'revoked_api_key' };
    return { kind: 'key', id: j.id, ownerId: j.owner_id || null, hash };
  }

  async function gateApi(res, who, ip, { analysis = false } = {}) {
    let r;
    if (who.kind === 'key') {
      r = await limit([{ k: 'api:k:' + who.id, max: RL.apiKeyHour }],
        RL.apiKeyHour, HOUR, { failClosed: true });
      if (r.ok && analysis) {
        const a = await limit([{ k: 'api:analyze:' + who.id, max: RL.apiAnalyzeDay }],
          RL.apiAnalyzeDay, DAY, { failClosed: true });
        if (!a.ok) r = a;
      }
    } else {
      r = await limit(
        buildKeys('api', { ip }, { perIp: RL.apiAnonHour, perId: RL.apiAnonHour, global: RL.apiAnonGlobal }),
        RL.apiAnonHour, HOUR, {});
    }
    if (r.ok) return true;
    if (r.via === 'db-down') {
      apiErr(res, 503, 'server_error', 'rate_limit_unavailable',
        'rate limiter temporarily unavailable', { 'retry-after': '5' });
    } else {
      apiErr(res, 429, 'rate_limit_error', 'rate_limit_exceeded',
        'too many requests; retry later', rlHeaders(r));
    }
    return false;
  }

  function logUsage(who, endpoint, status, chartId, startMs) {
    if (!who || who.kind !== 'key') return;
    const ms = Date.now() - startMs;
    callApiRpc('hm_api_usage_log', {
      p_key_id: who.id, p_endpoint: endpoint, p_status: status,
      p_chart_id: chartId == null ? null : Number(chartId), p_duration_ms: ms,
    }).catch(() => {});
  }

  async function handleCharts(req, res, who, ip, idStr) {
    const id = Number(idStr);
    if (!Number.isInteger(id) || id < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_chart_id', 'chart_id must be a positive integer');
    }
    if (!(await gateApi(res, who, ip))) return;
    const t0 = Date.now();
    const r = await dbFetch('/phm_charts?chart_id=eq.' + id + '&select=*');
    if (!r.ok) return apiErr(res, 502, 'server_error', 'cache_unavailable', 'cache temporarily unavailable');
    let rows = [];
    try { rows = JSON.parse(r.body); } catch { /* 保底 */ }
    if (!Array.isArray(rows) || !rows.length) {
      logUsage(who, '/charts', 200, id, t0);
      return json(res, 200, { chart_id: id, analyzed: false, cached: false });
    }
    logUsage(who, '/charts', 200, id, t0);
    return json(res, 200, formatRow(rows[0]));
  }

  async function handleAnalyses(req, res, who, ip) {
    const body = await readBody(req, 16 * 1024);
    const id = Number(body && body.chart_id);
    if (!Number.isInteger(id) || id < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_chart_id', 'chart_id must be a positive integer');
    }
    if (!(await gateApi(res, who, ip, { analysis: true }))) return;
    const t0 = Date.now();
    const ex = await dbFetch('/phm_charts?chart_id=eq.' + id + '&select=*');
    if (ex.ok && ex.body && ex.body !== '[]') {
      const row = JSON.parse(ex.body)[0];
      logUsage(who, '/analyses', 200, id, t0);
      return json(res, 200, formatRow(row));
    }
    if (!tryEnter('api-analyze', 2)) {
      return apiErr(res, 503, 'server_error', 'analysis_busy', 'analysis is busy; retry shortly', { 'retry-after': '3' });
    }
    let trusted;
    try {
      trusted = await recompute(id);
    } catch (e) {
      return apiErr(res, 502, 'server_error', 'analysis_failed', String(e.message || e).slice(0, 140));
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

  async function handleUsage(req, res, who) {
    let ownerId = null;
    if (who.kind === 'key') {
      if (!who.ownerId) {
        return json(res, 200, {
          key_id: who.id, today: 0, week: 0, month: 0, by_endpoint: {},
          note: 'this key has no owner (admin-issued); per-owner summary unavailable',
          quota: { hourly: RL.apiKeyHour, analysisDaily: RL.apiAnalyzeDay },
        });
      }
      ownerId = who.ownerId;
    } else if (who.kind === 'account') {
      ownerId = who.sub;
    } else {
      return apiErr(res, 401, 'authentication_error', 'api_key_required', 'usage requires an API key or account token');
    }
    const r = await callApiRpc('hm_api_usage_summary', { p_owner: ownerId });
    if (!r.ok) return apiErr(res, 502, 'server_error', 'usage_unavailable', 'usage summary temporarily unavailable');
    let s = {};
    try { s = JSON.parse(r.body); } catch { /* 保底 */ }
    return json(res, 200, Object.assign({ key_id: who.id || null, account: ownerId }, s, {
      quota: { hourly: RL.apiKeyHour, analysisDaily: RL.apiAnalyzeDay },
    }));
  }

  async function requireAccount(req, res) {
    const token = accountToken(req);
    if (!token) {
      apiErr(res, 401, 'authentication_error', 'account_token_required', 'sign in and pass x-hm-token');
      return null;
    }
    const who = await hmWhoami(token);
    if (!who.sub || who.verified !== true) {
      apiErr(res, 401, 'authentication_error', 'account_token_invalid', 'account token is invalid or unverified');
      return null;
    }
    return who;
  }

  async function handleKeys(req, res, method, path) {
    const who = await requireAccount(req, res);
    if (!who) return;
    if (method === 'GET' && path === '/keys') {
      const r = await callApiRpc('hm_api_key_list', { p_owner: who.sub });
      if (!r.ok) return apiErr(res, 502, 'server_error', 'keys_unavailable', 'key list temporarily unavailable');
      let keys = [];
      try { keys = JSON.parse(r.body); } catch { /* 保底 */ }
      return json(res, 200, { keys, max_keys: 100 });
    }
    if (method === 'POST' && path === '/keys') {
      const body = await readBody(req, 16 * 1024);
      const name = String(body && body.name || 'default').trim().slice(0, 40) || 'default';
      const k = generateApiKey();
      const r = await callApiRpc('hm_api_key_create', {
        p_owner: who.sub, p_name: name, p_hint: k.hint, p_hash: k.hash,
      });
      if (!r.ok) {
        const detail = String(r.body || r.error || '');
        if (/key_limit/.test(detail)) {
          return apiErr(res, 409, 'invalid_request_error', 'key_limit_reached', 'max 100 active keys per account');
        }
        return apiErr(res, 502, 'server_error', 'key_create_failed', 'could not create key');
      }
      let j = {};
      try { j = JSON.parse(r.body); } catch { /* 保底 */ }
      return json(res, 201, { id: j.id, name: j.name || name, hint: j.hint || k.hint, key: k.key });
    }
    const m = /^\/keys\/([0-9a-f-]{36})$/.exec(path);
    if (m && (method === 'PATCH' || method === 'DELETE')) {
      if (method === 'PATCH') {
        const body = await readBody(req, 16 * 1024);
        const name = String(body && body.name || '').trim().slice(0, 40);
        if (!name) return apiErr(res, 400, 'invalid_request_error', 'invalid_name', 'name is required');
        const r = await callApiRpc('hm_api_key_rename', { p_owner: who.sub, p_id: m[1], p_name: name });
        const j = r.ok ? safeJson(r.body) : null;
        if (!j || !j.ok) return apiErr(res, 404, 'invalid_request_error', 'key_not_found', 'key not found');
        return json(res, 200, { ok: true });
      }
      const r = await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: m[1] });
      const j = r.ok ? safeJson(r.body) : null;
      if (!j || !j.ok) return apiErr(res, 404, 'invalid_request_error', 'key_not_found', 'key not found');
      return json(res, 200, { ok: true });
    }
    return apiErr(res, 404, 'invalid_request_error', 'not_found', 'unknown key endpoint');
  }

  function openapi() {
    return {
      openapi: '3.1.0',
      info: { title: 'P.H.M. API', version: 'v1', description: 'Phira / Phigros chart difficulty reference API' },
      servers: [{ url: 'https://phm.app.workbuddy.host/api/v1' }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'sk-...' },
        },
        schemas: {
          Chart: {
            type: 'object',
            properties: {
              chart_id: { type: 'integer' }, name: { type: 'string' }, level: { type: 'string' },
              difficulty: { type: 'number', nullable: true }, ref_const: { type: 'number', nullable: true },
              ref_official: { type: 'number', nullable: true }, ps_score: { type: 'number', nullable: true },
              engine_ver: { type: 'string' }, engine_build: { type: 'string' },
              analyzed: { type: 'boolean' }, cached: { type: 'boolean' },
            },
          },
          Error: {
            type: 'object',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
      },
      paths: {
        '/charts/{chart_id}': { get: { summary: 'Read a cached chart', security: [{}, { bearer: [] }], parameters: [{ name: 'chart_id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Chart or { analyzed:false }' } } } },
        '/analyses': { post: { summary: 'Analyse a chart and cache the result', security: [{}, { bearer: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['chart_id'], properties: { chart_id: { type: 'integer' } } } } } }, responses: { 200: { description: 'Chart' }, 429: { description: 'Rate limited' } } } },
        '/usage': { get: { summary: 'Usage for the current key', security: [{ bearer: [] }], responses: { 200: { description: 'Usage summary' } } } },
        '/keys': { get: { summary: 'List API keys', security: [{ bearer: [] }], responses: { 200: { description: 'Keys' } } }, post: { summary: 'Create an API key', security: [{ bearer: [] }], responses: { 201: { description: 'Created; plaintext key returned once' } } } },
        '/keys/{id}': { patch: { summary: 'Rename a key', security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } }, delete: { summary: 'Revoke a key', security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } } },
      },
    };
  }

  async function handle(req, res, ip) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS); res.end(); return;
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/^\/api\/v1/, '') || '/';
    const t0 = Date.now();

    if (req.method === 'GET' && p === '/openapi.json') {
      return json(res, 200, openapi());
    }

    /* Key 管理用「账号 token」，不是 API key —— 必须在 identify 之前分流，
       否则 platform token 会被当成 sk- key 判 401。 */
    if (p === '/keys' || p.startsWith('/keys/')) {
      return handleKeys(req, res, req.method, p);
    }

    /* /usage 同时接受 API key 与网页账号 token（控制台用后者看账号总用量）。 */
    if (req.method === 'GET' && p === '/usage') {
      const raw = bearer(req);
      if (!raw || !raw.startsWith('sk-')) {
        const acc = await requireAccount(req, res);
        if (!acc) return;
        return handleUsage(req, res, { kind: 'account', sub: acc.sub });
      }
    }

    const who = await identify(req);
    if (who.error) {
      const status = who.error === 'key_lookup_failed' ? 503 : 401;
      return apiErr(res, status, 'authentication_error', who.error,
        who.error === 'key_lookup_failed' ? 'key store temporarily unavailable' : 'invalid API key');
    }

    if (req.method === 'GET' && /^\/charts\/[^/]+$/.test(p)) {
      return handleCharts(req, res, who, ip, p.slice('/charts/'.length));
    }
    if (req.method === 'POST' && p === '/analyses') {
      return handleAnalyses(req, res, who, ip);
    }
    if (req.method === 'GET' && p === '/usage') {
      return handleUsage(req, res, who);
    }
    if (p === '/keys' || /^\/keys\//.test(p)) {
      return handleKeys(req, res, req.method, p);
    }
    return apiErr(res, 404, 'invalid_request_error', 'not_found', 'unknown endpoint');
  }

  return { handle };
}
