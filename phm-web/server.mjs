/* P.H.M. Standard —— 前端 + 轻量 Node 服务
 *
 * 依赖：**默认零依赖**（只用 Node 内置模块）。唯一例外是数据库驱动 `pg` ——
 * 只有配了 PHM_NEON_URL（新站）才需要，静态站（腾讯那块指路牌）完全用不到。
 * 见 lib/db-pg.mjs 与 lib/retired.mjs 的 STATIC_ONLY。
 *
 * 职责边界（刻意做小）：托管静态前端、提供受限的 /api/* 网关（校验 → 限流 → 落库）。
 *
 * ⚠ 权限真相（实测过，别再想当然）：网关与浏览器持同一把 key、同为 anon，
 *   所以"网关是唯一写入口"只是**规范**不是防线。真正的封堵靠
 *   phm_put_chart()（SECURITY DEFINER + 写入凭据）：表已对 anon 撤销写权限，
 *   库侧只剩"带凭据的 RPC"这一条路。凭据只在本进程内，不进前端产物。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { reviewContribution, grosslyMismatched, recompute, chartInfo } from './lib/review.mjs';
/* 云数据库访问层（配置 + 写入凭据 + 两个写 RPC）都在 lib/cloud.mjs，
   与 tools/ 下的批量脚本共用同一份 —— 别再复制一份到这里。 */
import { dbFetch, dbPutChart, dbPutScores, dbPageCharts, dbSummary, SORTABLE, DB, WRITE_SECRET } from './lib/cloud.mjs';
/* huamei 数据飞轮的身份与成绩校验 —— 单独一个模块，见 lib/hm.mjs 顶部。 */
import { appIdFromKey, makeWhoami, validatePlay } from './lib/hm.mjs';
/* 自建账号：注册 / 登录 / 自签 token。见 lib/hm-accounts.mjs 顶部。 */
import {
  register as hmRegister, login as hmLogin, verifyOwnToken, claimsOwnIssuer,
  sendCode as hmSendCode, verifyCode as hmVerifyCode, resetPassword as hmResetPassword,
  getProfile as hmGetProfile, putProfile as hmPutProfile, touchProfile as hmTouchProfile,
  deleteAccount as hmDeleteAccount } from './lib/hm-accounts.mjs';
import { makeProfileRoutes } from './lib/hm-profile-routes.mjs';
import { makeDownloadHandler, DOWNLOAD_FILES } from './lib/download.mjs';
import { installFaultGuards, guardRequest } from './lib/resilience.mjs';
import { retiredGate, STATIC_ONLY, RETIRED_HTML, stripBanner } from './lib/retired.mjs';
/* 贡献凭证：/api/contribute 的准入能力票（见 lib/contribute-ticket.mjs 顶部）。 */
import {
  ticketAvailable, issueTicket, verifyTicket, ticketCovers,
  TICKET_TTL_MS, TICKET_MAX_CHARTS,
} from './lib/contribute-ticket.mjs';
import { makeContributeRoutes } from './lib/contribute-routes.mjs';
/* API v1 路由（/api/v1/*）—— 独立模块，避免 server.mjs 破 900 行。 */
import { makeApiRoutes } from './lib/api-routes.mjs';
import { makeStatusRoutes, startStatusMonitor } from './lib/status.mjs';
import { makeChartAssetRoutes } from './lib/chartassets.mjs';
import { CLEAN, makePageRoutes } from './lib/pages.mjs';
import { makeCodeRoutes } from './lib/hm-code-routes.mjs';
import { ENGINE_VER } from './public/js/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
/* 静态资源根目录。
   只有 public/ 下的内容可能被送出 —— 源码（server.mjs / lib/）与运行时数据
   （server-store.json）都在 ROOT 下，天然在可服务范围之外。 */
const WEB_ROOT = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;
const BOOT_AT = new Date().toISOString();

/* ── 服务端自有存储：**已废弃**（2026-10-13）──
 * 原来这里用 `server-store.json` 存限流计数与写入计数。问题是
 * `storeSave` 是 `try { writeFileSync } catch {}` —— 线上沙箱的部署目录
 * **不可写**，失败被静默吞掉，于是每次请求都从空计数开始：
 * 限流上限（30 次/分/IP）**一次都没触发过**（审计实测 70 连发全 200）。
 * 现已改为进程内计数（lib/ratelimit.mjs），不再依赖文件系统。
 * 这两个函数留着只为文档价值，**不要再引用**。 */
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

