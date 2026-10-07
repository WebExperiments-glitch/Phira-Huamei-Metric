#!/usr/bin/env node
/**
 * 参照集生成器 —— P.H.M.
 *
 * 产出两个东西，它们是**同一套 8 维特征、同一套管线**，因此可以逐维比对：
 *
 *   1. public/js/ref-official.js  官谱参照（1,037 张 Phigros 官谱，标称定数人工标注）
 *   2. public/data/ref-com.json   社区参照（9,509 张 Phira 社区谱，定数为谱师声明）
 *
 * 为什么要有两份（2026-10-07 实测，见 docs/ENGINE-EXPERIMENT.md）：
 *   官谱与社区谱**不是同一个分布**。社区谱 p50 = 15.1 而官谱 p50 = 10.6；
 *   社区谱长条占比 0.04~0.23，官谱 0.11~0.55；社区谱拖键/秒 0.36~3.84，官谱 0.03~0.72。
 *   拿官谱当唯一参照去测社区谱，≤1.0 命中只有 65.6%；换成社区参照 + 8 维后是 82.0%。
 *   但官谱标度是**与 Phigros 官方一致**的绝对标度，不能丢 —— 所以两份都留，前端并列展示。
 *
 * 用法：
 *   node tools/gen-ref.mjs              # 生成（默认跳过被当前引擎判为脏的行）
 *   node tools/gen-ref.mjs --check      # 只校验现有产物是否与真源同步
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = path.resolve(WEB, '..');

/* ── 8 维：由 90 张社区谱 + 800 张社区谱两轮实测选出 ──
   注意 8 维已经吃掉 12 维的全部收益（8 维 |偏差|均值 0.815 / 12 维 0.810），
   所以这里刻意停在 8 维：多出来的 4 维只增加体积，不增加精度。 */
export const REF_DIMS = [
  'real_notes_per_second',
  'real_core_notes_per_second',
  'notes_real',
  'strain_p99',
  'iv_mean',
  'above_avg_density_mean',
  'note_clutter_ratio',
  'cross_hand_density',
];
/* 每维保留小数位（体积与精度的折中；参照值本身就是估计量，再多位是假精度） */
const ROUND = {
  real_notes_per_second: 3,
  real_core_notes_per_second: 3,
  notes_real: 0,
  strain_p99: 3,
  iv_mean: 4,
  above_avg_density_mean: 3,
  note_clutter_ratio: 2,
  cross_hand_density: 3,
};
const LV_CODE = { EZ: 0, HD: 1, IN: 2, AT: 3, SP: 4 };
const DIFF_MAX = 19.5;             /* 官方历史最高 18.0；超过 19.5 的声明视为脏数据 */

const rn = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };

