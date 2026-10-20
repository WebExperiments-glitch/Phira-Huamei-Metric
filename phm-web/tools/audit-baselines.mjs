#!/usr/bin/env node
/* ============================================================
 * tools/audit-baselines.mjs —— 参照集的「天花板与基线」审计
 * ============================================================
 * 【为什么要有它】
 *   现有文档回答了「我们的引擎比旧引擎好多少」，但没回答三个更要紧的问题：
 *     ① 比**最笨的基线**好多少？（只报「比 4 维 k-NN 好」是不够的 —— 任何
 *        预测器都比「拍一个常数」好，读者真正想知道的是差多少）
 *     ② 这套 8 维结构**最多能解释多少**？（命中率 84% 不等于「难度算得准」，
 *        因为真值本身就是人工声明值）
 *     ③ 换成**更新的谱**还准吗？（随机留出与调参集同源，天然偏乐观）
 *   这三个问题都能用现有数据回答，一个下午就能跑完。跑不出来就等于没有。
 *
 * 【怎么跑】
 *     node tools/audit-baselines.mjs                 # 默认：随机留出 + id 分块留出
 *     node tools/audit-baselines.mjs --split hash    # 只跑随机留出（项目口径）
 *     node tools/audit-baselines.mjs --split created # 按**上传时间**切（最接近真时间外推）
 *     node tools/audit-baselines.mjs --hold 1500     # 换留出规模
 *     node tools/audit-baselines.mjs --limit 1200    # id / created 切分时最多测多少张（控时长）
 *     node tools/audit-baselines.mjs --split-date 2026-06-01   # 指定 created 切分的分界日
 *
 * 【--split created 需要 chart-list.jsonl】
 *     python tools/fetch_chart_list.py     # 拉 Phira 公开列表（含每张谱的 created 上传时间）
 *     有了它就能按**真实上传时间**切「老谱 → 新谱」，而不是用 chart id 当代理。
 *     ⚠ 生成的 data/chart-list.jsonl 不入库（可随时重新拉），所以干净克隆上
 *       这一项会自动跳过并告诉你怎么生成。
 *
 * 【方法纪律】
 *   ⚠ k-NN 那一行走的是**引擎真正的那条路径**（public/js/engine.js 的
 *     knnReference），不是重写的一份 —— 重写就跟线上不是同一个算法了。
 *   ⚠ 参照集用 buildCommunityRows()（生产行，与线上同源），不自己写过滤。
 *   ⚠ 基线是**故意做笨的**：常数中位 / 8 维线性回归 / 单特征 1-NN。
 *     它们不是稻草人 —— 8 维 OLS 是任何认真做这件事的人都会先跑一遍的东西。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommunityRows, buildOfficialRows } from './gen-ref.mjs';
import { knnReference, REF_DIMS, ROW_LABELS } from '../public/js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const SPLIT = arg('split', 'all');                 /* hash | id | created | all */
const HOLD = +arg('hold', 1367);
const LIMIT = +arg('limit', 3000);

const readJsonl = p => fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));

/* 确定性哈希：与 validate-ref.mjs 同一套，同一 id 永远落在同一侧 */
function hash01(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000003) / 1000003;
}

/* ── 数据准备 ── */
const rows = buildCommunityRows();                       /* 生产行（与线上同源） */
const raw = readJsonl(path.join(REPO, 'data', 'community.jsonl'));
const byId = new Map(raw.map(r => [r.id, r]));
if (!rows.length) { console.error('参照集是空的 —— 先跑 pipeline.py community'); process.exit(1); }

/* 特征矩阵：log1p + z-score（与引擎同一套配方，k-NN 之外的三条基线要用） */
const P = REF_DIMS.length;
const X = rows.map(r => {
  const x = new Array(P);
  for (let c = 0; c < P; c++) x[c] = Math.log1p(Math.max(+r[ROW_LABELS + c] || 0, 0));
  return x;
});
const Y = rows.map(r => r[0]);

/* ── 一条基线：最笨的「永远猜中位数」 ── */
function constBaseline(poolIdx, testIdx) {
  const ys = poolIdx.map(i => Y[i]).sort((a, b) => a - b);
  const med = ys[Math.floor(ys.length / 2)];
  return testIdx.map(() => med);
}

