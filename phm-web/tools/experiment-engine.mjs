#!/usr/bin/env node
/* ============================================================
 * tools/experiment-engine.mjs —— 引擎升级用的离线实验台
 * ============================================================
 * 【为什么需要它】
 *   现在说"升级引擎"，能拿出的依据只有中位误差 0.443。但**误差是怎么来的、
 *   换一种模型能好多少**，全靠猜。这个脚本让每个想法都能先算出数字再决定要不要做。
 *
 * 【它回答的问题】
 *   1. 现在的 kNN（8 维）在这份数据上到底是多少？（复现基线，防自欺）
 *   2. 把 **8 维换成全部特征** 能好多少？（数据里每张谱有 60+ 个特征，
 *      而 REF_DIMS 只用 8 个 —— 这是最便宜的一次实验，不需要重算任何谱面）
 *   3. 换成线性回归 / 梯度提升树呢？（判断"该换模型"还是"该加特征"）
 *
 * 【不做什么】
 *   · 不改 engine.js、不动 ENGINE_VER、不写库。纯离线读 data/*.jsonl。
 *   · 不做超参搜索（除了一个 λ 网格），避免把验证集当训练集调。
 *
 * 【用法】
 *   node tools/experiment-engine.mjs                 # 全部模型
 *   node tools/experiment-engine.mjs --seed 7        # 换随机种子看稳定性
 *   node tools/experiment-engine.mjs --only knn8,ridge
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(ROOT, '..', 'data');
const ARG = process.argv.slice(2);
const val = n => { const i = ARG.indexOf('--' + n); return i >= 0 ? ARG[i + 1] : null; };
const flag = n => ARG.includes('--' + n);

const SEED = +(val('seed') || 20261022);
const HOLD = +(val('hold') || 0.15);
const K = 20;                  /* 与 engine.js 的 K_NEIGHBORS 一致 */
const DIFF_MAX = 19.5;         /* 与 gen-ref.mjs 一致 */

/* 当前线上用的 8 维（REF_DIMS 的副本）。⚠ 别从 ref-official.js import ——
   那份是生成物，改参照集时会被覆盖；这里要的是"引擎现在用哪 8 维"这件事本身。 */
const DIMS8 = ['real_notes_per_second', 'real_core_notes_per_second', 'notes_real',
  'strain_p99', 'iv_mean', 'above_avg_density_mean', 'note_clutter_ratio', 'cross_hand_density'];

/* 明确排除：标识、目标、以及**会泄漏目标的元数据**
   （rating 是 Phira 侧的难度评级，跟 difficulty 高度相关；stable/ranked 是状态位）。
   ⚠ 泄漏检查比调参重要：一次泄漏能让任何模型看起来"准得不可思议"。 */
const BAN = new Set(['id', 'song_id', 'difficulty', 'level', 'name', 'composer', 'charter',
  'rating', 'ratingCount', 'stable', 'ranked', 'tags', 'file_size', 'chart_file', 'format',
  'rpe_version', 'fmt', 'fetched_at', 'bpm_items', 'with_father', 'bpmfactor_non1',
  't_sec', 'duration_s_missing']);

/* ── 工具 ─────────────────────────────────────────────── */
const rnd = (s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)(SEED);
const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const q = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

/* ── 载入 + 与 gen-ref 同样的清洗 ───────────────────────── */
function loadSet(file) {
  const raw = readJsonl(path.join(DATA, file));
  const rows = [];
  for (const r of raw) {
    const y = Math.round(+r.difficulty * 100) / 100;
    if (!(y > 0) || y > DIFF_MAX) continue;
    if (!(r.notes_real > 0)) continue;
    if (DIMS8.some(k => !isFinite(+r[k]) || +r[k] < 0)) continue;   /* 与参照集同口径 */
    rows.push({ y, f: r });
  }
  return rows;
}

/* 特征列：所有数值型、非禁用、且覆盖率 ≥95% 的键 */
function pickFeatures(rows) {
  const keys = new Set();
  for (const r of rows) for (const k in r.f) if (!BAN.has(k)) keys.add(k);
  const out = [];
  for (const k of keys) {
    const vals = rows.map(r => r.f[k]).filter(v => typeof v === 'number' && isFinite(v));
    if (vals.length >= rows.length * 0.95 && new Set(vals).size > 1) out.push(k);
  }
  return out.sort();
}

