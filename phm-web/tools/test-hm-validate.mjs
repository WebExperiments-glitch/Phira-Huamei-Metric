/* lib/hm.mjs 的 `validatePlay` 单元测试。
 *
 * ⚠ **直接 import 真模块**，不抄一份实现 —— 抄一份等于测了个副本，
 *   源码改坏了测试还报"通过"。`lib/hm.mjs` 是干净的 ES 模块（无顶层副作用），
 *   所以可以放心直接 import（不需要起服务器）。
 *
 * 背景：用户实测一局真实成绩（谱面 80281 [SP]，159 音符，631855 分）被
 * 服务端 409 拒收，`error=score_mismatch`。根因是服务端拿 `perfect+good`
 * 当 max_combo 反推分数 —— 断连时算出来的分偏高。见 lib/hm.mjs 里的长注释。 */
import { validatePlay, phiraScore, subFromJwt, appIdFromKey } from '../lib/hm.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const base = {
  chart_id: 80281, chart_level: 'SP', chart_digest: 'a'.repeat(64),
  chart_notes: 159, speed: 1, mods: 0, keyboard: false,
  played_at: Date.now(), judge: 'AA==', client_ver: '0.8.2-huamei.1', judge_ver: 1,
};

console.log('\n【1】用户实测那一局（159 音符 / 631855 分）—— 130 组解里的代表');
for (const [p, g, b, m, mc] of [
  [40, 109, 5, 5, 7], [53, 89, 4, 13, 7], [105, 9, 22, 23, 7], [10, 149, 0, 0, 43],
]) {
  const n = p + g + b + m;
  const { acc, score } = phiraScore(p, g, mc, n);
  const r = validatePlay({ ...base, chart_notes: n, counts: [p, g, b, m], accuracy: acc, max_combo: mc, score });
  T(`${p}p/${g}g/${b}b/${m}m mc=${mc} → ${score} 分`, !r.error && r.warn.length === 0,
    `error=${r.error} warn=${JSON.stringify(r.warn)}`);
}

console.log('\n【2】曾经的 bug 必须不再复现：p+g 断连场景');
{
  const p = 40, g = 109, mc = 7, n = 159;
  const { score } = phiraScore(p, g, mc, n);
  const r = validatePlay({ ...base, counts: [p, g, 10, 0], accuracy: (p + 0.65 * g) / n, max_combo: mc, score });
  T('断连的真实成绩被接受（回归）', !r.error, `error=${r.error}`);
  T('且没有一致性告警', Array.isArray(r.warn) && r.warn.length === 0, JSON.stringify(r.warn));
  T('落库分数 = 客户端报的分数', r.row && r.row.score === score, `${r.row && r.row.score} vs ${score}`);
  const wrong = Math.round((0.9 * ((p + 0.65 * g) / n) + ((p + g) / n) * 0.1) * 1e6);
  T('旧错算法的值确实不同（证明这个用例有区分力）', wrong !== score, `${wrong} vs ${score}`);
}

console.log('\n【3】硬约束仍然拦得住');
T('max_combo > 物量 → 拒', validatePlay({ ...base, counts: [159, 0, 0, 0], max_combo: 200, score: 1000000, accuracy: 1 }).error === 'max_combo_impossible');
T('max_combo > p+g → 拒', validatePlay({ ...base, counts: [10, 10, 100, 39], max_combo: 21, score: 100, accuracy: 0.1 }).error === 'max_combo_impossible');
T('判定和 ≠ 物量 → 拒', validatePlay({ ...base, counts: [10, 10, 10, 10], max_combo: 1, score: 100, accuracy: 0.1 }).error === 'counts_mismatch');
T('缺 judge → 拒', validatePlay({ ...base, counts: [159, 0, 0, 0], max_combo: 159, judge: '' }).error === 'judge_missing');
T('judge 过大 → 413', validatePlay({ ...base, counts: [159, 0, 0, 0], max_combo: 159, judge: 'x'.repeat(400001) }).code === 413);
T('物量 0 → 拒', validatePlay({ ...base, chart_notes: 0, counts: [0, 0, 0, 0] }).error === 'chart_notes_invalid');
T('物量超上限 → 拒', validatePlay({ ...base, chart_notes: 100001, counts: [100001, 0, 0, 0] }).error === 'chart_notes_invalid');
T('非对象 → 拒', validatePlay(null).error === 'bad_body');
T('counts 长度不对 → 拒', validatePlay({ ...base, counts: [1, 2, 3] }).error === 'counts_invalid');
T('chart_id 非数字 → 拒', validatePlay({ ...base, chart_id: 'x', counts: [159, 0, 0, 0] }).error === 'chart_id_invalid');
T('缺 chart_level → 拒', validatePlay({ ...base, chart_level: '', counts: [159, 0, 0, 0], max_combo: 159 }).error === 'chart_level_missing');

console.log('\n【4】伪造分数 → 放行但必须告警（不再静默，也不再拒收）');
{
  const r = validatePlay({ ...base, counts: [100, 59, 0, 0], max_combo: 159, score: 999999, accuracy: 0.85 });
  T('不拒收', !r.error, `error=${r.error}`);
  T('warn 里带 score 差异', r.warn.some(w => w.startsWith('score:')), JSON.stringify(r.warn));
  T('warn 里带 accuracy 差异', r.warn.some(w => w.startsWith('accuracy:')), JSON.stringify(r.warn));
  T('落库用的是服务端自算值（不信客户端）', r.row.accuracy === (100 + 0.65 * 59) / 159, String(r.row.accuracy));
}

console.log('\n【5】满分（全 Perfect）走 1000000 分支');
{
  const r = validatePlay({ ...base, counts: [159, 0, 0, 0], max_combo: 159, score: 1000000, accuracy: 1 });
  T('满分被接受且无告警', !r.error && r.warn.length === 0, `error=${r.error} warn=${JSON.stringify(r.warn)}`);
  T('落库分数 = 1000000', r.row && r.row.score === 1000000, String(r.row && r.row.score));
}

console.log('\n【6】计分公式与 Phira 源码一致');
{
  /* 逐条对照 `prpr/src/judge.rs:207-227` 的定义 */
  T('全 Perfect → 1000000', phiraScore(10, 0, 10, 10).score === 1000000);
  T('acc 权重 good=0.65', Math.abs(phiraScore(0, 10, 0, 10).acc - 0.65) < 1e-12);
  T('score 权重 0.9/0.1', phiraScore(0, 0, 0, 10).score === 0);
  T('combo 拉满分：0.1·mc/n', phiraScore(0, 0, 10, 10).score === 100000);
}

console.log('\n【7】身份：JWT 兜底解析的拒绝路径');
{
  const appId = appIdFromKey('wbpk_abc123_rest');
  T('appId 从 key 推出', appId === 'wbapp_abc123', appId);
  T('非 JWT → not_jwt', subFromJwt('abc', appId).err === 'not_jwt');
  T('坏 payload → bad_payload', subFromJwt('a.!!!.c', appId).err === 'bad_payload');
  const mk = (payload) => 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
  T('无 sub → no_sub', subFromJwt(mk({ aud: appId }), appId).err === 'no_sub');
  T('aud 不符 → aud_mismatch', subFromJwt(mk({ sub: 'u1', aud: 'wbapp_other' }), appId).err === 'aud_mismatch');
  T('过期 → expired', subFromJwt(mk({ sub: 'u1', aud: appId, exp: 1 }), appId).err === 'expired');
  T('正常 → 拿到 sub', subFromJwt(mk({ sub: 'u1', aud: appId, exp: 9e9 }), appId).sub === 'u1');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
