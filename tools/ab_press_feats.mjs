#!/usr/bin/env node
/* tools/ab_press_feats.mjs —— 把抽样谱面过一遍引擎，导出特征 jsonl
 *
 * 只做一件事：读 tmp/pde-sample/{id}/chart.json → engine.loadChart + reportFromChart
 *              → 写 tmp/pde-sample/features.jsonl（含新追加的 press_* 四个字段）
 *
 * 为什么用 reportFromChart 而不是直接调 extractDims：
 *   extractDims 没有 export，而 reportFromChart 返回的 feats 就是喂给 Ridge 的
 *   那一份 —— 用它才能保证 A/B 用的特征和线上完全同源（少一次平行实现的风险）。
 *
 * 代价：会顺带算一次官谱 kNN（每张 1037 邻域）。实测可接受，不值得为省这点
 *       时间去复制一份特征提取逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'tmp', 'pde-sample');
const OUT = path.join(SAMPLE, 'features.jsonl');

const engine = await import('../phm-web/public/js/engine.js');

const labels = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'labels.json'), 'utf8'));
const ids = Object.keys(labels);
console.log(`样本 ${ids.length} 张`);

const lines = [];
let ok = 0, fail = 0;
const fails = [];

for (const id of ids) {
  const p = path.join(SAMPLE, id, 'chart.json');
  if (!fs.existsSync(p)) { fail++; fails.push([id, 'missing']); continue; }
  try {
    const txt = fs.readFileSync(p, 'utf8');
    /* 归档里有约 10% 是 PEC 文本（不是 JSON）——直接 JSON.parse 会报
       "Unexpected non-whitespace character after JSON"。
       引擎自己提供了 isPecText / parsePec，走它才能和线上同一套解析。 */
    let r;
    if (engine.isPecText(txt)) {
      r = engine.parsePec(txt);
    } else {
      r = engine.loadChart(JSON.parse(txt));
    }
    const rep = engine.reportFromChart(r, id, {}, null, [], null);
    const f = rep.feats;
    lines.push(JSON.stringify({
      id,
      charter: labels[id].charter,
      difficulty: labels[id].difficulty,
      feats: f,
    }));
    ok++;
  } catch (e) {
    fail++;
    fails.push([id, String(e.message || e).slice(0, 60)]);
  }
  if ((ok + fail) % 200 === 0) console.log(`  已处理 ${ok + fail} …`);
}

fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`成功 ${ok} / 失败 ${fail} → ${OUT}`);
if (fails.length) {
  console.log('失败样例（最多 5 条）：');
  for (const [id, m] of fails.slice(0, 5)) console.log(`  ${id}: ${m}`);
}

/* 顺手验证新字段确实存在，避免 A/B 拿一列 0 去训练还以为是「无增益」 */
const probe = lines.length ? JSON.parse(lines[0]).feats : null;
if (probe) {
  for (const k of ['press_iv_mean', 'press_iv_median', 'press_chord_ratio', 'press_fast_ratio']) {
    console.log(`  ${k} = ${probe[k]}`);
  }
}