/* log1p + z-score（与引擎同一种变换；负值按 0 处理，与 featsToDims 一致） */
function prep(rows, feats) {
  const X = rows.map(r => feats.map(k => {
    const v = +r.f[k];
    return Math.log1p(isFinite(v) && v > 0 ? v : 0);
  }));
  return X;
}
function standardize(Xtr, Xte) {
  const p = Xtr[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (const x of Xtr) for (let j = 0; j < p; j++) mu[j] += x[j];
  for (let j = 0; j < p; j++) mu[j] /= Xtr.length;
  for (const x of Xtr) for (let j = 0; j < p; j++) { const d = x[j] - mu[j]; sd[j] += d * d; }
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j] / Xtr.length) || 1;
  const norm = X => X.map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
  return { tr: norm(Xtr), te: norm(Xte) };
}

function aggTrimmed(pairs) {
  /* 按权重归一后掐掉首尾各 15% 的**权重**，再对剩下的加权平均 */
  pairs.sort((a, b) => a.y - b.y);
  const W = pairs.reduce((s, p) => s + p.w, 0);
  if (W <= 0) return pairs[0].y;
  let acc = 0, sum = 0, wsum = 0;
  for (const p of pairs) {
    const a = acc / W, b = (acc + p.w) / W;
    const lo = Math.max(a, 0.15), hi = Math.min(b, 0.85);
    if (hi > lo) { const frac = (hi - lo) / (b - a); sum += p.y * p.w * frac; wsum += p.w * frac; }
    acc += p.w;
  }
  return wsum > 0 ? sum / wsum : median(pairs.map(p => p.y));
}

/* ── 模型 ─────────────────────────────────────────────── */
function knnPredict(Xtr, ytr, Xte) {
  const out = [];
  const p = Xtr[0].length;
  for (const qv of Xte) {
    const d = new Float64Array(Xtr.length);
    for (let i = 0; i < Xtr.length; i++) {
      const x = Xtr[i]; let s = 0;
      for (let j = 0; j < p; j++) { const t = x[j] - qv[j]; s += t * t; }
      d[i] = s;
    }
    const idx = Array.from({ length: Xtr.length }, (_, i) => i).sort((a, b) => d[a] - d[b]).slice(0, K);
    const scale = Math.max(Math.sqrt(d[idx[idx.length - 1]]), 1e-6);
    const pairs = idx.map(i => ({ y: ytr[i], w: Math.max(0, 1 - Math.sqrt(d[i]) / (scale + 1e-9)) }));
    out.push(aggTrimmed(pairs));
  }
  return out;
}

/* 岭回归：用**共轭梯度**解正规方程 (XᵀX + λI)w = Xᵀy。
   ⚠ 第一版用的是高斯-约当消元，结果预测全变成 0（中位误差 15.0）——
   47 个特征里有大量共线（strain_p90/p99/max 本来就高度相关），主元极小，
   我那句 `continue` 让整行没被归一化，解出来就是垃圾，而且**不报错**。
   共轭梯度在 λ>0 时天然良态，也不怕共线。 */
function ridgeFit(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const x = X[i], yi = y[i];
    for (let a = 0; a < p; a++) {
      const xa = x[a];
      if (!xa) continue;
      b[a] += xa * yi;
      for (let c = a; c < p; c++) A[a][c] += xa * x[c];
    }
  }
  for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  for (let a = 0; a < p; a++) A[a][a] += lambda;

  const mv = v => { const o = new Float64Array(p); for (let a = 0; a < p; a++) { let s = 0; const row = A[a]; for (let c = 0; c < p; c++) s += row[c] * v[c]; o[a] = s; } return o; };
  const dot = (u, v) => { let s = 0; for (let i = 0; i < p; i++) s += u[i] * v[i]; return s; };

  let w = new Float64Array(p);
  let r = Float64Array.from(b);
  let d = Float64Array.from(r);
  let rs = dot(r, r);
  for (let it = 0; it < 400 && rs > 1e-12; it++) {
    const Ad = mv(d);
    const alpha = rs / (dot(d, Ad) || 1e-12);
    for (let i = 0; i < p; i++) { w[i] += alpha * d[i]; r[i] -= alpha * Ad[i]; }
    const rs2 = dot(r, r);
    const beta = rs2 / (rs || 1e-12);
    for (let i = 0; i < p; i++) d[i] = r[i] + beta * d[i];
    rs = rs2;
  }
  return Array.from(w);
}
const ridgePred = (w, x) => x.reduce((s, v, j) => s + v * w[j], 0);

