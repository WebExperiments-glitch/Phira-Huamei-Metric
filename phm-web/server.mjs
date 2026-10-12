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
import { dbFetch, dbPutChart, dbPutScores, dbPageCharts, dbSummary, SORTABLE, DB, WRITE_SECRET } from './lib/cloud.mjs';
/* huamei 数据飞轮的身份与成绩校验 —— 单独一个模块，见 lib/hm.mjs 顶部。 */
import { appIdFromKey, makeWhoami, validatePlay } from './lib/hm.mjs';
/* 自建账号：注册 / 登录 / 自签 token。见 lib/hm-accounts.mjs 顶部。 */
import { register as hmRegister, login as hmLogin, verifyOwnToken, claimsOwnIssuer } from './lib/hm-accounts.mjs';
import { makeDownloadHandler, DOWNLOAD_FILES } from './lib/download.mjs';
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

/* ══════════════════════════════════════════════════════════════
 * huamei 数据飞轮的两条 API
 * ══════════════════════════════════════════════════════════════
 * 契约：docs/规范/数据飞轮契约.md（**改契约先改文档**）
 *
 *   /api/phira/*     取谱代理 —— 客户端只认我们，不持 Phira 凭据
 *   /api/hm/play     成绩接收 —— 逐音符判定
 *
 * 设计要点：
 *   · Phira 侧只放行**只读**方法，且**剥掉**入站的 Authorization。
 *     绝不把用户的 huamei token 转给第三方。
 *   · 成绩写入只走 `hm_put_play()`（SECURITY DEFINER + 写入凭据），
 *     与 phm_charts / phm_scores 同一条防线：不给 anon 任何直连写权限。
 *   · 身份来自用户自己的 huamei token（调云端 `user/me` 换 sub），
 *     服务端**不存储**用户凭据。 */
const PHIRA_API = 'https://api.phira.cn';
const SITE_ORIGIN = 'https://phm.app.workbuddy.host';
const CLOUD_AUTH = SITE_ORIGIN + '/.cloud/auth/v1';
/* ── huamei 数据飞轮：实现全在 lib/hm.mjs，这里只做「装配 + 路由」──
 * 把站点相关配置（站点根、publishableKey、Referer）注进去，拿到两个入口：
 *   `hmWhoami(token)`   —— token → 身份（主路云端 `user/me`，兜底本地解 JWT）
 *   `validatePlay(body)` —— 一局上报 → 规范化后的行（`{row, warn}` 或硬伤错误）
 *
 * ⚠ 原先这两件事的实现内联在本文件里。挪出去有两个原因：
 *   一、本文件有 900 行上限，塞在这里会越线；
 *   二、放在一起会让人误以为 /api/hm/play 和 /api/contribute 共用一套防线 ——
 *   其实信任模型完全不同（那边服务端能自己复算谱面，这边拿不到谱面字节）。 */
const APP_ID = appIdFromKey(DB.key);
const hmWhoami = makeWhoami({
  cloudAuth: CLOUD_AUTH,
  siteOrigin: SITE_ORIGIN,
  referer: DB.referer,
  key: DB.key,
  appId: APP_ID,
  /* 自建账号的 token 走**真验签**（服务端独有密钥）。
     ⚠ 必须传这两个：少了 `claimsOwnIssuer`，一个标了我们 iss 却签得不对的 token
        会掉到下面「不验签也认」的兜底路径上去 —— 那比没有自签体系更糟。 */
  verifyOwnToken,
  claimsOwnIssuer,
});


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
/* ⚠ 白名单里**必须包含 source**：sanitize() 只保留 LIMITS / TEXTS 里出现过的键，
   漏掉就等于静默丢弃。/user 提交的成绩带 source:'phira-recent'，早先被洗掉后
   库里一律是默认值 manual —— 之后再也分不清"手打的"和"从 Phira 导入的"。
   同类字段（client_id 等）新增时记得同时加到这里，否则同样会被悄悄丢掉。 */
