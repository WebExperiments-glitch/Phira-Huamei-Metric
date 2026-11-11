/* tools/test-load.mjs —— 压力感知与选择性放弃的单测
 *
 * 跑法： node tools/test-load.mjs
 *
 * 【为什么必须有】
 *   这是"被打也不瘫"的核心逻辑，判错的两个方向都很糟：
 *     · 太早 shed  → 正常流量被误杀（用户看到 503）
 *     · 太晚 shed  → 全站一起变慢，连状态页都打不开
 *   所以每条规则都要有明确的断言，尤其是"谁不该被牺牲"。
 */
import {
  loadEnter, loadLeave, costOf, shouldShed, pressure, loadStats, _resetLoad, _T,
} from '../lib/api-load.mjs';

let pass = 0, fail = 0;
const T = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → 实际 ' + JSON.stringify(got)); }
};

/* ── 成本分类：分错档等于把贵的当便宜的放过去 ── */
/* ⚠ 必须带 method：POST /analyses 才是 expensive，
   成本档现在由 lib/routes.mjs 的路由表决定，不是按路径正则猜。 */
const CASES = [
  ['/api/v1/analyses', 'expensive', 'POST'],
  ['/api/v1/analyses?x=1', 'expensive', 'POST'],
  ['/api/v1/charters/257272', 'expensive'],
  ['/api/v1/players/257272', 'expensive'],
  ['/api/v1/meta', 'cheap'],
  ['/api/v1/engines/engine-v4', 'cheap'],
  ['/api/v1/behavior?limit=1', 'cheap'],
  ['/api/v1/reference', 'cheap'],
  ['/api/v1/analyses/probe', 'cheap'],
  ['/api/v1/charts', 'normal'],
  ['/api/v1/charts/22681', 'normal'],
  ['/api/v1/stats', 'normal'],
  ['/api/v1/discrepancy', 'normal'],
];
for (const [path, want, method] of CASES) {
  const got = costOf(path, method || 'GET');
  T(`成本分类 ${method || 'GET'} ${path} → ${want}`, got === want, got);
}

/* ── 正常压力：什么都不该拦 ── */
_resetLoad();
for (const cost of ['cheap', 'normal', 'expensive']) {
  for (const tier of ['anon', 'key', 'signed', 'admin']) {
    const r = shouldShed(cost, tier);
    T(`normal 下不 shed：${cost} / ${tier}`, r.shed === false, r);
  }
}

/* ── busy：只牺牲"昂贵 + 匿名" ── */
_resetLoad();
const realBusy = _T.busyInflight;
_T.busyInflight = 1;
loadEnter(); loadEnter();
T('busy 档已识别', pressure().level === 'busy', pressure());

T('★ busy：昂贵 + 匿名 → 放弃', shouldShed('expensive', 'anon').shed === true);
T('★ busy：昂贵 + Key → 保留', shouldShed('expensive', 'key').shed === false);
T('★ busy：昂贵 + 签名 → 保留', shouldShed('expensive', 'signed').shed === false);
T('busy：普通查库 + 匿名 → 保留', shouldShed('normal', 'anon').shed === false);
T('busy：廉价 + 匿名 → 保留', shouldShed('cheap', 'anon').shed === false);
const shedBusy = shouldShed('expensive', 'anon');
T('放弃时给 Retry-After', shedBusy.retryAfter > 0, shedBusy);

/* ── critical：只保"廉价"和"有身份" ── */
_resetLoad();
const realCrit = _T.criticalInflight;
_T.criticalInflight = 1;
loadEnter(); loadEnter();
T('critical 档已识别', pressure().level === 'critical', pressure());

T('★★ critical：廉价永远保（状态页/监控靠它活着）',
  ['anon', 'key', 'signed', 'admin'].every(t => shouldShed('cheap', t).shed === false));
T('★ critical：普通查库 + 匿名 → 放弃', shouldShed('normal', 'anon').shed === true);
T('★ critical：普通查库 + Key → 保留', shouldShed('normal', 'key').shed === false);
T('critical：昂贵 + Key → 放弃', shouldShed('expensive', 'key').shed === true);
T('critical：昂贵 + 签名 → 保留', shouldShed('expensive', 'signed').shed === false);
T('critical：昂贵 + 管理员 → 保留', shouldShed('expensive', 'admin').shed === false);

/* ── 计数与回落 ── */
const st = loadStats();
T('shed 有计数', st.shedTotal > 0, st);
T('shedBy 分档记录', typeof st.shedBy.expensive === 'number', st.shedBy);

_resetLoad();
loadLeave(50); loadLeave(60);
T('leave 后 inflight 不为负', pressure().inflight === 0, pressure());
loadEnter(); loadLeave(100);
T('一次 enter/leave 后 inflight 归零', pressure().inflight === 0, pressure());

_T.busyInflight = realBusy;
_T.criticalInflight = realCrit;
_resetLoad();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
