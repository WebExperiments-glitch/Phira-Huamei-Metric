#!/usr/bin/env node
/* ============================================================
 * tools/rulechart.mjs —— 规则写谱 CLI（零依赖）
 * ============================================================
 * 用法：
 *   node tools/rulechart.mjs --bpm 128 --duration 60 --difficulty hard
 *   node tools/rulechart.mjs --name "My Song" --audio song.wav --lanes 6
 * 输出：output/rulechart/<id>.pez + <id>.json
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { buildChart, buildPez } from '../public/js/rulechart.js';

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    o[k] = v;
  }
  return o;
}

const a = parse(process.argv.slice(2));
if (a.help || a.h) {
  console.log(`规则写谱 CLI

  --bpm 128               BPM
  --duration 60           时长（秒）
  --difficulty hard       easy|normal|hard|expert|master
  --lanes 4               2|4|6
  --density 1.0           密度倍率 0.4~2.0
  --name "My Song"        曲名
  --artist "Unknown"      曲师
  --charter "P.H.M."      谱师
  --seed abc              随机种子（同参数可复现）
  --audio song.wav        可选音频（不提供则生成节拍 click 音轨）
  --outdir output/rulechart
`);
  process.exit(0);
}

const opts = {
  bpm: Number(a.bpm || 128),
  duration: Number(a.duration || 60),
  difficulty: a.difficulty || 'hard',
  lanes: Number(a.lanes || 4),
  density: Number(a.density || 1),
  name: a.name || 'Rule Chart',
  artist: a.artist || 'Unknown',
  charter: a.charter || 'P.H.M. rulechart',
  seed: a.seed || '',
};
const { chart, stats } = buildChart(opts);
let audio = null, audioName = 'audio.wav';
if (a.audio) {
  audio = new Uint8Array(fs.readFileSync(a.audio));
  audioName = path.basename(a.audio);
}
const { pez } = buildPez(chart, { audio, audioName });
const outdir = path.resolve(a.outdir || 'output/rulechart');
fs.mkdirSync(outdir, { recursive: true });
const id = chart.META.id;
const pezPath = path.join(outdir, id + '.pez');
const jsonPath = path.join(outdir, id + '.json');
fs.writeFileSync(pezPath, Buffer.from(pez));
fs.writeFileSync(jsonPath, JSON.stringify(chart, null, 2));
console.log('ok: ' + stats.notes + ' notes · ' + stats.bpm + ' BPM · ' + stats.difficulty + ' · ' + stats.lanes + 'K');
console.log('pez: ' + pezPath + ' (' + (pez.length / 1048576).toFixed(2) + ' MB)');
console.log('json: ' + jsonPath);
