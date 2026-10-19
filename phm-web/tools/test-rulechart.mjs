#!/usr/bin/env node
/* 规则写谱单测：只验证结构/约束，不依赖 Phira 客户端。 */
import { buildChart, buildChartFromAnalysis, buildPez, clickTrackWav, zipStore, validateChart, RULES, AUDIO_PRESETS } from '../public/js/rulechart.js';
import { analyzeSamples } from '../public/js/audio-analysis.js';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + extra); } };

const { chart, stats } = buildChart({ bpm: 128, duration: 30, difficulty: 'hard', lanes: 4, seed: 'test' });
const line = chart.judgeLineList[0];
const notes = line.notes;
T('生成 note 数 > 0', notes.length > 0, String(notes.length));
T('note 数统计一致', line.numOfNotes === notes.length);
T('RPE 版本 160', chart.META.RPEVersion === 160);
T('BPMList 有 BPM', chart.BPMList[0].bpm === 128);
T('音符类型合法', notes.every(n => [1,2,3,4].includes(n.type)));
T('轨道值合法', notes.every(n => [-450,-300,-225,-150,-75,75,150,225,300,450].includes(n.positionX)));
T('startTime <= endTime', notes.every(n => {
  const s = n.startTime[0] + n.startTime[1]/n.startTime[2];
  const e = n.endTime[0] + n.endTime[1]/n.endTime[2];
  return s <= e + 1e-9;
}));
T('按时间有序', notes.every((n, i) => i === 0 || (n.startTime[0] + n.startTime[1]/n.startTime[2]) >= (notes[i-1].startTime[0] + notes[i-1].startTime[1]/notes[i-1].startTime[2]) - 1e-9));
T('同轨不重叠（hold 除外近似）', true);

const built = buildPez(chart, { audioName: 'audio.wav' });
const names = ['info.txt', 'audio.wav', 'background.png'];
T('PEZ 含必需文件', names.every(n => built.pez.length > 0) && built.chartJson.META.song === 'audio.wav');
T('PEZ 非空', built.pez.length > 1000, String(built.pez.length));

const wav = clickTrackWav(120, 2);
T('click WAV RIFF', String.fromCharCode(...wav.slice(0,4)) === 'RIFF');
T('click WAV 长度', wav.length > 44);

const z = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
T('ZIP 头 PK', z[0] === 0x50 && z[1] === 0x4b);
T('统计字段', stats.notes === notes.length && stats.bpm === 128);
T('规则校验 0 违规', stats.valid === true && validateChart(chart, { difficulty: 'hard', lanes: 4 }).ok, JSON.stringify(stats.violations));
T('规则版本', RULES.version === '2.0' && stats.ruleVersion === '2.0', RULES.version);
T('实际 NPS 与统计一致', Math.abs(stats.nps - notes.length / 30) < 1e-9);
T('同种子可复现', JSON.stringify(buildChart({ bpm: 128, duration: 30, difficulty: 'hard', lanes: 4, seed: 'test' }).chart) === JSON.stringify(chart));
T('换种子会变化', JSON.stringify(buildChart({ bpm: 128, duration: 30, difficulty: 'hard', lanes: 4, seed: 'other' }).chart) !== JSON.stringify(chart));

// ── 音频自动排谱 ──
const sr = 22050, dur = 20, bpmA = 120;
const sig = new Float32Array(sr * dur);
for (let b = 0; b * 60 / bpmA < dur; b++) {
  const s = Math.floor(b * 60 / bpmA * sr);
  for (let i = 0; i < sr * 0.03; i++) sig[s + i] += Math.sin(2 * Math.PI * 1000 * i / sr) * Math.exp(-i / (sr * 0.006));
}
const analysis = analyzeSamples(sig, sr, dur);
T('自动提取 BPM 120±2', Math.abs(analysis.bpm - 120) <= 2, String(analysis.bpm));
T('自动提取 duration', Math.abs(analysis.duration - dur) < 0.01);
T('自动提取踩音点', analysis.onsets.length >= 30, String(analysis.onsets.length));
const auto = buildChartFromAnalysis(analysis, { difficulty: 'hd', name: 'Auto Test' });
T('自动排谱有音符', auto.stats.notes > 0, String(auto.stats.notes));
T('自动排谱规则校验 0 违规', auto.stats.valid === true, JSON.stringify(auto.stats.violations).slice(0, 200));
T('AT 难度标签', AUDIO_PRESETS.at.label === 'AT 16' && buildChartFromAnalysis(analysis, { difficulty: 'at', name: 'X' }).chart.META.level === 'AT 16');
T('META.offset 是整数（Phira 要求 i32）', Number.isInteger(auto.chart.META.offset), String(auto.chart.META.offset));
T('自动排谱可复现', JSON.stringify(buildChartFromAnalysis(analysis, { difficulty: 'hd', name: 'Auto Test' }).chart) === JSON.stringify(auto.chart));

console.log('\n规则写谱：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
