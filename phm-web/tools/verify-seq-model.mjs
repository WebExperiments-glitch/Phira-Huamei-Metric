/**
 * tools/verify-seq-model.mjs —— 序列模型（JS）与 Python 参考实现的一致性闸门
 *
 * 【为什么必须有】
 *   这个模型在浏览器里是 34k 个数按固定顺序做四则运算。移植写错**不会报错**，
 *   只会静默偏移 —— 页面照样出数字，每个数都不可信。
 *   最像的两种错法：GELU 用了 tanh 近似、GRU 门序写成 z,r,n。
 *   两者都能跑、"看起来差不多"，但定数会差 0.1~1 级。
 *
 * 【参照系】
 *   tools/golden-seq.json —— 由 tools/gen-seq-golden.py 生成：
 *     · 特征：Python 的 build_seq_dataset.to_feats 取前 20 列（现场从谱面算）
 *     · 前向：tools/export_seq_model.py 的 np_predict（已与 torch 对拍 1.5e-07）
 *
 * 【两条判据，分开看，因为量的东西不一样】
 *
 *   ① synth（合成序列，n=1/8/9/55/320/1500）：输入两边逐位相同，
 *      所以比的是**纯模型数学**。阈值 1e-5，实测 ~1e-16。
 *      覆盖补齐位（n 不是 8 的倍数）、Conv1d 两端补零、GRU 反向扫描、
 *      attention 归一化 —— 这些是移植最容易写错的地方。
 *
 *   ② chart（5 张真谱）：解析 → seqFeatures20 → 前向，整条产品链路。
 *      阈值 1e-4 b（≈1.1e-4 定数），实测最差 4.2e-5。
 *      为什么不是 1e-5：残差**全部**来自 20 维特征的两个已知差异，
 *      与模型无关（把 dim 13/14 换成 Python 的值之后立刻掉到 1e-8）：
 *        a. engine-v3.mjs 的夹角分母是 `(n1*n2)||1`，Python 是 `n1*n2+1e-9`。
 *           夹角接近 0°（直线）时 sin=√(1-cos²) 对 cos 极敏感，1e-9 的
 *           分母差被放大成 ~1e-3 的 sin 差。该文件本次禁止改动。
 *        b. 超过 8,000 事件的谱，特征是**截断后**算的（这里按同一口径先切音符）。
 *      两者都在既有 v3 闸门（阈值 0.05 定数）覆盖范围内，且远小于模型自身
 *      MAE 0.42 —— 不是移植误差，所以不能拿它当失败。
 *
 * 用法：node tools/verify-seq-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOL_SYNTH = 1e-5;    /* 纯模型数学 */
const TOL_CHART = 1e-4;    /* 端到端（含特征层的已知 epsilon 差） */
const MAX_EVENTS = 8000;   /* 与 build_seq_dataset.MAX_EVENTS / engine-seq 同一口径 */

/* 最小 RPE 解析：只做序列模型需要的部分（拍→秒、类型、x、above、hold）。
   与 tools/verify-engine-v3.mjs 同一个解析器 —— 两边测的必须是同一份输入。 */
function parseRpe(j) {
  const bpm = (j.BPMList || [{ bpm: 120, startTime: [0, 0, 1] }])
    .slice().sort((a, b) => frac(a.startTime) - frac(b.startTime))
    .map(s => [frac(s.startTime), +s.bpm]);
  const sec = beat => {
    let t = 0;
    for (let i = 0; i < bpm.length; i++) {
      const [b0, v] = bpm[i];
      const b1 = i + 1 < bpm.length ? bpm[i + 1][0] : Infinity;
      if (beat <= b0) break;
      t += (Math.min(beat, b1) - b0) * 60 / v;
      if (beat <= b1) return t;
    }
    return t;
  };
  const out = [];
  for (const ln of j.judgeLineList || []) {
    for (const n of ln.notes || []) {
      if (!n.startTime || n.startTime.length !== 3 || n.type == null) continue;
      const t = sec(frac(n.startTime));
      const hold = (n.type === 2 && n.endTime) ? Math.max(sec(frac(n.endTime)) - t, 0) : 0;
      out.push({ sec: t, type: n.type, x: n.positionX || 0,
        above: (n.above === 0 || n.above === false) ? 0 : 1, hold });
    }
  }
  out.sort((a, b) => a.sec - b.sec);
  return out;
}
function frac(st) {
  if (!st) return 0;
  const den = st.length > 2 && st[2] ? +st[2] : 1;
  return +st[0] + (+st[1] / den);
}

