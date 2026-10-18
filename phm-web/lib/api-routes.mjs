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
const ALL_SCOPES = ['charts:read', 'analyses:write', 'usage:read'];

/* Phira 上游。谱师/玩家这两个端点要打它，是本模块**唯一的外部依赖**，
   所以超时给得比内部查询短：内部 15s，上游 8s。
   ⚠ 超时值可以用环境变量调，但不要调大到接近网关的读超时 ——
   网关先断，客户端会收到 502 HTML 而不是我们的 JSON 错误体，很难排查。 */
const PHM_UPSTREAM_TIMEOUT = Math.min(20000, Math.max(2000,
  parseInt(process.env.PHM_UPSTREAM_TIMEOUT, 10) || 8000));

/* 带超时的 fetch。上游卡住时不能把整个请求无限挂住 ——
   Node 的 fetch 默认没有超时，一个慢上游能拖垮并发名额。 */
async function fetchTO(url) {
  return fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'phm-api/1.0 (+https://phm.app.workbuddy.host)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(PHM_UPSTREAM_TIMEOUT),
  });
}

function hasScope(who, scope) {
  return who.kind !== 'key' || (Array.isArray(who.scopes) && who.scopes.includes(scope));
}
function requireScope(res, who, scope) {
  if (hasScope(who, scope)) return true;
  apiErr(res, 403, 'permission_error', 'insufficient_scope',
    'API key is missing required scope: ' + scope, { 'x-required-scope': scope });
  return false;
}
function normalizeScopesInput(v) {
  if (v == null) return ALL_SCOPES.slice();
  if (!Array.isArray(v) || !v.length) return null;
  const out = [...new Set(v.filter(s => ALL_SCOPES.includes(s)))];
  return out.length ? out : null;
}
function expiryFromDays(v) {
  if (v == null || v === '') return null;
  const days = Number(v);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return undefined;
  return new Date(Date.now() + days * DAY).toISOString();
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-hm-token, x-api-key, x-phm-key',
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

/* ⚠ 部署环境有 CloudStudio 网关，它会动鉴权头。2026-10-18 线上实测两轮：
 *   第一轮（只读 Authorization）：网关**注入**自己的 Authorization 头，值不是 sk-。
 *     · 匿名请求 → 读到网关的值 → 格式不匹配 → 401 invalid_api_key
 *     · 带真 Key → 网关的值盖掉用户的 → 同样 401
 *   第二轮（改读 x-api-key）：网关把 **x-api-key 当成自己的鉴权头消费掉**了 ——
 *     发一把格式合法但不存在的 Key 过去，仍然返回 200（= 走匿名），
 *     而同一时刻 `x-hm-token` 能正常穿透（假值得到 account_token_invalid）。
 *     所以 `x-api-key` 在本环境**不可用**，它不在我们的控制之下。
 *
 * 结论：**只有私有前缀的自定义头能穿透**。取 Key 的顺序：
 *   x-phm-key → x-api-key → Authorization（且只认 sk- 前缀）。
 * 三路都拿不到就退回匿名 —— 「匿名可用」是 v1 的基本契约，
 * 绝不能因为某个来路不明的 token 判 401。
 *
 * 自查：`GET /api/v1/meta?diag=1` 会回各鉴权头的**长度**（0 = 没收到），
 * 用来判断到底是"头没穿透"还是"Key 不对"，不必靠猜。 */
const KEY_HEADERS = ['x-phm-key', 'x-api-key'];

function bearer(req) {
  for (const h of KEY_HEADERS) {
    const v = String(req.headers[h] || '').trim();
    if (v) return v;
  }
  const raw = String(req.headers.authorization || '').trim();
  /* ⚠ 这里刻意**不用正则**解析 "Bearer <value>"：
     `/^Bearer\s+(.+)$/i` 这种写法在 "bearer\t\t\t\t…" 上是多项式回溯
     （CodeQL js/polynomial-redos 实报过），而 Authorization 是攻击者完全可控的。
     切第一个空格就够了 —— 方案名与凭据之间规范上就是一个空格。 */
  const sp = raw.indexOf(' ');
  if (sp <= 0) return '';
  if (raw.slice(0, sp).toLowerCase() !== 'bearer') return '';
  const v = raw.slice(sp + 1).trim();
  /* 只认 sk- 前缀：长度/字符是否合规交给 identify 判，那里才报 invalid_api_key。
     网关注入的任意 token 在这里被丢弃 → 退回匿名。 */
  return /^sk-/i.test(v) ? v : '';
}

function accountToken(req) {
  const custom = String(req.headers['x-hm-token'] || '').trim();
  if (custom) return custom;
  /* ⚠ 绝不回退到 Authorization：那里现在只认 sk- API Key。
     早先回退过一次，结果网关注入的 token 被当成「账号 token」去验，
     匿名看用量的人拿到 account_token_invalid —— 错得很有迷惑性。
     账号 token 的契约就只有 x-hm-token 一个。 */
  return '';
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
    send, readBody, dbFetch, dbPutChart, dbPageCharts, recompute, hmWhoami,
    writeSecret, engineVer, serviceVersion, openapiSpec,
    SORTABLE, phiraBase,
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
    if (j.expires_at && Date.parse(j.expires_at) <= Date.now()) return { error: 'expired_api_key' };
    const scopes = Array.isArray(j.scopes) && j.scopes.length
      ? j.scopes.filter(s => ALL_SCOPES.includes(s))
      : ALL_SCOPES.slice();
    return { kind: 'key', id: j.id, ownerId: j.owner_id || null, hash, scopes };
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
    if (!requireScope(res, who, 'charts:read')) return;
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

  /* ── GET /charts ── 列表：分页 / 搜索 / 排序 / 过滤（V0.21.0.0）
   *
   * 为什么必须补这个：`/charts/{id}` 只能一张一张查。想"看看库里有哪些谱"
   * 就得知道 id，或者一张张试 —— 这不是 API，是猜谜。
   *
   * 实现直接复用 `dbPageCharts`（网页端 /data 页用的同一份），
   * 不另写一套查询：两套分页必然漂移，而漂移的表现是"网页看到的和 API 看到的不是同一批数据"。
   * 排序字段走 `SORTABLE` 白名单 —— 它直接进 PostgREST 查询串，不挡就是把查询表达式交给调用方。
   */
  async function handleChartList(req, res, who, ip, url) {
    if (!requireScope(res, who, 'charts:read')) return;
    if (!(await gateApi(res, who, ip))) return;
    const qp = url.searchParams;
    const sort = qp.get('sort') || 'chart_id';
    if (!SORTABLE.has(sort)) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_sort_field',
        'unsupported sort field; see GET /meta for the allowed list',
        { 'x-allowed-sort': [...SORTABLE].join(',') });
    }
    const t0 = Date.now();
    const r = await dbPageCharts({
      page: qp.get('page'), pageSize: qp.get('pageSize'),
      sort, order: qp.get('order') === 'desc' ? 'desc' : 'asc',
      q: qp.get('q') || '', level: qp.get('level') || '',
      only: qp.get('only') || '', build: qp.get('build') || '',
    });
    /* ⚠ `dbPageCharts` 的失败信号是**返回 null**，不是 `{ok:false}` ——
       它内部已经把"上游挂了/JSON 坏/不是数组"三种情况都折叠成 null。
       写成 `if (!r.ok)` 会恒真（null.ok 是 undefined），整个端点永远 502。 */
    if (!r) {
      logUsage(who, '/charts:list', 502, null, t0);
      return apiErr(res, 502, 'server_error', 'cache_unavailable', 'cache temporarily unavailable');
    }
    logUsage(who, '/charts:list', 200, null, t0);
    return json(res, 200, {
      rows: r.rows.map(formatRow),
      total: r.total, page: r.page, pageSize: r.pageSize, pages: r.pages,
      sort, order: qp.get('order') === 'desc' ? 'desc' : 'asc',
    });
  }

  /* ── GET /stats ── 全库统计（共多少谱、覆盖多少、引擎版本分布）
   * 复用网页端同一份 `phm_stats` RPC；**失败时不透传上游报错正文**
   * （那里面可能有表名/字段名，属于内部结构）。 */
  async function handleStats(req, res, who, ip) {
    if (!requireScope(res, who, 'charts:read')) return;
    if (!(await gateApi(res, who, ip))) return;
    const t0 = Date.now();
    const r = await dbFetch('/rpc/phm_stats', { method: 'POST', body: '{}' });
    logUsage(who, '/stats', r.ok ? 200 : 502, null, t0);
    if (!r.ok) return apiErr(res, 502, 'server_error', 'stats_unavailable', 'statistics temporarily unavailable');
    let j;
    try { j = JSON.parse(r.body); } catch {
      return apiErr(res, 502, 'server_error', 'stats_unparseable', 'statistics could not be parsed');
    }
    return json(res, 200, j);
  }

  /* ── GET /charters/{uid} ── 某谱师上传的谱面（附本站已算出的定数）
   *
   * ⚠ 这条要打 Phira 上游，属于**最慢也最容易失败**的路径，所以：
   *   · 独立超时（`PHM_UPSTREAM_TIMEOUT`，默认 8s），比对内查询短；
   *   · 上游失败返回 502 `upstream_unavailable`，**绝不返回空数组** ——
   *     空数组会让调用方以为"这人没有作品"，那是最坏的错误答案。
   *   · 只读前 N 页（默认 maxPages=3），不做全量拉取：公开 API 不该变成爬虫入口。 */
  async function handleCharter(req, res, who, ip, uidStr, url) {
    if (!requireScope(res, who, 'charts:read')) return;
    if (!(await gateApi(res, who, ip))) return;
    const uid = Number(uidStr);
    if (!Number.isInteger(uid) || uid < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_uid', 'uid must be a positive integer');
    }
    const maxPages = Math.min(5, Math.max(1, parseInt(url.searchParams.get('maxPages'), 10) || 3));
    const t0 = Date.now();
    const out = [];
    let count = null;
    try {
      for (let page = 1; page <= maxPages; page++) {
        const r = await fetchTO(phiraBase + '/chart?uploader=' + uid + '&page=' + page + '&pageNum=30');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (count == null && j && Number.isFinite(Number(j.count))) count = Number(j.count);
        const list = Array.isArray(j) ? j : (Array.isArray(j && j.results) ? j.results : []);
        if (!list.length) break;
        out.push(...list);
        if (list.length < 30) break;
      }
    } catch (e) {
      logUsage(who, '/charters', 502, null, t0);
      return apiErr(res, 502, 'server_error', 'upstream_unavailable',
        'Phira upstream is unavailable; try again later');
    }
    /* 把本地缓存里的定数贴上去（一次 IN 查询，≤60 个 id 是同一份约束）。 */
    const ids = out.map(x => Number(x.id)).filter(x => Number.isInteger(x) && x > 0).slice(0, 60);
    const cache = new Map();
    if (ids.length) {
      const cr = await dbFetch('/phm_charts?chart_id=in.(' + ids.join(',') + ')&select=*', undefined, 15000, 4 * 1024 * 1024);
      if (cr.ok && cr.body) {
        try {
          for (const row of JSON.parse(cr.body)) cache.set(Number(row.chart_id), row);
        } catch { /* 缓存坏了不影响主结果 */ }
      }
    }
    const charts = out.map(c => {
      const hit = cache.get(Number(c.id));
      const base = {
        chart_id: c.id, name: c.name, level: c.level, difficulty: c.difficulty,
        charter: c.charter, uploader: c.uploader, rated: c.rated == null ? null : c.rated,
      };
      /* analyzed=false 明确告诉调用方"本站还没算过这张"，
         而不是让它去猜 ref_const 为什么缺 —— 缺字段和"算出来是 0"是两回事。 */
      return hit ? Object.assign(base, { analyzed: true, ref_const: hit.ref_const, ref_official: hit.ref_official, ps_score: hit.ps_score, nps: hit.nps, notes: hit.notes, engine_ver: hit.engine_ver })
        : Object.assign(base, { analyzed: false });
    });
    logUsage(who, '/charters', 200, null, t0);
    return json(res, 200, { uid, count, returned: charts.length, maxPages, charts });
  }

  /* ── GET /players/{uid} ── 玩家公开资料 + 统计（不含成绩明细）
   * 成绩明细要另外的接口和额度，先不给：把"资料"和"几百条成绩"混在一个响应里，
   * 既慢又容易被拿来批量抓。 */
  async function handlePlayer(req, res, who, ip, uidStr) {
    if (!requireScope(res, who, 'charts:read')) return;
    if (!(await gateApi(res, who, ip))) return;
    const uid = Number(uidStr);
    if (!Number.isInteger(uid) || uid < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_uid', 'uid must be a positive integer');
    }
    const t0 = Date.now();
    let user;
    try {
      const r = await fetchTO(phiraBase + '/user/' + uid);
      /* ⚠ Phira 对**不存在的 uid** 回的是 400，不是 404（实测 /user/1 → 400）。
         只判 404 的话，调用方会收到 502「上游不可用」，从而去重试一个
         永远不会成功的请求 —— 错误码要表达真实原因。 */
      if (r.status === 404 || r.status === 400) {
        logUsage(who, '/players', 404, null, t0);
        return apiErr(res, 404, 'invalid_request_error', 'player_not_found', 'no such player');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      user = await r.json();
    } catch (e) {
      logUsage(who, '/players', 502, null, t0);
      return apiErr(res, 502, 'server_error', 'upstream_unavailable',
        'Phira upstream is unavailable; try again later');
    }
    if (!user || user.id == null) {
      logUsage(who, '/players', 404, null, t0);
      return apiErr(res, 404, 'invalid_request_error', 'player_not_found', 'no such player');
    }
    /* stats 是可选增强：拿不到就把 stats 置 null，**不要因此让整个请求失败**。 */
    let stats = null;
    try {
      const sr = await fetchTO(phiraBase + '/user/' + uid + '/stats');
      if (sr.ok) stats = await sr.json();
    } catch { /* 保持 null */ }
    logUsage(who, '/players', 200, null, t0);
    return json(res, 200, {
      id: user.id, name: user.name, bio: user.bio == null ? null : user.bio,
      avatar: user.avatar == null ? null : user.avatar,
      joined: user.joined == null ? null : user.joined,
      rks: user.rks == null ? null : user.rks,
      stats,
    });
  }

  async function handleAnalyses(req, res, who, ip) {
    const body = await readBody(req, 16 * 1024);
    const id = Number(body && body.chart_id);
    if (!Number.isInteger(id) || id < 1) {
      return apiErr(res, 400, 'invalid_request_error', 'invalid_chart_id', 'chart_id must be a positive integer');
    }
    if (!requireScope(res, who, 'analyses:write')) return;
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
      if (!requireScope(res, who, 'usage:read')) return;
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
    const out = Object.assign({ key_id: who.id || null, account: ownerId }, s, {
      quota: { hourly: RL.apiKeyHour, analysisDaily: RL.apiAnalyzeDay },
    });
    if (who.kind === 'key') {
      const kr = await callApiRpc('hm_api_usage_key_summary', { p_key_id: who.id });
      if (kr.ok) {
        const ku = safeJson(kr.body);
        if (ku) out.key_usage = ku;
      }
    }
    return json(res, 200, out);
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

  async function metaSet(owner, id, scopes, expiresAt) {
    const r = await callApiRpc('hm_api_key_meta_set', {
      p_owner: owner, p_id: id, p_scopes: scopes, p_expires_at: expiresAt,
    });
    if (!r.ok) return { ok: false, missing: r.status === 404 };
    const j = safeJson(r.body);
    return { ok: !!(j && j.ok), missing: false };
  }

  function keyOut(k) {
    return {
      id: k.id, name: k.name, hint: k.hint,
      scopes: Array.isArray(k.scopes) && k.scopes.length ? k.scopes : ALL_SCOPES.slice(),
      created_at: k.created_at, last_used_at: k.last_used_at || null,
      expires_at: k.expires_at || null,
    };
  }

  async function handleKeys(req, res, method, path) {
    const who = await requireAccount(req, res);
    if (!who) return;

    if (method === 'GET' && path === '/keys') {
      const r = await callApiRpc('hm_api_key_list', { p_owner: who.sub });
      if (!r.ok) return apiErr(res, 502, 'server_error', 'keys_unavailable', 'key list temporarily unavailable');
      let keys = [];
      try { keys = (JSON.parse(r.body) || []).filter(k => !k.revoked_at).map(keyOut); } catch { /* 保底 */ }
      /* 只返回有效 Key：吊销后从列表消失（历史用量仍然保留）。 */
      return json(res, 200, { keys, max_keys: 100, scopes: ALL_SCOPES });
    }

    if (method === 'POST' && path === '/keys') {
      const body = await readBody(req, 16 * 1024);
      const name = String(body && body.name || 'default').trim().slice(0, 40) || 'default';
      const scopes = normalizeScopesInput(body && body.scopes);
      if (!scopes) return apiErr(res, 400, 'invalid_request_error', 'invalid_scopes',
        'scopes must be a non-empty subset of: ' + ALL_SCOPES.join(', '));
      const expiresAt = expiryFromDays(body && body.expires_in_days);
      if (expiresAt === undefined) return apiErr(res, 400, 'invalid_request_error', 'invalid_expiry',
        'expires_in_days must be an integer between 1 and 3650');
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
      const j = safeJson(r.body) || {};
      const meta = await metaSet(who.sub, j.id, scopes, expiresAt);
      if (!meta.ok && !meta.missing) {
        await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: j.id }).catch(() => {});
        return apiErr(res, 502, 'server_error', 'key_meta_failed', 'could not save key scopes/expiry');
      }
      return json(res, 201, {
        id: j.id, name: j.name || name, hint: j.hint || k.hint, key: k.key,
        scopes, expires_at: expiresAt, metaAvailable: meta.ok,
        warning: meta.ok ? undefined : 'key metadata table is not migrated; key uses all scopes and never expires',
      });
    }

    const rot = /^\/keys\/([0-9a-f-]{36})\/rotate$/.exec(path);
    if (method === 'POST' && rot) {
      const list = await callApiRpc('hm_api_key_list', { p_owner: who.sub });
      if (!list.ok) return apiErr(res, 502, 'server_error', 'keys_unavailable', 'key list temporarily unavailable');
      let keys = [];
      try { keys = (JSON.parse(list.body) || []).filter(k => !k.revoked_at); } catch { /* 保底 */ }
      const old = keys.find(k => k.id === rot[1]);
      if (!old) return apiErr(res, 404, 'invalid_request_error', 'key_not_found', 'key not found');
      const scopes = Array.isArray(old.scopes) && old.scopes.length ? old.scopes : ALL_SCOPES.slice();
      const expiresAt = old.expires_at && Date.parse(old.expires_at) > Date.now() ? old.expires_at : null;
      const k = generateApiKey();
      const c = await callApiRpc('hm_api_key_create', {
        p_owner: who.sub, p_name: old.name, p_hint: k.hint, p_hash: k.hash,
      });
      if (!c.ok) return apiErr(res, 502, 'server_error', 'key_create_failed', 'could not create replacement key');
      const cj = safeJson(c.body) || {};
      const meta = await metaSet(who.sub, cj.id, scopes, expiresAt);
      const rev = await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: old.id });
      if (!meta.ok && !meta.missing) {
        await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: cj.id }).catch(() => {});
        return apiErr(res, 502, 'server_error', 'key_meta_failed', 'could not copy key scopes');
      }
      if (!rev.ok) {
        await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: cj.id }).catch(() => {});
        return apiErr(res, 502, 'server_error', 'key_revoke_failed', 'replacement created but old key could not be revoked');
      }
      return json(res, 201, {
        id: cj.id, name: old.name, hint: k.hint, key: k.key,
        scopes, expires_at: expiresAt, metaAvailable: meta.ok, rotated_from: old.id,
      });
    }

    const m = /^\/keys\/([0-9a-f-]{36})$/.exec(path);
    if (m && method === 'PATCH') {
      const body = await readBody(req, 16 * 1024);
      const hasName = typeof (body && body.name) === 'string' && body.name.trim();
      const hasScopes = !!(body && Object.prototype.hasOwnProperty.call(body, 'scopes'));
      const hasExpiry = !!(body && Object.prototype.hasOwnProperty.call(body, 'expires_in_days'));
      if (!hasName && !hasScopes && !hasExpiry) {
        return apiErr(res, 400, 'invalid_request_error', 'nothing_to_update', 'provide name, scopes or expires_in_days');
      }
      if (hasName) {
        const r = await callApiRpc('hm_api_key_rename', { p_owner: who.sub, p_id: m[1], p_name: hasName.trim().slice(0, 40) });
        const j = r.ok ? safeJson(r.body) : null;
        if (!j || !j.ok) return apiErr(res, 404, 'invalid_request_error', 'key_not_found', 'key not found');
      }
      if (hasScopes || hasExpiry) {
        const scopes = hasScopes ? normalizeScopesInput(body.scopes) : null;
        if (hasScopes && !scopes) return apiErr(res, 400, 'invalid_request_error', 'invalid_scopes',
          'scopes must be a non-empty subset of: ' + ALL_SCOPES.join(', '));
        /* 未给 scopes 时沿用旧值：先读列表 */
        let current = null;
        if (!hasScopes) {
          const list = await callApiRpc('hm_api_key_list', { p_owner: who.sub });
          if (list.ok) {
            const keys = (safeJson(list.body) || []).filter(k => !k.revoked_at);
            current = keys.find(k => k.id === m[1]) || null;
          }
        }
        const finalScopes = scopes || (current && current.scopes) || ALL_SCOPES.slice();
        let expiresAt = hasExpiry ? expiryFromDays(body.expires_in_days) : (current ? current.expires_at : null);
        if (expiresAt === undefined) return apiErr(res, 400, 'invalid_request_error', 'invalid_expiry',
          'expires_in_days must be an integer between 1 and 3650');
        const meta = await metaSet(who.sub, m[1], finalScopes, expiresAt || null);
        if (meta.missing) return apiErr(res, 409, 'invalid_request_error', 'meta_unavailable',
          'key metadata table is not migrated; run db/api-v2.sql first');
        if (!meta.ok) return apiErr(res, 502, 'server_error', 'key_meta_failed', 'could not update key scopes/expiry');
        return json(res, 200, { ok: true, scopes: finalScopes, expires_at: expiresAt || null });
      }
      return json(res, 200, { ok: true });
    }

    if (m && method === 'DELETE') {
      const r = await callApiRpc('hm_api_key_revoke', { p_owner: who.sub, p_id: m[1] });
      const j = r.ok ? safeJson(r.body) : null;
      if (!j || !j.ok) return apiErr(res, 404, 'invalid_request_error', 'key_not_found', 'key not found');
      return json(res, 200, { ok: true });
    }
    return apiErr(res, 404, 'invalid_request_error', 'not_found', 'unknown key endpoint');
  }

  function openapi() {
    /* 单一契约：api/openapi.json。再在代码里维护一份必然漂移。 */
    return openapiSpec || { openapi: '3.1.0', info: { title: 'P.H.M. API', version: '1.0.0' }, paths: {} };
  }

  async function handle(req, res, ip) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS); res.end(); return;
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/^\/api\/v1/, '') || '/';
    const t0 = Date.now();

    /* 公开的版本/构建信息：客户端用它判断「页面与 API 是否同一版本」。 */
    if (req.method === 'GET' && p === '/meta') {
      const body = {
        api: 'v1',
        service: serviceVersion || null,
        engine: engineVer || null,
        time: new Date().toISOString(),
      };
      /* ?diag=1 —— 鉴权头自检。**只回长度，不回内容**：
         0 表示这个头没穿透到服务端（网关吞了/没发），>0 表示收到了。
         用途：区分「头被网关吃掉」和「Key 本身不对」，别再靠猜。
         2026-10-18 就是靠这个思路发现 x-api-key 被网关消费掉的。 */
      if (url.searchParams.get('diag') === '1') {
        const h = req.headers;
        body.diag = {
          /* 每个头回长度；值为 0 或缺失都记 0 */
          'x-phm-key': String(h['x-phm-key'] || '').length,
          'x-api-key': String(h['x-api-key'] || '').length,
          'authorization': String(h.authorization || '').length,
          'x-hm-token': String(h['x-hm-token'] || '').length,
          /* 解析结果：这次请求最终被当成什么身份（只看 kind，不暴露 key 内容） */
          key_seen: bearer(req) ? 'yes' : 'no',
        };
      }
      return json(res, 200, body);
    }

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
      const msg = who.error === 'expired_api_key' ? 'API key has expired'
        : who.error === 'revoked_api_key' ? 'API key has been revoked'
        : who.error === 'key_lookup_failed' ? 'key store temporarily unavailable'
        : 'invalid API key';
      return apiErr(res, status, 'authentication_error', who.error, msg);
    }

    /* ⚠ 顺序有意义：`/charts/{id}` 要排在 `/charts` 之前，
       否则 `/charts` 会把 `/charts/123` 也吃掉（`^\/charts\/[^/]+$` 是精确的，不会，
       但先列长的更不容易在以后加子路径时踩坑）。 */
    if (req.method === 'GET' && /^\/charts\/[^/]+$/.test(p)) {
      return handleCharts(req, res, who, ip, p.slice('/charts/'.length));
    }
    if (req.method === 'GET' && p === '/charts') {
      return handleChartList(req, res, who, ip, url);
    }
    if (req.method === 'GET' && p === '/stats') {
      return handleStats(req, res, who, ip);
    }
    if (req.method === 'GET' && /^\/charters\/[^/]+$/.test(p)) {
      return handleCharter(req, res, who, ip, p.slice('/charters/'.length), url);
    }
    if (req.method === 'GET' && /^\/players\/[^/]+$/.test(p)) {
      return handlePlayer(req, res, who, ip, p.slice('/players/'.length));
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
