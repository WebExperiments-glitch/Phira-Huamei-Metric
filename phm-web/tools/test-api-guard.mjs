/* lib/api-guard.mjs 单测 —— 五层防控，全部在进程内、不连 DB。
 *
 * 跑法： node tools/test-api-guard.mjs
 * ⚠ 必须先设 PHM_TEST_NO_RATELIMIT 再动态 import：ratelimit.mjs 的 NO_RL
 *   是模块顶层常量，静态 import 会在设 env 之前求值，旁路就不生效。
 */
process.env.PHM_TEST_NO_RATELIMIT = '1';

import crypto from 'node:crypto';

const { evaluateGuard, isAdmin, guardCapabilities } = await import('../lib/api-guard.mjs');

let pass = 0, fail = 0;
const T = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const b64u = (s) => Buffer.from(s).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const SECRET = 'test-write-secret';
const HMAC_KEY = crypto.createHmac('sha256', SECRET).update('phm-hmac-v1').digest('hex');
const req = (over = {}) => Object.assign({ headers: {}, method: 'GET', url: '/api/v1/charts' }, over);
const run = (r, who = { kind: 'anon' }, opts = {}) =>
  evaluateGuard(r, who, '203.0.113.7', Object.assign({ writeSecret: SECRET, endpoint: '/charts' }, opts));

/* ── 层 3 / 身份分档：匿名只读保留，贵操作收口 ── */
let g = await run(req());
T('匿名只读放行', g.ok === true && g.tier === 'anon', JSON.stringify(g));
if (g.release) g.release();

g = await run(req(), { kind: 'anon' }, { analysis: true, bodyText: '{"chart_id":22681}' });
T('★ 匿名禁止触发重算（403）', g.ok === false && g.status === 403 && g.code === 'authentication_required', JSON.stringify(g));

g = await run(req(), { kind: 'key', id: 7 }, { analysis: true });
T('API Key 可触发重算', g.ok === true, JSON.stringify(g));
if (g.release) g.release();

/* ── 层 1：HMAC 签名 ── */
function signedHeaders(bodyText = '', ts = String(Date.now()), nonce = crypto.randomBytes(8).toString('hex'), secret = HMAC_KEY) {
  const base = ['POST', '/api/v1/analyses', sha256(bodyText), ts, nonce].join('\n');
  const sig = crypto.createHmac('sha256', secret).update(base).digest('base64url');
  return { 'x-phm-ts': ts, 'x-phm-nonce': nonce, 'x-phm-sig': sig, 'x-phm-signer': 'svc-a' };
}
const bodyText = '{"chart_id":22681}';
let hdrs = signedHeaders(bodyText);
g = await run(req({ method: 'POST', url: '/api/v1/analyses', headers: hdrs }), { kind: 'anon' },
  { analysis: true, bodyText });
T('★ 有效 HMAC 签名让匿名获得 signed 档并可重算', g.ok === true && g.tier === 'signed', JSON.stringify(g));
if (g.release) g.release();

g = await run(req({ method: 'POST', url: '/api/v1/analyses', headers: hdrs }), { kind: 'anon' },
  { analysis: true, bodyText });
T('★ nonce 重放被拒', g.ok === false && g.code === 'invalid_signature' && /nonce_replay/.test(g.message), JSON.stringify(g));

const stale = signedHeaders(bodyText, String(Date.now() - 600_000));
g = await run(req({ method: 'POST', url: '/api/v1/analyses', headers: stale }), { kind: 'anon' },
  { analysis: true, bodyText });
T('过期时间戳被拒', g.ok === false && /stale_timestamp/.test(g.message), JSON.stringify(g));

const wrong = signedHeaders(bodyText, String(Date.now()), crypto.randomBytes(8).toString('hex'), 'wrong-secret');
g = await run(req({ method: 'POST', url: '/api/v1/analyses', headers: wrong }), { kind: 'anon' },
  { analysis: true, bodyText });
T('错误签名被拒', g.ok === false && /bad_signature/.test(g.message), JSON.stringify(g));