/* ── 一条基线：8 维线性回归（正规方程 + 高斯消元） ──
   ⚠ 这不是稻草人：任何认真做「结构→定数」的人都会先跑一遍 OLS，
     文档里如果只有「26 维岭回归 1.042」这种被配弱的对手，结论就站不住。 */
function olsBaseline(poolIdx, testIdx, mu, sd) {
  const d = P + 1;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (const i of poolIdx) {
    const z = X[i].map((v, c) => (v - mu[c]) / sd[c]);
    const row = [1, ...z];
    for (let r = 0; r < d; r++) {
      b[r] += row[r] * Y[i];
      for (let c = 0; c < d; c++) A[r][c] += row[r] * row[c];
    }
  }
  for (let i = 0; i < d; i++) A[i][i] += 1e-8;            /* 轻微正则，避开奇异 */
  for (let i = 0; i < d; i++) {                            /* 前向消元 */
    let piv = i;
    for (let r = i + 1; r < d; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (piv !== i) { [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]]; }
    for (let r = i + 1; r < d; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < d; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const w = new Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < d; c++) s -= A[i][c] * w[c];
    w[i] = s / A[i][i];
  }
  return testIdx.map(i => {
    const z = X[i].map((v, c) => (v - mu[c]) / sd[c]);
    let s = w[0];
    for (let c = 0; c < P; c++) s += w[c + 1] * z[c];
    return s;
  });
}

/* ── 一条基线：单特征 1-NN（只用 real_notes_per_second） ──
   用途：量一下「就一条 NPS」能有多准，好知道多出来的 7 维值不值那个复杂度。 */
function oneFeatureBaseline(poolIdx, testIdx, mu, sd) {
  const c = REF_DIMS.indexOf('real_notes_per_second');
  const zp = poolIdx.map(i => (X[i][c] - mu[c]) / sd[c]);
  const yt = poolIdx.map(i => Y[i]);
  return testIdx.map(i => {
    const z = (X[i][c] - mu[c]) / sd[c];
    let best = 0, bd = Infinity;
    for (let k = 0; k < zp.length; k++) {
      const d = Math.abs(zp[k] - z);
      if (d < bd) { bd = d; best = k; }
    }
    return yt[best];
  });
}

/* ── 指标 ── */
function metrics(pred, truth) {
  const dev = pred.map((p, i) => Math.abs(p - truth[i]));
  const sorted = dev.slice().sort((a, b) => a - b);
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  const mean = dev.reduce((a, b) => a + b, 0) / dev.length;
  const hit10 = dev.filter(x => x <= 1.0).length / dev.length * 100;
  const hit15 = dev.filter(x => x <= 1.5).length / dev.length * 100;
  const my = truth.reduce((a, b) => a + b, 0) / truth.length;
  const ssRes = pred.reduce((a, p, i) => a + (p - truth[i]) ** 2, 0);
  const ssTot = truth.reduce((a, t) => a + (t - my) ** 2, 0);
  return { n: dev.length, med: q(0.5), mean, p90: q(0.9), hit10, hit15, r2: 1 - ssRes / ssTot };
}
const fmtM = m => '|偏差| 中位 ' + m.med.toFixed(3) + '  均值 ' + m.mean.toFixed(3)
  + '  p90 ' + m.p90.toFixed(2) + '  ≤1.0 ' + m.hit10.toFixed(1) + '%  ≤1.5 ' + m.hit15.toFixed(1) + '%';

/* ── 残差的谱师内聚：残差里有多少是「谱师是谁」 ──
   ⚠ 分组门槛：每个谱师在测试集里至少 MIN_GROUP 张谱才进组。
     门槛定 5 时，随机留出（1,394 张摊到上千个谱师）几乎组不出东西 ——
     所以门槛放到 3，组数与张数一并打出来，让读者自己判断样本够不够。 */
