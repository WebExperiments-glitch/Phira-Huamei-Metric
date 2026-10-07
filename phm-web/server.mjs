/* P.H.M. Standard —— 静态前端 + 轻量 Node 服务
 * 零依赖（只用 Node 内置模块），沙箱里装不上任何东西也能跑。
 *
 * 职责边界（刻意做小）：
 *   1. 托管静态前端（index.html / robots.txt）
 *   2. 对外提供受限的写入网关 /api/*：校验 → 限流 → 转发到云数据库
 *   3. 服务端自有的持久化（JSON 文件），用于限流计数与可信统计
 *
 * 为什么需要它：前端直连数据面时，任何规则都能被绕过；这里把「写」收归一处，
 * 至少做到校验与限流。注意它与前端同权限（anon），所以是「规范」不是「强制防线」。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BOOT_AT = new Date().toISOString();

/* ── 服务端自有存储（验证沙箱持久性 + 限流计数）── */
const STORE = path.join(ROOT, 'server-store.json');
function storeLoad() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { bootAt: BOOT_AT, writes: 0, hits: {}, lastWrite: null }; }
}
function storeSave(o) { try { fs.writeFileSync(STORE, JSON.stringify(o)); } catch {} }

/* ── 云数据库（服务端复现浏览器调用方式）──
 * 实测确认：认证头是 x-wb-webapp-access-key（=publishableKey），身份由 referer 判定。
 * ⚠ 这意味着服务端与浏览器同为 anon 角色 —— 所以这一层是「统一入口」，不是「更高权限」。
 * 真正的权限提升需要 service key，当前托管环境不提供。 */
const DB = {
  base: 'https://phm.app.workbuddy.host/.cloud/database/rest',
  key: 'wbpk_TRm3Cbt5VeYHHDwUL854jr_5Xi69EqYG18sPzQnMMJhJr08x67NoE3b',
  referer: 'https://phm.app.workbuddy.host/',
  batch: 8,          /* 环境级限流约 25~40 并发触发，服务端同样要温和 */
  gapMs: 400,
};
function dbHeaders(extra) {
  return Object.assign({
    'x-wb-webapp-access-key': DB.key,
    'referer': DB.referer,
    'content-type': 'application/json',
    'prefer': 'resolution=merge-duplicates,return=minimal',
  }, extra || {});
}
async function dbFetch(pathAndQuery, init, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(DB.base + pathAndQuery, Object.assign({ headers: dbHeaders() }, init || {}, { signal: ctl.signal }));
    clearTimeout(timer);
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt.slice(0, 400) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(e.message || e).slice(0, 200) };
  }
}
/* 分批 upsert（与前端同策略：批 8 条 + 间隔 400ms） */
async function dbUpsert(table, rows, onConflict) {
  let ok = 0; const fails = [];
  for (let i = 0; i < rows.length; i += DB.batch) {
    const chunk = rows.slice(i, i + DB.batch);
    const q = '/' + table + (onConflict ? '?on_conflict=' + encodeURIComponent(onConflict) : '');
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const r = await dbFetch(q, { method: 'POST', body: JSON.stringify(chunk) });
      if (r.ok) { ok += chunk.length; done = true; break; }
      const limited = r.status === 429 || /rate limit|exceeds|too many/i.test(r.body || '');
      if (limited && attempt < 3) { await new Promise(s => setTimeout(s, 500 * attempt)); continue; }
      fails.push(r.status + ' ' + String(r.body || r.error || '').slice(0, 120));
      done = true;
    }
    if (i + DB.batch < rows.length) await new Promise(s => setTimeout(s, DB.gapMs));
  }
  return { ok, fail: fails.slice(0, 3) };
}

/* ── 业务校验：与前端 numOrNull 同一套规则，服务端重算一遍 ── */
const LIMITS = {
  chart_id: [1, null], name: null, level: null, difficulty: [0, 25],
  ref_const: [0, 25], ps_score: [0, 25], nps: [0, 200], hold_ratio: [0, 1],
  notes: [0, 100000], stair_avg: [0, 500], speed_peak: [0, 1000000],
  acc: [0, 100], song_rks: [0, 25], official_const: [1, 25],
  phira_user_id: [1, null],
};
const TEXTS = { name: 160, level: 60, chart_name: 120, chart_diff: 8, chart_level: 60, phira_user_name: 60, engine_ver: 32, client_id: 64 };

function sanitize(row, required) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k in LIMITS && LIMITS[k]) {
      const [lo, hi] = LIMITS[k];
      if (v == null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (lo != null && n < lo) continue;
      if (hi != null && n > hi) continue;
      out[k] = n;
    } else if (k in TEXTS) {
      if (v == null) continue;
      const t = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (t) out[k] = t.slice(0, TEXTS[k]);
    }
  }
  /* 必填字段缺失 = 整行报废（避免只留一个 name 的空壳行入库） */
  if (required && !required.every(k => out[k] != null)) return null;
  return Object.keys(out).length ? out : null;
}