/* ── 限流 ──
 * ⚠⚠ 2026-10-13 授权渗透审计实测：**原限流在生产环境完全失效**。
 *   连发 70 个 /api/stats 全 200（源码写的上限 60/分），
 *   连发 35 个 /api/contribute 也全 200（上限 30/分）。
 *   根因：计数写进 server-store.json，而线上沙箱的部署目录**不可写**，
 *   `storeSave` 的 `try{…}catch{}` 把失败吞了 → 每次请求都从空计数开始。
 *   不是阈值定得松，是**计数压根没存下来**。
 *
 *   现已改成进程内计数（lib/ratelimit.mjs），不碰文件系统。
 *   配额、过闸句柄、429 标准头也都在那个模块里 —— 集中一份策略，
 *   免得同一个路径在两处写着不同的限额。
 *   代价：进程重启清零；多实例部署时各算各的。边界见该文件顶部说明。 */
import {
  limit as rlLimit, tryEnter, leave as rlLeave, snapshot as rlSnapshot,
  RL, RL_WINDOW, makeGate, gateWriteId,
  gateWrite, gateStats, gateProxy, gateAnalyze, gateAuth, gateCode,
} from './lib/ratelimit.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  /* ⚠ 字体必须给对 MIME。不给的话是 application/octet-stream，
     部分浏览器会**拒绝**加载（@font-face 直接静默失败，页面掉回系统字体，
     控制台只有一条不显眼的警告）—— 这种"改了没生效"最难查。 */
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* ⚠ 静态白名单 —— 只允许这些文件被送出。
   之前只做了「路径不以 ROOT 开头则拒」，结果 server.mjs / package.json /
   server-store.json 全都躺在 ROOT 里被当静态资源送出去（含数据库地址、密钥、访客 IP）。
   目录穿越防护 ≠ 白名单。这是安全修复的核心。
   现在拆成两层：少量精确允许的根文件 + 仅限 public/js、public/css 下的安全扩展名。 */
/* 完整白名单；静态站按 RETIRED_HTML 减掉（同一份代码两个站，见 lib/retired.mjs） */
const PUBLIC_FILES = new Set(['index.html', 'app.html', 'user.html', 'charter.html', 'data.html',
  'settings.html', 'robots.txt', 'favicon.ico', 'privacy.html', 'terms.html',
  '404.html', 'chart.html', 'og.png', 'version.html', 'download.html',
  'developers.html', 'platform.html', 'phm-api.html', 'rulechart.html',
  'status.html', 'packs.html',
  /* 末尾三个是许可证正文：按**名字**放行，别往 SAFE_EXT 加 .txt（见 docs/README「许可证」） */
  'fonts/OFL-LXGWWenKai.txt', 'fonts/OFL-NotoSerifSC.txt', 'vendor/uqr-LICENSE']);
if (STATIC_ONLY) for (const f of RETIRED_HTML) PUBLIC_FILES.delete(f);
/* ⚠ 加页面必须同时改 PUBLIC_FILES（放行文件）与 CLEAN（干净 URL），漏一处就 404。 */

/* 注：曾经还有一个独立的英文页 en.html。i18n 上线后它是**冗余**的 ——
   全站一套代码两种语言，再留一个手写的英文页就变成两份必然漂移的实现，
   而且「English」入口和设置页里的语言开关重复。已删除。 */
/* ⚠ PUBLIC_DIRS 每加一个目录，都是往互联网上多开一扇门。
   加 data/ 是为了 ref-com.json（社区参照集生成物，生成器只往这里写它）；
   这个目录里不允许出现任何其他文件 —— 有的话就该把它挪出 public/。 */
/* ⚠ 每加一个目录都是往互联网上多开一扇门。fonts/ 是 2026-10-11 加的 ——
   标题用的思源宋体子集（83KB woff2）要自托管：CSP 里 font-src 只允许 'self'，
   而且中文站依赖 CDN 字体既慢又不可靠。这个目录里只应有裁好的 woff2。 */