const MIN_GROUP = 3;
function charterEffect(pred, truth, testIdx) {
  const groups = new Map();
  testIdx.forEach((rowIdx, k) => {
    const rec = byId.get(rows[rowIdx][3]);
    const ch = rec && rec.charter ? rec.charter : '';
    if (!ch) return;
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch).push(truth[k] - pred[k]);
  });
  const big = [...groups.entries()].filter(([, v]) => v.length >= MIN_GROUP);
  if (big.length < 5) return null;
  const all = [...groups.values()].flat();
  const meanAll = all.reduce((a, v) => a + v, 0) / all.length;
  const totVar = all.reduce((a, v) => a + (v - meanAll) ** 2, 0) / all.length;
  const within = big.reduce((a, [, v]) => {
    const m = v.reduce((x, y) => x + y, 0) / v.length;
    return a + v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length;
  }, 0) / big.length;
  return {
    charters: big.length, charts: big.reduce((a, [, v]) => a + v.length, 0),
    withinShare: within / totVar, betweenShare: 1 - within / totVar,
  };
}

/* ── 不确定带校准 ──
   【为什么要做】现在卡��上那个「±」用的 lo/hi = 20 个近邻定数的 min/max。
   这个带**从没被校准过**：只在「官谱参照」上测过覆盖率（桌面引擎那个
   引擎给的是加权 P25/P75，55.4% 是四分位距的数学性质）。
   要重新定宽，先得知道各种候选带定义的真实覆盖率，再挑一个覆盖率
   可解释、半宽不离谱的。这里只**测**，不改引擎输出。 */
function bandCalibration(poolIdx, testIdx, label) {
  const poolRows = poolIdx.map(i => rows[i]);
  const samples = [];
  for (const i of testIdx) {
    const rec = byId.get(rows[i][3]);
    if (!rec) continue;
    const k = knnReference(rec, rec.strain_peak, poolRows, 'community', rows[i][3]);
    if (!k || !isFinite(k.ref) || !k.dvals || !k.dvals.length) continue;
    const v = k.dvals;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    samples.push({ y: rows[i][0], ref: k.ref, lo: k.lo, hi: k.hi, sd, v });
  }
  if (samples.length < 50) return null;
  const cover = fn => {
    let hit = 0;
    for (const s of samples) { const h = fn(s); if (h != null && Math.abs(s.y - s.ref) <= h) hit++; }
    return hit / samples.length * 100;
  };
  const halfWidth = fn => {
    const ws = samples.map(fn).filter(x => x != null).sort((a, b) => a - b);
    return ws.length ? ws[Math.floor(ws.length / 2)] : NaN;
  };
  console.log('\n── 不确定带校准（' + label + '，n=' + samples.length + '）──');
  const rowsOut = [
    ['当前：近邻 min/max（lo/hi）', s => (s.hi - s.lo) / 2],
    ['近邻 q10–q90', s => {
      const q = p => s.v[Math.min(s.v.length - 1, Math.floor(s.v.length * p))];
      return (q(0.9) - q(0.1)) / 2;
    }],
    ['ref ± 1.0·σ_n', s => 1.0 * s.sd],
    ['ref ± 1.5·σ_n', s => 1.5 * s.sd],
    ['ref ± 2.0·σ_n', s => 2.0 * s.sd],
  ];
  for (const [name, h] of rowsOut) {
    console.log('  ' + name.padEnd(26) + ' 覆盖率 ' + cover(h).toFixed(1).padStart(5)
      + '%   半宽中位 ±' + halfWidth(h).toFixed(2) + ' 级');
  }
  /* 解一个 k，使 ref ± k·σ_n 的覆盖率正好到 90% */
  let lo = 0, hi = 12;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cover(s => mid * s.sd) < 90) lo = mid; else hi = mid;
  }
  const k90 = (lo + hi) / 2;
  console.log('  → 要达到 90% 覆盖：ref ± ' + k90.toFixed(2) + '·σ_n'
    + '   半宽中位 ±' + halfWidth(s => k90 * s.sd).toFixed(2) + ' 级');
  /* 再解一个固定项 c：ref ± (1.0·σ_n + c) 覆盖 90%
     —— 这一项代表「结构解释不了的那部分」（谱师习惯等），是固定成本。 */
  lo = 0; hi = 6;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cover(s => s.sd + mid) < 90) lo = mid; else hi = mid;
  }
  const c90 = (lo + hi) / 2;
  console.log('  → 或：ref ± (1.0·σ_n + ' + c90.toFixed(2) + ')   半宽中位 ±'
    + halfWidth(s => s.sd + c90).toFixed(2) + ' 级   ← 固定项 = 结构之外那部分');
  return { k90, c90, coverCurrent: cover(s => (s.hi - s.lo) / 2) };
}

