#!/usr/bin/env node
/* ============================================================
 * tools/golden-engine.mjs —— 引擎「数值金标」测试
 * ============================================================
 * 目的：引擎是产品本身。任何改动（重构/调参/换维度）都不该在无人察觉时
 * 改变输出数字——那会让所有已缓存定数与 API 返回值悄悄失真。
 *
 * 做法：固定一张合成 PEC 谱面 → 跑 parsePec + reportFromChart →
 * 与 tools/golden-engine.json 逐字段比较（浮点容差 1e-9）。
 *
 * 改引擎后数值确实要变：node tools/golden-engine.mjs --update
 * **并把 golden-engine.json 的 diff 当成一次「算法变更」review**，
 * 必要时同步 ENGINE_VER + 重算缓存（见 HANDOVER 红线）。
 * ============================================================ */
import fs from 'node:fs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePec, reportFromChart, ENGINE_VER } from '../public/js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'golden-engine.json');
const UPDATE = process.argv.includes('--update');

/* 固定语料：三种音符（Tap/Drag/Hold）+ 不同时间/位置，覆盖解析与特征主路径。 */
const PEC = [
  '175',
  'bp 0.000 120.000',
  'n1 0 0.000 0.000 1 0',
  'n1 0 0.500 480.000 1 0',
  'n2 0 1.000 2.000 -480.000 1 0',
  'n3 0 2.000 0.000 1 0',
  'n4 0 3.000 0.000 1 0',
].join('\n');

function snapshot() {
  const r = parsePec(PEC);
  /* ⚠ 必须把 v2 权重传进去。不传的话 v2 分支根本不走，
     金标测的还是旧 kNN 路径 —— 看起来绿，其实没覆盖新算法。 */
  const W2 = JSON.parse(fs.readFileSync(new URL('../public/data/engine-v2.json', import.meta.url), 'utf8'));
  const rep = reportFromChart(r, 'golden', { name: 'Golden Fixture', level: 'IN.14', charter: 'ci' }, 500, null, null, W2);
  return {
    engineVer: ENGINE_VER,
    parse: { notes: r.notes.length, real: r.real.length, bpm: r.bpm, dur: r.dur, nlines: r.nlines },
    feats: rep.feats,
    ps: { total: rep.ps.total, g: rep.ps.g },
    knnOff: {
      ref: rep.knnOff.ref, tier: rep.knnOff.tier, basis: rep.knnOff.basis,
      lo: rep.knnOff.lo, hi: rep.knnOff.hi, q1: rep.knnOff.q1, q3: rep.knnOff.q3,
      spread: rep.knnOff.spread, n20: rep.knnOff.n20, selfExcluded: rep.knnOff.selfExcluded,
      near: rep.knnOff.near.map(n => ({ name: n.name, level: n.level, diff: n.diff })),
    },
    knn: rep.knn,
  };
}

function cmp(a, b, pathStr, bad) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9) bad.push(pathStr + ': ' + a + ' ≠ ' + b);
    return;
  }
  if (a && b && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) cmp(a[k], b[k], pathStr + '.' + k, bad);
    return;
  }
  if (a !== b) bad.push(pathStr + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
}

const now = snapshot();
if (UPDATE) {
  writeFileSync(FILE, JSON.stringify(now, null, 2) + '\n');
  console.log('已更新金标：' + FILE + '（engineVer=' + now.engineVer + '）');
  console.log('⚠ 请把这次 diff 当成算法变更 review；若数值语义变了，记得同步 ENGINE_VER。');
  process.exit(0);
}
if (!existsSync(FILE)) {
  console.error('缺少 tools/golden-engine.json —— 先跑 node tools/golden-engine.mjs --update');
  process.exit(2);
}
const want = JSON.parse(readFileSync(FILE, 'utf8'));
const bad = [];
cmp(want, now, 'golden', bad);
if (bad.length) {
  console.error('引擎数值金标不一致（' + bad.length + ' 处）：');
  for (const b of bad.slice(0, 20)) console.error('  ✗ ' + b);
  if (bad.length > 20) console.error('  …还有 ' + (bad.length - 20) + ' 处');
  console.error('\n若这是有意的算法变更：node tools/golden-engine.mjs --update，并同步 ENGINE_VER/缓存。');
  process.exit(1);
}
console.log('引擎数值金标一致 ✓（engineVer=' + now.engineVer + '）');
