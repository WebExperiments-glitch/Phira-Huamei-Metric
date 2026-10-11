#!/usr/bin/env node
/* ============================================================
 * tools/validate-ref.mjs —— 参照集留出验证（改参照集/引擎前必跑）
 * ============================================================
 * 【为什么要有它】改参照集的筛选规则、或改引擎的聚合方式，**必须能量化**。
 *   项目历史上被否掉的方案（全局岭回归、贪心选维、加权平均…）全是靠这个
 *   方法判的死刑，见 docs/ENGINE-EXPERIMENT.md。没有它就只能拍脑袋。
 *
 * 【方法（与 docs/ENGINE-EXPERIMENT.md 一致）】
 *   从 9,508 张社区参照里按 id 哈希**确定性地**切出 N 张当"未来新谱"，
 *   参照集只用剩下的。对每张留出谱跑**引擎真正的那条 k-NN**
 *   （不是重写一份 —— 重写就跟线上不是同一个算法了），
 *   预测值 vs 真值（Phira 上的声明定数）。
 *
 * 【指标】|偏差| 中位 / 均值 / p90、≤1.0 命中率、≤1.5 命中率。
 *   ⚠ 光看均值会被长尾带偏，所以五个都打出来。
 *
 * 用法：
 *   node tools/validate-ref.mjs                     # 基线
 *   node tools/validate-ref.mjs --filter "rating>=0.8"
 *   node tools/validate-ref.mjs --sweep rating      # 扫一串阈值对比
 *   node tools/validate-ref.mjs --hold 1367         # 换留出规模
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommunityRows } from './gen-ref.mjs';
import { knnReference } from '../public/js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = path.resolve(WEB, '..');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const HOLD = +(arg('hold', 1367));

/* ── 确定性哈希：同一 id 永远落在同一侧，换机器/重跑结果一致 ── */
function hash01(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000003) / 1000003;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

/* ── 数据准备：一次性，各变体共用 ── */
const rows = buildCommunityRows();                       /* 生产用行（已过滤脏行） */
const raw = readJsonl(path.join(REPO, 'data', 'community.jsonl'));
const byId = new Map(raw.map(r => [r.id, r]));
const rowsById = new Map(rows.map(r => [r[3], r]));

const holdRatio = HOLD / rows.length;
const heldOut = rows.filter(r => hash01(r[3]) < holdRatio);
const restAll = rows.filter(r => hash01(r[3]) >= holdRatio);

console.log('参照集（生产行）: ' + rows.length);
console.log('留出: ' + heldOut.length + '   参照池: ' + restAll.length + '   （留出比例 '
  + (holdRatio * 100).toFixed(1) + '%）');

/** 解析 "rating>=0.8" / "ratingCount>=50" 这类筛选 */
function parseFilter(expr) {
  if (!expr) return null;
  const m = /^(\w+)\s*(>=|>|<=|<)\s*([\d.]+)$/.exec(expr.trim());
  if (!m) throw new Error('筛选式看不懂（示例：rating>=0.8）: ' + expr);
  const [, key, op, v] = m;
  const num = +v;
  return (r) => {
    const x = +(r[key] ?? NaN);
    if (!isFinite(x)) return false;
    return op === '>=' ? x >= num : op === '>' ? x > num : op === '<=' ? x <= num : x < num;
  };
}

/** 在给定参照池上跑一遍留出验证 */
function evaluate(poolRows, label) {
  if (poolRows.length < 25) { console.log('  ' + label + '：参照池太小，跳过'); return null; }
  const devs = [];
  let skipped = 0;
  for (const h of heldOut) {
    const rec = byId.get(h[3]);
    if (!rec) { skipped++; continue; }
    /* ⚠ 用**引擎真正的那条路径**。knnReference 自己的 excludeId 也照传 ——
       留出谱本来不在池子里，但保持与线上调用形状一致，免得漏掉同源假设。 */
    const k = knnReference(rec, rec.strain_peak, poolRows, 'community', h[3]);
    if (!k || !isFinite(k.ref)) { skipped++; continue; }
    devs.push(Math.abs(k.ref - h[0]));   /* h[0] = 声明定数（真值） */
  }
  if (!devs.length) { console.log('  ' + label + '：没有可用样本'); return null; }
  devs.sort((a, b) => a - b);
  const q = p => devs[Math.min(devs.length - 1, Math.floor(devs.length * p))];
  const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
  return {
    label, n: devs.length, skipped,
    med: q(0.5), mean, p90: q(0.9),
    hit10: devs.filter(x => x <= 1.0).length / devs.length * 100,
    hit15: devs.filter(x => x <= 1.5).length / devs.length * 100,
  };
}

