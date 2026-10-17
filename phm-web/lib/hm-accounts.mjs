/* ============================================================
 * lib/hm-accounts.mjs —— huamei 自建账号：注册 / 登录 / 自签 token
 * ============================================================
 * 【为什么要有这个模块】
 *   原先身份完全依赖平台云认证（`.cloud/auth/v1`），那条路有两个问题：
 *    ① 每次登录都要邮箱 + 验证码，新用户还被注册成**空密码**
 *       （`finish_login` 传 `password: None`），于是永远不能用密码登录；
 *    ② 平台 token 是 HS256、密钥在平台手里，**我们无法验签** ——
 *       `lib/hm.mjs` 的 `subFromJwt` 只能解析不能验证，身份是可伪造的。
 *
 *   所以把账号收到自己手里：密码 scrypt 哈希后入库，token 用**服务端独有的密钥**
 *   签发。这样一来：
 *     · 注册只要 邮箱 + 密码（无验证码）
 *     · 之后登录只输密码
 *     · 服务端**能验签**了，身份不再可伪造（顺带修掉 ②）
 *
 * 【信任边界（照实说）】
 *   · 密码只以 scrypt 哈希形式落库，明文不进日志、不进数据库。
 *   · `hm_accounts` 开了 RLS 且**没有给任何角色直连权限**，
 *     只能走带写入凭据的 RPC（`hm_account_lookup` / `hm_account_create`）。
 *     也就是说：即使 publishableKey 泄漏（它本来就公开在网页里），
 *     也读不到任何账号行。
 *   · token 是 HS256，密钥只在服务端。客户端拿到的是 bearer token。
 *   · ⚠ 没有「改密码 / 找回密码」。目前规模下由管理员直接改库，
 *     真需要时再加，并且必须配邮件验证 —— 不能凭一个邮箱地址就重置。
 * ============================================================ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbFetch, WRITE_SECRET } from './cloud.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ── token 签名密钥 ──
 * 三路解析，与写入凭据同一套规矩（见 lib/cloud.mjs 顶部）：
 *   1. 环境变量 PHM_TOKEN_SECRET
 *   2. .env 里的 PHM_TOKEN_SECRET=
 *   3. 都没有 → 从 WRITE_SECRET **派生**（HMAC + 固定标签，域分离）
 * 第 3 条是为了「不配也能跑」—— 部署时忘了加环境变量，账号系统照常工作，
 * 只是不能独立轮换。要独立轮换就显式配第 1 或第 2 条。
 *
 * ⚠ 绝不能退回「不签名」或「固定硬编码密钥」：那等于把身份又变成可伪造的。 */
function resolveTokenSecret() {
  const fromEnv = (process.env.PHM_TOKEN_SECRET || '').trim();
  if (fromEnv) return { value: fromEnv, source: '环境变量 PHM_TOKEN_SECRET' };
  try {
    const env = Object.fromEntries(
      fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
        .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
    if (env.PHM_TOKEN_SECRET) return { value: env.PHM_TOKEN_SECRET, source: '.env' };
  } catch { /* 没有 .env 就往下走 */ }
  if (WRITE_SECRET) {
    const derived = crypto.createHmac('sha256', WRITE_SECRET)
      .update('phm-huamei:account-token:v1').digest('hex');
    return { value: derived, source: '从写入凭据派生（配 PHM_TOKEN_SECRET 可独立轮换）' };
  }
  return { value: '', source: '未配置' };
}
const TOKEN_SECRET = resolveTokenSecret();
console.log('[phm] token 签名密钥来源：' + TOKEN_SECRET.source);

const TOKEN_TTL = 60 * 60 * 24 * 90;      /* 90 天 —— 音游客户端不该天天登录 */
const ISSUER = 'phm-huamei';
const SCRYPT_KEYLEN = 64;

/* ── 校验规则 ──
 * 邮箱规则比平台那套**松一点**：允许 `+` 别名。原来禁 `+` 是平台的限制，
 * 现在我们自己存账号，没有理由继承它。
 * ⚠ 但两侧（服务端 / 客户端）必须一致，否则会出现「本地说合法、服务端说非法」。 */
export function validateEmail(email) {
  const e = String(email || '').trim();
  if (!e) return '邮箱不能为空';
  if (e.length > 254) return '邮箱太长（最多 254 个字符）';
  const parts = e.split('@');
  if (parts.length !== 2) return '邮箱里只能有一个 @';
  const [local, domain] = parts;
  if (!local) return '@ 前面是空的';
  if (local.length > 64) return '@ 前面太长（最多 64 个字符）';
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    return '@ 前面含有非法字符';
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return '@ 前面不能以点开头/结尾，也不能有连续两个点';
  }
  if (!domain || !domain.includes('.')) return '域名要带点，例如 qq.com';
  if (domain.length > 190) return '域名太长';
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return '域名里只能有英文、数字、点、减号';
  if (domain.startsWith('-') || domain.endsWith('-') || domain.includes('..')) {
    return '域名不能以减号开头/结尾，也不能有连续两个点';
  }
  const tld = domain.split('.').pop();
  if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) return '域名后缀要至少 2 个英文字母';
  return null;
}

