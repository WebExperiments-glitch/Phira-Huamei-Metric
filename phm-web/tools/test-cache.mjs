/* tools/test-cache.mjs —— 结果缓存的单测
 *
 * 跑法： node tools/test-cache.mjs
 *
 * 【为什么必须有】
 *   缓存的两类错误都很糟，而且都**不会报错**：
 *     · 该失效没失效 → 用户看到陈旧数据，以为系统坏了
 *     · key 里少了参数 → A 用户拿到 B 用户的结果（这条最严重）
 *   所以 TTL 与 key 形状必须有断言。
 */
import { cacheGet, cacheSet, cacheStats, cacheClear, CACHEABLE } from '../lib/api-cache.mjs';

let pass = 0, fail = 0;
const T = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + JSON.stringify(got)); }
};

/* ── 基本存取 ── */
cacheClear();
T('空缓存返回 undefined', cacheGet('nope') === undefined, cacheGet('nope'));
cacheSet('a', { v: 1 }, 60_000);
T('写入后能读到', cacheGet('a').v === 1, cacheGet('a'));
T('stats 记数正确', cacheStats().entries === 1, cacheStats());

/* ── 覆盖写 ── */
cacheSet('a', { v: 2 }, 60_000);
T('同 key 覆盖', cacheGet('a').v === 2, cacheGet('a'));

/* ── TTL 过期（替换 Date.now 模拟时间前进）── */
cacheClear();
const realNow = Date.now;
let fake = realNow();
Date.now = () => fake;
try {
  cacheSet('t', 'old', 1000);
  T('未到期可读', cacheGet('t') === 'old');
  fake += 500;
  T('TTL 内仍在', cacheGet('t') === 'old');
  fake += 600;                       /* 累计 1100 > 1000 */
  T('★ 到期后读不到', cacheGet('t') === undefined, cacheGet('t'));
  T('到期项被顺手清掉', cacheStats().entries === 0, cacheStats());
} finally {
  Date.now = realNow;
}

/* ── 上限淘汰（不该无限吃内存）── */
cacheClear();
for (let i = 0; i < 260; i++) cacheSet('k' + i, i, 60_000);
const st = cacheStats();
T('★ 条目数不超过上限', st.entries <= 200, st);
T('最早的被淘汰', cacheGet('k0') === undefined, cacheGet('k0'));
T('最新的还在', cacheGet('k259') === 259, cacheGet('k259'));

/* ── key 必须带参数（这是最容易出事的地方）── */
cacheClear();
cacheSet('/stats?limit=10', 'A', 60_000);
cacheSet('/stats?limit=20', 'B', 60_000);
T('★ 不同参数不串（limit=10）', cacheGet('/stats?limit=10') === 'A');
T('★ 不同参数不串（limit=20）', cacheGet('/stats?limit=20') === 'B');

/* ── 白名单只包含"全站统计/静态参照"类 ── */
T('/stats 可缓存', CACHEABLE['/stats'] > 0);
T('/reference 可缓存', CACHEABLE['/reference'] > 0);
T('★ /charts 不在白名单（用户要看最新）', CACHEABLE['/charts'] === undefined);
T('★ /file 不在白名单（二进制流式）', CACHEABLE['/file'] === undefined);
T('★ /analyses 不在白名单（有副作用）', CACHEABLE['/analyses'] === undefined);

cacheClear();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
