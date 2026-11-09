/* ============================================================
 * lib/api-guard.mjs —— API v1 的分档防控（2026-11-08）
 * ============================================================
 * 【设计前提】匿名保留。GitHub 的做法不是"防住匿名"，而是给匿名一个
 *   "窄到亏得起"的范围：低配额 + 只读 + 次级限流；贵操作必须认证。
 *   我们照这个来，而不是把匿名一刀切掉。
 *
 * 【三档身份】
 *   admin   管理员密钥（PHM_ADMIN_SECRET）+ 时间戳签名，只管 /keys
 *   signed  带 HMAC 请求签名或 DPoP 证明 → 中高配额、防重放
 *   key     普通 API Key → 原配额
 *   anon    匿名 → 低配额只读；**禁止触发重算**
 *
 * 【五层】
 *   1 HMAC 签名：method/path/body-hash/ts/nonce，±5 分钟，nonce 去重
 *   2 DPoP：自包含 ES256 JWK proof，绑定 key 的 jkt，jti 去重
 *   3 按 subject 限流：突发桶(10s) + 持续桶(1h) + 并发上限；
 *     匿名指纹 = hash(ip + UA + lang)，缓解网关共享 IP 连坐
 *   4 管理员密钥独立：/keys 单独一套，不与业务 key 共用
 *   5 PoW 挑战 / 行为熵 / 诱捕：只对匿名生效，阈值宽松、可 env 关闭
 *
 * 【兼容】所有增强都是**可选请求头**：不带就走原来的低配额路径，
 *   现有匿名客户端与现有 sk- Key 客户端一行都不用改。
 *
 * 【状态】nonce/jti/行为记录都在进程内。部署是无状态的，重启即清空 ——
 *   这是刻意的：宁可重启后重新观察，也不把安全状态放进不可用的外部存储。
 *   文档里写清楚，别让人误以为是持久防重放。
 * ============================================================ */
import crypto from 'node:crypto';
import { limit, tryEnter, leave, RL } from './ratelimit.mjs';
import { TIERS } from './api-keys.mjs';
import { trustSignals } from './api-trust.mjs';

const HOUR = 3_600_000;
const BURST_MS = 10_000;
const TS_TOL = 300_000;
const NONCE_TTL = 600_000;

const CFG = {
  hmac: process.env.PHM_HMAC_SECRET || '',
  admin: process.env.PHM_ADMIN_SECRET || '',
  pow: process.env.PHM_POW !== '0',
  entropy: process.env.PHM_ENTROPY !== '0',
  decoy: process.env.PHM_DECOY !== '0',
  difficulty: Math.min(4, Math.max(1, Number(process.env.PHM_POW_BITS) || 2)),
};

/* 进程内状态（有上限，定期清理，防内存涨） */
const used = new Map();        // nonce|jti -> exp
const challenges = new Map();  // subject -> { seed, exp, fails }
const behavior = new Map();    // subject -> number[]（最近时间戳）
const bindings = new Map();    // keyId -> jkt（DPoP 公钥指纹）
const MAX_TRACK = 20_000;