export function validatePassword(pw) {
  const p = String(pw || '');
  if (!p) return '密码不能为空';
  if (p.length < 8) return `密码至少 8 位（当前 ${p.length} 位）`;
  if (p.length > 128) return '密码太长（最多 128 位）';
  if (/^\s+$/.test(p)) return '密码不能全是空白字符';
  return null;
}

/* ── 密码哈希 ──
 * 用 node:crypto 的 scrypt：内存硬化、零依赖、Node 官方维护。
 * ⚠ 参数用默认值（N=16384, r=8, p=1）而不是自己调 —— 调大会让登录变慢，
 *   而这个项目跑在免费沙箱里，CPU 本来就不富裕。salt 每账号随机 16 字节。 */
export function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, dk) => {
      if (err) reject(err); else resolve(dk.toString('hex'));
    });
  });
}
export function verifyPassword(password, salt, expectedHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, dk) => {
      if (err) { reject(err); return; }
      const a = Buffer.from(dk.toString('hex'), 'hex');
      const b = Buffer.from(String(expectedHex || ''), 'hex');
      /* timingSafeEqual 要求等长；长度不一致直接判否（长度本身不是秘密） */
      resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
    });
  });
}

/* ── JWT（HS256，自签）── */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (obj) => b64u(JSON.stringify(obj));

export function signJwt(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = Object.assign({ iss: ISSUER, iat: Math.floor(Date.now() / 1000) }, payload);
  body.exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const data = b64uJson(header) + '.' + b64uJson(body);
  const sig = crypto.createHmac('sha256', TOKEN_SECRET.value).update(data).digest('base64url');
  return data + '.' + sig;
}

/** 这个 token 是否**声称**是我们签的（只看 payload 的 `iss`，**不验签**）。
 *
 * 为什么需要它：`verifyOwnToken` 对「不是我们的」和「是我们的但签名不对」
 * 都返回 null，调用方无法区分。而这两者的正确处置**相反**：
 *   · 不是我们的 → 交给别的路子（云端 user/me）试试
 *   · 是我们的但签不对 → **直接拒绝**，绝不回退到不验签也认
 *      （否则攻击者给自己的 token 标上我们的 iss 就能冒充任何人）
 * 所以把「声称」这件事单独暴露出来。 */
export function claimsOwnIssuer(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !!(p && typeof p === 'object' && p.iss === ISSUER);
  } catch { return false; }
}

/** 验我们自己的 token。
 * @returns `{{sub, email}}` 或 `null`。
 *
 * ⚠ 关键语义：**只要 payload 里声明了 `iss = phm-huamei`，签名不过就一律拒绝**，
 *    绝不回退到「不验签也认」。否则攻击者把自己的 token 标上我们的 iss 就能冒充。 */