const PUBLIC_DIRS = ['js/', 'css/', 'data/', 'fonts/', 'vendor/'];
const SAFE_EXT = new Set(['.js', '.mjs', '.css', '.png', '.svg', '.ico', '.webp', '.woff2', '.json']);
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
    /* ⚠ phira.5wyxi.com 是**谱面文件与曲绘**的 CDN（不是 API）。
      /packs 与 /app?chart=<id> 都靠浏览器直连它取文件 ——
      不放进 connect-src 的话 fetch 会被 CSP 直接拦掉，页面表现是「点了没反应」。 */
    "connect-src 'self' https://api.phira.cn https://phira.5wyxi.com https://phm.app.workbuddy.host https://cdn.jsdelivr.net",
    "form-action 'self'",
    /* frame-ancestors 交给 X-Frame-Options: DENY —— 写在 CSP 里会被 Chrome 报
       「keyword 'none' alongside with other sources」，功能重复且有告警 */
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
};

/* 过闸 —— 实现与理由都在 lib/ratelimit.mjs 的 makeGate()。
   这里只把站点的安全头注进去。 */

/* ⚠⚠ 在途并发上限（与限流是两回事：限流管频率，这里管同时几个）。
   ⚠ 这两个常量 2026-10-17 被我**误删过** —— 当时把限流配置挪进 lib/ratelimit.mjs，
      /  一起被带走，而路由还在引用。
     症状是**一请求 /api/analyze 就抛 ReferenceError、整个进程退出**，
     全站的谱面分析直接死掉。而冒烟测试不覆盖这条路径，所以 176/0 放过了它。
     教训：删常量前先 grep 全文件；以及**冒烟必须打一遍所有 API 路由**。 */
const ANALYZE_INFLIGHT = 3, CONTRIBUTE_INFLIGHT = 2;

const gate = makeGate(SEC_HEADERS);

/* 账号邮件环节（发码 / 重置密码）—— 逻辑在 lib/hm-code-routes.mjs。
   这里只把 send / 闸句柄 / 两个账号入口注进去。 */
const codeRoutes = makeCodeRoutes({
  send, gate, gateCode, gateAuth,
  sendCode: hmSendCode, resetPassword: hmResetPassword,
  verifyCode: hmVerifyCode, register: hmRegister, login: hmLogin,
  /* 注册**默认要邮箱验证码**（2026-10-17 起）。
     之前默认关，是因为当时唯一的注册入口是 Windows 客户端、它还不带 code 字段 ——
     关着等于「可以拿任意邮箱批量注册」，那是个真实的洞，只能当过渡。
     客户端已跟上（设置页 → huamei 账号 → 注册，会先发码再问码），所以现在默认开。

     ⚠ 逃生口：REQUIRE_EMAIL_CODE=0 才关。**反过来写**（!== '0'）是故意的 ——
       没配环境变量时必须是**安全的那一侧**，不能因为忘了配就悄悄放开。 */
  requireCode: process.env.REQUIRE_EMAIL_CODE !== '0',
});




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

/* 贡献凭证路由：实现见 lib/contribute-routes.mjs。
   server.mjs 有 900 行上限（lint-slop 守着），所以路由逻辑不进这个文件。 */
const contributeRoutes = makeContributeRoutes({
  send, gate, gateAnalyze, readBody, chartInfo,
  issueTicket, verifyTicket, ticketAvailable, ticketCovers,
  ticketTtlMs: TICKET_TTL_MS, ticketMaxCharts: TICKET_MAX_CHARTS,
  /* 写路径：复核 + 落库依赖由装配层注入（模块不认识数据库/闸门） */
  dbFetch, dbPutChart, reviewContribution, grosslyMismatched,
  tryEnter, rlLeave, contributeInflight: CONTRIBUTE_INFLIGHT,
});

/* API v1 装配：认证 / 配额 / 用量 / Key 管理都在 lib/api-routes.mjs。 */
/* 服务端构建版本 —— /api/v1/meta 用它和静态页面版本对账，
   避免「页面是新的、server.mjs 是旧的」这种部署错位被当成 Key 失效。 */
