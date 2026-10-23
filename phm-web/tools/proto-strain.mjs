#!/usr/bin/env node
/* ============================================================
 * tools/proto-strain.mjs —— 应变模型离线原型（不改引擎、不上线）
 * ============================================================
 * 【要回答的两个问题】
 *   1. 把"整曲 37 个聚合特征"换成"逐物件 strain + 分段峰值"，难度还能算出来吗？
 *   2. 应变特征能不能给现有 37 维**加信息**？—— 这才是决定要不要做的那个
 *
 * 【为什么这么算】
 *   照 osu! 的结构（2025-10 公开说明）：
 *     物件预处理 → 逐物件难度 → strain 随时间衰减累积
 *     → 固定时长切段取峰值 → 峰值按衰减权重加权 → 一个标量
 *   我们改的两处：用 Phigros 坐标算位移；chord 单独给倍率。
 *
 * 【用法】
 *   node tools/proto-strain.mjs --n 200            # 单变量相关 + ASCII 曲线
 *   node tools/proto-strain.mjs --n 400 --combine  # 关键实验：加信息测试
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(ROOT, '..', 'data');
const ARG = process.argv.slice(2);
const val = n => { const i = ARG.indexOf('--' + n); return i >= 0 ? ARG[i + 1] : null; };
const N = +(val('n') || 200);
const SPARK = +(val('spark') || 3);

const eng = await import('../public/js/engine.js');

/* ── 参数（先手调；相关性对常数不敏感）────────────────────── */
const SEC_MS = 500;        /* 分段长度：osu 用 400ms，我们谱面更密，取 500 */
const TAU_SPEED = 0.35;    /* 速度轴衰减：连续快速出音会累积 */
const TAU_STAMINA = 1.6;   /* 耐力轴衰减慢：长段落会积累疲劳 */
const PEAKS = 12;
const PEAK_DECAY = 0.92;
const MIN_DT = 0.045;

const sat = (v, k) => (v <= 0 ? 0 : 1 - Math.exp(-v / k));

/* ── 物件组难度 ─────────────────────────────────────────────── */
function groupDifficulty(g, prev) {
  const dt = Math.max(g.sec - prev.sec, MIN_DT);
  const nps = g.notes.length / dt;
  const dSpeed = sat(nps, 4.5);

  let dMove = 0;
  if (prev.notes.length) {
    let sum = 0, cnt = 0;
    for (const a of g.notes) {
      let best = Infinity;
      for (const b of prev.notes) {
        const dx = Math.abs(a.x - b.x) / 900;
        const dl = Math.abs(a.line - b.line);
        const d = Math.sqrt(dx * dx + (dl * 0.35) ** 2);
        if (d < best) best = d;
      }
      sum += best; cnt++;
    }
    dMove = sat(sum / Math.max(cnt, 1), 0.55);
  }

  const chord = g.notes.length;
  const dChord = sat(chord - 1, 1.8);
  return { d: 0.55 * dSpeed + 0.30 * dMove + 0.15 * dChord, dSpeed, dMove, dChord, chord, dt, nps };
}

/* ── 应变累积：两条轴（速度衰减快 / 耐力衰减慢）──────────────── */
export function strainCurve(notes) {
  const groups = [];
  for (const n of notes) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.sec - n.sec) < 0.006) last.notes.push(n);
    else groups.push({ sec: n.sec, notes: [n] });
  }
  const out = [];
  let sSpeed = 0, sStam = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const prev = i ? groups[i - 1] : { sec: g.sec - MIN_DT, notes: [] };
    const dt = Math.max(g.sec - prev.sec, MIN_DT);
    const q = groupDifficulty(g, prev);
    sSpeed = sSpeed * Math.exp(-dt / TAU_SPEED) + q.d;
    sStam = sStam * Math.exp(-dt / TAU_STAMINA) + q.d * 0.35;
    out.push(Object.assign({ sec: g.sec, strain: sSpeed + sStam }, q));
  }
  return out;
}