export function verifyOwnToken(token) {
  const t = String(token || '');
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
  const claims = payload && typeof payload === 'object' ? payload : {};
  const ours = claims.iss === ISSUER;
  if (!ours) return null;                     /* 不是我们的 → 交给别的路子 */
  if (!TOKEN_SECRET.value) return null;        /* 没密钥就无法验 → 拒绝 */
  if (header && header.alg !== 'HS256') return null;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET.value)
    .update(parts[0] + '.' + parts[1]).digest('base64url');
  const got = Buffer.from(parts[2] || '');
  const want = Buffer.from(expect);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) return null;
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) return null;
  return { sub, email: typeof claims.email === 'string' ? claims.email : '' };
}

/** 生成账号 id。形如 `2107772020426018816`（19 位数字）——
 *  和平台那边发过来的 sub 长得一样，混在同一个 `owner_id` 列里不突兀。 */
function newSub() {
  const n = crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000000n;
  return (1000000000000000000n + n).toString();
}

function rpc(name, args) {
  return dbFetch('/rpc/' + name, {
    method: 'POST',
    body: JSON.stringify(Object.assign({ p_secret: WRITE_SECRET }, args)),
  }, 20000, 8192);
}

/** 注册。邮箱重复 → `{error:'email_taken'}`；服务端不可用 → `{error:'unavailable'}`。 */
export async function register(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const eErr = validateEmail(e);
  if (eErr) return { error: 'email_invalid', detail: eErr };
  const pErr = validatePassword(password);
  if (pErr) return { error: 'password_invalid', detail: pErr };
  if (!WRITE_SECRET) return { error: 'unavailable', detail: '服务端未配置写入凭据' };

  const salt = crypto.randomBytes(16).toString('hex');
  let hash;
  try { hash = await hashPassword(password, salt); }
  catch (err) { return { error: 'hash_failed', detail: String(err.message || err) }; }

  const sub = newSub();
  const r = await rpc('hm_account_create', { p_sub: sub, p_email: e, p_pass_hash: hash, p_salt: salt });
  if (!r.ok) {
    /* 23505 = unique_violation，即邮箱已被注册。
       ⚠ 不能把原始报文透给客户端（会带出表名/列名），只回一个稳定的错误码。 */
    const dup = /23505|duplicate key|already exists/i.test(String(r.body || '') + String(r.error || ''));
    if (dup) return { error: 'email_taken' };
    return { error: 'store_failed', detail: String(r.body || r.error || '').slice(0, 160) };
  }
  return { ok: true, sub, token: signJwt({ sub, email: e }) };
}

/** 登录。失败一律回 `bad_credentials` —— **不区分**「账号不存在」和「密码错」。
 *
 * ⚠ 为什么统一：区分开就等于开放了账号枚举 —— 拿一个邮箱字典跑这个接口，
 *   就能知道谁注册过。对本站的威胁模型（聚合节奏游戏数据）影响不大，
 *   但「默认不泄露」是应该的，成本也只是把区别写进服务端日志而已。
 *
 * 真要区分的那天（比如要做「这个邮箱还没注册，帮你注册？」），
 * 请先想清楚：那等于把枚举接口做回产品功能里。 */
export async function login(email, password) {
  const e = String(email || '').trim().toLowerCase();
  const eErr = validateEmail(e);
  if (eErr) return { error: 'email_invalid', detail: eErr };
  const pErr = validatePassword(password);
  if (pErr) return { error: 'password_invalid', detail: pErr };
  if (!WRITE_SECRET) return { error: 'unavailable', detail: '服务端未配置写入凭据' };

  const r = await rpc('hm_account_lookup', { p_email: e });
  if (!r.ok) return { error: 'store_failed', detail: String(r.body || r.error || '').slice(0, 160) };
  let rows;
  try { rows = JSON.parse(r.body || '[]'); } catch { rows = []; }
  const row = Array.isArray(rows) ? rows[0] : null;
  /* 区别只进服务端日志，不回客户端 */
  if (!row) {
    console.warn('[hm/login] 邮箱未注册：' + e);
    return { error: 'bad_credentials' };
  }

  let ok = false;
  try { ok = await verifyPassword(password, row.salt, row.pass_hash); }
  catch { return { error: 'store_failed', detail: '校验密码时出错' }; }
  if (!ok) {
    console.warn('[hm/login] 密码错误：' + e);
    return { error: 'bad_credentials' };
  }

  return { ok: true, sub: row.sub, token: signJwt({ sub: row.sub, email: e }) };
}