/* 梯度提升树（分箱加速，深度 3）。不用外部库：多一个依赖就多一份构建麻烦。 */
function gbdtFit(X, y, { trees = 120, depth = 3, lr = 0.08, bins = 32 } = {}) {
  const n = X.length, p = X[0].length;
  /* 每个特征做分位数分箱：把连续值映射到 0..bins-1，建树时只扫箱 */
  const cuts = [];
  for (let j = 0; j < p; j++) {
    const col = X.map(x => x[j]).sort((a, b) => a - b);
    const c = [];
    for (let b = 1; b < bins; b++) c.push(col[Math.floor((b / bins) * (n - 1))]);
    cuts.push(c);
  }
  const B = X.map(x => x.map((v, j) => {
    let lo = 0, hi = cuts[j].length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (v <= cuts[j][m]) hi = m; else lo = m + 1; }
    return lo;
  }));
  const pred = new Float64Array(n);
  const base = mean(y);
  pred.fill(base);
  const forest = [];
  const idx = Array.from({ length: n }, (_, i) => i);

  for (let t = 0; t < trees; t++) {
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = y[i] - pred[i];
    const tree = buildTree(B, r, idx, depth);
    forest.push(tree);
    const upd = applyTree(tree, B, idx);
    for (let i = 0; i < n; i++) pred[i] += lr * upd[i];
  }
  return { base, forest, lr, cuts, bins };

  function buildTree(Bm, res, ids, dep) {
    const node = { leaf: null, f: -1, thr: -1, L: null, R: null };
    const sum = ids.reduce((s, i) => s + res[i], 0);
    const m = sum / ids.length;
    if (dep === 0 || ids.length < 40) { node.leaf = m; return node; }
    let best = { gain: 0, f: -1, thr: -1 };
    const total = ids.reduce((s, i) => s + res[i] * res[i], 0) - ids.length * m * m;
    for (let j = 0; j < p; j++) {
      const hist = new Map();   /* thr → [sum, cnt] 左侧累积 */
      for (const i of ids) {
        const b = Bm[i][j];
        const h = hist.get(b) || [0, 0];
        h[0] += res[i]; h[1] += 1; hist.set(b, h);
      }
      const ks = [...hist.keys()].sort((a, b) => a - b);
      let sl = 0, cl = 0;
      for (let k = 0; k < ks.length - 1; k++) {
        const [s, c] = hist.get(ks[k]);
        sl += s; cl += c;
        const sr = sum - sl, cr = ids.length - cl;
        if (cl === 0 || cr === 0) continue;
        const gain = (sl * sl) / cl + (sr * sr) / cr;
        if (gain > best.gain) best = { gain, f: j, thr: ks[k] };
      }
    }
    if (best.f < 0 || best.gain <= total * 1e-6) { node.leaf = m; return node; }
    node.f = best.f; node.thr = best.thr;
    const L = [], R = [];
    for (const i of ids) (Bm[i][best.f] <= best.thr ? L : R).push(i);
    if (!L.length || !R.length) { node.leaf = m; return node; }
    node.L = buildTree(Bm, res, L, dep - 1);
    node.R = buildTree(Bm, res, R, dep - 1);
    return node;
  }
  function applyTree(node, Bm, ids) {
    const out = new Float64Array(Bm.length);
    for (const i of ids) {
      let nd = node;
      while (nd.leaf === null) nd = Bm[i][nd.f] <= nd.thr ? nd.L : nd.R;
      out[i] = nd.leaf;
    }
    return out;
  }
}
function gbdtPred(m, X) {
  const { base, forest, lr, cuts } = m;
  const B = X.map(x => x.map((v, j) => {
    let lo = 0, hi = cuts[j].length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= cuts[j][mid]) hi = mid; else lo = mid + 1; }
    return lo;
  }));
  return B.map(b => {
    let s = base;
    for (const tree of forest) {
      let nd = tree;
      while (nd.leaf === null) nd = b[nd.f] <= nd.thr ? nd.L : nd.R;
      s += lr * nd.leaf;
    }
    return s;
  });
}