const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seq-model.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/golden-seq.json'), 'utf8'));

/* 直接 import 线上那份实现 —— 测副本等于没测 */
const { predictSeq } = await import('../public/js/engine-seq.mjs');
const { seqFeatures20 } = await import('../public/js/engine-v3.mjs');

/* 与 gen-seq-golden.py 的 synth_seq() 逐字一致（量级表随 golden 一起下发，
   避免两边各写一份常数表然后悄悄漂移） */
function synthSeq(n) {
  const S = G.meta.synth_scale, a = new Float64Array(n * 20);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 20; d++) a[i * 20 + d] = ((i * 13 + d * 7) % 97) / 97.0 * S[d] - 0.3;
  }
  return a;
}

let fail = 0, skipped = 0;
const worstOf = { synth: 0, chart: 0 };
const worstId = { synth: null, chart: null };

function check(c) {
  let seq, tol, kind;
  if (c.kind === 'chart') {
    const p = path.join(ROOT, '..', 'data', 'charts', c.id, 'chart.json');
    if (!fs.existsSync(p)) { console.log(`  · 跳过 ${c.id}（本地没有谱面文件）`); skipped++; return; }
    const notes = parseRpe(JSON.parse(fs.readFileSync(p, 'utf8'))).slice(0, MAX_EVENTS);
    if (notes.length !== c.n) {
      console.log(`  ✗ ${c.id} 事件数 ${notes.length} vs 参考 ${c.n} —— 解析口径不一致`);
      fail++; return;
    }
    seq = seqFeatures20(notes);          /* 产品链路：先截断音符，再算特征 */
    tol = TOL_CHART; kind = 'chart';
  } else {
    seq = synthSeq(c.n);
    tol = TOL_SYNTH; kind = 'synth';
  }
  const r = predictSeq(seq, W);
  if (!r) { console.log(`  ✗ ${c.id} predictSeq 返回 null`); fail++; return; }
  const d = Math.abs(r.b - c.b);
  if (d > worstOf[kind]) { worstOf[kind] = d; worstId[kind] = c.id; }
  const ok = d <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${c.id.padEnd(11)} n=${String(c.n).padStart(5)} `
    + `b ${r.b.toFixed(6)} vs ${c.b.toFixed(6)}（差 ${d.toExponential(2)}）`
    + ` · ding ${r.ding.toFixed(3)}`);
}

console.log('—— 合成序列（纯模型数学，阈值 1e-5）——');
for (const c of G.cases) if (c.kind === 'synth') check(c);
console.log('\n—— 真谱端到端（解析 + 特征 + 前向，阈值 1e-4）——');
for (const c of G.cases) if (c.kind === 'chart') check(c);

console.log(`\n最差：合成 ${worstOf.synth.toExponential(2)}（${worstId.synth}）`
  + ` · 真谱 ${worstOf.chart.toExponential(2)}（${worstId.chart}）`
  + (skipped ? ` · 跳过 ${skipped} 张（缺谱面文件）` : ''));
if (fail) { console.log(`✗ ${fail} 条超出阈值 —— JS 移植有问题，**不要上线**`); process.exit(1); }
if (skipped === G.cases.length) { console.log('✗ 一条都没跑成'); process.exit(1); }
console.log('序列模型一致性：通过 ✓');