/* ── 分段峰值 → 标量 + 曲线 ─────────────────────────────────── */
export function summarize(curve) {
  if (!curve.length) return { value: 0, sections: [] };
  const t0 = curve[0].sec;
  const buckets = new Map();
  for (const p of curve) {
    const k = Math.floor((p.sec - t0) / (SEC_MS / 1000));
    const cur = buckets.get(k);
    if (!cur || p.strain > cur) buckets.set(k, p.strain);
  }
  const sections = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => ({ t: t0 + k * SEC_MS / 1000, v }));
  const top = sections.map(s => s.v).sort((a, b) => b - a).slice(0, PEAKS);
  let sum = 0, w = 0, acc = 1;
  for (const v of top) { sum += v * acc; w += acc; acc *= PEAK_DECAY; }
  return { value: w ? sum / w : 0, sections };
}

/* ── 统计 ───────────────────────────────────────────────────── */
function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1;
  return r;
}
function spearman(a, b) {
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
function pearson(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}
function r2linear(xs, ys) {
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0, sst = 0;
  for (let i = 0; i < xs.length; i++) {
    sse += (ys[i] - (a + b * xs[i])) ** 2;
    sst += (ys[i] - my) ** 2;
  }
  return 1 - sse / sst;
}

/* ── 载入 ───────────────────────────────────────────────────── */
function loadNotes(id) {
  const fp = path.join(DATA, 'charts', String(id), 'chart.json');
  if (!fs.existsSync(fp)) return null;
  try {
    /* ⚠ 有些 chart.json 其实是 PEC 纯文本，JSON.parse 会抛 —— 跳过就好，
       但不能让整个原型挂掉（第一版就是这么崩的） */
    const ch = eng.loadChart(JSON.parse(fs.readFileSync(fp, 'utf8')));
    const notes = ch.real.filter(n => !n.fake).sort((a, b) => a.sec - b.sec);
    return notes.length >= 30 ? { notes, dur: ch.dur } : null;
  } catch { return null; }
}

const rows = fs.readFileSync(path.join(DATA, 'community.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l))
  .filter(r => +r.difficulty > 0 && +r.difficulty <= 19.5 && +r.notes_real > 0);

const step = Math.max(1, Math.floor(rows.length / N));
const sample = rows.filter((_, i) => i % step === 0).slice(0, N);

/* ── 模式一：单变量相关 + ASCII 曲线 ────────────────────────── */
if (!ARG.includes('--combine')) {
  const got = [], want = [];
  let skipped = 0;
  for (const r of sample) {
    const c = loadNotes(r.id);
    if (!c) { skipped++; continue; }
    const { value } = summarize(strainCurve(c.notes));
    if (!isFinite(value) || value <= 0) { skipped++; continue; }
    got.push(value); want.push(+r.difficulty);
  }
  console.log(`[proto-strain] 样本 ${got.length} 张（跳过 ${skipped}）`);
  console.log(`  Spearman ρ = ${spearman(got, want).toFixed(4)}`);
  console.log(`  Pearson  r = ${pearson(got, want).toFixed(4)}`);
  console.log(`  单变量拟合 R² = ${r2linear(got, want).toFixed(4)}   ← 与 kNN 的 0.464 同一尺度`);
  console.log(`  strain 范围 ${Math.min(...got).toFixed(2)} ~ ${Math.max(...got).toFixed(2)}`);
  console.log('\n⚠ 这是**一个标量**的线性拟合，kNN 用了 37 维。');
  console.log('   单标量到这个数说明方向对；能不能超过 37 维，看 --combine。');

  const bars = '▁▂▃▄▅▆▇█';
  for (let i = 0; i < Math.min(SPARK, sample.length); i++) {
    const c = loadNotes(sample[i].id);
    if (!c) continue;
    const { sections } = summarize(strainCurve(c.notes));
    const vs = sections.map(s => s.v);
    const mx = Math.max(...vs) || 1;
    console.log(`\n  ${String(sample[i].name || '').slice(0, 28)}  [声明 ${sample[i].difficulty}]`);
    console.log('  ' + vs.map(v => bars[Math.min(7, Math.floor((v / mx) * 7.99))]).join(''));
    const peak = sections.reduce((a, b) => (b.v > a.v ? b : a));
    console.log(`  最难点 ≈ ${Math.floor(peak.t / 60)}:${String(Math.floor(peak.t % 60)).padStart(2, '0')}`
      + `  全长 ${Math.floor(c.dur / 60)}:${String(Math.floor(c.dur % 60)).padStart(2, '0')}`);
  }
}

/* ── 模式二：关键实验 —— 新特征能不能给现有 37 维加信息 ───────
 * 两组候选：
 *   A. 应变特征（逐物件 strain 派生的 8 个汇总）—— 已验证无增益，留作对照
 *   B. 结构特征（jack / trill / 变速 / 密度变异）—— 这次要测的
 *
 * 判据只有一个：**加进去之后 R² 涨不涨**。
 * 单独跑得好看没有意义 —— 一个标量当然比不过 37 维。
 */
if (ARG.includes('--combine')) {
  const DIMS37 = ['real_notes_per_second', 'real_core_notes_per_second', 'notes_real',
    'strain_p99', 'iv_mean', 'above_avg_density_mean', 'note_clutter_ratio', 'cross_hand_density',
    'notes_all', 'duration_s', 'strain_peak', 'strain_p50', 'strain_p90', 'strain_raw_max',
    'iv_median', 'chord_ratio', 'fast_ratio', 'eff_peak_tps_1s', 'eff_avg_tps_1s',
    'above_avg_duration_sec', 'above_avg_density_ratio', 'chord_size_entropy', 'avg_chord_size',
    'weighted_mf_score_per_sec', 'multi_finger_3plus_events', 'stair_speed_avg', 'stair_speed_max',
    'stair_density', 'pattern_switch_rate', 'type_switch_per_sec', 'tempo_change_count',
    'hold_ratio', 'jline_rotate_density', 'drag_per_sec', 'position_entropy', 'bpm', 'lines'];

  /* ── 结构特征：从音符序列表里"形状"，不是强度 ──────────────
     这些和现有特征的关键区别：现有全是"多少/多快"，
     这里问的是"怎么排"。同一批音符换个排法，强度一样、难度不一样。 */
  function structFeatures(notes) {
    /* 按时间分组（chord 为一组） */
    const groups = [];
    for (const n of notes) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(last.sec - n.sec) < 0.006) last.notes.push(n);
      else groups.push({ sec: n.sec, notes: [n] });
    }
    const X = 36;                       /* 位置量化：450*2/36 ≈ 25 单位一档 */
    const key = n => n.line * 1000 + Math.round(n.x / X);

    /* 1) jack：同一条"轨道"上连续出现 —— 采样最短间隔与最长连续数 */
    let jackRunMax = 0, jackGapMin = 9, jackRuns = 0;
    {
      let run = 1, prevSec = null;
      for (let i = 1; i < groups.length; i++) {
        const a = groups[i - 1].notes, b = groups[i].notes;
        const shared = b.some(y => a.some(x => key(x) === key(y)));
        if (shared) {
          run++;
          const gap = groups[i].sec - groups[i - 1].sec;
          if (gap < jackGapMin) jackGapMin = gap;
          if (run >= 3) jackRuns++;
        } else {
          if (run > jackRunMax) jackRunMax = run;
          run = 1;
        }
        prevSec = groups[i].sec;
      }
      if (run > jackRunMax) jackRunMax = run;
      if (jackGapMin > 8) jackGapMin = 8;
    }

    /* 2) trill：两组位置交替（A-B-A-B），统计最长交替长度 */
    let trillRunMax = 0;
    {
      let run = 1;
      for (let i = 2; i < groups.length; i++) {
        const k0 = groups[i - 2].notes.map(key).sort().join(',');
        const k1 = groups[i - 1].notes.map(key).sort().join(',');
        const k2 = groups[i].notes.map(key).sort().join(',');
        if (k0 === k2 && k0 !== k1) run++;
        else { if (run > trillRunMax) trillRunMax = run; run = 1; }
      }
      if (run > trillRunMax) trillRunMax = run;
    }

    /* 3) 密度变异：把曲目切 1 秒，看每格音符数的变异系数
          —— 峰值型（爆发）与均匀型在这条上分得开，现有特征只有均值/分位 */
    let densityCV = 0, densityMaxRatio = 0;
    {
      const t0 = groups[0].sec, dur = Math.max(groups[groups.length - 1].sec - t0, 1);
      const bins = Math.max(1, Math.floor(dur));
      const cnt = new Array(bins).fill(0);
      for (const g of groups) {
        const b = Math.min(bins - 1, Math.floor(g.sec - t0));
        cnt[b] += g.notes.length;
      }
      const mean = cnt.reduce((s, v) => s + v, 0) / bins;
      const varr = cnt.reduce((s, v) => s + (v - mean) ** 2, 0) / bins;
      densityCV = mean > 0 ? Math.sqrt(varr) / mean : 0;
      const sorted = [...cnt].sort((a, b) => b - a);
      const med = sorted[Math.floor(bins / 2)] || 1;
      densityMaxRatio = (sorted[0] || 0) / Math.max(med, 1);
    }

    /* 4) 变速：相邻组间隔的比值分布 —— 恒速谱比值集中在 1，变速谱散开 */
    let intervalEntropy = 0, intervalMad = 0;
    {
      const dts = [];
      for (let i = 1; i < groups.length; i++) dts.push(groups[i].sec - groups[i - 1].sec);
      const ok = dts.filter(d => d > 0.01);
      if (ok.length > 10) {
        const mx = Math.max(...ok);
        const BINS = 24, hist = new Array(BINS).fill(0);
        for (const d of ok) hist[Math.min(BINS - 1, Math.floor((d / mx) * BINS))]++;
        const tot = ok.length;
        for (const h of hist) if (h) intervalEntropy -= (h / tot) * Math.log2(h / tot);
        const med = [...ok].sort((a, b) => a - b)[ok.length >> 1];
        intervalMad = ok.reduce((s, d) => s + Math.abs(d - med), 0) / ok.length / (med || 1);
      }
    }

    /* 5) 跨手：相邻组的主要位置是否分居两侧 */
    let crossHandRate = 0;
    {
      let cross = 0;
      for (let i = 1; i < groups.length; i++) {
        const ax = groups[i - 1].notes.reduce((s, n) => s + n.x, 0) / groups[i - 1].notes.length;
        const bx = groups[i].notes.reduce((s, n) => s + n.x, 0) / groups[i].notes.length;
        if (ax * bx < 0 && Math.abs(ax - bx) > 200) cross++;
      }
      crossHandRate = groups.length > 1 ? cross / (groups.length - 1) : 0;
    }

    return [jackRunMax, jackGapMin, jackRuns / Math.max(groups.length, 1),
      trillRunMax, densityCV, densityMaxRatio, intervalEntropy, intervalMad, crossHandRate];
  }

  /* 应变特征（对照组，已验证无增益） */
  function strainFeaturesOf(secs) {
    const sorted = [...secs].sort((a, b) => b - a);
    const mx = sorted[0] || 1;
    const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
    let run = 0, best = 0;
    for (const v of secs) { if (v > mx * 0.7) { run++; if (run > best) best = run; } else run = 0; }
    return [mx, mean,
      sorted.slice(0, 12).reduce((a, b) => a + b, 0) / Math.min(12, sorted.length),
      secs.filter(v => v > mx * 0.8).length / secs.length,
      best * (SEC_MS / 1000), secs.length,
      sorted[Math.floor(sorted.length * 0.5)] || 0, (mx - mean) / (mean || 1)];
  }

  const data = [];
  for (const r of sample) {
    const c = loadNotes(r.id);
    if (!c) continue;
    const secs = summarize(strainCurve(c.notes)).sections.map(s => s.v);
    if (!secs.length) continue;
    const base = DIMS37.map(k => Math.log1p(Math.max(0, +r[k] || 0)));
    if (!base.every(isFinite)) continue;
    data.push({
      base,
      strain: strainFeaturesOf(secs),
      struct: structFeatures(c.notes),
      y: +r.difficulty,
    });
  }
  console.log(`\n[combine] 可用样本 ${data.length} 张`);

  /* 多次随机切分：单次 ΔR² 的随机波动可能就有 0.02 量级，
     不重复几遍根本分不清"特征有用"和"这次切得好"。 */
  const SEEDS = +(val('seeds') || 6);
  const splits = [];
  for (let k = 0; k < SEEDS; k++) {
    let sd = 7 + k * 1013;
    const rr = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;
    const order = data.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const nT = Math.floor(data.length * 0.2);
    const teSet = new Set(order.slice(0, nT));
    splits.push({
      tr: data.filter((_, i) => !teSet.has(i)),
      ts: data.filter((_, i) => teSet.has(i)),
    });
  }

  const ridge = (X, y, lam) => {
    const n = X.length, p = X[0].length;
    const A = Array.from({ length: p }, () => new Float64Array(p));
    const b = new Float64Array(p);
    for (let i = 0; i < n; i++) {
      const x = X[i], yi = y[i];
      for (let a = 0; a < p; a++) {
        const xa = x[a]; if (!xa) continue;
        b[a] += xa * yi;
        for (let c = a; c < p; c++) A[a][c] += xa * x[c];
      }
    }
    for (let a = 0; a < p; a++) { for (let c = 0; c < a; c++) A[a][c] = A[c][a]; A[a][a] += lam; }
    const mv = v => { const o = new Float64Array(p); for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += A[a][c] * v[c]; o[a] = s; } return o; };
    const dot = (u, v) => { let s = 0; for (let i = 0; i < p; i++) s += u[i] * v[i]; return s; };
    const w = new Float64Array(p);
    const res = Float64Array.from(b), d = Float64Array.from(res);
    let rs = dot(res, res);
    for (let it = 0; it < 400 && rs > 1e-12; it++) {
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

  /* 一次切分上算一个 R²；返回全部切分的数组 */
  const runModel = (pick) => splits.map(({ tr, ts }) => {
    const yTr = tr.map(d => d.y), yTe = ts.map(d => d.y);
    const myY = yTr.reduce((a, b) => a + b, 0) / yTr.length;
    const myTe = yTe.reduce((a, b) => a + b, 0) / yTe.length;
    const sst = yTe.reduce((s, y) => s + (y - myTe) ** 2, 0);
    const { tr: Xa, te: Xb } = standardize(tr.map(pick), ts.map(pick));
    let best = -9;
    for (const lam of [1, 10, 30, 100, 300]) {
      const w = ridge(Xa, yTr, lam);
      const pred = Xb.map(x => myY + x.reduce((s, v, j) => s + v * w[j], 0));
      const sse = yTe.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0);
      const v = 1 - sse / sst;
      if (v > best) best = v;
    }
    return best;
  });

  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const std = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

  console.log(`
  ── ${SEEDS} 次随机切分（每次 20% 留出）──`);
  const base = runModel(d => d.base);
  const strainR = runModel(d => d.base.concat(d.strain));
  const structR = runModel(d => d.base.concat(d.struct));
  const allR = runModel(d => d.base.concat(d.struct).concat(d.strain));

  const show = (rs, label) => {
    const d = rs.map((v, i) => v - base[i]);
    const dm = mean(d), ds = std(d);
    /* 判断"稳定为正"：均值超过 2 倍标准误（不是拍 0.005 这种魔数） */
    const se = ds / Math.sqrt(d.length);
    const solid = dm > 2 * se && dm > 0.003;
    console.log(`  ${label.padEnd(20)} R² ${mean(rs).toFixed(4)} ±${std(rs).toFixed(4)}`
      + `   ΔR² ${(dm >= 0 ? '+' : '')}${dm.toFixed(4)} ±${se.toFixed(4)}`
      + (solid ? '   ✅ 稳定有新信息' : '   ⚠ 不显著'));
  };
  console.log(`  ${'37 维（现状）'.padEnd(18)} R² ${mean(base).toFixed(4)} ±${std(base).toFixed(4)}`);
  show(strainR, '+ 8 应变特征');
  show(structR, '+ 9 结构特征');
  show(allR, '+ 全部');
}
