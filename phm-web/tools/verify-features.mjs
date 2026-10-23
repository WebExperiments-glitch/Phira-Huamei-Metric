#!/usr/bin/env node
/* ============================================================
 * tools/verify-features.mjs —— 特征对账：引擎算的 vs 参照集里存的
 * ============================================================
 * 【为什么必须先做这一步】
 *   引擎实际能算出 **39 个特征**，但参照集（ref-official.js / ref-com.json）
 *   只存了 **8 个**（REF_DIMS）。想把 8 扩到 39 来提升准确度，
 *   前提是这 31 个"新"维度在**两边是同一个数** ——
 *   参照集的值来自离线 Python 管线（data/*.jsonl），引擎的值来自 JS 移植版，
 *   两者从来没逐维对过账。
 *
 *   如果对不上却直接扩维：kNN 会在**两个不同的坐标空间**里算距离，
 *   结果错得毫无征兆（不报错、只是变差），而且很难往回查。
 *   —— 这就是"先量再改"。
 *
 * 【判据】
 *   相对误差 < 1% 视为一致；统计每个特征的不一致比例与最大偏差。
 *   只把**全部一致**的维度加进 REF_DIMS。
 *
 * 【用法】
 *   node tools/verify-features.mjs              # 随机抽 150 张
 *   node tools/verify-features.mjs --all        # 全部 9,684 张（慢）
 *   node tools/verify-features.mjs --n 500
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(ROOT, '..', 'data');
const ARG = process.argv.slice(2);
const val = n => { const i = ARG.indexOf('--' + n); return i >= 0 ? ARG[i + 1] : null; };
const N = ARG.includes('--all') ? Infinity : +(val('n') || 150);

const eng = await import('../public/js/engine.js');

/* 参照集里存的那 8 维（就是现在线上用的） */
const DIMS8 = ['real_notes_per_second', 'real_core_notes_per_second', 'notes_real',
  'strain_p99', 'iv_mean', 'above_avg_density_mean', 'note_clutter_ratio', 'cross_hand_density'];

const BAN = new Set(['id', 'song_id', 'difficulty', 'level', 'name', 'composer', 'charter',
  'rating', 'ratingCount', 'stable', 'ranked', 'tags', 'file_size', 'chart_file', 'format',
  'rpe_version', 'fmt', 'fetched_at', 'bpm_items', 'with_father', 'bpmfactor_non1', 't_sec']);

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

const rows = readJsonl(path.join(DATA, 'community.jsonl'));
const byId = new Map(rows.map(r => [String(r.id), r]));

/* 找一个能加载的谱面目录 */
function chartPath(id) {
  const d = path.join(DATA, 'charts', String(id));
  const f = path.join(d, 'chart.json');
  return fs.existsSync(f) ? f : null;
}

const pool = rows.filter(r => chartPath(r.id));
/* 固定间隔抽样，避免只取到开头那批（同一作者/同一时期的谱会聚堆） */
const step = Math.max(1, Math.floor(pool.length / (N === Infinity ? pool.length : N)));
const sample = pool.filter((_, i) => i % step === 0).slice(0, N === Infinity ? undefined : N);
console.log(`[对账] 候选 ${pool.length} 张，抽样 ${sample.length} 张`);

const stats = new Map();   /* 特征名 → {n, bad, maxRel, sumRel} */
let loaded = 0;
for (const row of sample) {
  const fp = chartPath(row.id);
  if (!fp) continue;
  let rep;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const r = eng.loadChart(j);
    /* 只取特征：refCom 传 null，不让它算社区 kNN（省时间） */
    rep = eng.reportFromChart(r, 'x', { name: row.name, level: row.level }, 0, null, null);
  } catch { continue; }
  const f = rep.feats;
  loaded++;

  for (const k of Object.keys(f)) {
    if (BAN.has(k)) continue;
    const a = +f[k];
    const b = +row[k];
    if (!isFinite(a) || !isFinite(b)) continue;
    const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-6);
    const s = stats.get(k) || { n: 0, bad: 0, maxRel: 0, sumRel: 0 };
    s.n++; s.sumRel += rel;
    if (rel > s.maxRel) s.maxRel = rel;
    if (rel > 0.01) s.bad++;
    stats.set(k, s);
  }
}

console.log(`[对账] 实际跑通 ${loaded} 张\n`);

const list = [...stats.entries()]
  .map(([k, s]) => ({ k, ...s, badRate: s.bad / s.n, avgRel: s.sumRel / s.n }))
  .sort((a, b) => b.badRate - a.badRate || b.maxRel - a.maxRel);

const mark = (k, ok) => (DIMS8.includes(k) ? (ok ? '★' : '★✗') : ok ? ' ' : '✗');
console.log('特征'.padEnd(32) + '不一致率   最大偏差   平均偏差');
console.log('─'.repeat(72));
for (const r of list) {
  const ok = r.badRate === 0;
  console.log(
    (mark(r.k, ok) + ' ' + r.k).padEnd(32)
    + (r.badRate * 100).toFixed(1).padStart(7) + '%'
    + r.maxRel.toFixed(4).padStart(11)
    + r.avgRel.toFixed(4).padStart(11));
}

const good = list.filter(r => r.badRate === 0);
const bad = list.filter(r => r.badRate > 0);
console.log('\n' + '─'.repeat(72));
console.log(`一致（可以加进 REF_DIMS）：${good.length} 个`);
console.log(`不一致（不能加）：${bad.length} 个` + (bad.length ? ' → ' + bad.map(b => b.k).join(', ') : ''));
console.log('\n★ = 现在线上用的 8 维。它们如果也标 ✗，说明抽样/加载有问题，先查那个。');