const TEXTS = { name: 160, level: 60, chart_name: 120, chart_diff: 8, chart_level: 60, phira_user_name: 60, engine_ver: 32, client_id: 64, source: 32 };

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
    /* 顺手回收过期键，避免文件随 IP 无限膨胀。
       ⚠ 全局计数**只统计写桶**（无前缀的键）。
       以前这里把所有键都加起来，于是 /api/stats（'S:'）和 /api/analyze（'A:'）
       的计数也被算进「写请求全局上限 240/分」—— 流量一大，正常写入会被
       只读统计请求挤掉。三个配额本来就是分开设计的，这里必须一致。 */
    for (const k of Object.keys(s.hits)) {
      const arr = (s.hits[k] || []).filter(t => now - t < RL_WINDOW);
      if (arr.length) {
        s.hits[k] = arr;
        /* 'S:'=统计、'A:'=分析，各有独立配额，不计入写请求的全局桶 */
        if (!/^[SA]:/.test(k)) global += arr.length;
      } else delete s.hits[k];
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
  '.json': 'application/json; charset=utf-8',
  /* ⚠ 字体必须给对 MIME。不给的话是 application/octet-stream，
     部分浏览器会**拒绝**加载（@font-face 直接静默失败，页面掉回系统字体，
     控制台只有一条不显眼的警告）—— 这种"改了没生效"最难查。 */
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* ⚠ 静态白名单 —— 只允许这些文件被送出。
   之前只做了「路径不以 ROOT 开头则拒」，结果 server.mjs / package.json /
   server-store.json 全都躺在 ROOT 里被当静态资源送出去（含数据库地址、密钥、访客 IP）。
   目录穿越防护 ≠ 白名单。这是安全修复的核心。
   现在拆成两层：少量精确允许的根文件 + 仅限 public/js、public/css 下的安全扩展名。 */
const PUBLIC_FILES = new Set(['index.html', 'app.html', 'user.html', 'charter.html', 'data.html',
  'settings.html', 'robots.txt', 'favicon.ico', 'privacy.html', 'terms.html',
  '404.html', 'sitemap.xml', 'og.png', 'version.html', 'download.html']);
/* ⚠ 加页面**必须同时改两处**：PUBLIC_FILES（放行文件）+ 下面的 CLEAN（干净 URL）。
   只改一处要么 404、要么页面存在但没有 /xxx 这样的地址。 */

/* 注：曾经还有一个独立的英文页 en.html。i18n 上线后它是**冗余**的 ——
   全站一套代码两种语言，再留一个手写的英文页就变成两份必然漂移的实现，
   而且「English」入口和设置页里的语言开关重复。已删除。 */
/* ⚠ PUBLIC_DIRS 每加一个目录，都是往互联网上多开一扇门。
   加 data/ 是为了 ref-com.json（社区参照集生成物，生成器只往这里写它）；
   这个目录里不允许出现任何其他文件 —— 有的话就该把它挪出 public/。 */
/* ⚠ 每加一个目录都是往互联网上多开一扇门。fonts/ 是 2026-10-11 加的 ——
   标题用的思源宋体子集（83KB woff2）要自托管：CSP 里 font-src 只允许 'self'，
   而且中文站依赖 CDN 字体既慢又不可靠。这个目录里只应有裁好的 woff2。 */
const PUBLIC_DIRS = ['js/', 'css/', 'data/', 'fonts/'];
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
       · 带 ?v= 的 js/css/图片/参照集 → 长缓存 + immutable。版本号一变 URL 就变，
         所以可以放心长缓存，不需要再手工维护「改引擎要记得换 ?v=」这类同步点。
       · **不带 ?v= 的 js / json → no-cache**。它们是模块间相对 import 的 URL，
         长缓存既会让更新滞后，又会让同一模块产生两个实例（见调用处的注释）。
       · 其余（txt/xml 等）→ 1 小时，够用又不会卡住更新。 */
    /* ⚠ `immutable` 已经去掉了 —— 它是 2026-10-11 一次真实事故的原因。
       原策略「?v= 变了 URL 就变，所以可以 immutable 7 天」**前提是每次内容变化
       都必须换版本号**。我那次连着部署了两遍 V0.9.4.0（内容不同），于是：
         · 第一次那份被浏览器按 immutable 缓存 7 天
         · immutable 连**强刷都不重新校验** → 用户手里永远是旧模块
         · 页面报「does not provide an export named ...」→ 模块链断 → 下半页空白
       改成 1 小时 + must-revalidate：既保住缓存收益，又能**自己好**（最多一小时）。
       配上下面新加的 ETag，重校验是 304，不会重下 730KB 的参照集。 */
    const cc = isHtml ? 'no-cache'
      : (longCache ? 'public, max-age=3600, must-revalidate'
        : ((ext === '.js' || ext === '.json') ? 'no-cache' : 'public, max-age=3600'));

    /* ETag：由「大小 + mtime」算出（弱校验即可 —— 内容会随 accept-encoding 变）。
       有了它，must-revalidate 的代价从「重下整个文件」降到「一次 304」。
       ⚠ 以前没有 ETag，所以长缓存的资源一旦过期就只能整份重传。 */
    const st = fs.statSync(fp);
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    const head = Object.assign({
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cc,
      'etag': etag,
      'vary': 'accept-encoding',
    }, SEC_HEADERS);
    /* 客户端带了匹配的 ETag → 304，不发 body */
    if ((req && req.headers['if-none-match'] || '').split(',').some(function (t) {
      return t.trim() === etag; })) {
      delete head['content-length'];
      res.writeHead(304, head);
      return res.end();
    }
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
/* 构建产物下载（Windows 客户端）—— 逻辑在 lib/download.mjs。
   ⚠ 必须装配在 SEC_HEADERS 与 send404 之后：工厂要这两样。 */
const serveDownload = makeDownloadHandler({
  dir: path.join(ROOT, 'downloads'),
  secHeaders: SEC_HEADERS,
  notFound: send404,
});

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

  /* ── huamei：取谱代理 ──
     客户端把 `API_URL` 指到这里，于是 Phira 的整个 API 面都经我们这一跳。
     ⚠ 只放行 GET/HEAD；⚠ **剥掉入站 Authorization** —— 那是用户的 huamei
     token，绝不能转给第三方。 */
  if (p === '/api/phira' || p.startsWith('/api/phira/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 403, JSON.stringify({ error: 'only GET/HEAD' }));
    }
    if (!(await statsOk(ip))) {
      return send(res, 429, JSON.stringify({ error: 'rate limit' }));
    }
    const sub = p.replace(/^\/api\/phira/, '') || '/';
    const target = PHIRA_API + sub + (url.search || '');
    /* ⚠ 条件请求头必须转发。
       客户端用 HEAD `/terms/{locale}.txt` + `If-Modified-Since` 判断
       「服务条款有没有变」—— 只靠响应里的 `Last-Modified`。
       把这两个头截掉，客户端会直接报
       `获取服务条款和隐私政策内容失败 / invalid last-modified header`。
       （实测：代理只回 content-type 时，条款页永远打不开。） */
    const fwd = {};
    for (const h of ['if-modified-since', 'if-none-match']) {
      if (req.headers[h]) fwd[h] = req.headers[h];
    }
    try {
      const up = await fetch(target, {
        method: req.method,
        headers: Object.assign({
          'accept': 'application/json,text/plain,*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'user-agent': 'phm-huamei/1.0 (+https://phm.app.workbuddy.host)',
        }, fwd),
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const buf = Buffer.from(await up.arrayBuffer());
      /* 回程头白名单 —— **不能只回 content-type**。
         `last-modified` / `etag` 是条件请求的判据；
         `content-length` 给 HEAD 用；`accept-ranges` 留给续传。 */
      const out = { 'content-type': up.headers.get('content-type') || 'application/json; charset=utf-8' };
      for (const h of ['last-modified', 'etag', 'content-length', 'accept-ranges']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      out['cache-control'] = 'no-store';
      res.writeHead(up.status, Object.assign(out, SEC_HEADERS));
      return res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: 'upstream: ' + String(e.message || e).slice(0, 120) }));
    }
  }

  /* ── huamei：成绩接收 ──
     身份 = 用户自己的 huamei token；写入只经 hm_put_play()（SECURITY DEFINER）。 */
  /* ── huamei 账号：注册 / 登录 ──
     这是 /api/hm/* 下**唯一**不要求已登录的两条 —— 它们的全部意义就是
     「把未登录的人变成已登录的」。所以限流和普通写入共用一桶，
     但错误码要分开，客户端要靠它决定「该注册还是该重试」。

     ⚠ 登录失败只回 `bad_credentials`，**不区分**「账号不存在」和「密码错」——
       否则这里成了一个账号枚举接口（拿字典跑一遍就知道谁注册过）。
       注册侧的 `email_taken` 无法避免：注册本来就必须拒绝重复邮箱。 */
  if (p === '/api/hm/register' || p === '/api/hm/login') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (!(await rateOk(ip))) {
      return send(res, 429, JSON.stringify({ error: 'rate limit: 每分钟最多 ' + RL_MAX + ' 次写入' }));
    }
    const body = await readBody(req);
    const email = String((body && body.email) || '').trim();
    const password = String((body && body.password) || '');
    if (!email || !password) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'email_and_password_required' }));
    }
    const r = p === '/api/hm/register'
      ? await hmRegister(email, password)
      : await hmLogin(email, password);
    if (r.error) {
      /* 400 = 调用方自己的输入不合法（改一下就能好）；
         401 = 凭据不被接受（账号已被注册 / 邮箱或密码不对 / 库里没这行）。 */
      const clientErr = (r.error === 'email_invalid' || r.error === 'password_invalid');
      const payload = { ok: false, error: r.error };
      /* detail 只在**输入不合法**时给 —— 那是帮助用户改对的提示。
         凭据类错误的 detail 可能是库的原始报文，含表名/列名，不外泄。 */
      if (clientErr && r.detail) payload.detail = r.detail;
      return send(res, clientErr ? 400 : 401, JSON.stringify(payload));
    }
    /* token 只在响应体里回一次，**不落服务端日志** —— 它是 bearer 凭据。 */
    return send(res, 200, JSON.stringify({ ok: true, sub: r.sub, token: r.token }));
  }

  if (p === '/api/hm/play') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (!(await rateOk(ip))) {
      return send(res, 429, JSON.stringify({ error: 'rate limit: 每分钟最多 ' + RL_MAX + ' 次写入' }));
    }
    /* ⚠⚠ **不要依赖入站的 `Authorization` 头。**
       实测（2026-10-11）：同样的 token，本机整条链全绿，线上**每一步都 401**，
       且降级解析 JWT 时报 `no_sub` —— 说明**线上收到的那个值根本不是我们发出去的 token**。
       最一致的解释：托管边缘把入站的 `Authorization` 头吃掉/改掉了
       （它自己也要用这个头做鉴权）。这同时解释了为什么调 `/user/me`
       连模拟全套浏览器头都 401：带过去的是**另一个**值。

       所以：**优先读自定义头 `x-hm-token`**，`Authorization` 只作兜底。 */
    const hdrToken = String(req.headers['x-hm-token'] || '').trim();
    const authToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = hdrToken || authToken;
    const tokenSrc = hdrToken ? 'x-hm-token' : (authToken ? 'authorization' : 'none');
    if (!token) return send(res, 401, JSON.stringify({ ok: false, error: 'token_required' }));
    const who = await hmWhoami(token);
    if (!who.sub) {
      return send(res, 401, JSON.stringify({
        ok: false,
        error: 'token_invalid',
        /* 排障用：**不含 token 本身**，只暴露它的来源与形状
           （长度、有几段），以及尝试过的头组合与上游状态码。 */
        detail: who.err === 'all_variants_failed'
          ? (who.tried || '') + (who.jwt ? ' jwt=' + who.jwt : '')
          : who.err,
        src: tokenSrc,
        len: token.length,
        dots: token.split('.').length - 1,
      }));
    }
    const ownerId = who.sub;

    let body;
    try { body = await readBody(req, 1024 * 1024); }
    catch (e) { return send(res, 413, JSON.stringify({ error: 'body_too_large' })); }

    const v = validatePlay(body);
    if (v.error) {
      /* 拒收也要留痕：连"为什么拒"一起写服务端日志，否则线上只有 409 一个数字。 */
      console.warn('[hm/play] 拒收 %s chart=%s notes=%s counts=%j', v.error, body && body.chart_id, body && body.chart_notes, body && body.counts);
      return send(res, v.code || 400, JSON.stringify({ ok: false, error: v.error }));
    }
    /* 一致性告警：**不挡写入**，但必须回传（客户端会写进 data/huamei-login.log）。
       见 lib/hm.mjs 的 validatePlay 里那段「只记账，不拒收」的说明。 */
    const warn = Array.isArray(v.warn) ? v.warn : [];
    if (warn.length) {
      console.warn('[hm/play] 一致性告警 chart=%s notes=%s counts=%j mc=%s → %s',
        body.chart_id, body.chart_notes, body.counts, body.max_combo, warn.join(' | '));
    }

    const r = await dbFetch('/rpc/hm_put_play', {
      method: 'POST',
      body: JSON.stringify({ p_secret: WRITE_SECRET, p_row: Object.assign(v.row, { owner_id: ownerId }) }),
    }, 20000, 4096);
    if (!r.ok) {
      return send(res, 500, JSON.stringify({
        ok: false, error: 'store_failed',
        detail: String(r.body || r.error || '').slice(0, 160),
      }));
    }
    let playId = null;
    try { playId = JSON.parse(r.body).play_id; } catch { /* 拿不到 id 不算失败 */ }
    /* 回报身份是怎么定的：`verified` 为真表示走的是云端 `user/me` 正路，
       假表示走了本地解 JWT 的降级路径（见 lib/hm.mjs 的 subFromJwt 信任边界说明）。
       `warn` 只在有差异时出现 —— 客户端把它记进日志。 */
    return send(res, 200, JSON.stringify({
      ok: true, play_id: playId, verified: who.verified === true,
      ...(warn.length ? { warn } : {}),
    }));
  }

  /* 写入网关：校验 + 限流 + 落库 */
  if (p === '/api/contribute' || p === '/api/scores') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    /* ⚠ 必须 await。withStore() 返回的是 **Promise**，而 Promise 永远是真值 ——
       `if (!rateOk(ip))` 恒为 false，429 从来没出现过。只读路径用的是
       `await statsOk(ip)`（所以那边是好的），写路径漏了 await，等于写接口裸奔。
       这个 bug 是 2026-10-11 审计实测出来的：连打 35 次非法贡献全部 200。 */
    if (!(await rateOk(ip))) {
      return send(res, 429, JSON.stringify({ error: 'rate limit: 每分钟最多 ' + RL_MAX + ' 次写入' }));
    }
    const body = await readBody(req);
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.rows) ? body.rows : null);
    if (!rows) return send(res, 400, JSON.stringify({ error: 'body must be an array or {rows:[]}' }));
    if (rows.length > 500) return send(res, 413, JSON.stringify({ error: '单次最多 500 行' }));

    /* ⚠ 两条路径的必填字段**不一样**，别共用一份。
       早先这里对两条路径都用 `['chart_name']`，而 /api/contribute 的前端发的是
       `name`（与 phm_charts 表的列名一致）—— 于是**每一次拖谱贡献都被整行作废**：
       实测 POST {chart_id,name,ref_const} → {"accepted":0,"rejected":1}。
       定数缓存因此长期停止增长，而 /api/analyze（搜索后点「算」）不走这条校验，
       所以症状看起来像"有时候能算出来、有时候不能"。
       定数是按 chart_id 关联的，谱名只是展示字段，不该当必填。 */
    const required = p === '/api/contribute' ? ['chart_id'] : ['chart_name'];
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
          /* 差异**过大** → 有两种可能，必须分开处理：
               ① 根本不是同一张谱（把某曲 IN 的特征提交到同曲 HD 的谱号上）
               ② 客户端**没有排除自己**：浏览器拖入谱面时不知道 chart_id，
                  自然不会从参照集里剔掉这张谱，于是它的 ref_const 会系统性偏一点。
                  两个口径差 1 级以上并不罕见（约两成），而这跟"是不是同一张谱"无关。
             所以先按「不排除自己」的口径再算一次，对得上就说明是 ② ——
             **接受，但仍然落库排除口径的服务端值**（那个才是权威值）。
             只有两个口径都对不上，才判定为 ① 并拒绝。 */
          const huge = grosslyMismatched(diffs);
          if (huge.length) {
            let rescued = null;
            try {
              const alt = await reviewContribution(row, { noExclude: true });
              if (!grosslyMismatched(alt.diffs).length) rescued = alt;
            } catch (e) { /* 兜底口径失败不影响主判定 */ }
            if (!rescued) {
              failed++;
              notes.push('提交特征与该谱号严重不符（疑似同名不同难度）→ 拒绝写入: '
                + huge.map(d => d.field).join(','));
              continue;
            }
            mismatched++;
            notes.push('客户端未排除自身参照（已按服务端排除口径落库）');
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
    /* ⚠ 失败时**不要**把数据库响应正文带给客户端 —— 那里面可能有
       PostgREST 的报错细节（表名、字段、约束）。日志里留，对外只给一句。 */
    if (!r.ok) console.error('[phm] /api/stats 上游失败:', r.status, String(r.body || r.error || '').slice(0, 300));
    return send(res, r.ok ? 200 : 502, r.ok ? (r.body || '{}') : JSON.stringify({ error: 'stats unavailable' }));
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
    /* ⚠ maxBody 必须显式放宽。dbFetch 的默认值是 8192 字节（本意是别把错误大页
       塞进日志），而这里一次允许 60 个 id、一行约 420 字节 —— 超过约 19 个 id
       响应就被从中间截断，JSON.parse 直接抛，用户看到 502「cache 响应无法解析」。
       实测：20 个 id → 200（7897 字节，刚好没超），25 个 → 502。
       /charter 与 /user 都走这条路径，于是"谱师作品一多，整页定数全变空"。
       分页接口 /api/charts?page= 走的是另一条（dbListAll，6MB），所以数据页一直是好的。 */
    const r = await dbFetch('/phm_charts?chart_id=in.(' + ids.join(',') + ')&select=*',
      undefined, 15000, 4 * 1024 * 1024);
    if (!r.ok || !r.body) {
      console.error('[phm] /api/charts 上游失败:', r.status, String(r.body || r.error || '').slice(0, 300));
      return send(res, 502, JSON.stringify({ error: 'cache unavailable' }));
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

    /* 先读 body、再校验 —— 校验放在配额之前，是为了让「参数不合法」的请求
       **不消耗配额**（以前是先扣配额再发现 chart_id 无效，用户一次没算成却被记一笔）。 */
    const body = await readBody(req);
    const cid = body && Number(body.chart_id);
    if (!Number.isInteger(cid) || cid < 1) {
      return send(res, 400, JSON.stringify({ error: 'chart_id 无效' }));
    }

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
      for (const k of Object.keys(s.hits)) if (k.slice(0, 2) === 'A:') global += s.hits[k].length;
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

    /* ⚠ 并发闸门的「检查 + 自增」必须在**同一个 tick** 里完成。
       以前是：先检查 analyzeInflight，然后 await readBody() 让出事件循环，
       读完 body 才自增 —— 中间这一让，后面排队的请求全都看到了同一个
       旧值、一起通过检查，"最多 3 个同时算" 于是只是注释。
       现在读 body 在前、检查与自增紧挨着，中间没有 await，检查才是真的。 */
    if (analyzeInflight >= ANALYZE_INFLIGHT) {
      return send(res, 503, JSON.stringify({
        error: '服务器正在计算其他谱面（最多同时 ' + ANALYZE_INFLIGHT + ' 个），请几秒后重试',
        retryAfter: 3,
      }));
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

  /* ── 构建产物下载 ──
     ⚠ 必须在下面的静态白名单**之前**处理：downloads/ 不在 PUBLIC_DIRS 里，
       晚一步就会被 isPublicPath 判 404。

     文件放 ROOT/downloads/ 而**不在 public/** 是有意的：public/ 的语义是
     「白名单里的东西可以送」，而这个是「只准走这一条路由」。放在 public/
     下面但不在白名单里，下次有人顺手往 PUBLIC_DIRS 加个目录就会把它也放出去。 */
  if (DOWNLOAD_FILES[p]) return serveDownload(req, res, DOWNLOAD_FILES[p]);

  /* ── 干净 URL ──
     站点已经拆成多页（/app 工作台、/charter 谱师、/user 玩家），
     但不想让用户看到 .html 后缀 —— 分享链接短一点、也少一个改动点
     （换实现时 URL 不变）。映射是**显式白名单**，不是通配：
     将来加页面必须同时加进 PUBLIC_FILES，不会因为忘了写路由就暴露文件。 */
  const CLEAN = { '/app': 'app.html', '/user': 'user.html', '/charter': 'charter.html',
                  '/data': 'data.html', '/settings': 'settings.html',
                  '/privacy': 'privacy.html', '/terms': 'terms.html',
                  '/version': 'version.html', '/download': 'download.html' };
  const cleanHit = CLEAN[p];

  /* 静态资源：**白名单之外一律 404** —— 绝不送源码 / 配置 / 运行时数据 */
  /* ⚠ decodeURIComponent 遇畸形百分号编码会 **抛 URIError**
     （`/%`、`/%E0%A4%A` 这类）。这个处理函数是 async，外面没有 try/catch，
     而 Node 默认把未处理的 rejection 当致命错误 → **整个进程被打掉**。
     一个畸形 URL 就能下线站点，所以必须自己接住、按客户端错误返回。
     （路径穿越本身是安全的：`%2e%2e` 解码后被 isPublicPath 的白名单挡住。） */
  let decoded;
  try {
    decoded = p === '/' ? null : decodeURIComponent(p);
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: 'bad request: 路径编码不合法' }));
  }
  const rel = cleanHit || (p === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  if (!isPublicPath(rel)) return send404(res);
  const fp = path.resolve(WEB_ROOT, rel);
  if (!fp.startsWith(WEB_ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  /* js/css/图片内容稳定且前端用版本化 URL 引用 → 可以长缓存 */
  /* ⚠ 只有**带 ?v=** 的请求才长缓存。
     ES 模块之间是用相对路径互相 import 的（`./ui.js`），那些 URL 没有查询串。
     如果它们也被长缓存，会有两个后果：
       1. 模块更新后用户一直吃旧版本；
       2. 更隐蔽的：同一个模块被"带版本"和"不带版本"两种 URL 加载时，
          浏览器会当成**两个不同的模块**，于是两份状态（语言、设置）分裂。
          这个真踩过 —— 设置页切了语言，ui.js 里的导航不跟着变。
     无查询串的 js / json 走 no-cache：每次协商，命中就是 304，开销很小。 */
  const hasVer = /[?&]v=/.test(req.url || '');
  const longCache = hasVer && /\.(js|css|png|svg|ico|webp|woff2|json)$/i.test(rel);
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
