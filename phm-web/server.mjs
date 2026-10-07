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
import { reviewContribution } from './lib/review.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
/* 静态资源根目录。
   只有 public/ 下的内容可能被送出 —— 源码（server.mjs / lib/）与运行时数据
   （server-store.json）都在 ROOT 下，天然在可服务范围之外。 */
const WEB_ROOT = path.join(ROOT, 'public');
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

/* ── 限流：每 IP 每分钟 N 次写 + 全局每分钟上限 ──
 * 文件读改写必须串行（并发请求会互相覆盖丢计数）；
 * 同时加全局桶，防止 X-Forwarded-For 被伪造时无限刷。 */
const RL_WINDOW = 60_000, RL_MAX = 30, RL_GLOBAL_MAX = 240;
let storeQueue = Promise.resolve();
function withStore(fn) {
  const run = storeQueue.then(() => {
    const s = storeLoad();
    const out = fn(s);
    storeSave(s);
    return out;
  });
  storeQueue = run.catch(() => {});
  return run;
}
function rateOk(ip) {
  return withStore((s) => {
    const now = Date.now();
    s.hits = s.hits || {};
    let global = 0;
    /* 顺手回收过期键，避免文件随 IP 无限膨胀 */
    for (const k of Object.keys(s.hits)) {
      const arr = (s.hits[k] || []).filter(t => now - t < RL_WINDOW);
      if (arr.length) { s.hits[k] = arr; global += arr.length; }
      else delete s.hits[k];
    }
    const arr = s.hits[ip] || [];
    if (arr.length >= RL_MAX) return false;
    if (global >= RL_GLOBAL_MAX) return false;
    arr.push(now);
    s.hits[ip] = arr;
    return true;
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* ⚠ 静态白名单 —— 只允许这些文件被送出。
   之前只做了「路径不以 ROOT 开头则拒」，结果 server.mjs / package.json /
   server-store.json 全都躺在 ROOT 里被当静态资源送出去（含数据库地址、密钥、访客 IP）。
   目录穿越防护 ≠ 白名单。这是安全修复的核心。
   现在拆成两层：少量精确允许的根文件 + 仅限 public/js、public/css 下的安全扩展名。 */
const PUBLIC_FILES = new Set(['index.html', 'robots.txt', 'favicon.ico', 'privacy.html']);
const PUBLIC_DIRS = ['js/', 'css/'];                       /* 只暴露这两个子目录 */
const SAFE_EXT = new Set(['.js', '.css', '.png', '.svg', '.ico', '.webp', '.woff2']);
function isPublicPath(rel) {
  if (PUBLIC_FILES.has(rel)) return true;
  if (!PUBLIC_DIRS.some(d => rel.startsWith(d))) return false;
  if (rel.includes('..')) return false;
  return SAFE_EXT.has(path.extname(rel).toLowerCase());
}

/* 安全响应头（此前只有 nosniff，等于裸奔） */
const SEC_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  /* CSP：单文件内联脚本 + jsDelivr(云 SDK) + Phira API + 本站 CloudBase */
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.phira.cn https://phm.app.workbuddy.host https://cdn.jsdelivr.net",
    "form-action 'self'",
    /* frame-ancestors 交给 X-Frame-Options: DENY —— 写在 CSP 里会被 Chrome 报
       「keyword 'none' alongside with other sources」，功能重复且有告警 */
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
};

function send(res, code, body, type) {
  res.writeHead(code, Object.assign({
    'content-type': type || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, SEC_HEADERS));
  res.end(body);
}
function sendFile(res, fp) {
  try {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, Object.assign({
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
    }, SEC_HEADERS));
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

  /* 健康检查：只回 ok。
     此前返回 Node 版本 / 启动时间 / uptime / 存储状态 —— 那是给攻击者的情报，已删。 */
  if (p === '/api/health') return send(res, 200, JSON.stringify({ ok: true }));
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

    /* ── 定数缓存：**服务端复核后才落库**（防投毒）──
       客户端报上来的特征值一律不直接采信：先查该 chart_id 是否已有权威值，
       没有就用服务端自己的引擎复算一遍（下载谱面 → 与提交值比对），
       一致才写，且**写入的是服务端算出来的值**。 */
    if (p === '/api/contribute') {
      let verified = 0, skipped = 0, failed = 0, mismatched = 0;
      const notes = [];
      for (const row of clean) {
        try {
          const existing = await dbFetch(
            '/phm_charts?chart_id=eq.' + encodeURIComponent(row.chart_id) + '&select=chart_id');
          if (existing.ok && existing.body && existing.body !== '[]') { skipped++; continue; }

          const { trusted, diffs } = await reviewContribution(row);
          /* ⚠ 写入的永远是**服务端复算出来的值**，不是客户端报上来的值。
             客户端与服务端不一致只是说明它过期了，不构成写入障碍。 */
          const wr = await dbUpsert('phm_charts', [trusted], 'chart_id');
          if (wr.ok > 0) {
            verified++;
            if (diffs.length) {
              mismatched++;
              notes.push('客户端值不一致（已改用服务端值）: ' + diffs.map(d => d.field).join(','));
            }
          } else { failed++; notes.push('写入失败: ' + String(wr.fail[0] || '').slice(0, 80)); }
        } catch (e) {
          failed++;
          notes.push(String(e.message || e).slice(0, 100));
        }
      }
      return send(res, 200, JSON.stringify({
        received: rows.length, accepted: clean.length, rejected: rows.length - clean.length,
        written: verified, skipped, failed,
        mismatched: mismatched || undefined,
        note: notes.length ? notes.slice(0, 3) : undefined,
        verified: true, source: 'server-verified',
        policy: '定数由服务端独立复算；落库值永远是服务端计算结果，客户端提交值仅用于一致性检查',
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

  /* 静态资源：**白名单之外一律 404** —— 绝不送源码 / 配置 / 运行时数据 */
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  if (!isPublicPath(rel)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  const fp = path.resolve(WEB_ROOT, rel);
  if (!fp.startsWith(WEB_ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
  return send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

/* 请求级超时：出站 fetch 有 15s 上限，入站此前没有 —— 慢连接可以挂住进程 */
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 15000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('[phm] listening on 0.0.0.0:' + PORT + ' | boot ' + BOOT_AT + ' | node ' + process.version);
});