const fmt = (r) => r
  ? '  ' + r.label.padEnd(26) + ' n=' + String(r.n).padStart(5)
    + '  |偏差| 中位 ' + r.med.toFixed(3) + '  均值 ' + r.mean.toFixed(3)
    + '  p90 ' + r.p90.toFixed(2)
    + '   ≤1.0 ' + r.hit10.toFixed(1) + '%   ≤1.5 ' + r.hit15.toFixed(1) + '%'
  : '  ' + label + '：无结果';

/* ── 变体 ── */
const sweepKey = arg('sweep', null);
const oneFilter = arg('filter', null);
/* 裸 --clean（不带值）= 自动扫一组阈值；--clean 3 = 只测这一个 */
const cleanOn = process.argv.includes('--clean');
const cleanT = cleanOn ? (arg('clean', null) ?? '') : null;
const results = [];

const base = evaluate(restAll, '基线（全部参照）');
results.push(base);
console.log(fmt(base));

/* ── 结构自洽性清洗 ──
   思路：参照集里可能有**乱填的声明定数**。判据不用任何外部信号，
   只用结构本身 —— 一张谱的 20 个结构邻居说它大概是 X，而它自己声明是 Y，
   差得多就说明这一行是噪声标签（或者那张谱结构上很独特）。
   ⚠ 这是**标签清洗**，天然有过拟合风险：在留出集上评才有意义。
   ⚠ 只清洗参照池，**绝不动留出集** —— 否则就是拿答案改题。 */
if (cleanOn) {
  const T = +cleanT;
  console.log('\n先给参照池做自洽性体检（每个参照行用自己的邻居预测自己）…');
  const t0 = Date.now();
  const devOf = new Map();
  for (const r of restAll) {
    const rec = byId.get(r[3]);
    if (!rec) continue;
    /* excludeId = 自己：这才是"留一"，不然距离 0 自匹配，误差恒为 0 */
    const k = knnReference(rec, rec.strain_peak, restAll, 'community', r[3]);
    if (k && isFinite(k.ref)) devOf.set(r[3], Math.abs(k.ref - r[0]));
  }
  const devsAll = [...devOf.values()].sort((a, b) => a - b);
  console.log('  体检完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's    '
    + '自身 |偏差| 中位 ' + devsAll[Math.floor(devsAll.length * 0.5)].toFixed(3)
    + '  均值 ' + (devsAll.reduce((a, b) => a + b, 0) / devsAll.length).toFixed(3));
  for (const t of T ? [T] : [2, 3, 4, 5]) {
    const pool = restAll.filter(r => (devOf.get(r[3]) ?? 0) <= t);
    const r = evaluate(pool, '清洗 |自偏|≤' + t + '（参照 ' + pool.length + '）');
    results.push(r); console.log(fmt(r));
  }
}

if (sweepKey) {
  const cand = sweepKey === 'rating' ? [0.5, 0.6, 0.7, 0.8, 0.85, 0.9]
    : sweepKey === 'ratingCount' ? [1, 5, 10, 30, 50, 100, 200]
      : (() => { throw new Error('--sweep 只支持 rating / ratingCount'); })();
  for (const v of cand) {
    const f = parseFilter(sweepKey + '>=' + v);
    const pool = restAll.filter(r => f(byId.get(r[3]) || {}));
    const r = evaluate(pool, sweepKey + '>=' + v + '（参照 ' + pool.length + '）');
    results.push(r); console.log(fmt(r));
  }
} else if (oneFilter) {
  const f = parseFilter(oneFilter);
  const pool = restAll.filter(r => f(byId.get(r[3]) || {}));
  const r = evaluate(pool, oneFilter + '（参照 ' + pool.length + '）');
  results.push(r); console.log(fmt(r));
}

/* ── 小结：相对基线的变化 ── */
if (base && results.length > 1) {
  console.log('\n相对基线的变化（负 = 变好）：');
  for (const r of results.slice(1)) {
    if (!r) continue;
    const dMean = r.mean - base.mean, dMed = r.med - base.med, dHit = r.hit10 - base.hit10;
    console.log('  ' + r.label.padEnd(26)
      + ' 均值 ' + (dMean >= 0 ? '+' : '') + dMean.toFixed(3)
      + '   中位 ' + (dMed >= 0 ? '+' : '') + dMed.toFixed(3)
      + '   ≤1.0 ' + (dHit >= 0 ? '+' : '') + dHit.toFixed(1) + 'pp'
      + (dMean < -0.005 || dHit > 0.5 ? '   ← 有改善' : ''));
  }
}
