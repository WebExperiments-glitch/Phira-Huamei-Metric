/**
 * tools/verify-engine-v3.mjs —— v3 引擎（JS）与 Python 训练侧的一致性闸门
 *
 * 【为什么必须有这个脚本】
 *   v3 是把 Python 训出来的 142 维岭回归搬进浏览器。移植错了不会报错，
 *   只会**静默偏差**——页面照出数字，但每个数都不可信。
 *   2026-11-03 第一次移植就是这样：`above` 用了 indexOf 找（永远找不到），
 *   池化向量整体偏 38，b 差 0.57。肉眼完全看不出来。
 *
 * 【判据】
 *   engine-v3.json 里带 5 条自检样本（池化向量 + 期望 b + 定数）。
 *   逐条重算，**定数差 > 0.05 级就红**。
 *
 *   为什么是 0.05 而不是 1e-6：两边是两套独立的浮点实现，
 *   在「±250ms 窗口计数」的边界上会因为舍入差 1~2 个计数，
 *   折算到定数约 0.02 级。0.05 是模型 MAE（0.44）的 1/9，
 *   低于用户可感知阈值，同时能拦住真正致命的移植错误（≥0.1 级）。
 *
 * 用法：node tools/verify-engine-v3.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* 最小 RPE 解析：只做 v3 需要的部分（拍→秒、类型、x、above、hold）。
   ⚠ 它必须与 engine.js 的 loadChart 在**这几个字段**上同口径，
   否则测的又不是同一件事。 */
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

const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/engine-v3.json'), 'utf8'));

/* 直接 import 线上那份实现（engine-v3.mjs）—— 不复制副本，
   否则测的是副本而不是真跑在浏览器里的代码。 */
const { seqFeatures20, pool142 } = await import('../public/js/engine-v3.mjs');
/* loadChart 在 engine.js 里，它带浏览器 import（?v=），Node 解析不了；
   这里用一个最小 RPE 解析器，只取 v3 需要的字段（时间/类型/x/above/hold）。 */
const TOL = 0.05;
let worst = 0, worstId = null, fail = 0;

for (const c of W.checks) {
  const p = path.join(ROOT, '..', 'data', 'charts', c.id, 'chart.json');
  if (!fs.existsSync(p)) { console.log(`  · 跳过 ${c.id}（本地没有谱面文件）`); continue; }
  const r = { notes: parseRpe(JSON.parse(fs.readFileSync(p, 'utf8'))) };
  const pooled = pool142(seqFeatures20(r.notes), r.notes.length);
  let s = W.b;
  for (let i = 0; i < W.w.length; i++) s += ((pooled[i] - W.mu[i]) / (W.sd[i] || 1)) * W.w[i];
  const ding = (W.b2d.slope || 1.12) * s + (W.b2d.inter || 15.99);
  const d = Math.abs(ding - c.ding);
  if (d > worst) { worst = d; worstId = c.id; }
  if (d > TOL) { fail++; console.log(`  ✗ ${c.id} 定数 ${ding.toFixed(3)} vs 期望 ${c.ding.toFixed(3)}（差 ${d.toFixed(3)}）`); }
  else console.log(`  ✓ ${c.id} 定数 ${ding.toFixed(3)}（差 ${d.toFixed(4)}）`);
}

console.log(`\n最差 ${worst.toFixed(4)} 级（${worstId}）· 阈值 ${TOL}`);
if (fail) { console.log(`✗ ${fail} 条超出阈值 —— v3 移植有问题，**不要上线**`); process.exit(1); }
console.log('v3 一致性：通过 ✓');
