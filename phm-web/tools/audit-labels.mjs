#!/usr/bin/env node
/* ============================================================
 * tools/audit-labels.mjs —— 标签噪声：找出来、量出来、看剔除有没有用
 * ============================================================
 * 【为什么先做这个】
 *   引擎的三条路（换模型 / 应变 / 结构特征）都测过了，R² 卡在 0.46。
 *   剩下的假设是：**标签本身有噪声**。谱师自己声明的定数是主观量。
 *
 * 【三步，一步比一步硬】
 *   1. 硬规则：结构上不可能的标注（音符极少却标高难度）
 *   2. 同曲一致性：同一首歌的多张谱，难度与结构应该同向
 *   3. 剔除实验：**唯一能证明"噪声真在标签里"的那一步** ——
 *      在训练集上迭代剔掉残差最大的样本，看**留出集** R² 涨不涨。
 *      涨 = 那些样本确实是坏标签；不涨 = 它们只是难算，删了也没用。
 *
 * ⚠ 剔除实验的陷阱：按残差删样本一定会让**训练**误差变好。
 *   所以判据只能是**留出集**，而且留出集不能一起剔。
 *
 * 【用法】
 *   node tools/audit-labels.mjs            # 全部三步
 *   node tools/audit-labels.mjs --quick    # 跳过剔除实验
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(ROOT, '..', 'data');
const ARG = process.argv.slice(2);

const DIMS37 = ['real_notes_per_second', 'real_core_notes_per_second', 'notes_real',
  'strain_p99', 'iv_mean', 'above_avg_density_mean', 'note_clutter_ratio', 'cross_hand_density',
  'notes_all', 'duration_s', 'strain_peak', 'strain_p50', 'strain_p90', 'strain_raw_max',
  'iv_median', 'chord_ratio', 'fast_ratio', 'eff_peak_tps_1s', 'eff_avg_tps_1s',
  'above_avg_duration_sec', 'above_avg_density_ratio', 'chord_size_entropy', 'avg_chord_size',
  'weighted_mf_score_per_sec', 'multi_finger_3plus_events', 'stair_speed_avg', 'stair_speed_max',
  'stair_density', 'pattern_switch_rate', 'type_switch_per_sec', 'tempo_change_count',
  'hold_ratio', 'jline_rotate_density', 'drag_per_sec', 'position_entropy', 'bpm', 'lines'];

const rows = fs.readFileSync(path.join(DATA, 'community.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l))
  .filter(r => +r.difficulty > 0 && +r.difficulty <= 19.5 && +r.notes_real > 0)
  .filter(r => DIMS37.every(k => isFinite(+r[k])));

console.log(`[audit] 可用 ${rows.length} 张`);

/* ── 1) 硬规则：结构上说不通的标注 ───────────────────────────── */
console.log('\n[1] 硬规则（音符数与定数的物理关系）');
{
  /* 真实音符数对应的"合理定数上限"：经验值，故意放宽，只抓离谱的。
     Phigros 里 1000+ 音符才可能上 15；200 音符几乎不可能过 13。 */
  const caps = [
    { notes: 100, maxDiff: 9 },
    { notes: 200, maxDiff: 12 },
    { notes: 400, maxDiff: 14 },
    { notes: 800, maxDiff: 16 },
  ];
  const bad = rows.filter(r => caps.some(c => +r.notes_real < c.notes && +r.difficulty > c.maxDiff));
  console.log(`  notes_real 与定数矛盾：${bad.length} 张（${(bad.length / rows.length * 100).toFixed(2)}%）`);
  for (const b of bad.slice(0, 5)) {
    console.log(`    ${String(b.name).slice(0, 22).padEnd(24)} 音符 ${b.notes_real}  声明 ${b.difficulty}`);
  }
}