function sweep(map, now) {
  if (map.size < 5_000) return;
  for (const [k, v] of map) {
    const exp = typeof v === 'number' ? v : (v && v.exp) || 0;
    if (exp && exp < now) map.delete(k);
  }
  if (map.size > MAX_TRACK) {
    for (const k of map.keys()) { if (map.size <= MAX_TRACK) break; map.delete(k); }
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
function timingEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ── 层 4：管理员密钥 ────────────────────────────────────────
   /keys 原本只认账号 token。这里加一条独立通道：x-phm-admin + 时间戳签名。
   不带就走原路径，兼容不变。 */
export function isAdmin(req) {
  /* ⚠ 不回退到 writeSecret：那是服务端内部密钥，让客户端持有等于泄漏。
     未配置 PHM_ADMIN_SECRET 时，这条通道直接关闭，/keys 仍走账号 token。 */
  if (!CFG.admin) return false;
  const given = String(req.headers['x-phm-admin'] || '');
  const ts = String(req.headers['x-phm-ts'] || '');
  const sig = String(req.headers['x-phm-sig'] || '');
  if (!given || !/^\d{10,13}$/.test(ts) || !sig) return false;
  if (Math.abs(Date.now() - Number(ts)) > 60_000) return false;
  if (!timingEq(given, CFG.admin)) return false;
  const expect = crypto.createHmac('sha256', CFG.admin).update('admin:' + ts).digest('base64url');
  return timingEq(sig, expect);
}

/* ── 层 1：HMAC 请求签名 ─────────────────────────────────────
   头：x-phm-ts / x-phm-nonce / x-phm-sig / x-phm-signer（可选）
   基串：METHOD \n PATH \n sha256(body) \n ts \n nonce
   密钥：PHM_HMAC_SECRET；未配置时从 writeSecret 派生，保证开箱可用。 */
function signingSecret(writeSecret) {
  return CFG.hmac || (writeSecret
    ? crypto.createHmac('sha256', writeSecret).update('phm-hmac-v1').digest('hex') : '');
}

function verifyHmac(req, bodyText, writeSecret) {
  const ts = String(req.headers['x-phm-ts'] || '');
  const nonce = String(req.headers['x-phm-nonce'] || '');
  const sig = String(req.headers['x-phm-sig'] || '');
  if (!ts || !nonce || !sig) return null;
  const secret = signingSecret(writeSecret);
  if (!secret) return null;
  if (!/^\d{10,13}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > TS_TOL) return { error: 'stale_timestamp' };
  if (nonce.length < 8 || nonce.length > 128) return { error: 'bad_nonce' };
  const base = [req.method || 'GET', (req.url || '/').split('?')[0], sha256(bodyText || ''), ts, nonce].join('\n');
  const expect = crypto.createHmac('sha256', secret).update(base).digest('base64url');
  if (!timingEq(sig, expect)) return { error: 'bad_signature' };
  const nk = 'n:' + nonce;
  const now = Date.now();
  if (used.has(nk)) return { error: 'nonce_replay' };
  used.set(nk, now + NONCE_TTL);
  sweep(used, now);
  return { signer: String(req.headers['x-phm-signer'] || '') || 'hmac' };
}

/* ── 层 2：DPoP 式自包含证明 ─────────────────────────────────
   x-phm-proof = base64url(header).base64url(payload).base64url(sig)
   header 带客户端 P-256 公钥（jwk），payload 带 htm/htu/iat/jti/jkt。
   自包含 → 不需要注册端点、不需要 DB 迁移。
   与 API Key 绑定：首次见到某 key 的 jkt 就记住，之后必须一致。 */
function jktFromJwk(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(sha256(canonical));
}

function verifyProof(req, who) {
  const raw = String(req.headers['x-phm-proof'] || '');
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return { error: 'bad_proof' };
  let h, p;
  try {
    h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return { error: 'bad_proof' }; }
  if (!h || h.alg !== 'ES256' || !h.jwk || h.typ !== 'dpop+jwt') return { error: 'bad_proof' };
  if (Math.abs(Date.now() - Number(p.iat || 0)) > TS_TOL) return { error: 'stale_proof' };
  if (String(p.htm || '') !== (req.method || 'GET')) return { error: 'proof_mismatch' };
  if (String(p.htu || '').split('?')[0] !== (req.url || '/').split('?')[0]) return { error: 'proof_mismatch' };
  const jkt = jktFromJwk(h.jwk);
  if (p.jkt && p.jkt !== jkt) return { error: 'proof_mismatch' };
  let okSig = false;
  try {
    const pub = crypto.createPublicKey({ key: h.jwk, format: 'jwk' });
    okSig = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), pub,
      Buffer.from(parts[2], 'base64url'));
  } catch { return { error: 'bad_proof' }; }
  if (!okSig) return { error: 'bad_signature' };

  const jk = 'j:' + String(p.jti || '');
  const now = Date.now();
  if (!p.jti || used.has(jk)) return { error: 'proof_replay' };
  used.set(jk, now + NONCE_TTL);

  if (who && who.kind === 'key') {
    const bound = bindings.get(who.id);
    if (bound && bound !== jkt) return { error: 'key_binding_mismatch' };
    if (!bound) bindings.set(who.id, jkt);
  }
  sweep(used, now);
  sweep(bindings, now);
  return { jkt };
}

/* ── 层 3：身份指纹与双桶 ──────────────────────────────────── */
function subjectOf(req, who, ip, proof) {
  if (who.kind === 'key') return 'key:' + who.id;
  if (proof && proof.signer) return 'sig:' + proof.signer;
  if (proof && proof.jkt) return 'dpop:' + proof.jkt;
  const ua = String(req.headers['user-agent'] || '');
  const lang = String(req.headers['accept-language'] || '');
  return 'anon:' + sha256([ip || '', ua, lang].join('|')).slice(0, 20);
}