/* ── 层 2：DPoP 自包含证明 ── */
function makeProof(htm, htu, jti) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const h = b64u(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey.export({ format: 'jwk' }) }));
  const p = b64u(JSON.stringify({ htm, htu, iat: Date.now(), jti: jti || crypto.randomUUID() }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
  return h + '.' + p + '.' + sig;
}
const proof = makeProof('GET', '/api/v1/charts');
g = await run(req({ headers: { 'x-phm-proof': proof } }));
T('★ 有效 DPoP 证明 → signed 档', g.ok === true && g.tier === 'signed', JSON.stringify(g));
if (g.release) g.release();

g = await run(req({ headers: { 'x-phm-proof': proof } }));
T('★ DPoP jti 重放被拒', g.ok === false && /proof_replay/.test(g.message), JSON.stringify(g));

const mismatched = makeProof('POST', '/api/v1/charts');
g = await run(req({ headers: { 'x-phm-proof': mismatched } }));
T('DPoP htm 不匹配被拒', g.ok === false && /proof_mismatch/.test(g.message), JSON.stringify(g));

/* ── 层 4：管理员密钥独立 ── */
T('未配置 PHM_ADMIN_SECRET 时管理员通道关闭', isAdmin(req()) === false);

/* ── 层 5：PoW 挑战（行为熵过于均匀时触发）── */
const uniformUA = 'uniform-bot/1.0';
const botReq = () => req({ headers: { 'user-agent': uniformUA, 'accept-language': 'en' } });
let challenged = null;
for (let i = 0; i < 14; i++) {
  const r = await run(botReq());
  if (r.ok && r.release) r.release();
  if (!r.ok && r.status === 428) { challenged = r; break; }
}
T('★ 过于均匀的请求间隔触发 428 PoW 挑战',
  challenged !== null && Boolean(challenged.body && challenged.body.challenge && challenged.body.challenge.seed),
  JSON.stringify(challenged));

if (challenged) {
  const seed = challenged.body.challenge.seed;
  const bits = challenged.body.challenge.bits;
  let nonce = null;
  for (let n = 0; n < 200_000; n++) {
    const cand = n.toString(16);
    if (sha256(seed + ':' + cand).startsWith('0'.repeat(bits))) { nonce = cand; break; }
  }
  T('PoW 难度在可解范围', nonce !== null, 'bits=' + bits);
  if (nonce !== null) {
    const withPow = req({ headers: { 'user-agent': uniformUA, 'accept-language': 'en', 'x-phm-pow': nonce } });
    const r = await run(withPow);
    T('★ 带正确 PoW nonce 后放行', r.ok === true, JSON.stringify(r));
    if (r.release) r.release();
  }
}

/* ── 回归：低频均匀流量不该被当成脚本（2026-11-09 线上事故）──
   状态页监控间隔精确 600s，CV≈0，被"间隔过于均匀"判成滥用 → 428 → 监控红。
   真实影响：全库统计/玩家资料各红了若干次，加上另一条 403 的，状态页红了一整天。 */
{
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  let challenged = false;
  try {
    for (let i = 0; i < 12; i++) {
      t += 600_000;                        /* 每 10 分钟一次，像监控 */
      const r = await run(req({ headers: { 'user-agent': 'monitor-600s', 'accept-language': 'en' } }));
      if (!r.ok && r.status === 428) { challenged = true; break; }
      if (r.ok && r.release) r.release();
    }
  } finally {
    Date.now = realNow;
  }
  T('★ 600s 间隔的定时监控不触发 PoW（今天是它打红了监控）', challenged === false);
}

/* ── 能力自述 ── */
const caps = guardCapabilities();
T('能力自述含三档与五层特性',
  caps.tiers.includes('anon') && caps.tiers.includes('signed') && caps.tiers.includes('admin')
  && caps.features.hmac_signature && caps.features.dpop_proof
  && caps.features.subject_rate_limit && caps.features.pow_challenge
  && caps.features.behavior_entropy && caps.features.decoy_response,
  JSON.stringify(caps));
T('匿名配置：可读、禁重算', caps.anonymous.read === true && caps.anonymous.analysis === false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