/* ── 一次评估：给定参照池与待测集，跑四条方案 ── */
function evaluate(poolIdx, testIdx, label) {
  if (poolIdx.length < 50 || testIdx.length < 20) { console.log('  ' + label + '：样本不足，跳过'); return null; }
  const poolRows = poolIdx.map(i => rows[i]);
  const mu = new Array(P).fill(0), sd = new Array(P).fill(0);
  for (const i of poolIdx) for (let c = 0; c < P; c++) mu[c] += X[i][c] / poolIdx.length;
  for (const i of poolIdx) for (let c = 0; c < P; c++) sd[c] += (X[i][c] - mu[c]) ** 2 / poolIdx.length;
  for (let c = 0; c < P; c++) sd[c] = Math.sqrt(sd[c]) || 1;

  /* k-NN：走引擎那条真路径 */
  const predKnn = [], truth = [];
  for (const i of testIdx) {
    const rec = byId.get(rows[i][3]);
    if (!rec) continue;
    const k = knnReference(rec, rec.strain_peak, poolRows, 'community', rows[i][3]);
    if (!k || !isFinite(k.ref)) continue;
    predKnn.push(k.ref); truth.push(rows[i][0]);
  }
  if (!predKnn.length) { console.log('  ' + label + '：没有可用样本'); return null; }
  const used = testIdx.filter(i => byId.get(rows[i][3]));

  const mKnn = metrics(predKnn, truth);
  const mConst = metrics(constBaseline(poolIdx, used), truth);
  const mOl = metrics(olsBaseline(poolIdx, used, mu, sd), truth);
  const m1nn = metrics(oneFeatureBaseline(poolIdx, used, mu, sd), truth);

  console.log('\n### ' + label + '   参照 ' + poolIdx.length + ' / 测试 ' + truth.length);
  console.log('  k-NN（引擎真路径）  ' + fmtM(mKnn) + '   R²=' + mKnn.r2.toFixed(3));
  console.log('  基线 8维线性回归    ' + fmtM(mOl));
  console.log('  基线 单特征NPS 1-NN ' + fmtM(m1nn));
  console.log('  基线 常数中位数     ' + fmtM(mConst));

  const ce = charterEffect(predKnn, truth, used);
  if (ce) {
    console.log('  ── 残差归属：谱师间可解释 ' + (ce.betweenShare * 100).toFixed(1)
      + '%（' + ce.charters + ' 个谱师 / ' + ce.charts + ' 张谱，组内方差占 '
      + (ce.withinShare * 100).toFixed(1) + '%）');
  } else {
    console.log('  ── 残差归属：测试集里没有足够的同谱师样本（每个谱师 ≥' + MIN_GROUP
      + ' 张），算不出来 —— 这本身就是「按谱师分组分析」难做的地方。');
  }
  const band = bandCalibration(poolIdx, testIdx, label);
  return { label, mKnn, mOl, mConst, m1nn, ce, band };
}

/* ── 上传时间表（可选，来自 data/chart-list.jsonl）──
   没有它就做不了「按上传时间」的切分 —— 那正是这个工具最想回答的问题。 */
const CREATED_MAP = (() => {
  const p = path.join(REPO, 'data', 'chart-list.jsonl');
  if (!fs.existsSync(p)) return null;
  const m = new Map();
  for (const r of readJsonl(p)) {
    if (r.id != null && r.created) m.set(r.id, String(r.created).slice(0, 10));
  }
  return m.size ? m : null;
})();

/* ── 官谱「相邻档位定数差」拆解 ──
   【为什么】项目文档把「同曲、物量相近、相邻难度」的定数差中位 2.80 叫
   「官方标注噪声」，并据此说「没有任何工具能区分谱师标错与官方也会这么标」。
   但相邻档位（EZ→HD→IN→AT）**本来就该差好几级** —— 那是设计差异，不是噪声。
   这里把它按档位对拆开，让读者自己判断这个数字该怎么读。 */