/* ── 2) 同曲一致性：同一首歌多张谱，难度应该和结构同向 ───────── */
console.log('\n[2] 同曲一致性（1494 首歌有多张谱）');
{
  const bySong = new Map();
  for (const r of rows) {
    const k = String(r.name || '').trim();
    if (!k) continue;
    if (!bySong.has(k)) bySong.set(k, []);
    bySong.get(k).push(r);
  }
  const groups = [...bySong.values()].filter(g => g.length >= 2);
  /* 组内：定数与"每音符密度"的秩相关 —— 同一首歌，密度越高定数该越高 */
  let agree = 0, disagree = 0;
  const worst = [];
  for (const g of groups) {
    const d = g.map(r => +r.difficulty);
    const f = g.map(r => Math.log1p(+r.real_notes_per_second || 0));
    const rho = spearman(f, d);
    if (g.length >= 3 && isFinite(rho)) {
      if (rho <= -0.5) { disagree++; worst.push({ name: g[0].name, n: g.length, rho }); }
      else agree++;
    }
  }
  console.log(`  三张以上同名谱的组：${agree + disagree} 个`);
  console.log(`  其中"密度越高定数反而越低"（ρ ≤ −0.5）：${disagree} 个（${(disagree / Math.max(agree + disagree, 1) * 100).toFixed(1)}%）`);
  for (const w of worst.slice(0, 4)) {
    console.log(`    ${String(w.name).slice(0, 22).padEnd(24)} ${w.n} 张  ρ=${w.rho.toFixed(2)}`);
  }
}