/* ══════════════════════════════════════════════════════════════
 * 邮箱验证码（注册 / 重置密码用；**登录不需要**）
 * ══════════════════════════════════════════════════════════════
 * 为什么现在要它：注册不验证邮箱所有权 = 可以拿别人的邮箱批量注册
 * （白帽报告发现 4）。登录仍然只要密码 —— 那是用户要的体验，
 * 而且登录本来就有 per-IP + per-邮箱 三重限流兜着。
 *
 * 发信走**平台自带的** `/.cloud/auth/v1/verification`（CloudBase 网关）：
 *   · 零配置、零成本，不用注册第三方、不用域名、不用存 SMTP 凭据
 *   · 平台自己保管验证码（我们只拿到一个带邮箱 + 过期时间的 verification_id）
 *   · 实测：发码 200 返回 verification_id；错码 400 `verification code does not match the id`
 *
 * ⚠⚠ 三条必须守住的：
 *   ① **verification_id 只存服务端，绝不接受客户端传来**。
 *      否则攻击者给自己邮箱领一个 id、用自己的码验过，再拿去注册别人的邮箱。
 *   ② 尝试次数上限 5（在 hm_code_get 里）。10 分钟窗口 + 6 位码不封顶是能枚举的。
 *   ③ 发信必须限流，否则就成了给别人邮箱灌垃圾邮件的工具（报告发现 7 的形态）。
 */
const AUTH_BASE = 'https://phm.app.workbuddy.host/.cloud/auth/v1';
/* 平台网关要求这两个头才认我们的调用（与站点前端同源的那把 publishable key） */
const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-wb-webapp-access-key': 'wbpk_TRm3Cbt5VeYHHDwUL854jr_5Xi69EqYG18sPzQnMMJhJr08x67NoE3b',
  'referer': 'https://phm.app.workbuddy.host/',
};
const CODE_PURPOSES = new Set(['register', 'reset']);
const CODE_TTL_SECONDS = 600;   /* 平台给的窗口就是 10 分钟 */

/** 让平台给这个邮箱发一封验证码，并把 verification_id 存进我们的库。
 *  返回 {ok} 或 {error}。**不把 verification_id 回给客户端**。 */
export async function sendCode(email, purpose) {
  const e = String(email || '').trim().toLowerCase();
  const eErr = validateEmail(e);
  if (eErr) return { error: 'email_invalid', detail: eErr };
  if (!CODE_PURPOSES.has(purpose)) return { error: 'purpose_invalid' };
  if (!WRITE_SECRET) return { error: 'unavailable', detail: '服务端未配置写入凭据' };

  /* 注册前先看这个邮箱是不是已经被注册了 —— 免得白发一封、也免得用户
     收完码才被告知"这邮箱已注册"。代价是会泄露「某邮箱注册过没」，
     但 register 本来就要回 email_taken，所以没有新增暴露面。 */
  if (purpose === 'register') {
    const ex = await rpc('hm_account_lookup', { p_email: e });
    if (ex.ok) {
      let rows = [];
      try { rows = JSON.parse(ex.body || '[]'); } catch { rows = []; }
      if (Array.isArray(rows) && rows[0]) return { error: 'email_taken' };
    }
  }

  let vid;
  try {
    const r = await fetch(AUTH_BASE + '/verification', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify({ email: e, usage: 'email' }),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.warn('[hm/send-code] 平台发信失败:', r.status, txt.slice(0, 200));
      return { error: 'send_failed' };
    }
    vid = JSON.parse(txt).verification_id;
  } catch (err) {
    console.warn('[hm/send-code] 平台请求异常:', String(err.message || err));
    return { error: 'send_failed' };
  }
  if (!vid) return { error: 'send_failed' };

  const exp = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;
  const put = await rpc('hm_code_put', { p_email: e, p_purpose: purpose, p_vid: vid, p_exp: exp });
  if (!put.ok) return { error: 'store_failed', detail: String(put.body || put.error || '').slice(0, 160) };
  return { ok: true, ttl: CODE_TTL_SECONDS };
}