/* ── 层 5：PoW / 行为熵 / 诱捕 ─────────────────────────────── */
function powValid(seed, nonce) {
  if (!seed || !nonce || !/^[0-9a-f]{1,16}$/i.test(nonce)) return false;
  return sha256(seed + ':' + nonce).startsWith('0'.repeat(CFG.difficulty));
}

function behaviorOdd(subject, now) {
  const arr = behavior.get(subject) || [];
  arr.push(now);
  if (arr.length > 24) arr.shift();
  behavior.set(subject, arr);
  sweep(behavior, now);
  if (arr.length < 10) return false;
  const gaps = [];
  for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  /* ⚠ 平均间隔 < 2ms 直接判脚本：真人（甚至正常轮询）不可能连续 10 次
     亚毫秒连发。只看变异系数会漏掉这种情况 —— 全是 0/1ms 时 CV 反而很大。 */
  if (mean < 2) return true;
  const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  /* 主信号：10 次以上请求挤在 15 秒内 —— 对应 GitHub 次级限流里的
     "同一端点短时过多请求"。比变异系数稳健得多：真实网络抖动不会
     抹掉密度，却会把 CV 搅乱（HTTP 实测连发 16 次 CV 仍 > 0.25）。
     PoW 只是几毫秒的低成本摩擦，误判代价远小于漏判，且只作用于匿名。 */
  if (now - arr[0] < 15_000) return true;
  /* ⚠⚠ 2026-11-09 线上事故：状态页监控间隔精确 600s，CV ≈ 0，
     被下面这条"间隔过于均匀 = 脚本"判成滥用 → 返回 428 → 监控红。
     教训：**定时监控本身就是均匀的**，均匀性只在"高频"语境下才等于脚本。
     所以加一道频率门槛：中位间隔 > 5s 的流量不适用这条启发式。
     5s 以上的均匀请求（监控 / 定时任务 / 正常轮询）不是我们想拦的东西；
     真正的滥用要么高频，要么被上面的密度信号抓住。 */
  const sorted = gaps.slice().sort((a, b) => a - b);
  const medGap = sorted[Math.floor(sorted.length / 2)];
  if (medGap > 5_000) return false;
  /* 辅助信号（仅限高频）：间隔过于均匀 = 脚本 */
  return Math.sqrt(varr) / mean < 0.25;
}

function softChallenge(subject, now) {
  const c = challenges.get(subject);
  if (c && c.exp > now) return c;
  const fresh = { seed: crypto.randomBytes(12).toString('hex'), exp: now + 120_000, fails: 0 };
  challenges.set(subject, fresh);
  sweep(challenges, now);
  return fresh;
}

/* ── 主入口 ─────────────────────────────────────────────────
   返回 { ok:true, tier, subject, release } 或
        { ok:false, status, code, message, headers?, body? }
   由 api-routes 的统一封装写成 HTTP 响应。 */
