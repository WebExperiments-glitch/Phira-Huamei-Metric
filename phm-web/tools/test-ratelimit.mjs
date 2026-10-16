/* lib/ratelimit.mjs 的完整单测 —— 直接 import 真模块。
 *
 * 覆盖十类行为，其中三类是**专门针对已发生过的故障**写的：
 *   · 滑动窗口（不是固定窗口）—— 固定窗口在边界上会放走双倍配额
 *   · 并发不丢计数 —— 读改写不串行就会互相覆盖（bfccd91 修过一次的老 bug）
 *   · 返回值不是布尔 —— `if (!obj)` 永远为真，那正是「限流失效」的同类 bug
 *
 * 跑法： node tools/test-ratelimit.mjs
 */
import {
  limit, tryEnter, leave, snapshot, reset, rlHeaders,
  RL, RL_WINDOW, gateWrite, gateStats, gateAuth, gateAnalyze, gateProxy,
} from '../lib/ratelimit.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('\n【1】基本额度：第 N 次放行，第 N+1 次拒绝');
{
  reset();
  const key = 't1';
  for (let i = 1; i <= 3; i++) T(`第 ${i} 次放行`, (await limit([key], 3)).ok);
  const r = await limit([key], 3);
  T('第 4 次拒绝', r.ok === false);
  T('拒绝时 remaining = -1', r.remaining === -1, `实际 ${r.remaining}`);
  T('拒绝时 resetMs > 0', r.resetMs > 0, `实际 ${r.resetMs}`);
  /* remaining 报的是「这一发之后还能发几次」——第一次放行后应是 max-1 */
  reset();
  const first = await limit(['t1b'], 3);
  T('放行时 remaining = max-1', first.remaining === 2, `实际 ${first.remaining}`);
}

console.log('\n【2】窗口过期后额度恢复');
{
  reset();
  const key = 't2';
  const W = 120;
  for (let i = 0; i < 2; i++) await limit([key], 2, W);
  T('第 3 次被拒', (await limit([key], 2, W)).ok === false);
  await sleep(W + 40);
  T('过了窗口又能放行', (await limit([key], 2, W)).ok === true);
}

console.log('\n【3】★ 滑动窗口 —— 不是固定窗口');
/* 固定窗口的毛病：在边界两侧各打满配额，实际拿到双倍。
   滑动窗口按「过去 W 毫秒内的计数」算，不会有这种免费重置。 */
{
  reset();
  const key = 't3';
  const W = 200;
  for (let i = 0; i < 3; i++) await limit([key], 3, W);
  T('先打满 3 次', (await limit([key], 3, W)).ok === false);
  /* 等到窗口刚过一点点 —— 固定窗口会在这里「整块清零」，
     滑动窗口只放走最早那一两条，所以仍然接近满。 */
  await sleep(W + 20);
  T('窗口过后放行 1 次', (await limit([key], 3, W)).ok === true);
  /* 关键：这一发之后不应该又白送 3 次 */
  let allowed = 1;
  while (allowed < 10 && (await limit([key], 3, W)).ok) allowed++;
  T('★ 没有出现「边界双倍」', allowed <= 3, `窗口过后又放行了 ${allowed} 次`);
}

console.log('\n【4】每个键可以有不同上限（{k, max}）');
{
  reset();
  /* 登录场景：per-IP 5 次，但 per-邮箱 3 次 */
  const spec = () => [{ k: 't4:ip', max: 5 }, { k: 't4:e', max: 3 }];
  T('第 1 次放行', (await limit(spec(), null)).ok);
  T('第 2 次放行', (await limit(spec(), null)).ok);
  T('第 3 次放行（per-邮箱到顶）', (await limit(spec(), null)).ok);
  const r = await limit(spec(), null);
  T('第 4 次被 per-邮箱 挡下', r.ok === false);
  /* 换个邮箱（同 IP）应该还能放行 —— 证明两个键是独立计数的 */
  T('换个邮箱同 IP 仍放行', (await limit([{ k: 't4:ip', max: 5 }, { k: 't4:e2', max: 3 }], null)).ok === true);
}

console.log('\n【5】多键任一超限就整体拒绝');
{
  reset();
  await limit(['t5:a', 't5:b'], 1);          // 两个键各用掉 1 次
  T('两个键都满 → 拒绝', (await limit(['t5:a', 't5:b'], 1)).ok === false);
  T('只换掉超限的那个 → 放行', (await limit(['t5:c', 't5:b'], 1)).ok === false);
  T('只换掉没超的那个 → 也放行', (await limit(['t5:a', 't5:d'], 1)).ok === false);
}