const SERVICE_VER = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version;
const OPENAPI_SPEC = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'api', 'openapi.json'), 'utf8'));

const apiRoutes = makeApiRoutes({
  send, readBody, dbFetch, dbPutChart, dbPageCharts, recompute, hmWhoami,
  writeSecret: WRITE_SECRET, engineVer: ENGINE_VER, serviceVersion: SERVICE_VER, openapiSpec: OPENAPI_SPEC,
  /* 分页/排序与谱师/玩家查询复用网页端同一份实现，
     不在这里另写一套 —— 两套分页必然漂移（见 lib/api-routes.mjs 里 handleChartList 的注释）。 */
  SORTABLE, phiraBase: PHIRA_API,
});

/* 状态页 / 曲绘代理路由：工厂都要 SEC_HEADERS，必须装配在它之后。 */
const statusRoutes = makeStatusRoutes(SEC_HEADERS), chartAssets = makeChartAssetRoutes(SEC_HEADERS);
/* 档案路由：token 从 x-hm-token 读（托管网关会吃掉 Authorization，真踩过）。 */
const profileRoutes = makeProfileRoutes({ send, gate, gateRead: gateStats, gateWriteId, whoami: hmWhoami,
  getProfile: hmGetProfile, putProfile: hmPutProfile, touchProfile: hmTouchProfile, deleteAccount: hmDeleteAccount, dbFetch });
/* 详情页模板只在启动时读一次 —— 每请求读盘是纯浪费（模板不随请求变）。 */
const chartTpl = fs.readFileSync(path.join(WEB_ROOT, 'chart.html'), 'utf8');
const pageRoutes = makePageRoutes({ secHeaders: SEC_HEADERS, send, send404,
  readTemplate: () => chartTpl });