/** 验码。成功时**作废**这条码（同一个码不能再用第二次）。
 *  错误码：code_missing / code_expired / code_used / code_too_many /
 *          code_wrong / code_invalid。 */
export async function verifyCode(email, purpose, code) {
  const e = String(email || '').trim().toLowerCase();
  const c = String(code || '').trim();
  if (!c) return { error: 'code_missing' };
  if (!CODE_PURPOSES.has(purpose)) return { error: 'purpose_invalid' };

  const g = await rpc('hm_code_get', { p_email: e, p_purpose: purpose });
  if (!g.ok) return { error: 'store_failed', detail: String(g.body || g.error || '').slice(0, 160) };
  let j = {};
  try { j = JSON.parse(g.body || '{}'); } catch { j = {}; }
  if (j.ok !== true) {
    /* 把 DB 的内部原因翻成稳定错误码，不直接透给客户端 */
    const map = {
      not_found: 'code_missing', expired: 'code_expired',
      used: 'code_used', too_many: 'code_too_many',
    };
    return { error: map[j.reason] || 'code_invalid' };
  }

  let ok = false;
  try {
    const r = await fetch(AUTH_BASE + '/verification/verify', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify({ verification_id: j.vid, verification_code: c }),
      signal: AbortSignal.timeout(15000),
    });
    ok = r.ok;
    if (!ok) {
      const txt = await r.text();
      console.warn('[hm/verify-code] 平台拒绝:', r.status, txt.slice(0, 160));
    }
  } catch (err) {
    console.warn('[hm/verify-code] 平台请求异常:', String(err.message || err));
    return { error: 'verify_failed' };
  }
  if (!ok) return { error: 'code_wrong' };

  const c2 = await rpc('hm_code_consume', { p_email: e, p_purpose: purpose });
  if (!c2.ok) console.warn('[hm/verify-code] 作废失败（不影响本次通过）:', String(c2.body || '').slice(0, 120));
  return { ok: true };
}

/** 重置密码：先验码，再换 hash。**不需要旧密码**（有码就够）。 */
export async function resetPassword(email, password, code) {
  const e = String(email || '').trim().toLowerCase();
  const pErr = validatePassword(password);
  if (pErr) return { error: 'password_invalid', detail: pErr };
  if (!WRITE_SECRET) return { error: 'unavailable', detail: '服务端未配置写入凭据' };

  const v = await verifyCode(e, 'reset', code);
  if (v.error) return v;

  const r = await rpc('hm_account_lookup', { p_email: e });
  if (!r.ok) return { error: 'store_failed', detail: String(r.body || r.error || '').slice(0, 160) };
  let rows = [];
  try { rows = JSON.parse(r.body || '[]'); } catch { rows = []; }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { error: 'bad_credentials' };

  const salt = crypto.randomBytes(16).toString('hex');
  let hash;
  try { hash = await hashPassword(password, salt); }
  catch (err) { return { error: 'hash_failed', detail: String(err.message || err) }; }

  const w = await rpc('hm_account_setpw', { p_sub: row.sub, p_hash: hash, p_salt: salt });
  if (!w.ok) return { error: 'store_failed', detail: String(w.body || w.error || '').slice(0, 160) };
  return { ok: true, sub: row.sub };
}

/** 诊断用：当前 token 密钥来自哪一路。**不返回值本身**。 */
export function tokenSecretSource() { return TOKEN_SECRET.source; }

/* 单测钩子：让 tools/test-hm-accounts.mjs 能验 JWT 与 sub 生成的**真身**，
   不需要起服务器、也不需要一个真数据库。 */
export const __test = {
  validateEmail, validatePassword, signJwt, verifyOwnToken, claimsOwnIssuer,
  hashPassword, verifyPassword, newSub,
  tokenSecretSource,
};