/* ── 限流：每 IP 每分钟 N 次写 ── */
const RL_WINDOW = 60_000, RL_MAX = 30;
function rateOk(ip) {
  const s = storeLoad();
  const now = Date.now();
  s.hits = s.hits || {};
  const arr = (s.hits[ip] || []).filter(t => now - t < RL_WINDOW);
  if (arr.length >= RL_MAX) { s.hits[ip] = arr; storeSave(s); return false; }
  arr.push(now);
  s.hits[ip] = arr;
  storeSave(s);
  return true;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon' };

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function sendFile(res, fp) {
  try {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
      'x-content-type-options': 'nosniff' });
    res.end(buf);
  } catch { send(res, 404, 'not found', 'text/plain; charset=utf-8'); }
}
function readBody(req, max = 512 * 1024) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  /* 健康与自检 */
  if (p === '/api/health') {
    const s = storeLoad();
    return send(res, 200, JSON.stringify({
      ok: true, bootAt: BOOT_AT, now: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()), node: process.version,
      storeWrites: s.writes || 0, storeLastWrite: s.lastWrite || null,
      storeFileExists: fs.existsSync(STORE),
    }));
  }
  /* 持久性实验：写一次 +1 */
  if (p === '/api/kv') {
    const s = storeLoad();
    if (req.method === 'POST') {
      s.writes = (s.writes || 0) + 1;
      s.lastWrite = new Date().toISOString();
      s.firstBoot = s.firstBoot || BOOT_AT;
      storeSave(s);
      return send(res, 200, JSON.stringify(s));
    }
    return send(res, 200, JSON.stringify(s));
  }
  /* 沙箱外网连通性探测 */
  if (p === '/api/net') {
    const out = {};
    const targets = {
      phira: 'https://api.phira.cn/chart/47579',
      cloud: 'https://phm.app.workbuddy.host/.cloud/database/rest/phm_charts?limit=1',
    };
    for (const [k, u] of Object.entries(targets)) {
      const t0 = Date.now();
      try {
        const ctl = AbortController ? new AbortController() : null;
        const timer = setTimeout(() => ctl && ctl.abort(), 8000);
        const r = await fetch(u, ctl ? { signal: ctl.signal } : undefined);
        clearTimeout(timer);
        out[k] = { status: r.status, ms: Date.now() - t0 };
      } catch (e) { out[k] = { error: String(e.message || e).slice(0, 80), ms: Date.now() - t0 }; }
    }
    return send(res, 200, JSON.stringify(out));
  }
  /* 写入网关：校验 + 限流 + 落库 */
  if (p === '/api/contribute' || p === '/api/scores') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (!rateOk(ip)) return send(res, 429, JSON.stringify({ error: 'rate limit: 每分钟最多 ' + RL_MAX + ' 次写入' }));
    const body = await readBody(req);
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.rows) ? body.rows : null);
    if (!rows) return send(res, 400, JSON.stringify({ error: 'body must be an array or {rows:[]}' }));
    if (rows.length > 500) return send(res, 413, JSON.stringify({ error: '单次最多 500 行' }));

    const table = p === '/api/contribute' ? 'phm_charts' : 'phm_scores';
    const onConflict = p === '/api/contribute' ? 'chart_id' : 'phira_user_id,chart_id';
    const required = p === '/api/contribute' ? ['chart_id', 'name'] : ['chart_name'];
    const clean = rows.map(r => sanitize(r, required)).filter(Boolean);

    if (!clean.length) {
      return send(res, 200, JSON.stringify({
        received: rows.length, accepted: 0, rejected: rows.length, written: 0,
        note: '全部未通过服务端校验，未写入',
      }));
    }
    const wr = await dbUpsert(table, clean, onConflict);
    return send(res, 200, JSON.stringify({
      received: rows.length, accepted: clean.length, rejected: rows.length - clean.length,
      written: wr.ok, fail: wr.fail.length ? wr.fail : undefined,
      table, source: 'server-proxy',
    }));
  }
  /* 聚合统计（服务端转发 RPC，前端可不再直连） */
  if (p === '/api/stats') {
    const r = await dbFetch('/rpc/phm_stats', { method: 'POST', body: '{}' });
    return send(res, r.ok ? 200 : 502, r.ok ? (r.body || '{}') : JSON.stringify({ error: 'stats unavailable', detail: r.body || r.error }));
  }

  /* 静态资源 */
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
  return send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[phm] listening on 0.0.0.0:' + PORT + ' | boot ' + BOOT_AT + ' | node ' + process.version);
});
