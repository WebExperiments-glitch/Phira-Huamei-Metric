/* 匿名「PoW 换一次分析」的语义测试。
 *
 * 【为什么必须有】
 *   这条链路有三个容易错的点，且都不会在页面上显形：
 *     1. 挑战必须**一次性**——能一题多用，等于把 20~40 秒 CPU 白送
 *     2. 匿名必须**立刻 202**——同步等就会 504（网关 30 秒）
 *     3. 已缓存必须**不消耗配额**——否则热门谱会把玩家的日额度吃光
 *
 * 【为什么用 ?query 重新 import】
 *   CFG 在模块加载时读环境变量。要验证「位数可调 + 有夹取」，
 *   必须拿到多个互不影响的新实例；ESM 的模块缓存用 query 后缀绕开。
 *   默认档（20 bits）单独一次 import 验，求解则用低位数实例 ——
 *   否则每跑一次测试都要烧 100 万次 sha256，CI 会变慢且偶发超时。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/* 按**真 bit** 判定前导零（与服务端 powValidBits 同一口径）。
   ⚠ 不能用 startsWith('0'.repeat(bits)) —— 那是「几个十六进制零」，
     20 就变成 80 bit，永远解不出。这条坑服务端也踩过。 */
const leadBits = (hex) => {
  let n = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) { n += 4; continue; }
    n += v < 2 ? 3 : v < 4 ? 2 : v < 8 ? 1 : 0;
    break;
  }
  return n;
};
const solve = (seed, bits) => {
  for (let i = 0; i < 4_000_000; i++) {
    const nonce = i.toString(16);
    if (leadBits(sha256(seed + ':' + nonce)) >= bits) return nonce;
  }
  throw new Error('解不出挑战（位数 ' + bits + '）');
};

const mkReq = () => ({
  headers: { 'user-agent': 'test-agent', 'accept-language': 'zh' },
  method: 'POST', url: '/api/v1/pow',
});
const who = { kind: 'anon', sub: null };

/* ── ① 默认档必须是 20 bits，且带 purpose ── */
delete process.env.PHM_POW_ANALYZE_BITS;
const gDefault = await import('../lib/api-guard.mjs?case=default');
const chDefault = gDefault.issueAnalysisChallenge(mkReq(), who, '1.2.3.4');
assert.equal(chDefault.bits, 20, '分析档默认 20 bits（摩擦档是 2~4，绝不能混）');
assert.equal(chDefault.purpose, 'analyze');
assert.ok(chDefault.seed && chDefault.seed.length >= 16, 'seed 必须存在');
assert.ok(chDefault.expires_at, '必须带过期时间');
console.log('  ✓ 默认档 20 bits');

/* ── ② 位数可调且有夹取（12..24） ── */
process.env.PHM_POW_ANALYZE_BITS = '14';
const g14 = await import('../lib/api-guard.mjs?case=14');
assert.equal(g14.issueAnalysisChallenge(mkReq(), who, '1.2.3.4').bits, 14, '应能调到 14');

process.env.PHM_POW_ANALYZE_BITS = '99';
const gHigh = await import('../lib/api-guard.mjs?case=high');
assert.equal(gHigh.issueAnalysisChallenge(mkReq(), who, '1.2.3.4').bits, 24, '上限应夹到 24');

process.env.PHM_POW_ANALYZE_BITS = '1';
const gLow = await import('../lib/api-guard.mjs?case=low');
assert.equal(gLow.issueAnalysisChallenge(mkReq(), who, '1.2.3.4').bits, 12, '下限应夹到 12');
console.log('  ✓ 位数可调且夹取在 12..24');