const softFault = installFaultGuards();   /* 最后一层兜底，见 lib/resilience.mjs 顶部 */
const server = http.createServer(guardRequest(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (retiredGate(p, req, res, send)) return;   /* 下线闸门：被撤的一律 410，放在最前 */

  /* ── 客户端身份（限流键用）── ⚠⚠ 只用 socket 真实对端，**不采信 XFF**：
     2026-10-16 实测平台给每个请求注入不同的 XFF → per-IP 限额永远撞不到上限
     （70 连发全 200）；而 socket 对端稳定。且 XFF 客户端可伪造，
     拿它当限流键等于把钥匙交给攻击方（白帽报告同一条）。 */
  const ip = req.socket.remoteAddress || 'unknown';

  /* API v1：独立模块处理（认证 / 配额 / 用量 / Key 管理）。 */
  if (p === '/api/v1' || p.startsWith('/api/v1/')) return apiRoutes.handle(req, res, ip);

  /* 健康检查：只回 ok。
     此前返回 Node 版本 / 启动时间 / uptime / 存储状态 —— 那是给攻击者的情报，已删。 */
  if (p === '/api/health') return send(res, 200, JSON.stringify({ ok: true }));

  /* 状态页数据（/status 页面用）。装配在 SEC_HEADERS 之后。 */
  if (p === '/api/status') return statusRoutes(req, res, url);
  if (p.startsWith('/api/phira-illust/') || p.startsWith('/api/phira-file/')) return chartAssets(req, res, url);

  /* ── huamei：取谱代理 ──
     客户端把 `API_URL` 指到这里，于是 Phira 的整个 API 面都经我们这一跳。
     ⚠ 只放行 GET/HEAD；⚠ **剥掉入站 Authorization** —— 那是用户的 huamei
     token，绝不能转给第三方。

     ⚠⚠ 路径白名单（2026-10-13 审计新增）。
     原来是「`/api/phira/*` 一律透传」，等于把我们的出口 IP + 带宽白送给
     任何人去批量采集上游（审计实测：`/api/phira/user/1` 能透传到
     `api.phira.cn`，而**上游零限流**，25 连发全 200）。
     现在只放行客户端**真正会用到**的那几个前缀，其余 404。
     ⚠ 加新前缀前先确认客户端确实在调 —— 白名单放宽永远比事后收紧容易。 */
  const PHIRA_PROXY_PATHS = [
    '/chart',            // 谱面元数据 + 文件直链
    '/chart/',           // 同上（带 id）
    '/record/best/',     // 自己的最佳成绩
    '/record/recent',    // 最近成绩
    '/terms/',           // 服务条款 / 隐私政策（客户端要读）
    '/music',            // 谱面音频
  ];
  if (p === '/api/phira' || p.startsWith('/api/phira/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 403, JSON.stringify({ error: 'only GET/HEAD' }));
    }
    if (!(await gate(res, gateProxy({ ip }), 'rate limit'))) return;
    const sub = p.replace(/^\/api\/phira/, '') || '/';
    /* 前缀不匹配 → 404，**不要**透传。
       ⚠ 用 startsWith 而不是正则：前缀是写死的字面量，正则只会引入意外。 */
    if (!PHIRA_PROXY_PATHS.some(pre => sub === pre || sub.startsWith(pre))) {
      return send(res, 404, JSON.stringify({ error: 'path not allowed' }));
    }
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
  /* ── 账号的邮件环节：发验证码 / 重置密码 ──
     实现与理由都在 lib/hm-code-routes.mjs（server.mjs 有 900 行上限）。 */
  if (p === '/api/hm/send-code' || p === '/api/hm/reset-password') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    const body = await readBody(req);
    return p === '/api/hm/send-code'
      ? codeRoutes.sendCodeRoute(res, body, ip)
      : codeRoutes.resetPasswordRoute(res, body, ip);
  }

  if (p === '/api/hm/register' || p === '/api/hm/login') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    const body = await readBody(req);
    /* 限流在**读 body 之后** —— per-邮箱那一维要拿到 email 才能算。 */
    if (!(await gate(res, gateAuth({ ip }, body && body.email),
        '尝试太频繁，请一分钟后再试（每邮箱每分钟最多 ' + RL.loginEmail + ' 次）'))) return;
    return codeRoutes.accountRoute(res, p, body, ip);
  }

  if (await profileRoutes(req, res, p, url)) return;

  if (p === '/api/hm/play') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (!(await gate(res, gateWrite({ ip }), 'rate limit: 每分钟最多 ' + RL.writeIp + ' 次写入'))) return;
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

    /* ⚠ 第二道闸：按**身份**限流（身份优先于 IP —— GitHub/Stripe 的做法）。
       IP 在 NAT/网关后面不可信（实测线上对端恒为 127.0.0.1），
       而我们自己签发的 sub 伪造不了。
       第一道（IP/全局）挡未鉴权的洪水；这一道挡「一个账号刷爆」，
       而且**只按 sub 计**，不重复占用全局桶。 */
    if (!(await gate(res, gateWriteId(String(who.sub)),
      'rate limit: 每分钟最多 ' + RL.writeId + ' 次上报'))) return;
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

  /* ── /api/contribute/ticket ── 贡献凭证（见 lib/contribute-routes.mjs）──
     /api/contribute 不再接受匿名直接写入：客户端必须先用真实存在的 chart_id
     换一张 5 分钟有效的 HMAC 凭证。换证只查 Phira 元数据，**不下载谱面**。 */
  if (p === '/api/contribute/ticket') return contributeRoutes.ticketRoute(req, res, ip);

  /* 写入网关：校验 + 限流 + 落库 */
  if (p === '/api/contribute' || p === '/api/scores') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));

    /* ── 贡献凭证：**先验票，再读 body** ──
       2026-10-17 白帽实测：/api/contribute 完全无认证，任意 chart_id 都能
       让服务端下载 ≤60MB 谱面并跑引擎（复算保证了数据正确，但成本面敞开）。
       现在必须持有服务端签发的 HMAC 凭证；凭证只覆盖「刚刚确认过存在」的 chart_id。
       ⚠ 顺序很重要：验票在建 body 之前 —— 未认证请求连 body 解析都到不了，
         错误信息也不会回显请求结构（白帽就是从 `rows:[]` 的报错推断出批量格式的）。 */
    let ticketCids = null;
    if (p === '/api/contribute') {
      const tv = contributeRoutes.readTicket(req, ip);
      if (!tv.ok) return send(res, tv.status, JSON.stringify(tv.body));
      ticketCids = tv.cids;
    }

    /* ⚠ 必须 await。限流函数返回 Promise，而 Promise 永远是真值 ——
       `if (!rateOk(ip))` 恒为 false，429 从来没出现过。
       这个 bug 2026-10-11 就审计出来过（写路径漏 await），
       2026-10-13 又实测到 35 连发全 200 —— 因为计数写不进只读文件系统，
       于是连 await 对了也不生效。两件事现在一起修了。 */
    if (!(await gate(res, gateWrite({ ip }), 'rate limit: 每分钟最多 ' + RL.writeIp + ' 次写入'))) return;
    const body = await readBody(req);
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.rows) ? body.rows : null);
    /* 错误信息不描述期望结构 —— 白帽就是靠报错里的 `{rows:[]}` 认出批量上报的。 */
    if (!rows) return send(res, 400, JSON.stringify({ error: 'invalid request body' }));
    /* ⚠ 单次行数从 500 降到 20。
       500 行/请求是把"灌水"放大了 25 倍 —— 审计实测一次请求就能塞进
       500 行垃圾。正常用法一次最多几十行（一个玩家的 recent 成绩），
       20 行足够；真要批量，前端自己分页发，限流会兜住。 */
    if (rows.length > 20) return send(res, 413, JSON.stringify({ error: '单次最多 20 行' }));

    /* ⚠ 两条路径的必填字段**不一样**，别共用一份。
       早先这里对两条路径都用 `['chart_name']`，而 /api/contribute 的前端发的是
       `name`（与 phm_charts 表的列名一致）—— 于是**每一次拖谱贡献都被整行作废**：
       实测 POST {chart_id,name,ref_const} → {"accepted":0,"rejected":1}。
       定数缓存因此长期停止增长，而 /api/analyze（搜索后点「算」）不走这条校验，
       所以症状看起来像"有时候能算出来、有时候不能"。
       定数是按 chart_id 关联的，谱名只是展示字段，不该当必填。

       ⚠⚠ scores 路径加严：2026-10-13 审计实测，只填 `chart_name` 就能落库，
       于是白帽往里灌了 `SECURITY_PROBE` / `123` / 12 万个 'A' 三行垃圾
       （`acc` 等字段被 sanitize 丢掉，行却照样写进去了）。
       一行"成绩"至少要有**曲名 + 准确度**才有意义，所以两个都要必填。
       这不会误伤正常提交：/user 页发的就是 `{chart_name, acc, client_id, source}`。 */
    const required = p === '/api/contribute' ? ['chart_id'] : ['chart_name', 'acc'];
    const clean = rows.map(r => sanitize(r, required)).filter(Boolean);

    if (!clean.length) {
      return send(res, 200, JSON.stringify({
        received: rows.length, accepted: 0, rejected: rows.length, written: 0,
        note: '全部未通过服务端校验，未写入',
      }));
    }

    if (p === '/api/contribute') {
      return contributeRoutes.write(res, rows, clean, ticketCids);
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
    if (!(await gate(res, gateStats({ ip }), '请求过于频繁（每分钟最多 ' + RL.statsIp + ' 次）'))) return;
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
    if (!(await gate(res, gateStats({ ip }), '请求过于频繁（每分钟最多 ' + RL.statsIp + ' 次）'))) return;
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
    if (!(await gate(res, gateStats({ ip }), '请求过于频繁（每分钟最多 ' + RL.statsIp + ' 次）'))) return;
    const sum = await dbSummary();
    if (!sum) return send(res, 502, JSON.stringify({ error: 'cache unavailable' }));
    return send(res, 200, JSON.stringify(Object.assign({ engineVer: ENGINE_VER }, sum)));
  }

  if (p === '/api/charts') {
    if (!(await gate(res, gateStats({ ip }), '请求过于频繁（每分钟最多 ' + RL.statsIp + ' 次）'))) return;
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

    /* 配额：per-IP + 全局。放行**才**记数 —— 上面 chart_id 无效的请求
       已经先返回了，不会白扣一笔（以前是先扣配额再发现 chart_id 无效）。 */
    if (!(await gate(res, gateAnalyze({ ip }), '算得太频繁了（每分钟最多 ' + RL.analyzeIp + ' 次），请稍后再试'))) return;

    /* ⚠ 并发闸门的「检查 + 自增」必须在**同一个 tick** 里完成。
       以前是：先检查 analyzeInflight，然后 await readBody() 让出事件循环，
       读完 body 才自增 —— 中间这一让，后面排队的请求全都看到了同一个
       旧值、一起通过检查，"最多 3 个同时算" 于是只是注释。
       现在读 body 在前、检查与自增紧挨着，中间没有 await，检查才是真的。 */
    /* ⚠ 这条闸是「在途并发」，和限流不是一回事：
       限流管**频率**（每分钟几次），这条管**同时有几个**。
       `/api/analyze` 会让服务端下载 ≤60MB 谱面并**同步**跑引擎 ——
       同步跑会卡住整个 Node 事件循环，所以在途数必须封顶。 */
    if (!tryEnter('analyze', ANALYZE_INFLIGHT)) {
      return send(res, 503, JSON.stringify({ error: '服务器正在计算其他谱面（最多同时 ' + ANALYZE_INFLIGHT + ' 个），请几秒后重试', retryAfter: 3 }));
    }
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
      rlLeave('analyze');
    }
  }

  /* ── 构建产物下载 ──
     ⚠ 必须在下面的静态白名单**之前**处理：downloads/ 不在 PUBLIC_DIRS 里，
       晚一步就会被 isPublicPath 判 404。

     文件放 ROOT/downloads/ 而**不在 public/** 是有意的：public/ 的语义是
     「白名单里的东西可以送」，而这个是「只准走这一条路由」。放在 public/
     下面但不在白名单里，下次有人顺手往 PUBLIC_DIRS 加个目录就会把它也放出去。 */
  if (DOWNLOAD_FILES[p]) return serveDownload(req, res, DOWNLOAD_FILES[p]);
  /* 详情页与动态 sitemap：要**先于**静态白名单，否则 /sitemap.xml 会被旧静态文件命中。 */
  if (await pageRoutes(req, res, url)) return;

  /* ── 干净 URL ──
     映射表在 lib/pages.mjs（与详情页 / sitemap 放一起）；
     **显式白名单，不是通配** —— 加页面必须同时进 PUBLIC_FILES。 */
  const cleanHit = CLEAN[p];

  /* 静态资源：**白名单之外一律 404** —— 绝不送源码 / 配置 / 运行时数据 */
  /* ⚠ 畸形百分号编码（`/%`）会让 decodeURIComponent 抛 URIError —— 一个畸形 URL
     就能打掉进程。必须自己接住。（路径穿越是安全的：`%2e%2e` 解码后被白名单挡住。） */
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
  /* ⚠ 只有**带 ?v=** 的请求才长缓存。ES 模块之间用相对路径互相 import，
     那些 URL 没有查询串 —— 若也长缓存，会出现「同一模块被两种 URL 加载 =
     两个模块实例」，于是语言/设置状态分裂（真踩过）。其余走 no-cache。 */
  const hasVer = /[?&]v=/.test(req.url || '');
  const longCache = hasVer && /\.(js|css|png|svg|ico|webp|woff2|json)$/i.test(rel);
  /* 页面 HTML 一律 no-cache（sendFile 内部按扩展名判断），
     所以干净 URL 不需要额外处理缓存头。 */
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    /* 全功能站要把公告横幅摘掉 —— 那句"本站已停止运行"在新站上是假话 */
    if (!STATIC_ONLY && rel.endsWith('.html')) {
      return send(res, 200, stripBanner(fs.readFileSync(fp, 'utf8')), 'text/html; charset=utf-8');
    }
    return sendFile(res, fp, longCache, req);
  }
  return send404(res);
}), softFault);

/* 请求级超时：出站 fetch 有 15s 上限，入站此前没有 —— 慢连接可以挂住进程 */
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 15000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('[phm] listening on 0.0.0.0:' + PORT + ' | boot ' + BOOT_AT + ' | node ' + process.version);
  /* 自监控：打回环地址，不走外部域名（沙箱出站常被网关限制，
     探外部只会得到一片假红）。详见 lib/status.mjs 顶部。
     ⚠ 它自己抛异常也不该影响主服务 —— startStatusMonitor 内部已兜住。 */
  startStatusMonitor(PORT);
});