export async function evaluateGuard(req, who, ip, opts = {}) {
  const { bodyText = '', endpoint = '', analysis = false, writeSecret = '' } = opts;
  const where = endpoint ? ' on ' + endpoint : '';
  const now = Date.now();

  let proof = verifyProof(req, who);
  if (proof && proof.error) {
    return { ok: false, status: 401, code: 'invalid_proof', message: proof.error };
  }
  if (!proof) {
    const h = verifyHmac(req, bodyText, writeSecret);
    if (h && h.error) return { ok: false, status: 401, code: 'invalid_signature', message: h.error };
    proof = h;
  }

  const admin = isAdmin(req);
  const tier = admin ? 'admin' : (who.kind === 'key' ? (proof ? 'signed' : 'key') : (proof ? 'signed' : 'anon'));
  const subject = subjectOf(req, who, ip, proof);

  /* 贵操作：匿名一律不许触发重算。GitHub 同理 —— 写/重算必须认证。
     带签名或 DPoP 的匿名请求视为"有身份"，放行。 */
  if (analysis && tier === 'anon') {
    return { ok: false, status: 403, code: 'authentication_required',
      message: 'analysis requires an API key or a signed request; anonymous read-only access is retained' };
  }

  /* 层 5：只对匿名做软挑战，正常浏览完全无感。
     两个独立信号：行为熵（时序）+ 协议自洽（请求自己说不说得通）。
     任一可疑就要求 PoW —— 真人几毫秒过，伪装者每请求都要付成本。 */
  if (tier === 'anon' && CFG.pow) {
    const trust = trustSignals(req);
    const suspicious = (CFG.entropy && behaviorOdd(subject, now)) || trust.sus;
    const c = challenges.get(subject);
    if (suspicious || (c && c.exp > now)) {
      const ch = softChallenge(subject, now);
      const nonce = String(req.headers['x-phm-pow'] || '');
      if (!powValid(ch.seed, nonce)) {
        ch.fails = (ch.fails || 0) + 1;
        if (CFG.decoy && ch.fails >= 3) {
          /* 诱捕：给一个极轻量的"成功"响应，不查库、不跑引擎。
             目的是耗攻击者的时间而不是我们的算力。 */
          return { ok: false, status: 200, code: 'degraded', decoy: true,
            body: { ok: true, degraded: true, note: 'request served from lightweight path' } };
        }
        return { ok: false, status: 428, code: 'precondition_required',
          message: 'proof of work required',
          headers: { 'retry-after': '1' },
          body: {
            challenge: { seed: ch.seed, bits: CFG.difficulty, expires_at: new Date(ch.exp).toISOString() },
            /* 原因码：方便调用方判断是"太密集"还是"协议不自洽" */
            reason: trust.sus ? ('trust:' + trust.reasons.join(',')) : 'rate',
          } };
      }
      challenges.delete(subject);
    }
  }

  /* 层 3：突发 + 持续双桶，按 subject 而不是裸 IP。
     Key 的额度按档位取（normal 1000 / premium 5000 / admin 20000）——
     admin 也不是无限：无限等于没有上限，被打时自己先挂。 */
  const isKey = who.kind === 'key';
  const quota = TIERS[(who && who.tier) || 'normal'] || TIERS.normal;
  const burstMax = tier === 'anon' ? 12
    : (tier === 'signed' ? Math.max(40, quota.burst) : quota.burst);
  const hourMax = tier === 'anon' ? RL.apiAnonHour
    : (tier === 'signed' ? Math.max(RL.apiKeyHour * 2, quota.hour * 2) : quota.hour);

  const burst = await limit([{ k: 'api:burst:' + subject, max: burstMax }], burstMax, BURST_MS, { failClosed: true });
  if (!burst.ok) {
    return { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'burst limit exceeded' + where,
      headers: { 'retry-after': String(Math.ceil(BURST_MS / 1000)) } };
  }
  const sustained = await limit([
    { k: 'api:sub:' + subject, max: hourMax },
    { k: 'api:g', max: RL.apiAnonGlobal },
  ], hourMax, HOUR, { failClosed: true });
  if (!sustained.ok) {
    if (sustained.via === 'db-down') {
      return { ok: false, status: 503, code: 'rate_limit_unavailable',
        message: 'rate limiter temporarily unavailable', headers: { 'retry-after': '5' } };
    }
    return { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'too many requests; retry later' + where,
      headers: { 'retry-after': '60' } };
  }
  if (analysis && isKey) {
    const dayMax = quota.analyzeDay || RL.apiAnalyzeDay;
    const a = await limit([{ k: 'api:analyze:' + who.id, max: dayMax }],
      dayMax, 86_400_000, { failClosed: true });
    if (!a.ok) return { ok: false, status: 429, code: 'rate_limit_exceeded',
      message: 'daily analysis quota exceeded', headers: { 'retry-after': '3600' } };
  }

  /* 并发上限：每个 subject 最多 4 个在途请求 */
  const conc = 'api:conc:' + subject;
  if (!tryEnter(conc, 4)) {
    return { ok: false, status: 503, code: 'concurrency_limit', message: 'too many concurrent requests',
      headers: { 'retry-after': '2' } };
  }
  return { ok: true, tier, subject, release: () => leave(conc) };
}

export function guardCapabilities() {
  return {
    tiers: ['anon', 'normal', 'premium', 'admin', 'signed'],
    /* 三档 Key 配额（由 owner 前缀推导；admin 也不是无限，见 lib/api-keys.mjs） */
    quotas: TIERS,
    anonymous: { read: true, analysis: false, hour: RL.apiAnonHour, burst_per_10s: 12 },
    key_formats: ['sk- + 43 base64url (256 bit, 新)', 'sk- + 32 hex (128 bit, 兼容存量)'],
    signed: { hour: RL.apiKeyHour * 2, burst_per_10s: 40 },
    features: {
      hmac_signature: true, dpop_proof: true, subject_rate_limit: true,
      admin_secret: Boolean(CFG.admin), pow_challenge: CFG.pow,
      behavior_entropy: CFG.entropy, decoy_response: CFG.decoy,
    },
    note: '所有增强通过可选请求头启用；不带任何头的现有客户端行为不变。防重放状态在进程内，重启清空。',
  };
}