/* ── 指标 ─────────────────────────────────────────────── */
function report(name, yTrue, yPred) {
  const err = yTrue.map((y, i) => Math.abs(y - yPred[i]));
  const mae = mean(err);
  const varY = mean(yTrue.map(y => (y - mean(yTrue)) ** 2));
  const r2 = 1 - mean(yTrue.map((y, i) => (y - yPred[i]) ** 2)) / varY;
  return {
    name,
    med: median(err), mean: mae, p90: q(err, 0.9),
    hit1: err.filter(e => e <= 1).length / err.length,
    hit15: err.filter(e => e <= 1.5).length / err.length,
    r2,
  };
}
const fmt = r => `${r.name.padEnd(18)} 中位 ${r.med.toFixed(3)}  均值 ${r.mean.toFixed(3)}  p90 ${r.p90.toFixed(2)}  ≤1.0 ${(r.hit1 * 100).toFixed(1)}%  ≤1.5 ${(r.hit15 * 100).toFixed(1)}%  R²=${r.r2.toFixed(3)}`;

/* ── 主流程 ───────────────────────────────────────────── */
const all = loadSet('community.jsonl');
console.log(`[experiment] 社区谱 ${all.length} 张（清洗后）  种子 ${SEED}  留出 ${(HOLD * 100).toFixed(0)}%`);

/* 固定打乱后切分 */
const order = all.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const nTest = Math.floor(all.length * HOLD);
const testIdx = new Set(order.slice(0, nTest));
const train = all.filter((_, i) => !testIdx.has(i));
const test = all.filter((_, i) => testIdx.has(i));
console.log(`  训练 ${train.length} / 测试 ${test.length}`);

/* --only a,b,c：只跑这几维（用来验证"真正要上线的那一版"的收益，
   而不是跑一个靠引擎算不出来的维度堆出来的漂亮数字） */
const ONLY = val('only') ? val('only').split(',').map(x => x.trim()).filter(Boolean) : null;
const featsAll = ONLY || pickFeatures(all);
console.log(`  特征：全部 ${featsAll.length} 个，线上用的是 ${DIMS8.length} 个`);

const yTr = train.map(r => r.y), yTe = test.map(r => r.y);
const results = [];

/* 1) 复现基线：8 维 kNN */
{
  const s = standardize(prep(train, DIMS8), prep(test, DIMS8));
  results.push(report('kNN-8（线上口径）', yTe, knnPredict(s.tr, yTr, s.te)));
}
/* 2) 全部特征 kNN */
{
  const s = standardize(prep(train, featsAll), prep(test, featsAll));
  results.push(report('kNN-全特征', yTe, knnPredict(s.tr, yTr, s.te)));
}
/* 3) 岭回归 */
{
  const s = standardize(prep(train, featsAll), prep(test, featsAll));
  /* ⚠ **必须有截距**。特征都 z-score 过（均值 0），不加截距时预测恒为 0，
     于是 |误差| ≈ 15 —— 我第一次就是这么跑出"中位 15.0"的，
     看起来像"线性模型完全不行"，其实是漏了一项，而且不报错。 */
  const yMean = mean(yTr);
  let best = null;
  for (const lam of [1, 10, 30, 100, 300]) {
    const w = ridgeFit(s.tr, yTr, lam);
    const r = report('ridge λ=' + lam, yTe, s.te.map(x => yMean + ridgePred(w, x)));
    if (!best || r.med < best.r.med) best = { r, w, lam };
  }
  results.push(Object.assign(best.r, { name: 'ridge（全特征）' }));
}
/* 4) 梯度提升树 */
if (!flag('skip-gbdt')) {
  const s = standardize(prep(train, featsAll), prep(test, featsAll));
  const t0 = Date.now();
  const m = gbdtFit(s.tr, yTr);
  results.push(report('GBDT（全特征）', yTe, gbdtPred(m, s.te)));
  console.log(`  GBDT 训练 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log('\n── 结果 ──');
for (const r of results) console.log('  ' + fmt(r));
console.log('\n注：kNN-8 应与 tools/audit-baselines.mjs 的数字接近（同口径、不同种子，差 ±0.02 属正常）。');