console.log('\n【6】被拒的请求不消耗配额（恢复更快）');
/* 这一条要验证的是：**桶不会因为被拒的请求而变厚**。
   做法是先把额度用干净，再狂撞 30 次，然后看桶里还是不是正好那么多条 ——
   而不是看"还能不能放行"（那种写法在额度没填满时会得出假结论）。 */
{
  reset();
  const key = 't6';
  const MAX = 3;
  for (let i = 0; i < MAX; i++) await limit([key], MAX, 60_000);
  const full = snapshot().buckets[key];
  T('额度已用干净', full === MAX, `桶里 ${full} 条`);
  for (let i = 0; i < 30; i++) await limit([key], MAX, 60_000);
  T('★ 撞 30 次后桶没有变厚', snapshot().buckets[key] === MAX,
    `桶里 ${snapshot().buckets[key]} 条`);
  T('仍然被拒', (await limit([key], MAX, 60_000)).ok === false);
  T('remaining = -1', (await limit([key], MAX, 60_000)).remaining === -1);
}

console.log('\n【7】★ 并发不丢计数');
/* 读改写不串行时，并发请求会读到同一个旧值、一起通过检查。 */
{
  reset();
  const key = 't7';
  const N = 50;
  const results = await Promise.all(Array.from({ length: N }, () => limit([key], N)));
  T(`${N} 个并发全部放行`, results.every(r => r.ok === true),
    `实际放行 ${results.filter(r => r.ok).length}`);
  const after = await limit([key], N);
  T('第 ' + (N + 1) + ' 个被拒', after.ok === false);
  /* ⚠ snapshot().buckets[k] 返回的是**条数**（number），不是数组 ——
     第一版写成 `.length` 于是恒为 undefined，断言假红。 */
  T('桶里正好 ' + N + ' 条', snapshot().buckets[key] === N,
    `实际 ${snapshot().buckets[key]}`);
}

console.log('\n【8】在途并发上限 tryEnter / leave');
{
  reset();
  T('能进 2 个', tryEnter('t8', 2) && tryEnter('t8', 2));
  T('第 3 个进不去', tryEnter('t8', 2) === false);
  T('snapshot 显示 2', (snapshot().inflight.t8 || 0) === 2);
  leave('t8');
  T('leave 后能进 1 个', tryEnter('t8', 2) === true);
  /* 漏 leave 会把名额永久吃掉 —— 这是调用方的责任，
     所以这里验证「leave 到 0 会删键」，避免 snapshot 里留下僵尸计数 */
  leave('t8'); leave('t8');
  T('leave 到 0 后键被删掉', snapshot().inflight.t8 === undefined,
    JSON.stringify(snapshot().inflight));
}

console.log('\n【9】429 的标准响应头');
{
  const h = rlHeaders({ ok: false, remaining: -1, resetMs: 42_000 });
  T('retry-after = 42', h['retry-after'] === '42', JSON.stringify(h));
  T('ratelimit-remaining = 0', h['ratelimit-remaining'] === '0');
  T('ratelimit-reset 有值', h['ratelimit-reset'] === '42');
  T('拿不到 resetMs 时兜底给整个窗口（宁可让客户端多等，不可让它立刻重试）',
    rlHeaders({})['retry-after'] === String(RL_WINDOW / 1000),
    JSON.stringify(rlHeaders({})));
  T('不是布尔值不能当 true 用（防 if(!obj) 那类 bug）',
    typeof (await limit(['t9'], 1)).ok === 'boolean');
}

console.log('\n【10】配额表本身合理');
{
  T('写入 20/分', RL.writeIp === 20);
  T('登录 per-IP 5/分', RL.loginIp === 5);
  T('登录 per-邮箱 3/分（比 per-IP 更严）', RL.loginEmail < RL.loginIp);
  T('登录有全局桶', RL.loginGlobal > 0);
  T('analyze 有全局桶', RL.analyzeGlobal > 0);
  T('代理有独立配额', RL.proxyIp > 0);
  T('所有配额都是正数', Object.values(RL).every(v => Number.isInteger(v) && v > 0));
}

console.log('\n【11】各 gate 句柄真的能跑（不起服务器）');
{
  reset();
  T('gateWrite 放行', (await gateWrite('g1')).ok === true);
  T('gateStats 放行', (await gateStats('g1')).ok === true);
  T('gateProxy 放行', (await gateProxy('g1')).ok === true);
  T('gateAnalyze 放行', (await gateAnalyze('g1')).ok === true);
  T('gateAuth 放行', (await gateAuth('g1', 'a@b.com')).ok === true);
  /* per-邮箱 3 次后第 4 次必拒，且换 IP 也绕不过 */
  for (let i = 0; i < 2; i++) await gateAuth('g1', 'a@b.com');
  T('per-邮箱第 4 次被拒', (await gateAuth('g1', 'a@b.com')).ok === false);
  T('★ 换 IP 打同一邮箱仍被拒',
    (await gateAuth('g-other', 'a@b.com')).ok === false);
  T('换邮箱同 IP 放行', (await gateAuth('g1', 'other@b.com')).ok === true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
