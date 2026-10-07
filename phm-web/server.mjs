/* P.H.M. Standard —— 静态前端 + 轻量 Node 服务
 * 零依赖（只用 Node 内置模块），沙箱里装不上任何东西也能跑。
 *
 * 职责边界（刻意做小）：
 *   1. 托管静态前端（index.html / robots.txt）
 *   2. 对外提供受限的写入网关 /api/*：校验 → 限流 → 转发到云数据库
 *   3. 服务端自有的持久化（JSON 文件），用于限流计数与可信统计
 *
 * 为什么需要它：前端直连数据面时，任何规则都能被绕过；这里把「写」收归一处，
 * 至少做到校验与限流。
 *
 * ⚠ 权限真相（实测过，别再想当然）：
 *   网关与浏览器持同一把 publishableKey、同为 anon，连 Referer 都能被非浏览器客户端伪造，
 *   所以**网关无法在数据库层面被区分出来**。因此最初「网关是唯一写入口」只是**规范**，
 *   不是防线 —— 攻击者绕开网关直连 REST 一样能写能改（实测 201/204）。
 *
 *   真正的封堵靠 **phm_put_chart()**（SECURITY DEFINER + 写入凭据）：
 *   已对 anon / authenticated 撤销 phm_charts 的 INSERT/UPDATE/DELETE，
 *   数据库侧只剩「带凭据的 RPC」这一条写路径。凭据只在本进程内，不进前端产物。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { reviewContribution, grosslyMismatched, recompute } from './lib/review.mjs';
/* 云数据库访问层（配置 + 写入凭据 + 两个写 RPC）都在 lib/cloud.mjs，
   与 tools/ 下的批量脚本共用同一份 —— 别再复制一份到这里。 */
import { dbFetch, dbPutChart, dbPutScores, dbPageCharts, dbSummary, SORTABLE } from './lib/cloud.mjs';
import { ENGINE_VER } from './public/js/engine.js';

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

/* ── 云数据库访问 → 见 lib/cloud.mjs ──
 * 数据库地址、publishableKey、写入凭据、dbFetch / dbPutChart / dbPutScores
 * 全部在那边，本文件只负责「路由 + 校验 + 静态托管」。 */

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
/* /api/analyze 的独立配额 —— 它是全站最贵的路径（下载 60MB + 同步跑引擎）。
   分开计数，避免它把普通写入的配额吃光，也便于单独调严。 */
const ANALYZE_PER_IP = 10, ANALYZE_GLOBAL = 60, ANALYZE_INFLIGHT = 3;
let analyzeInflight = 0;
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

/* /api/stats 的配额。
   它是只读的、便宜的，但没有理由允许被高频刷（审计实测连发 5 次全部 200）。
   页面只在加载时调一次，60 次/分钟/IP 绰绰有余。
   键前缀 'S:' 与写入('' 前缀)、分析('A:' 前缀)分开计数，互不挤占。 */
