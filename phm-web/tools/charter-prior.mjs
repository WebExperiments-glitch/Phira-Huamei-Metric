#!/usr/bin/env node
/* ============================================================
 * tools/charter-prior.mjs —— 谱师先验的可行性分析（只读，不改引擎）
 * ============================================================
 * 【要回答的问题】
 *   审计（tools/audit-baselines.mjs）实测：8 维结构只解释声明定数的 38%，
 *   残差里约 72% 由「谱师是谁」解释。
 *   但「误差里有谱师的账」≠「这份账能预先算出来」。要落地成产品，
 *   还得回答三件事：
 *
 *     ① 谱师偏移**可学吗**？
 *        用该谱师**其他谱**的残差估偏移，再去修正这一张 —— 留一验证。
 *        （合法：Phira 上每张谱的声明定数都是公开的，不需要任何私有信息。）
 *     ② 偏移是**标定偏差**还是**选曲偏好**？
 *        谱师 A 全写 15.x、谱师 B 全写 12.x —— 那不是「A 标得虚高」，
 *        是「两人写的档位不同」。按档位分层后再估偏移：层内还剩多少？
 *     ③ **冷启动**怎么办？
 *        新谱师没有历史谱，偏移无从估起。收益随谱师作品数怎么变？
 *
 * 【为什么不改引擎】
 *   谱师先验会改变点估计的语义 → ENGINE_VER 变 → 全部缓存要重算。
 *   这是**产品决策**（改不改口径），不是分析能顺手带过去的。
 *   所以本脚本**只产出证据**：读语料、算数字、打印结论，一个字都不写回引擎。
 *
 * 【怎么跑】
 *     node tools/charter-prior.mjs                 # 全量（约 2 分钟）
 *     node tools/charter-prior.mjs --limit 2000    # 快速抽样
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommunityRows } from './gen-ref.mjs';
import { knnReference } from '../public/js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const LIMIT = +arg('limit', 0);

const readJsonl = p => fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const rows = buildCommunityRows();
const raw = readJsonl(path.join(REPO, 'data', 'community.jsonl'));
const byId = new Map(raw.map(r => [r.id, r]));
console.log('生产参照集（社区）: ' + rows.length);

/* ── ① 基线预测：每张谱用全参照集留一（排除自己） ── */
const poolRows = rows;
let items = rows.map((r, i) => ({ i, id: r[3], y: r[0], lv: r[1], name: r[2] }))
  .filter(it => byId.has(it.id));
if (LIMIT && items.length > LIMIT) {
  const step = items.length / LIMIT;
  items = Array.from({ length: LIMIT }, (_, k) => items[Math.floor(k * step)]);
}
console.log('待评估: ' + items.length + ' 张（留一预测）…');