/* ── 3) 剔除实验：唯一能证明"噪声在标签里"的一步 ────────────── */
if (!ARG.includes('--quick')) {
  console.log('\n[3] 剔除实验（判据只看**留出集**）');
  const data = rows.map(r => ({
    x: DIMS37.map(k => Math.log1p(Math.max(0, +r[k] || 0))),
    y: +r.difficulty,
  }));

  /* 固定切分：留出集从头到尾不动 */
  let sd = 424242;
  const rr = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;
  const order = data.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const nT = Math.floor(data.length * 0.15);
  const teSet = new Set(order.slice(0, nT));
  const trAll = data.filter((_, i) => !teSet.has(i));
  const te = data.filter((_, i) => teSet.has(i));

  const ridge = (X, y, lam) => {
    const n = X.length, p = X[0].length;
    const A = Array.from({ length: p }, () => new Float64Array(p));
    const b = new Float64Array(p);
    for (let i = 0; i < n; i++) {
      const x = X[i], yi = y[i];
      for (let a = 0; a < p; a++) { const xa = x[a]; if (!xa) continue; b[a] += xa * yi; for (let c = a; c < p; c++) A[a][c] += xa * x[c]; }
    }
    for (let a = 0; a < p; a++) { for (let c = 0; c < a; c++) A[a][c] = A[c][a]; A[a][a] += lam; }
    const mv = v => { const o = new Float64Array(p); for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += A[a][c] * v[c]; o[a] = s; } return o; };
    const dot = (u, v) => { let s = 0; for (let i = 0; i < p; i++) s += u[i] * v[i]; return s; };
    const w = new Float64Array(p);
    const res = Float64Array.from(b), d = Float64Array.from(res);
    let rs = dot(res, res);
    for (let it = 0; it < 500 && rs > 1e-12; it++) {
      const Ad = mv(d), al = rs / (dot(d, Ad) || 1e-12);
      for (let i = 0; i < p; i++) { w[i] += al * d[i]; res[i] -= al * Ad[i]; }
      const rs2 = dot(res, res), be = rs2 / (rs || 1e-12);
      for (let i = 0; i < p; i++) d[i] = res[i] + be * d[i];
      rs = rs2;
    }
    return Array.from(w);
  };
  const standardize = (trX, teX) => {
    const p = trX[0].length;
    const mu = new Array(p).fill(0), sdv = new Array(p).fill(0);
    for (const x of trX) for (let j = 0; j < p; j++) mu[j] += x[j];
    for (let j = 0; j < p; j++) mu[j] /= trX.length;
    for (const x of trX) for (let j = 0; j < p; j++) { const dv = x[j] - mu[j]; sdv[j] += dv * dv; }
    for (let j = 0; j < p; j++) sdv[j] = Math.sqrt(sdv[j] / trX.length) || 1;
    const f = X => X.map(x => x.map((v, j) => (v - mu[j]) / sdv[j]));
    return { tr: f(trX), te: f(teX) };
  };
  /* λ 用**训练集内部的切分**挑，绝不碰留出集 */
  const fitAndEval = (tr) => {
    const innerCut = Math.floor(tr.length * 0.8);
    const innerTr = tr.slice(0, innerCut), innerVa = tr.slice(innerCut);
    const sInner = standardize(innerTr.map(d => d.x), innerVa.map(d => d.x));
    let best = { lam: 10, r2: -9 };
    for (const lam of [1, 10, 30, 100, 300]) {
      const w = ridge(sInner.tr, innerTr.map(d => d.y), lam);
      const my = innerTr.map(d => d.y).reduce((a, b) => a + b, 0) / innerTr.length;
      const pred = sInner.te.map(x => my + x.reduce((s, v, j) => s + v * w[j], 0));
      const yv = innerVa.map(d => d.y);
      const myv = yv.reduce((a, b) => a + b, 0) / yv.length;
      const sse = yv.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0);
      const sst = yv.reduce((s, y) => s + (y - myv) ** 2, 0);
      const r2 = 1 - sse / sst;
      if (r2 > best.r2) best = { lam, r2 };
    }
    const s = standardize(tr.map(d => d.x), te.map(d => d.x));
    const w = ridge(s.tr, tr.map(d => d.y), best.lam);
    const my = tr.map(d => d.y).reduce((a, b) => a + b, 0) / tr.length;
    const pred = s.te.map(x => my + x.reduce((sum, v, j) => sum + v * w[j], 0));
    const yv = te.map(d => d.y);
    const myv = yv.reduce((a, b) => a + b, 0) / yv.length;
    const sse = yv.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0);
    const sst = yv.reduce((s, y) => s + (y - myv) ** 2, 0);
    return { r2: 1 - sse / sst, lam: best.lam, pred };
  };

  const base = fitAndEval(trAll);
  console.log(`  基线（${trAll.length} 训练 / ${te.length} 留出）  R² = ${base.r2.toFixed(4)}  λ=${base.lam}`);

  /* 迭代剔除：每轮在**训练集内**用 5 折外的残差排，去掉最差的 5%
     ⚠ 用训练集自身的拟合残差会把"难算的正常样本"当噪声 —— 一定过拟合。
        所以每轮都留一小块做残差估计，用那一块的残差来排序。 */
  let cur = trAll.slice();
  for (let round = 1; round <= 6; round++) {
    const cut = Math.floor(cur.length * 0.8);
    const fitPart = cur.slice(0, cut), rankPart = cur.slice(cut);
    const s = standardize(fitPart.map(d => d.x), rankPart.map(d => d.x));
    const w = ridge(s.tr, fitPart.map(d => d.y), base.lam);
    const my = fitPart.map(d => d.y).reduce((a, b) => a + b, 0) / fitPart.length;
    const resid = rankPart.map((d, i) => Math.abs(d.y - (my + s.te[i].reduce((sum, v, j) => sum + v * w[j], 0))));
    const thr = [...resid].sort((a, b) => a - b)[Math.floor(resid.length * 0.95)];
    /* 只在 rankPart 上剔 —— 被剔的样本不再参与训练 */
    cur = fitPart.concat(rankPart.filter((d, i) => resid[i] <= thr));
    const r = fitAndEval(cur);
    console.log(`  第 ${round} 轮剔除后（${cur.length} 训练）  R² = ${r.r2.toFixed(4)}`
      + `   ΔR² ${(r.r2 - base.r2 >= 0 ? '+' : '')}${(r.r2 - base.r2).toFixed(4)}`);
  }
  console.log('\n  判读：ΔR² 显著为正 → 被剔的确实是坏标签，噪声在标签里；');
  console.log('        ΔR² 在 0 附近或为负 → 它们只是"难算"，不是错标 —— 别剔。');
}

function spearman(a, b) {
  const rank = xs => {
    const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  const mb = rb.reduce((s, v) => s + v, 0) / rb.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}
