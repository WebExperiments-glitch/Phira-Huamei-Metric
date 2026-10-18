#!/usr/bin/env node
/* ============================================================
 * tools/ai-chart.mjs —— 离线 AI 分轨 + 规则谱
 * ============================================================
 * 管线：MP3 → Demucs(htdemucs, MIT) 拆 drums / no_drums
 *      → ffmpeg 转 22050 mono f32
 *      → audio-analysis 分别提鼓点/钢琴点
 *      → buildChartFromAnalysis（2 指自由分散）→ .pez
 *
 * 依赖（本机，不打包进网页）：
 *   .venv-audio/Scripts/python -m pip install demucs
 *   ffmpeg 在 PATH
 *
 * 用法：
 *   node tools/ai-chart.mjs --audio "song.mp3" --out "song.pez"
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeSamples } from '../public/js/audio-analysis.js';
import { buildChartFromAnalysis, detectDifficulty, buildPez } from '../public/js/rulechart.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHM_WEB = path.resolve(HERE, '..');
const REPO = path.resolve(PHM_WEB, '..');
const VENV_PY = process.env.PHM_PYTHON || path.join(REPO, '.venv-audio', 'Scripts', 'python.exe');

const args = process.argv.slice(2);
const get = (k, def) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : def; };
const input = get('--audio');
const out = get('--out');
if (!input) { console.error('用法: node tools/ai-chart.mjs --audio <mp3> [--out <pez>]'); process.exit(2); }
const audio = path.resolve(input);
if (!fs.existsSync(audio)) { console.error('找不到音频:', audio); process.exit(2); }
if (!fs.existsSync(VENV_PY)) {
  console.error('缺少 Demucs 环境:', VENV_PY);
  console.error('先运行: powershell -File tools/install-demucs.ps1');
  process.exit(2);
}

const stemDir = fs.mkdtempSync(path.join(REPO, '_research', 'ai-tmp-'));
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: REPO, ...opts });
  if (r.status !== 0) throw new Error(cmd + ' 失败，exit ' + r.status);
};
const f32 = (wav, dst) => {
  run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ac', '1', '-ar', '22050', '-f', 'f32le', dst]);
  const b = fs.readFileSync(dst);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const name = path.basename(audio, path.extname(audio));

console.log('[1/4] Demucs 分轨…');
run(VENV_PY, ['-m', 'demucs.separate', '--two-stems=drums', '-n', 'htdemucs', '-o', stemDir, audio]);
const base = path.join(stemDir, 'htdemucs', name);
const drumsWav = path.join(base, 'drums.wav');
const otherWav = path.join(base, 'no_drums.wav');
if (!fs.existsSync(drumsWav)) throw new Error('Demucs 未产出 drums.wav: ' + drumsWav);

console.log('[2/4] 转 22050 mono f32…');
const full = f32(audio, path.join(stemDir, 'full.f32'));
const drums = f32(drumsWav, path.join(stemDir, 'drums.f32'));
const other = f32(otherWav, path.join(stemDir, 'other.f32'));

console.log('[3/4] 分析鼓/钢琴点…');
const fullA = analyzeSamples(full, 22050, full.length / 22050);
const drumA = analyzeSamples(drums, 22050, drums.length / 22050);
const otherA = analyzeSamples(other, 22050, other.length / 22050);
const analysis = Object.assign({}, fullA, {
  drumOnsets: drumA.onsets,
  pianoOnsets: otherA.onsets,
  drumRatio: drumA.onsets.length / Math.max(1, drumA.onsets.length + otherA.onsets.length),
  pianoRatio: otherA.onsets.length / Math.max(1, drumA.onsets.length + otherA.onsets.length),
  aiStems: true,
});
const diff = detectDifficulty(analysis);
console.log('系统判定:', diff.label, '潜力', diff.potential.toFixed(2),
  '| BPM', analysis.bpm, '| 鼓点', analysis.drumOnsets.length, '| 钢琴点', analysis.pianoOnsets.length);

console.log('[4/4] 生成 .pez…');
const built = buildChartFromAnalysis(analysis, { difficulty: diff.key, name });
if (!built.stats.valid) {
  console.error('规则校验失败:', built.stats.violations.slice(0, 5));
  process.exit(1);
}
const { pez } = buildPez(built.chart, { audio: fs.readFileSync(audio), audioName: path.basename(audio) });
const dst = path.resolve(out || (name + '.pez'));
fs.writeFileSync(dst, pez);
console.log('完成:', dst);
console.log('notes', built.stats.notes, 'NPS', built.stats.nps.toFixed(2), 'source', built.stats.onsetSource);
console.log('stems:', stemDir);