function officialTierGaps() {
  const off = buildOfficialRows();
  const LV = ['EZ', 'HD', 'IN', 'AT', 'SP'];
  const notesCol = REF_DIMS.indexOf('notes_real') + ROW_LABELS;
  const bySong = new Map();
  for (const r of off) {
    const name = r[2], lv = r[1];
    if (!name || lv > 3) continue;                       /* 只看 EZ/HD/IN/AT */
    if (!bySong.has(name)) bySong.set(name, {});
    bySong.get(name)[LV[lv]] = r;
  }
  const gaps = new Map();
  for (const [, m] of bySong) {
    for (let i = 0; i < 3; i++) {
      const a = m[LV[i]], b = m[LV[i + 1]];
      if (!a || !b) continue;
      const na = +a[notesCol], nb = +b[notesCol];
      if (!(na > 0) || !(nb > 0)) continue;
      const ratio = nb / na;
      if (!(ratio >= 0.85 && ratio <= 1.15)) continue;   /* 物量相近 ±15% */
      const key = LV[i] + '→' + LV[i + 1];
      if (!gaps.has(key)) gaps.set(key, []);
      gaps.get(key).push(+b[0] - +a[0]);
    }
  }
  const all = [];
  console.log('\n── 官谱：同曲 + 物量相近（±15%）的相邻档位定数差 ──');
  for (const k of ['EZ→HD', 'HD→IN', 'IN→AT']) {
    const v = (gaps.get(k) || []).sort((a, b) => a - b);
    if (!v.length) { console.log('  ' + k.padEnd(7) + ' n=0'); continue; }
    all.push(...v);
    const med = v[Math.floor(v.length / 2)];
    const p90 = v[Math.min(v.length - 1, Math.floor(v.length * 0.9))];
    console.log('  ' + k.padEnd(7) + ' n=' + String(v.length).padStart(3)
      + '   定数差 中位 ' + med.toFixed(2) + '   p90 ' + p90.toFixed(2));
  }
  if (all.length) {
    all.sort((a, b) => a - b);
    const med = all[Math.floor(all.length / 2)];
    console.log('  合计    n=' + String(all.length).padStart(3) + '   定数差 中位 ' + med.toFixed(2)
      + '   ← 项目文档里引用的「官方标注噪声 2.80」是这一类**档位差**的合计，');
    console.log('             它由 EZ→HD / HD→IN 主导（见上），不是同一难度上的重复标注。');
  }
}

/* ══════════════════ 主流程 ══════════════════ */
console.log('生产参照集（社区）: ' + rows.length);
const ratio = HOLD / rows.length;

/* 1) 随机留出（项目口径） */
let resHash = null;
if (SPLIT === 'hash' || SPLIT === 'all') {
  const held = [], rest = [];
  rows.forEach((r, i) => (hash01(r[3]) < ratio ? held : rest).push(i));
  resHash = evaluate(rest, held, '随机留出（项目口径，' + held.length + ' 张）');
}

/* 2) id 分块留出：参照 = 较早 id，测试 = 较晚 id
   （Phira 的 chart id 随上传顺序递增，所以这是「时间外推」的保守下界；
     真做法见第 3 项 —— 按真实 created 上传时间切） */
let resId = null;
if (SPLIT === 'id' || SPLIT === 'all') {
  const ids = rows.map(r => r[3]);
  const sorted = ids.slice().sort((a, b) => a - b);
  const medId = sorted[Math.floor(sorted.length / 2)];
  const oldIdx = [], newIdx = [];
  rows.forEach((r, i) => (r[3] <= medId ? oldIdx : newIdx).push(i));
  /* 测试集太大时按 id 均匀抽样，保证覆盖整段而不是只测最新那批 */
  let test = newIdx;
  if (newIdx.length > LIMIT) {
    const step = newIdx.length / LIMIT;
    test = Array.from({ length: LIMIT }, (_, k) => newIdx[Math.floor(k * step)]);
  }
  resId = evaluate(oldIdx, test, 'id 分块留出（参照=较早上传，测试=较晚上传，' + test.length + ' 张）');
}