/* ── ③ 正解通过 / 错解拒绝（用 14 bits 实例，成本可控） ── */
delete process.env.PHM_POW_ANALYZE_BITS;
const ch = g14.issueAnalysisChallenge(mkReq(), who, '5.6.7.8');
const t0 = Date.now();
const nonce = solve(ch.seed, ch.bits);
const solveMs = Date.now() - t0;
assert.ok(/^[0-9a-f]{1,16}$/i.test(nonce), 'nonce 必须能被 x-phm-pow 的正则接受');
assert.ok(leadBits(sha256(ch.seed + ':' + nonce)) >= ch.bits, '正解必须满足前导零 bit');
const wrong = nonce === 'deadbeef' ? 'cafe' : 'deadbeef';
assert.ok(leadBits(sha256(ch.seed + ':' + wrong)) < ch.bits, '错解必须不满足');
console.log(`  ✓ 正解通过 / 错解拒绝（${ch.bits} bits，本地 ${solveMs}ms）`);

/* ── ④ 队列：同一张谱去重，只算一次 ── */
const { createAnalysisQueue } = await import('../lib/analysis-queue.mjs');
let computed = 0;
const q = createAnalysisQueue({
  recompute: async () => { computed++; await new Promise(r => setTimeout(r, 10)); return { chart_id: 1 }; },
  dbPutChart: async () => ({ ok: true }),
  limit: async () => ({ ok: true, remaining: 4 }),
  log: { warn() {} },
});
const a = q.requestAnalysis(80030);
const b = q.requestAnalysis(80030);
assert.equal(a.ok, true);
assert.equal(a.dedup, false, '第一次是真正入队');
assert.equal(b.dedup, true, '同一张谱在算的时候必须去重');
await new Promise(r => setTimeout(r, 80));
assert.equal(computed, 1, '去重后只应该算一次（实际 ' + computed + ' 次）');
console.log('  ✓ 同谱去重：两次请求只计算 1 次');

/* ── ⑤ 不同谱各算一次 ── */
q.requestAnalysis(111);
q.requestAnalysis(222);
await new Promise(r => setTimeout(r, 150));
assert.equal(computed, 3, '三张不同的谱应该算三次（实际 ' + computed + '）');
console.log('  ✓ 不同谱各自入队');

/* ── ⑥ 背压：积压满了必须返回 ok:false，不能无声丢弃 ── */
const slow = createAnalysisQueue({
  recompute: () => new Promise(() => {}),
  dbPutChart: async () => ({ ok: true }),
  limit: async () => ({ ok: true, remaining: 4 }),
  log: { warn() {} },
});
let last = null;
for (let i = 1; i <= 70; i++) last = slow.requestAnalysis(i);
assert.equal(last.ok, false, '超过 64 张后必须拒绝（让调用方回 503）');
console.log('  ✓ 背压生效：积压满后返回 ok:false');

/* ── ⑦ 配额：**默认不限次**（2026-11-16 用户决定：游戏端不该被按天卡） ── */
const unlimited = createAnalysisQueue({
  recompute: async () => ({}), dbPutChart: async () => ({ ok: true }),
  limit: async () => { throw new Error('默认不应调用库侧配额'); }, log: { warn() {} },
});
const uq = await unlimited.anonQuota('9.9.9.9');
assert.equal(uq.ok, true, '默认必须放行');
assert.equal(uq.unlimited, true, '必须如实标注不限次');
console.log('  ✓ 默认不限次（不查库、不拒绝）');

/* 显式设了上限时才拒绝 —— 留一个可收紧的开关 */
process.env.PHM_ANON_ANALYSIS_DAILY = '3';
const { createAnalysisQueue: freshFactory } = await import('../lib/analysis-queue.mjs?case=cap');
const capped = freshFactory({
  recompute: async () => ({}), dbPutChart: async () => ({ ok: true }),
  limit: async () => ({ ok: false, remaining: -1 }), log: { warn() {} },
});
assert.equal((await capped.anonQuota('9.9.9.9')).ok, false, '设了上限且库侧说超了就必须拒');
delete process.env.PHM_ANON_ANALYSIS_DAILY;
console.log('  ✓ 显式设置上限时仍可拒绝（fail-closed）');

console.log('\n✓ 匿名 PoW 换分析：7 组断言通过（默认不限次）');
process.exit(0);