const t0 = Date.now();
for (const it of items) {
  const rec = byId.get(it.id);
  const k = knnReference(rec, rec.strain_peak, poolRows, 'community', it.id);
  it.p0 = k && isFinite(k.ref) ? k.ref : null;
  it.charter = rec.charter || null;   /* 没有谱师的谱不参与分组（不是「一个叫未知的谱师」） */
  /* 档位用**归一后的档位码**（items 构造时已从生产行取 r[1]：0=EZ 1=HD 2=IN 3=AT 4=SP），
     不用原始 level 文本 —— 那是自由文本（「IN Lv.15」/「IN」/「IN  Lv.15」），
     散成几百个「档位」会把方差分解搅乱。 */
  it.lv = it.lv;
}
items = items.filter(it => it.p0 != null);
for (const it of items) it.r = it.y - it.p0;      /* 残差 = 声明值 − 结构预测 */
console.log('完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const dev = (p, t) => p.map((x, i) => Math.abs(x - t[i]));
const stats = d => {
  const s = d.slice().sort((a, b) => a - b);
  return {
    n: d.length,
    med: s.length ? s[Math.floor(s.length / 2)] : NaN,
    mean: d.reduce((a, b) => a + b, 0) / (d.length || 1),
    p90: s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN,
    hit10: d.length ? 100 * d.filter(x => x <= 1.0).length / d.length : 0,
    hit15: d.length ? 100 * d.filter(x => x <= 1.5).length / d.length : 0,
  };
};
const show = (label, d) => {
  const s = stats(d);
  console.log('  ' + label.padEnd(30) + ' 中位 ' + s.med.toFixed(3)
    + '  均值 ' + s.mean.toFixed(3) + '  p90 ' + s.p90.toFixed(2)
    + '  ≤1.0 ' + s.hit10.toFixed(1) + '%  ≤1.5 ' + s.hit15.toFixed(1) + '%');
  return s;
};

/* ══════════════ ① 基线 ══════════════ */
console.log('\n── ① 基线：只用结构（8 维 k-NN）──');
const baseDev = dev(items.map(it => it.p0), items.map(it => it.y));
const baseStats = show('结构 k-NN（现行引擎）', baseDev);
const rs = items.map(it => it.r);
console.log('  残差：中位 ' + med(rs).toFixed(3) + '  均值 ' + mean(rs).toFixed(3)
  + '  标准差 ' + Math.sqrt(mean(rs.map(x => (x - mean(rs)) ** 2))).toFixed(3));

/* ══════════════ ② 方差分解：残差里 谱师 / 档位 各占多少 ══════════════ */
/* ⚠ 两个坑，都踩过：
 *   (1) 档位必须用**归一后的档位码**（rows[i][1]，EZ/HD/IN/AT/SP 五个），
 *       不能用原始 level 文本 —— 那是自由文本（「IN Lv.15」/「IN」/「IN  Lv.15」），
 *       2500 张能散出 503 个「档位」，分组一碎，SS 之和会超过 100%（我第一版就跑出了 −70.5%）。
 *   (2) **单例组会把「谱师间方差」系统性抬高**：一个只有 1 张谱的谱师，
 *       它的组均值就是那张谱自己的残差 —— 组间方差被这些组灌水。
 *       所以下面给三个口径：含单例 / 只留 n≥2 / 矩估计（扣掉「纯噪声」的部分）。 */
const byCharter = new Map(), byLevel = new Map();
for (const it of items) {
  if (!it.charter) continue;
  if (!byCharter.has(it.charter)) byCharter.set(it.charter, []);
  byCharter.get(it.charter).push(it.r);
  if (!byLevel.has(it.lv)) byLevel.set(it.lv, []);
  byLevel.get(it.lv).push(it.r);
}
function groupStats(groups) {
  const m = mean(rs);
  let total = 0;
  for (const r of rs) total += (r - m) ** 2;
  const list = [...groups.values()];
  let ssBetween = 0, nTotal = 0, withinPooled = 0, withinDf = 0;
  for (const v of list) {
    const mu = mean(v);
    ssBetween += v.length * (mu - m) ** 2;
    nTotal += v.length;
    if (v.length > 1) {
      const w = v.reduce((a, x) => a + (x - mu) ** 2, 0) / (v.length - 1);
      withinPooled += w * (v.length - 1);
      withinDf += v.length - 1;
    }
  }
  const varBetween = nTotal ? ssBetween / nTotal : 0;
  const sigmaW2 = withinDf ? withinPooled / withinDf : 0;
  /* 矩估计：若谱师之间毫无效应，单例组仍会贡献 E[σ²_w/n̄] 的组间方差。
     把它扣掉，剩下的才是「谱师真的系统性地偏高/偏低」的那部分。 */
  const meanInvN = list.length
    ? list.reduce((a, v) => a + (v.length ? 1 / v.length : 0), 0) / list.length : 0;
  const sigmaCharter2 = Math.max(0, varBetween - sigmaW2 * meanInvN);
  return { share: total ? ssBetween / total : 0, varBetween, sigmaW2, sigmaCharter2, total, n: list.length, nCharts: nTotal };
}
const cAll = groupStats(byCharter);
const cMulti = groupStats(new Map([...byCharter].filter(([, v]) => v.length >= 2)));
const lAll = groupStats(byLevel);
console.log('\n── ② 残差的方差分解（结构解释不了的那部分）──');
console.log('  残差总方差 SS = ' + cAll.total.toFixed(1)
  + '（' + rs.length + ' 张，谱师 ' + byCharter.size + ' 个 / 档位 ' + byLevel.size + ' 个）');
console.log('  谱师之间（含单例组，**偏高**）：' + (cAll.share * 100).toFixed(1) + '%'
  + '   ← 单例组的组均值 = 它自己的残差，会灌水');
console.log('  谱师之间（只留 n≥2 的组）：　　' + (cMulti.share * 100).toFixed(1) + '%（' + cMulti.n + ' 个谱师）');
console.log('  谱师之间（矩估计，扣掉纯噪声）：　' + (cAll.total ? cAll.sigmaCharter2 * cAll.nCharts / cAll.total * 100 : 0).toFixed(1) + '%'
  + '   ← 这才是「谱师系统性偏高/偏低」的可修正部分');
console.log('  档位之间：　　　　　　　　　　' + (lAll.share * 100).toFixed(1) + '%（' + lAll.n + ' 个档位）');
console.log('  组内残差方差 σ²_w = ' + cAll.sigmaW2.toFixed(3) + '（标准差 ' + Math.sqrt(cAll.sigmaW2).toFixed(3) + ' 级）');

/* ══════════════ ③ 谱师先验能不能学到（同谱师 2 折留一） ══════════════ */
/* 做法：把某谱师自己的谱按 id 排序后交替分成两半；
   预测 A 半里的谱时，偏移只用 B 半的残差估，反之亦然 —— 出谱样本外。 */
const charterItems = new Map();
for (const it of items) {
  if (!it.charter) continue;
  if (!charterItems.has(it.charter)) charterItems.set(it.charter, []);
  charterItems.get(it.charter).push(it);
}
function halfSplit(list) {
  const s = list.slice().sort((a, b) => a.id - b.id);
  return [s.filter((_, k) => k % 2 === 0), s.filter((_, k) => k % 2 === 1)];
}
function priorOffsets(levelAware) {
  /* 返回每个谱的「同伴估出的偏移」：out-of-sample。
     同一谱师的作品按 id 排序后交替两半：预测 A 半时只用 B 半的残差估偏移。 */
  const off = new Map();
  let fellBack = 0, usedLevel = 0;
  for (const [ch, list] of charterItems) {
    if (list.length < 2) { for (const it of list) off.set(it, null); continue; }
    const [A, B] = halfSplit(list);
    const pairs = [[A, B], [B, A]];
    for (const [use, est] of pairs) {
      let pool = est;
      if (levelAware) {
        const same = est.filter(x => x.lv === use[0].lv);
        if (same.length >= 2) { pool = same; usedLevel++; } else { fellBack++; }
      }
      for (const it of use) {
        const vals = pool.filter(x => x !== it).map(x => x.r);
        off.set(it, vals.length ? mean(vals) : null);
      }
    }
  }
  return { off, fellBack, usedLevel };
}
console.log('\n── ③ 谱师先验能不能学到（同谱师 2 折留一，出样本外）──');
for (const levelAware of [false, true]) {
  const { off, fellBack, usedLevel } = priorOffsets(levelAware);
  console.log(levelAware ? '  【按同档位估偏移】' : '  【按该谱师全部作品估偏移】');
  for (const lam of [0.25, 0.5, 0.75, 1.0]) {
    const pred = items.map(it => {
      const o = off.get(it);
      return o == null ? it.p0 : it.p0 + lam * o;
    });
    const d = dev(pred, items.map(it => it.y));
    const s = stats(d);
    console.log('    λ=' + lam.toFixed(2) + '  中位 ' + s.med.toFixed(3)
      + '  均值 ' + s.mean.toFixed(3) + '  p90 ' + s.p90.toFixed(2)
      + '  ≤1.0 ' + s.hit10.toFixed(1) + '%  ≤1.5 ' + s.hit15.toFixed(1) + '%'
      + '   （基线 ' + baseStats.med.toFixed(3) + ' / ' + baseStats.hit10.toFixed(1) + '%）');
  }
}

/* ══════════════ ④ 冷启动：谱师作品数 vs 收益 ══════════════ */
console.log('\n── ④ 冷启动：按谱师作品数分层的收益（λ=1.0，全体作品偏移）──');
const { off: offAll } = priorOffsets(false);
const buckets = [[1, 1], [2, 2], [3, 4], [5, 9], [10, 19], [20, Infinity]];
for (const [lo, hi] of buckets) {
  const sel = items.filter(it => {
    if (!it.charter) return false;            /* 没有谱师的谱没有「作品数」这一说 */
    const n = charterItems.get(it.charter).length;
    return n >= lo && n <= hi;
  });
  if (sel.length < 30) continue;
  const base = dev(sel.map(it => it.p0), sel.map(it => it.y));
  const corr = dev(sel.map(it => {
    const o = offAll.get(it);
    return o == null ? it.p0 : it.p0 + o;
  }), sel.map(it => it.y));
  const b = stats(base), c = stats(corr);
  console.log('  作品数 ' + (hi === Infinity ? lo + '+' : lo + '-' + hi)
    + '（' + sel.length + ' 张）  中位 ' + b.med.toFixed(3) + ' → ' + c.med.toFixed(3)
    + '   ≤1.0 ' + b.hit10.toFixed(1) + '% → ' + c.hit10.toFixed(1) + '%');
}

/* ══════════════ 结论 ══════════════ */
console.log('\n════════ 结论（给决策用，不是给引擎用）════════');
const { off: offBest } = priorOffsets(false);
const predBest = items.map(it => {
  const o = offBest.get(it);
  return o == null ? it.p0 : it.p0 + o;
});
const sBest = stats(dev(predBest, items.map(it => it.y)));
const gain = baseStats.med - sBest.med;
console.log('  结构 k-NN 中位误差 ' + baseStats.med.toFixed(3) + ' → 加谱师先验 ' + sBest.med.toFixed(3)
  + '（降 ' + gain.toFixed(3) + ' 级，' + (gain / baseStats.med * 100).toFixed(1) + '%）');
console.log('  ≤1.0 命中 ' + baseStats.hit10.toFixed(1) + '% → ' + sBest.hit10.toFixed(1) + '%');
console.log('  按档位分层后偏移的收益见 ③ —— 若明显变小，说明谱师间差异主要是「选曲偏好」');
console.log('  （两人写的档位不同），而不是「标定偏差」，修正的价值也就小得多。');