/* 3) 按上传时间切分：参照 = 较早上传的，测试 = 较晚上传的
   （比 id 分块更接近真的时间外推：id 只保证「更晚注册」，created 才是上传时刻） */
let resCreated = null;
if (SPLIT === 'created' || SPLIT === 'all') {
  if (!CREATED_MAP) {
    console.log('\n[跳过 created 切分] 没有 data/chart-list.jsonl —— '
      + '先跑 `python tools/fetch_chart_list.py`（拉 Phira 公开列表，带每张谱的上传时间）');
  } else {
    const dated = rows.map((r, i) => ({ i, d: CREATED_MAP.get(r[3]) }))
      .filter(x => x.d);
    if (dated.length < 200) {
      console.log('\n[跳过 created 切分] 能对上上传时间的谱太少（' + dated.length + ' 张）');
    } else {
      /* 分界日 D：取上传时间的中位数。参照 = created < D，测试 = created ≥ D。
         另一半（没有上传时间的行）不进测试集 —— 它们的上传时间未知，
         混进去会把「时间外推」变成「说不清」。 */
      const ds = dated.map(x => x.d).sort();
      const D = arg('split-date', ds[Math.floor(ds.length / 2)]);
      const ref = [], test = [];
      dated.forEach(x => (x.d < D ? ref : test).push(x.i));
      let testSet = test;
      if (testSet.length > LIMIT) {
        const step = testSet.length / LIMIT;
        testSet = Array.from({ length: LIMIT }, (_, k) => test[Math.floor(k * step)]);
      }
      console.log('\n── 按上传时间切分：分界日 ' + D + ' ──');
      resCreated = evaluate(ref, testSet,
        'created 切分（参照=上传较早，测试=上传较晚，' + testSet.length + ' 张）');
    }
  }
}

/* 4) 官谱档位差拆解 */
officialTierGaps();

/* ── 小结与建议 ── */
console.log('\n════════ 审计小结 ════════');
if (resHash) {
  const gain = resHash.mKnn.hit10 - resHash.mOl.hit10;
  console.log('  k-NN 比「8 维线性回归」好 ' + gain.toFixed(1) + 'pp（≤1.0 命中），'
    + '|偏差|中位差 ' + (resHash.mOl.med - resHash.mKnn.med).toFixed(3));
  console.log('  → 文档里必须写这条对比。只写「比 4 维 k-NN 好」是不够的：'
    + '任何预测器都打败「猜常数」。');
  if (gain < 1) {
    console.log('  ⚠ k-NN 相对 OLS 的优势已不足 1pp —— 「查表比拟合公式更合适」这句话'
      + '现在撑不住，建议在文档里改成「两者接近，k-NN 略优且可逐邻审计」。');
  }
}
if (resHash && resId) {
  console.log('  随机留出 ≤1.0 ' + resHash.mKnn.hit10.toFixed(1) + '%  vs  '
    + 'id 分块留出 ' + resId.mKnn.hit10.toFixed(1) + '%  （差 '
    + (resHash.mKnn.hit10 - resId.mKnn.hit10).toFixed(1) + 'pp）');
  console.log('  → 随机留出与调参集同源，天然偏乐观。要拿到无偏数字，需要'
    + '**增量抓取**出来的 future holdout（fetch_charts.py 记 fetched_at，攒够一批新谱再评）。');
}
if (resCreated) {
  console.log('  按上传时间切分 ≤1.0 ' + resCreated.mKnn.hit10.toFixed(1) + '%'
    + (resId ? '   （id 代理切分 ' + resId.mKnn.hit10.toFixed(1) + '%）' : ''));
  console.log('  → 这是**真上传时间**外推，比 id 分块更可信。'
    + '再往后要真正的 future holdout，只能靠增量抓取攒新谱。');
}
if (resHash && resHash.ce) {
  console.log('  结构解释 R²=' + resHash.mKnn.r2.toFixed(3) + '；残差里谱师间可解释 '
    + (resHash.ce.betweenShare * 100).toFixed(1) + '%');
  console.log('  → 声明定数里最大的一块是「谁标的」，不是「这张谱多难」。'
    + '注意：谱师习惯是**系统性偏移**，该进点估计的修正项，不该靠放宽不确定带来解决。');
}
