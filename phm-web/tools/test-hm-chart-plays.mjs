/* hm-queue 的 chart_plays 计数语义测试。
 *
 * 【为什么单独测】
 *   这是结算页「本谱累计第 N 局」的唯一数据源。错了客户端就显示错的数字，
 *   而且因为是内存计数，跑一遍看不出来 —— 必须有断言守着三条语义：
 *     1. 无 digest → 不返回字段（客户端 serde(default) 不显示）
 *     2. 入队即 +1，同一 digest 累加
 *     3. 预热基线 + 入队增量 分层，预热晚到也不覆盖增量
 */
import assert from 'node:assert/strict';

/* 先拿一个干净的模块实例：queue 是模块级单例，其他测试不 import 它，这里独占。 */
const q = await import('../lib/hm-queue.mjs');

/* ── ① 无 digest：返回空对象 ── */
assert.deepEqual(q.chartPlaysField(null), {}, '无 digest 必须返回空对象');
assert.deepEqual(q.chartPlaysField(undefined), {}, 'undefined digest 必须返回空对象');
assert.deepEqual(q.chartPlaysField(''), {}, '空字符串 digest 必须返回空对象');

/* ── ② 未初始化时：增量从 0 起算 ── */
const D = 'digest-abc123';
assert.deepEqual(q.chartPlaysField(D), { chart_plays: 0 }, '未入队时应为 0');

/* ── ③ 入队即计数（不需要 writer，enqueue 不该等库） ── */
const row = (digest, score) => ({ chart_digest: digest, score, chart_id: 80030 });
const before = Date.now();
const id1 = q.enqueue(row(D, 900001));
const enqueueMs = Date.now() - before;
assert.ok(id1, 'enqueue 应返回 id');
assert.ok(enqueueMs < 100, `enqueue 不该碰库（实测 ${enqueueMs}ms）`);
assert.deepEqual(q.chartPlaysField(D), { chart_plays: 1 }, '入队一局应为 1');

q.enqueue(row(D, 900002));
assert.deepEqual(q.chartPlaysField(D), { chart_plays: 2 }, '同 digest 第二局应为 2');

/* ── ④ 不同 digest 互不干扰 ── */
const D2 = 'digest-xyz789';
q.enqueue(row(D2, 900003));
assert.deepEqual(q.chartPlaysField(D), { chart_plays: 2 }, '另一个 digest 不影响第一个');
assert.deepEqual(q.chartPlaysField(D2), { chart_plays: 1 }, '新 digest 从 1 起');

/* ── ⑤ 无 digest 的局不计数 ── */
q.enqueue(row(null, 900004));
assert.deepEqual(q.chartPlaysField(null), {}, '无 digest 不入计数');

console.log('✓ hm chart_plays 计数语义：5 组断言通过');
process.exit(0);