/** 把自由文本 level 归一化（与 phm/core.py norm_level 同规则的白名单法） */
function normLevel(s) {
  const m = String(s || '').replace(/\./g, ' ').replace(/Lv/g, ' ')
    .match(/(?<![A-Za-z])(EZ|HD|IN|AT|SP)(?![A-Za-z])/i);
  return m ? m[1].toUpperCase() : null;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

/* 行格式：[定数, 档位码, 曲名, 谱面 ID, ...8 维]
   ID 只为一个用途：**排除自身**。参照集里本来就有被测谱，
   若不排除就是距离 0 的自匹配 —— 返回"它自己的声明值"，
   工具当场退化成橡皮图章（且这一点非常隐蔽：误差看起来完美）。
   官谱侧填 0（官方谱不参与社区谱的自匹配）。 */
const ID_COL = 3;
const ROW_LABELS = 4;

/** 一行谱面 → [定数, 档位码, 曲名, ID, ...8 维]；脏行返回 null */
function toRow(r, needLevel, id) {
  const diff = rn(+r.difficulty, 2);
  /* ⚠ 必须在**四舍五入之后**判零：0.004 声明值 > 0 能过旧判断，但 rn(x,2) 会把它
     变成 0，于是参照集里出现"定数 0"的行 —— 它是 z 空间里最远的负样本，
     一旦被选进邻居就把加权中位拉到 1~2 区间。已实测踩过。 */
  if (!(diff > 0) || diff > DIFF_MAX) return null;
  if (!(r.notes_real > 0)) return null;
  const lv = normLevel(r.level);
  if (needLevel && lv == null) return null;
  const vals = [];
  for (const k of REF_DIMS) {
    const v = +r[k];
    /* 缺一维就整行丢弃 —— 宁可少一张参照，也不要留一个 0 当成真值参与距离计算 */
    if (!isFinite(v) || v < 0) return null;
    vals.push(rn(v, ROUND[k]));
  }
  return [diff, lv == null ? 5 : LV_CODE[lv], String(r.name || '').slice(0, 48),
    id || 0, ...vals];
}

/* ── 官谱 ── 需要档位（前端要显示"最相近的官谱叫什么、什么难度"） */
const official = readJsonl(path.join(REPO, 'data', 'official.jsonl'))
  .map(r => toRow(r, true, 0)).filter(Boolean);

/* ── 社区谱 ── 档位字段在 Phira 上是自由文本，归一失败就记 5（未知），不丢行 */
const community = readJsonl(path.join(REPO, 'data', 'community.jsonl'))
  .map(r => toRow(r, false, r.id)).filter(Boolean);

/* 按定数排序，让"邻域"在文件里也是局部连续的（gzip 友好，且便于人工抽查） */
const byDiff = (a, b) => a[0] - b[0];
official.sort(byDiff); community.sort(byDiff);

const officialJs = `/* 自动生成 —— 不要手改。改参照集请改 data/*.jsonl 后跑 tools/gen-ref.mjs
 *
 * 官谱参照 ${official.length} 张（Phigros 官谱，标称定数 = 官方人工标注）
 * 行格式：[定数, 档位码(0=EZ 1=HD 2=IN 3=AT 4=SP), 曲名, ID(恒 0), ${REF_DIMS.join(', ')}]
 * 引擎把它们取 log1p 后 z-score，再做 k-NN —— 见 engine.js knnReference()。
 */
export const REF_DIMS = ${JSON.stringify(REF_DIMS)};
export const ROW_LABELS = ${ROW_LABELS};
export const REF_OFFICIAL = ${JSON.stringify(official)};
`;

const comJson = JSON.stringify({
  v: 'V0.4.0',
  dims: REF_DIMS,
  note: 'Phira 社区谱参照集；difficulty 为谱师声明值，是"站内共识"不是客观真值',
  idCol: ID_COL, labels: ROW_LABELS,
  rows: community,
});

const pOfficial = path.join(WEB, 'public', 'js', 'ref-official.js');
const pCom = path.join(WEB, 'public', 'data', 'ref-com.json');

if (process.argv.includes('--check')) {
  let bad = 0;
  const cur = fs.existsSync(pOfficial) ? fs.readFileSync(pOfficial, 'utf8') : '';
  const curCom = fs.existsSync(pCom) ? fs.readFileSync(pCom, 'utf8') : '';
  if (cur !== officialJs) { console.log('✗ ref-official.js 与真源不同步'); bad = 1; }
  if (curCom !== comJson) { console.log('✗ ref-com.json 与真源不同步'); bad = 1; }
  if (!bad) console.log(`✓ 两份参照集均与真源同步（官谱 ${official.length} / 社区 ${community.length}）`);
  process.exit(bad);
}

fs.mkdirSync(path.dirname(pCom), { recursive: true });
fs.writeFileSync(pOfficial, officialJs);
fs.writeFileSync(pCom, comJson);

const kb = p => (fs.statSync(p).size / 1024).toFixed(0) + ' KB';
console.log(`✓ ref-official.js  官谱 ${String(official.length).padStart(5)} 行  ${kb(pOfficial)}`);
console.log(`✓ ref-com.json     社区 ${String(community.length).padStart(5)} 行  ${kb(pCom)}`);
const skipped = { official: readJsonl(path.join(REPO, 'data', 'official.jsonl')).length - official.length };
console.log(`  （官谱剔除 ${skipped.official} 行：档位无法归一或缺特征）`);