const STATS_PER_IP = 60;
function statsOk(ip) {
  return withStore((s) => {
    const now = Date.now();
    s.hits = s.hits || {};
    const key = 'S:' + ip;
    const arr = (s.hits[key] || []).filter(t => now - t < RL_WINDOW);
    if (arr.length >= STATS_PER_IP) { s.hits[key] = arr; return false; }
    arr.push(now);
    s.hits[key] = arr;
    return true;
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* ⚠ 静态白名单 —— 只允许这些文件被送出。
   之前只做了「路径不以 ROOT 开头则拒」，结果 server.mjs / package.json /
   server-store.json 全都躺在 ROOT 里被当静态资源送出去（含数据库地址、密钥、访客 IP）。
   目录穿越防护 ≠ 白名单。这是安全修复的核心。
   现在拆成两层：少量精确允许的根文件 + 仅限 public/js、public/css 下的安全扩展名。 */
const PUBLIC_FILES = new Set(['index.html', 'app.html', 'user.html', 'charter.html', 'data.html',
  'settings.html', 'en.html', 'robots.txt', 'favicon.ico', 'privacy.html', 'terms.html',
  '404.html', 'sitemap.xml', 'og.png', 'og-en.png']);
/* ⚠ PUBLIC_DIRS 每加一个目录，都是往互联网上多开一扇门。
   加 data/ 是为了 ref-com.json（社区参照集生成物，生成器只往这里写它）；
   这个目录里不允许出现任何其他文件 —— 有的话就该把它挪出 public/。 */
const PUBLIC_DIRS = ['js/', 'css/', 'data/'];             /* 只暴露这三个子目录 */
const SAFE_EXT = new Set(['.js', '.css', '.png', '.svg', '.ico', '.webp', '.woff2', '.json']);
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
function sendFile(res, fp, longCache, req) {
  try {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).toLowerCase();
    const isHtml = ext === '.html';
    /* 缓存策略：
       · HTML → no-cache，每次校验。它是唯一「内容会变」的入口，缓存了会看到旧页面。
       · js/css/图片/参照集 → 长缓存 + immutable。前端用**版本化 URL**（/js/engine.js?v=…）
         破缓存 —— 版本号一变 URL 就变，所以这里可以放心长缓存，
         不需要再手工维护「改引擎要记得换 ?v=」这类同步点。
       · 其余（txt/xml 等）→ 1 小时，够用又不会卡住更新。 */
    const cc = isHtml ? 'no-cache'
      : (longCache ? 'public, max-age=604800, immutable' : 'public, max-age=3600');
    const head = Object.assign({
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cc,
      'vary': 'accept-encoding',
    }, SEC_HEADERS);
    /* ── gzip ──
       收益主要在两处：index.html（约 120 KB 源码）与参照集 ref-com.json（约 730 KB）。
       参照集是前端**首次分析时才拉**的，裸传 730 KB 在移动网络上体验很差；
       gzip 后约 200 KB。压缩结果按文件 mtime 缓存，不重复压。
       ⚠ 只压文本类，且只在客户端明确接受 gzip 时才压（否则老客户端会拿到乱码）。 */
    const gzOk = GZIP_EXT.has(ext) && /\bgzip\b/i.test((req && req.headers['accept-encoding']) || '');
    if (gzOk) {
      let gz = _gzCache.get(fp);
      const mt = fs.statSync(fp).mtimeMs;
      if (!gz || gz.mt !== mt) { gz = { mt, buf: zlib.gzipSync(buf, { level: 6 }) }; _gzCache.set(fp, gz); }
      /* 小文件压了反而更大（gzip 头 + 膨胀），这时直接发原文 */
      if (gz.buf.length < buf.length) {
        head['content-encoding'] = 'gzip';
        head['content-length'] = gz.buf.length;
        res.writeHead(200, head);
        return res.end(gz.buf);
      }
    }
    head['content-length'] = buf.length;
    res.writeHead(200, head);
    res.end(buf);
  } catch { send404(res); }
}
/* 压缩缓存：key = 绝对路径，value = {mt, buf}。文件改了 mtime 变，自动失效。 */
const _gzCache = new Map();
const GZIP_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.xml', '.txt', '.webmanifest']);
/* 404 交一张真正的错误页（原来只回纯文本 "not found"，没有导航也没有回首页的路）。
   ⚠ 用 text/html + 状态码 404 下发；页面自身带 noindex，不该被搜索引擎收录。 */
function send404(res) {
  try {
    const buf = fs.readFileSync(path.join(WEB_ROOT, '404.html'));
    res.writeHead(404, Object.assign({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
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

    /* 走到这里的只剩 /api/scores（contribute 已在上面的分支 return） */
    const required = ['chart_name'];
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
          /* 差异**过大** → 不是「客户端引擎过期」，而是**根本不是同一张谱**
             （典型：把某曲 IN 的特征提交到同曲 HD 的 chart_id 上）。
             此时必须拒绝 —— 服务端算的值虽然本身正确，写进去等于坐实错误关联。 */
          const huge = grosslyMismatched(diffs);
          if (huge.length) {
            failed++;
            notes.push('提交特征与该谱号严重不符（疑似同名不同难度）→ 拒绝写入: '
              + huge.map(d => d.field).join(','));
            continue;
          }
          /* 差异在容差内 = 客户端引擎过期 → 仍用服务端值写入 */
          const wr = await dbPutChart(trusted);
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

    const wr = await dbPutScores(clean);
    return send(res, 200, JSON.stringify({
      received: rows.length, accepted: clean.length, rejected: rows.length - clean.length,
      written: wr.ok, fail: wr.fail.length ? wr.fail : undefined,
      table: 'phm_scores', source: 'server-proxy',
    }));
  }
  /* 聚合统计（服务端转发 RPC，前端可不再直连） */
  if (p === '/api/stats') {
    if (!(await statsOk(ip))) {
      return send(res, 429, JSON.stringify({
        error: '请求过于频繁（每分钟最多 ' + STATS_PER_IP + ' 次）',
      }));
    }
    const r = await dbFetch('/rpc/phm_stats', { method: 'POST', body: '{}' });
    return send(res, r.ok ? 200 : 502, r.ok ? (r.body || '{}') : JSON.stringify({ error: 'stats unavailable', detail: r.body || r.error }));
  }
  /* 批量读定数缓存 → { "12345": {ref_const:…}, … }
   * 给**不加载云 SDK** 的页面用（英文页只做只读展示，没必要引入整个 SDK）。
   * 表本身对匿名可读，所以这里不是权限提升，只是把「一次拿一批」变成一个请求。
   * 与 /api/stats 共用同一份只读配额。 */
  /* ── /api/charts ── 两种读法，共用同一份只读配额
   *
   * ① `?ids=1,2,3`            → 按 id 批量取（前端「读了缓存再渲染」用的，老路径）
   * ② `?page=1&pageSize=50`   → **真分页**（数据管理页、任何"看全库"的需求）
   *    支持 sort / order / q / level / only / build，
   *    回 `{rows,total,page,pageSize,pages}`，total 来自 Content-Range（真总数）。
   *
   * 【为什么必须补第 ② 种】只有第 ① 种时，"看全库"只能 `limit=100000`
   *   一次拉回来 —— 649 行还行，几万行就是几十 MB 的响应 + 浏览器全量渲染。
   *   分页不是好看，是库变大之后还能用。
   */
  if (p === '/api/charts' && url.searchParams.has('page')) {
    if (!(await statsOk(ip))) {
      return send(res, 429, JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
    }
    const qp = url.searchParams;
    const sort = qp.get('sort') || 'chart_id';
    /* ⚠ 排序字段必须白名单。这里直接进查询串，不挡就是把查询表达式交给调用方。 */
    if (!SORTABLE.has(sort)) {
      return send(res, 400, JSON.stringify({ error: 'sort 不在允许的字段里', allowed: [...SORTABLE] }));
    }
    const res2 = await dbPageCharts({
      page: qp.get('page'), pageSize: qp.get('pageSize'),
      sort, order: qp.get('order') === 'desc' ? 'desc' : 'asc',
      q: qp.get('q') || '', level: qp.get('level') || '',
      only: qp.get('only') || '', build: qp.get('build') || ENGINE_VER,
    });
    if (!res2) {
      return send(res, 502, JSON.stringify({ error: 'cache unavailable' }));
    }
    return send(res, 200, JSON.stringify({
      rows: res2.rows, total: res2.total, page: res2.page,
      pageSize: res2.pageSize, pages: res2.pages,
      sort, order: qp.get('order') === 'desc' ? 'desc' : 'asc', engineVer: ENGINE_VER,
    }));
  }

  /* ── /api/summary ── 全库汇总（数据管理页顶部）。
     注意它要扫全表 —— 所以**不是**按 IP 高频配额，而是与 stats 共用一份只读配额，
     并且故意不放进任何自动轮询路径。 */
  if (p === '/api/summary') {
    if (!(await statsOk(ip))) {
      return send(res, 429, JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
    }
    const sum = await dbSummary();
    if (!sum) return send(res, 502, JSON.stringify({ error: 'cache unavailable' }));
    return send(res, 200, JSON.stringify(Object.assign({ engineVer: ENGINE_VER }, sum)));
  }

  if (p === '/api/charts') {
    if (!(await statsOk(ip))) {
      return send(res, 429, JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
    }
    const ids = String(url.searchParams.get('ids') || '')
      .split(',').map(x => Number(x.trim()))
      .filter(x => Number.isInteger(x) && x > 0)
      .slice(0, 60);                                    /* 一次最多 60 个，别把 URL 撑爆 */
    if (!ids.length) return send(res, 400, JSON.stringify({ error: 'ids 参数无效' }));
    const r = await dbFetch('/phm_charts?chart_id=in.(' + ids.join(',') + ')&select=*');
    if (!r.ok || !r.body) {
      return send(res, 502, JSON.stringify({ error: 'cache unavailable', detail: r.body || r.error }));
    }
    let rows = [];
    try { rows = JSON.parse(r.body); } catch { return send(res, 502, JSON.stringify({ error: 'cache 响应无法解析' })); }
    const map = {};
    for (const row of rows) map[row.chart_id] = row;
    return send(res, 200, JSON.stringify(map));
  }

  /* ★ 按 chart_id 直接算定数 —— 「搜索即出数」
   *
   * 【为什么只有服务端能做】
   * 浏览器拿不到谱面文件：Phira 的文件 CDN 没开 CORS，前端 fetch 必失败
   * （这是早期版本「点算必失败」的根因）。服务端不受这个限制，
   * 而它已经持有与浏览器同一份引擎 —— 于是「搜到 → 下载 → 拖回来」
   * 这三步可以合成一步。
   *
   * 安全性：本接口**不接收任何客户端算出来的数值**，只用 chart_id，
   * 由服务端自己下载、自己算、自己入库 —— 与复核链路同一套可信来源。
   *
   * ⚠ 这个接口是全站**代价最高**的路径：未命中缓存时要下载最多 60MB 的谱面包
   *   并跑完整引擎（zipParse 是同步计算，会阻塞事件循环）。因此它有**三重**约束：
   *   ① 每 IP 每分钟 10 次（比写入接口更严）
   *   ② 全局在途分析最多 3 个 —— 超出直接 503，让调用方稍后重试
   *   ③ 复用全局每分钟配额，防止有人换 IP 刷
   *   没有这三条时，枚举未缓存 chart_id 就能放大带宽/内存/CPU 到打死本进程。 */
  if (p === '/api/analyze') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));

    const box = await withStore(s => {
      const now = Date.now();
      s.hits = s.hits || {};
      for (const k of Object.keys(s.hits)) {
        const arr = (s.hits[k] || []).filter(t => now - t < RL_WINDOW);
        if (arr.length) s.hits[k] = arr; else delete s.hits[k];
      }
      const key = 'A:' + ip;
      const arr = s.hits[key] || [];
      let global = 0;
      for (const k of Object.keys(s.hits)) if (k[0] === 'A:') global += s.hits[k].length;
      if (arr.length >= ANALYZE_PER_IP) return { ok: false, why: 'per-ip' };
      if (global >= ANALYZE_GLOBAL) return { ok: false, why: 'global' };
      arr.push(now); s.hits[key] = arr;
      return { ok: true };
    });
    if (!box.ok) {
      return send(res, 429, JSON.stringify({
        error: box.why === 'per-ip'
          ? '算得太频繁了（每分钟最多 ' + ANALYZE_PER_IP + ' 次），请稍后再试'
          : '当前请求过多，请稍后再试',
      }));
    }
    if (analyzeInflight >= ANALYZE_INFLIGHT) {
      return send(res, 503, JSON.stringify({
        error: '服务器正在计算其他谱面（最多同时 ' + ANALYZE_INFLIGHT + ' 个），请几秒后重试',
        retryAfter: 3,
      }));
    }

    const body = await readBody(req);
    const cid = body && Number(body.chart_id);
    if (!Number.isInteger(cid) || cid < 1) {
      return send(res, 400, JSON.stringify({ error: 'chart_id 无效' }));
    }
    analyzeInflight++;
    try {
      const ex = await dbFetch('/phm_charts?chart_id=eq.' + cid + '&select=*');
      if (ex.ok && ex.body && ex.body !== '[]') {
        return send(res, 200, JSON.stringify({ cached: true, data: JSON.parse(ex.body)[0] }));
      }
      const trusted = await recompute(cid);
      const wr = await dbPutChart(trusted);
      /* 写缓存失败**不该毁掉这次计算**：值是服务端算的、本身正确，
         只是没能共享给别人。照常把结果返回，但把失败显式带出去 ——
         既不静默降级，也不让用户白等一次下载。 */
      if (!wr.ok) {
        return send(res, 200, JSON.stringify({
          cached: false, data: trusted,
          cacheWrite: { ok: false, detail: String(wr.fail[0] || '').slice(0, 120) },
        }));
      }
      return send(res, 200, JSON.stringify({ cached: false, data: trusted, cacheWrite: { ok: true } }));
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: String(e.message || e).slice(0, 140) }));
    } finally {
      analyzeInflight--;
    }
  }

  /* ── 干净 URL ──
     站点已经拆成多页（/app 工作台、/charter 谱师、/user 玩家），
     但不想让用户看到 .html 后缀 —— 分享链接短一点、也少一个改动点
     （换实现时 URL 不变）。映射是**显式白名单**，不是通配：
     将来加页面必须同时加进 PUBLIC_FILES，不会因为忘了写路由就暴露文件。 */
  const CLEAN = { '/app': 'app.html', '/user': 'user.html', '/charter': 'charter.html',
                  '/data': 'data.html', '/settings': 'settings.html',
                  '/privacy': 'privacy.html', '/terms': 'terms.html' };
  const cleanHit = CLEAN[p];

  /* 静态资源：**白名单之外一律 404** —— 绝不送源码 / 配置 / 运行时数据 */
  const rel = cleanHit || (p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, ''));
  if (!isPublicPath(rel)) return send404(res);
  const fp = path.resolve(WEB_ROOT, rel);
  if (!fp.startsWith(WEB_ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  /* js/css/图片内容稳定且前端用版本化 URL 引用 → 可以长缓存 */
  /* ⚠ .json 也进长缓存：public/data/ref-com.json 是**生成物**，靠 ?v= 破缓存，
    内容不会就地变。注意 data/ 目录里除了参照集没有别的东西（见 PUBLIC_DIRS）。 */
  const longCache = /\.(js|css|png|svg|ico|webp|woff2|json)$/i.test(rel);
  /* 页面 HTML 一律 no-cache（sendFile 内部按扩展名判断），
     所以干净 URL 不需要额外处理缓存头。 */
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp, longCache, req);
  return send404(res);
});

/* 请求级超时：出站 fetch 有 15s 上限，入站此前没有 —— 慢连接可以挂住进程 */
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 15000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('[phm] listening on 0.0.0.0:' + PORT + ' | boot ' + BOOT_AT + ' | node ' + process.version);
});
