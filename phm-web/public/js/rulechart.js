/* ============================================================
 * public/js/rulechart.js —— 规则写谱（纯前端 / Node 通用，零依赖）
 * ============================================================
 * 输入：BPM / 时长 / 难度 / 轨道数 / 密度 / 种子
 * 输出：RPE v160 chart JSON + .pez (ZIP: info.txt + chart.json + audio + background)
 *
 * 不是音频识别：先把「踩音点」抽象成拍网格，按难度规则排布
 * Tap/Hold/Flick/Drag、和弦与乐句密度。要接音频检测可在外部生成
 * points 后再调用 buildChartFromPoints（预留）。
 * ============================================================ */

import { buildGrid, quantizeOnsets, markTuplets, phraseBounds, quantizeReport } from './rhythm.js?v=V0.22.1.1';
import { scoreEvents, selectEvents, assignHands, assignNotes, selectionReport } from './salience.js?v=V0.22.1.1';
import { auditPlayability } from './playability.js?v=V0.22.1.1';

const LANES = {
  5: [-405, -202.5, 0, 202.5, 405],
  /* 2K = 两根手指可打，不是两根固定轨道：x 分散在整屏，左右手交替。 */
  2: [-405, 405],
  4: [-225, -75, 75, 225],
  6: [-450, -300, -150, 150, 300, 450],
  7: [-450, -300, -150, 0, 150, 300, 450],
};

const PRESETS = {
  /* 参照 _research/refs/pont（charter: RuleEngine）：5 个 x、1 线、无和弦、Tap/Hold/Drag、无 Flick。 */
  piano_ez: { label: 'EZ 7',  density: 0.40, subdivision: 4, minGap: 0.25, maxChord: 1, phrase: 8,
              weights: { tap: .74, hold: .115, flick: 0, drag: .145 }, holds: [.75, 1, 1.5], patterns: ['flow'] },
  piano_hd: { label: 'HD 11', density: 0.50, subdivision: 4, minGap: 0.25, maxChord: 1, phrase: 8,
              weights: { tap: .74, hold: .115, flick: 0, drag: .145 }, holds: [.75, 1, 1.5], patterns: ['flow'] },
  piano_in: { label: 'IN 14', density: 0.56, subdivision: 4, minGap: 0.25, maxChord: 1, phrase: 8,
              weights: { tap: .74, hold: .115, flick: 0, drag: .145 }, holds: [.75, 1, 1.5], patterns: ['flow'] },
  piano_at: { label: 'AT 16', density: 0.70, subdivision: 4, minGap: 0.25, maxChord: 1, phrase: 8,
              weights: { tap: .74, hold: .115, flick: 0, drag: .145 }, holds: [.75, 1, 1.5], patterns: ['flow'] },


  easy:   { label: 'EASY 5',   density: 0.32, subdivision: 4,  minGap: 1.0,  maxChord: 1, phrase: 16,
            weights: { tap: .55, hold: .15, flick: .10, drag: .20 }, holds: [.5, 1],
            patterns: ['alternate', 'flow'] },
  normal: { label: 'NORMAL 9', density: 0.52, subdivision: 4,  minGap: 0.5,  maxChord: 2, phrase: 16,
            weights: { tap: .48, hold: .16, flick: .14, drag: .22 }, holds: [.5, 1, 1.5],
            patterns: ['alternate', 'flow', 'stair'] },
  hard:   { label: 'HARD 12',  density: 0.72, subdivision: 8,  minGap: 0.5,  maxChord: 2, phrase: 12,
            weights: { tap: .40, hold: .18, flick: .18, drag: .24 }, holds: [.5, .75, 1, 1.5],
            patterns: ['alternate', 'stair', 'flow', 'jump'] },
  expert: { label: 'EXPERT 15', density: 0.92, subdivision: 8,  minGap: 0.25, maxChord: 3, phrase: 10,
            weights: { tap: .36, hold: .18, flick: .20, drag: .26 }, holds: [.25, .5, .75, 1, 1.5],
            patterns: ['alternate', 'stair', 'jump', 'stream'] },
  master: { label: 'MASTER 17', density: 1.12, subdivision: 16, minGap: 0.25, maxChord: 3, phrase: 8,
            weights: { tap: .32, hold: .18, flick: .22, drag: .28 }, holds: [.25, .5, .75, 1, 1.5, 2],
            patterns: ['alternate', 'stair', 'jump', 'stream', 'burst'] },
};

const TYPE = { tap: 1, hold: 2, flick: 3, drag: 4 };

/* ============================================================
 * 音频自动排谱：用户只选 EZ / HD / IN / AT
 * ============================================================ */
/* 参数来自 9,684 张真实 Phira 谱面的统计（见 RULECHART.md）：
 * Tap ~55–62% / Drag ~22–35% / Hold ~9–13% / Flick ~5–8%；
 * 难度越高 NPS 越高，但类型比例不会反过来变成 Flick 为主。 */
const AUDIO_PRESETS = {
  ez: { label: 'EZ 7',  keep: 0.55, targetNps: 3.6,  subdivision: 4,  minGap: 1.0,  maxChord: 1, lanes: 2,
        weights: { tap: .58, hold: .12, flick: .06, drag: .24 }, holds: [.5, 1],       phrase: 12 },
  hd: { label: 'HD 11', keep: 0.68, targetNps: 4.4,  subdivision: 8,  minGap: 0.5,  maxChord: 1, lanes: 2,
        weights: { tap: .58, hold: .10, flick: .07, drag: .25 }, holds: [.5, .75, 1],  phrase: 10 },
  in: { label: 'IN 14', keep: 0.82, targetNps: 4.9,  subdivision: 8,  minGap: 0.25, maxChord: 1, lanes: 2,
        weights: { tap: .56, hold: .10, flick: .07, drag: .27 }, holds: [.25, .5, .75], phrase: 8 },
  at: { label: 'AT 16', keep: 0.94, targetNps: 6.1,  subdivision: 16, minGap: 0.2,  maxChord: 1, lanes: 2,
        weights: { tap: .57, hold: .08, flick: .08, drag: .27 }, holds: [.25, .5], phrase: 8 },
};

const RULE_VERSION = '2.0';

/* 对外公开的规则表：页面/docs 与校验器共用同一份。 */
const RULES = {
  version: RULE_VERSION,
  leadInBeats: 2,
  endMarginBeats: 1,
  beatGrid: '4 / 8 / 16 分音符（按难度）',
  sections: [
    { from: 0.00, to: 0.12, label: 'intro', factor: 0.30 },
    { from: 0.12, to: 0.70, label: 'verse', factor: 0.72 },
    { from: 0.70, to: 0.90, label: 'chorus', factor: 1.08 },
    { from: 0.90, to: 1.00, label: 'outro', factor: 0.62 },
  ],
  constraints: [
    '同轨最小间隔 = 难度 minGap（拍）',
    '同一时刻最多 maxChord 个音符',
    'Hold 长度限制在预设 holds 列表内，且 end <= duration - 1 拍',
    '任何音符 start >= 2 拍（lead-in）',
    '同轨 Hold 与下一个音符不重叠',
    'Type 只能是 Tap/Hold/Flick/Drag',
  ],
};

/* 1280x720 深色占位封面（Phira 不接受 1x1 当作有图） */
const COVER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAABQAAAALQCAIAAABAH0oBAAAOfklEQVR42u3XMQ0AAAgEsZfBhBz8S0IDK2lSBbddugYAAADeiwQAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAgAFWAQAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAAAwwCoAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAADLAEAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAIABVgEAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAMMAqAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAAAywBAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAAAYYAAAADDAAAAAYYAAAADDAAAAAYIABAADAAAMAAIABBgAAAAMMAACAAVYBAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAwwAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAAAGGAAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAAAAAwwAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAAMAAAwAAgAEGAADAAAMAAIABBgAAAAMMAAAABhgAAAAMMAAAABhgAAAAMMAAAABggAEAADDAKgAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAADDAAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAAAYYAAAADDAAAAAYYAAAAAwwAAAAGGAAAAAwwAAAAGCAAQAAwAADAACAAQYAAAADDAAAADcLAH8mMaVp40wAAAAASUVORK5CYII=';

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a || 1; }
function frac(beat) {
  const whole = Math.floor(beat + 1e-9);
  const rem = beat - whole;
  if (rem < 1e-9) return [whole, 0, 1];
  const den = 480;
  const num = Math.round(rem * den);
  const g = gcd(num, den);
  return [whole, num / g, den / g];
}

function pickWeighted(rng, weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const [k, w] of Object.entries(weights)) { r -= w; if (r <= 0) return k; }
  return 'tap';
}

function pickLane(pattern, i, lanes, rng, prevLane) {
  const n = (LANES[lanes] || LANES[4]).length;
  switch (pattern) {
    case 'alternate': return (i + (prevLane == null ? 0 : 1)) % n;
    case 'stair': return i % n;
    case 'flow': return Math.floor(rng() * n);
    case 'jump': return (i * 2 + 1) % n;
    case 'stream': return (i + Math.floor(rng() * 2)) % n;
    case 'burst': return Math.floor(rng() * n);
    default: return Math.floor(rng() * n);
  }
}

function defaultEvents(speed) {
  const ev = (start, end) => ({
    bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1,
    easingType: 1, end, start, endTime: [999999, 0, 1], startTime: [0, 0, 1], linkgroup: 0,
  });
  return [{
    alphaEvents: [ev(255, 255)],
    moveXEvents: [ev(0, 0)],
    moveYEvents: [ev(0, 0)],
    rotateEvents: [ev(0, 0)],
    speedEvents: [{ end: speed, start: speed, endTime: [999999, 0, 1], startTime: [0, 0, 1], linkgroup: 0 }],
  }];
}

function incline() {
  return { bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1, easingType: 0,
    end: 0, start: 0, endTime: [1, 0, 1], startTime: [0, 0, 1], linkgroup: 0 };
}

export function buildChart(opts) {
  const o = Object.assign({
    bpm: 128, duration: 60, difficulty: 'hard', lanes: 4, density: 1,
    name: 'Rule Chart', artist: 'Unknown', charter: 'P.H.M. rulechart', seed: '', offset: 0,
  }, opts || {});
  const bpm = Math.max(30, Math.min(300, Number(o.bpm) || 128));
  const duration = Math.max(10, Math.min(900, Number(o.duration) || 60));
  const preset = PRESETS[o.difficulty] || PRESETS.hard;
  const lanes = LANES[o.lanes] ? Number(o.lanes) : 4;
  const density = Math.max(0.4, Math.min(2, Number(o.density) || 1));
  const rng = mulberry32(hashSeed(String(o.seed || '') + '|' + bpm + '|' + o.difficulty + '|' + lanes + '|' + density));
  const beats = duration * bpm / 60;
  const step = 1 / preset.subdivision;
  const notes = [];
  const lastLaneBeat = {};
  let idx = 0;
  let prevLane = null;

  for (let beat = 2; beat < beats - 1; beat += step) {
    const progress = beat / beats;
    const section = progress < 0.12 ? 0.30 : progress < 0.70 ? 0.72 : progress < 0.9 ? 1.08 : 0.62;
    const p = Math.min(0.95, preset.density * section * density);
    idx++;
    if (rng() > p) continue;

    const phrase = Math.floor(idx / preset.phrase) % preset.patterns.length;
    const pattern = preset.patterns[phrase];
    const lane = pickLane(pattern, idx, lanes, rng, prevLane);
    if (lastLaneBeat[lane] != null && beat - lastLaneBeat[lane] < preset.minGap) continue;

    let type = pickWeighted(rng, preset.weights);
    if (type === 'hold' && beat + 2 > beats - 1) type = 'tap';
    const holdBeats = type === 'hold' ? preset.holds[Math.floor(rng() * preset.holds.length)] : 0;
    const endBeat = Math.min(beats - 0.5, beat + holdBeats);
    if (type === 'hold' && endBeat - beat < 0.25) type = 'tap';

    notes.push({
      above: 1, alpha: 255, endTime: frac(type === 'hold' ? endBeat : beat),
      isFake: 0, positionX: LANES[lanes][lane], size: 1, speed: 1,
      startTime: frac(beat), type: TYPE[type], visibleTime: 999999, yOffset: 0,
    });
    lastLaneBeat[lane] = type === 'hold' ? endBeat : beat;
    prevLane = lane;

    /* 强拍和弦：高难度才有，且必须换轨 */
    if (preset.maxChord > 1 && Math.abs(beat - Math.round(beat)) < 1e-6 && Math.round(beat) % 4 === 0 && rng() < 0.18 * density) {
      let lane2 = (lane + 1 + Math.floor(rng() * (lanes - 1))) % lanes;
      if (lane2 === lane) lane2 = (lane + 1) % lanes;
      if (!(lastLaneBeat[lane2] != null && beat - lastLaneBeat[lane2] < preset.minGap)) {
        notes.push({
          above: 1, alpha: 255, endTime: frac(beat), isFake: 0,
          positionX: LANES[lanes][lane2], size: 1, speed: 1,
          startTime: frac(beat), type: TYPE.tap, visibleTime: 999999, yOffset: 0,
        });
        lastLaneBeat[lane2] = beat;
      }
    }
  }

  notes.sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] / a.startTime[2] - b.startTime[1] / b.startTime[2]);
  const id = String(o.name || 'chart').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'chart';
  const chartId = id + '_' + hashSeed(String(o.name) + String(o.seed)).toString(16).slice(0, 8);

  const mainLine = {
    Group: 0, Name: '主判定线', Texture: 'line.png',
    alphaControl: [{ alpha: 1, easing: 1, x: 0 }, { alpha: 1, easing: 1, x: 9999999 }],
    bpmfactor: 1, eventLayers: defaultEvents(10),
    extended: { inclineEvents: [incline()] }, father: -1, isCover: 1,
    notes, numOfNotes: notes.length,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
    zOrder: 0,
  };

  const chart = {
    BPMList: [{ startTime: [0, 0, 1], bpm }],
    META: {
      RPEVersion: 160, background: 'background.png',
      charter: String(o.charter || 'P.H.M. rulechart'), composer: String(o.artist || 'Unknown'),
      illustration: '', id: chartId, level: preset.label, name: String(o.name || 'Rule Chart'),
      offset: Number(o.offset) || 0, song: 'audio.wav', duration,
    },
    judgeLineGroup: ['Default'], judgeLineList: [mainLine],
  };
  const validation = validateChart(chart, { difficulty: o.difficulty, lanes });
  const typeCounts = { tap: 0, hold: 0, flick: 0, drag: 0 };
  for (const n of notes) for (const [k, v] of Object.entries(TYPE)) if (v === n.type) typeCounts[k]++;
  return {
    chart,
    stats: {
      notes: notes.length, bpm, duration, difficulty: preset.label, lanes, density,
      nps: notes.length / duration, typeCounts, valid: validation.ok,
      violations: validation.violations, metrics: validation.metrics, ruleVersion: RULE_VERSION,
    },
  };
}

/* RPE 事件：0..255 alpha、moveX/moveY、rotate；按段落生成连续关键帧。 */
function ev(startBeat, endBeat, start, end, ease) {
  return {
    bezier: 0, bezierPoints: [0, 0, 0, 0], easingLeft: 0, easingRight: 1,
    easingType: ease == null ? 1 : ease, start: Number(start), end: Number(end),
    startTime: frac(startBeat), endTime: frac(endBeat), linkgroup: 0,
  };
}
function speedEv(startBeat, endBeat, value) {
  return { start: Number(value), end: Number(value), startTime: frac(startBeat), endTime: frac(endBeat), linkgroup: 0 };
}
function lastEvent(list, fromBeat, value, isSpeed) {
  list.push(isSpeed ? speedEv(fromBeat, fromBeat + 999999, value) : ev(fromBeat, fromBeat + 999999, value, value));
  return list;
}
function buildLineData(analysis, bpm, totalBeats) {
  const secs = (analysis.sections && analysis.sections.length) ? analysis.sections : [
    { start: 0, end: analysis.duration / 4, label: 'intro', energy: 0.4 },
    { start: analysis.duration / 4, end: analysis.duration / 2, label: 'verse', energy: 0.6 },
    { start: analysis.duration / 2, end: analysis.duration * 3 / 4, label: 'chorus', energy: 0.9 },
    { start: analysis.duration * 3 / 4, end: analysis.duration, label: 'outro', energy: 0.5 },
  ];
  const main = { alphaEvents: [], moveXEvents: [], moveYEvents: [], rotateEvents: [], speedEvents: [] };
  const deco = { alphaEvents: [], moveXEvents: [], moveYEvents: [], rotateEvents: [], speedEvents: [] };
  let prev = 0, mx = 0, my = 0, rot = 0;
  secs.forEach((s, i) => {
    const a = Math.min(totalBeats, Math.max(prev, s.start * bpm / 60));
    const b = Math.min(totalBeats, Math.max(a + 0.01, s.end * bpm / 60));
    const chorus = s.label === 'chorus';
    const nextX = chorus ? (i % 2 ? -45 : 45) : (i % 2 ? 18 : -18);
    const nextY = chorus ? 25 : -15;
    const nextRot = chorus ? (i % 2 ? 4 : -4) : (i % 2 ? 1.2 : -1.2);
    main.moveXEvents.push(ev(a, b, mx, nextX, 3));
    main.moveYEvents.push(ev(a, b, my, nextY, 3));
    main.rotateEvents.push(ev(a, b, rot, nextRot, 3));
    main.alphaEvents.push(ev(a, b, 255, 255, 1));
    deco.moveXEvents.push(ev(a, b, -nextX * 1.6, nextX * 1.6, 2));
    deco.moveYEvents.push(ev(a, b, nextY * 2, -nextY, 2));
    deco.rotateEvents.push(ev(a, b, -nextRot * 2, nextRot * 2, 2));
    deco.alphaEvents.push(ev(a, b, chorus ? 140 : 70, chorus ? 220 : 120, 1));
    prev = b; mx = nextX; my = nextY; rot = nextRot;
  });
  main.speedEvents.push(speedEv(0, 999999, 10));
  deco.speedEvents.push(speedEv(0, 999999, 10));
  for (const arr of [main.moveXEvents, main.moveYEvents, main.rotateEvents, main.alphaEvents,
                     deco.moveXEvents, deco.moveYEvents, deco.rotateEvents, deco.alphaEvents]) {
    const last = arr[arr.length - 1];
    if (last) arr.push(ev(prev, prev + 999999, last.end, last.end, 1));
  }
  return { main, deco };
}

/* 系统判定难度：不再让用户选。用音频的踩音密度、能量、频谱重心与 BPM
 * 估算“这张音频适合的 NPS”，再映射到 EZ/HD/IN/AT。 */
export function detectDifficulty(analysis) {
  const duration = Math.max(1, Number(analysis.duration) || 1);
  const onsets = analysis.onsets || [];
  const rate = onsets.length / duration;
  const strength = onsets.length ? onsets.reduce((s, p) => s + (p.strength || 0), 0) / onsets.length : 0.3;
  const secs = analysis.sections || [];
  const energy = secs.length ? secs.reduce((s, x) => s + (x.energy || 0.5), 0) / secs.length : 0.5;
  const centroid = Number.isFinite(analysis.avgCentroid) ? analysis.avgCentroid : 0.5;
  const bpm = Number(analysis.bpm) || 120;
  /* 按两根参考谱（Pont IN13 / 诀别书 IN11.8）校准：两首 onsetRate 都在 3.7–3.9，
   * 都应该判 IN；所以以 onsetRate 为主，BPM/能量只做小幅修正。 */
  const potential = Math.max(2.5, Math.min(10,
    rate * 1.2 + Math.min(1, bpm / 190) * 0.6 + energy * 0.5));
  const key = potential < 4.0 ? 'ez' : potential < 4.75 ? 'hd' : potential < 5.8 ? 'in' : 'at';
  const preset = AUDIO_PRESETS[key];
  return {
    key, label: preset.label, targetNps: preset.targetNps, potential,
    reason: { onsetRate: rate, energy, centroid, strength, bpm },
  };
}

function centroidAtBeat(analysis, beat, bpm) {
  const arr = analysis.centroid;
  if (!arr || !arr.length || !analysis.fps) return Number.isFinite(analysis.avgCentroid) ? analysis.avgCentroid : 0.5;
  const idx = Math.round((beat * 60 / bpm) * analysis.fps);
  return arr[Math.max(0, Math.min(arr.length - 1, idx))] || 0.5;
}
function laneFromCentroid(c, lanes) {
  const v = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  return Math.max(0, Math.min(lanes - 1, Math.round(v * (lanes - 1))));
}

/* ============================================================
 * buildChartFromAnalysis —— 从音频分析结果自动排谱
 * ============================================================
 * analysis: { bpm, duration, beats, onsets:[{time,strength}], sections }
 * difficulty: ez | hd | in | at
 * 时间点来自真实音频（onsets），不再由用户手填 BPM/时长。
 * ============================================================ */
export function buildChartFromAnalysis(analysis, opts) {
  const o = opts || {};
  const preset = AUDIO_PRESETS[o.difficulty] || AUDIO_PRESETS.hd;
  const bpm = Math.max(30, Math.min(300, Number(analysis.bpm) || 120));
  const duration = Math.max(10, Math.min(900, Number(analysis.duration) || 60));
  const totalBeats = duration * bpm / 60;
  const beatSec = 60 / bpm;
  const name = String(o.name || 'Auto Chart');
  const rng = mulberry32(hashSeed(name + '|' + bpm + '|' + duration + '|' + (analysis.onsets || []).length + '|' + o.difficulty));
  const lead = 2 * beatSec;
  const end = (totalBeats - 1) * beatSec;

  /* ══════════════════════════════════════════════════════════════
   * ① 拍网格 —— 所有时间都要落到这上面
   * ══════════════════════════════════════════════════════════════
   * ⚠ 以前这里是「每个 onset 的时间原样当音符时间」。
   *   后果是音符落在 0.47 / 0.94 拍这种位置：检测误差 ±20ms 起，
   *   而判定线按拍走 —— 玩家读不出来，只能靠背。
   *   现在先建网格，再量化（推导见 rhythm.js 顶部）。 */
  const grid = buildGrid({
    bpm, offset: analysis.offset, duration, beats: analysis.beats,
    /* ⚠ 必须把 onsets 传进去：网格相位要靠它们精调一次。
       不传的话相位精度只到半拍，整张谱会整体落在「半拍」上。 */
    onsets: analysis.onsets,
  });

  /* ══════════════════════════════════════════════════════════════
   * ② 三个声部各自量化，合并成一个候选池
   * ══════════════════════════════════════════════════════════════
   * ⚠ 以前是「二选一」：piano 多就只用 piano，否则只用 drum。
   *   这等于丢掉一半音乐信息 —— 鼓点给骨架、旋律给重音，两者互补。
   *   现在三路都量化、都进池子，由显著性排序决定谁留下。 */
  const leadBeat = 2, endBeat = totalBeats - 1;
  /* 容差不写死：用 rhythm.js 的默认值（40ms）。
     早先这里写 95，比最细网格的半格还大 —— 于是任何位置都能被吸上，
     "量化失败"永远不会发生，容差等于没有。 */
  const qOpts = { minBeat: leadBeat, maxBeat: endBeat, maxShiftBeats: 1 };
  const tag = (arr, layer) => (arr || []).map(p => Object.assign({ layer }, p));

  const drumQ = quantizeOnsets(tag(analysis.drumOnsets, 'drum'), grid, qOpts);
  const pianoQ = quantizeOnsets(tag(analysis.pianoOnsets, 'piano'), grid, qOpts);
  const allQ = quantizeOnsets(tag(analysis.onsets, 'onset'), grid, qOpts);

  /* 合并 + 去重：不同声部的 onset 常被量化到**同一格**（鼓点与旋律同时响）。
     同一格只留一个，先用 conf × 层权重 粗筛（真正的排序在 scoreEvents 之后）。 */
  const layerPri = { drum: 1.0, piano: 0.72, onset: 0.6 };
  const bySlot = new Map();
  const pool = [];
  for (const e of [].concat(drumQ, pianoQ, allQ)) {
    if (!e || e.dropped) continue;
    const key = e.beat.toFixed(4);
    const score = (e.conf || 0) * (layerPri[e.layer] || 0.6);
    const prev = bySlot.get(key);
    if (prev) {
      if (score > prev._pick) { prev._pick = score; Object.assign(prev, e, { _pick: score }); }
      continue;
    }
    e._pick = score;
    bySlot.set(key, e);
    pool.push(e);
  }
  pool.sort((a, b) => a.beat - b.beat);

  /* ══════════════════════════════════════════════════════════════
   * ③ 乐句边界 —— 换气口上的音最该保留
   * ══════════════════════════════════════════════════════════════ */
  const phrases = phraseBounds(grid, analysis.sections, {
    phraseBars: preset.phrase >= 10 ? 4 : 2,
    duration,
  });

  /* ══════════════════════════════════════════════════════════════
   * ④ 打分 → 选点
   * ══════════════════════════════════════════════════════════════
   * ⚠⚠ **绝不凭空造音符。**
   *   旧代码在候选不足时会 `filled.push({t: beats[i] + s*beatSec/4, s: 0.2})`
   *   —— 那段音频里根本没有那个声音，玩家打到的是一张假谱。
   *   现在候选不够就少给，并把 shortfall 如实报出来。 */
  const target = Math.max(1, Math.round(preset.targetNps * duration));
  const scored = scoreEvents(pool, grid, { phrases });
  const sel = selectEvents(scored, {
    targetNotes: target,
    /* 阈值按难度微调：高难度允许更细的格子（那些音确实存在），
       低难度只留骨架。0.30 约等于「整拍 + 中等强度」能过的线。 */
    minSalience: preset.keep >= 0.9 ? 0.26 : preset.keep >= 0.75 ? 0.30 : 0.34,
  });
  const picked = sel.picked;
  markTuplets(picked);

  /* ══════════════════════════════════════════════════════════════
   * ⑤ 映射到判定线 + 决定类型
   * ══════════════════════════════════════════════════════════════ */
  assignHands(picked, { maxSameSide: 6 });
  assignNotes(picked, {
    weights: preset.weights, holds: preset.holds,
    beatSec, rng, maxHoldBeats: 2,
  });

  const notes = picked.map((e) => {
    const t = TYPE[e.kind] || 1;
    const endB = e.kind === 'hold' ? e.beat + (e.holdBeats || 0.5) : e.beat;
    return {
      above: 1, alpha: 255, endTime: frac(endB), isFake: 0,
      positionX: e.x, size: 1, speed: 1,
      startTime: frac(e.beat), type: t,
      visibleTime: 999999, yOffset: 0,
    };
  });

  notes.sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] / a.startTime[2] - b.startTime[1] / b.startTime[2]);
  const slug = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'chart';
  const chartId = slug + '_' + hashSeed(name + '|' + bpm).toString(16).slice(0, 6) + '_' + o.difficulty;
  /* 单条判定线：X = -300，Y = 200；音符保留左右手分散 x。 */
  notes.forEach((n) => { n.above = 1; });
  const baseLayer = defaultEvents(10)[0] || {};
  const mainLine = {
    Group: 0, Name: '主判定线', Texture: 'line.png',
    alphaControl: [{ alpha: 1, easing: 1, x: 0 }, { alpha: 1, easing: 1, x: 9999999 }],
    bpmfactor: 1,
    eventLayers: [Object.assign({}, baseLayer, {
      moveXEvents: [ev(0, 999999, -300, -300, 1)],
      moveYEvents: [ev(0, 999999, 200, 200, 1)],
    })],
    extended: { inclineEvents: [incline()] }, father: -1, isCover: 1,
    notes, numOfNotes: notes.length,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
    zOrder: 0,
  };
  const chart = {
    BPMList: [{ startTime: [0, 0, 1], bpm }],
    META: {
      RPEVersion: 160, background: 'background.png',
      charter: String(o.charter || 'P.H.M. rulechart'), composer: String(o.artist || 'Unknown'),
      illustration: '', id: chartId, level: preset.label, name,
      offset: 0, song: 'audio.wav', duration,
    },
    judgeLineGroup: ['Default'], judgeLineList: [mainLine],
  };
  const validation = validateChart(chart, {
    difficulty: o.difficulty, lanes: 2, free: true,
    targetNps: preset.targetNps, minGapBeats: preset.minGap, maxChord: preset.maxChord,
  });
  const typeCounts = { tap: 0, hold: 0, flick: 0, drag: 0 };
  for (const n of notes) for (const [k, v] of Object.entries(TYPE)) if (v === n.type) typeCounts[k]++;

  /* 三层报告全部带回给页面 —— 用户要能看见「时间轴靠不靠谱」、
     「为什么只出了这么多音」、「哪里可能难打」，而不是只拿到一个 valid 布尔。 */
  /* ⚠ 量化报告要分两层看：
     ① **候选池**（三声部合计）→ 平均偏差、丢弃数：衡量"时间轴靠不靠谱"
     ② **最终入选**（picked）→ 时值分布、三连音数：衡量"这份谱面长什么样"
     早先两者混用，页面出现「时值 1/1×174」而音符只有 58 —— 统计的是池子，
     用户会以为谱面里有 174 个音。 */
  const qAll = quantizeReport([].concat(drumQ, pianoQ, allQ));
  const qSel = quantizeReport(picked);
  const qReport = Object.assign({}, qAll, {
    byValue: qSel.byValue,
    tuplets: qSel.tuplets,
    meanDevMs: qSel.meanDevMs,
    maxDevMs: qSel.maxDevMs,
    candidates: qAll.kept,
  });
  const sReport = selectionReport(sel, picked);
  return {
    chart,
    stats: {
      notes: notes.length, bpm, duration, difficulty: preset.label, lanes: 2,
      onsets: (analysis.onsets || []).length,
      drumOnsets: (analysis.drumOnsets || []).length,
      pianoOnsets: (analysis.pianoOnsets || []).length,
      /* 三个声部都进了池子，不再有「只用一个源」这回事 */
      onsetSource: 'merged',
      nps: notes.length / duration,
      targetNps: preset.targetNps, targetNotes: target,
      typeCounts, valid: validation.ok,
      violations: validation.violations, warnings: validation.warnings,
      metrics: validation.metrics, ruleVersion: RULE_VERSION,
      /* ── A：时间轴 ── */
      quantize: qReport,
      grid: { bpm: grid.bpm, beatSec: Math.round(grid.beatSec * 10000) / 10000,
              offsetSec: Math.round(grid.offsetSec * 10000) / 10000,
              beatsPerBar: grid.beatsPerBar },
      phrases: phrases.length,
      /* ── B：事件选择 ── */
      selection: sReport,
      /* ── C：可玩性 ── */
      playability: validation.playability || null,
    },
  };
}

/* ============================================================
 * validateChart —— 规则校验器
 * ============================================================
 * 返回 { ok, violations[], metrics }。页面/CLI 在下载前跑同一份规则，
 * 保证「规则写谱」不是随口说说：同轨间隔、和弦数、Hold 重叠、时序、
 * 轨道/类型合法性都能被程序验证。
 * ============================================================ */
export function validateChart(chart, opts) {
  const o = opts || {};
  const preset = AUDIO_PRESETS[o.difficulty] || PRESETS[o.difficulty] || PRESETS.hard;
  const laneVals = LANES[o.lanes] || LANES[4];
  const free = !!o.free;
  const violations = [];
  const lines = chart && chart.judgeLineList;
  if (!lines || !Array.isArray(lines) || !lines.length) {
    return { ok: false, violations: ['chart has no judge line notes'], warnings: [], metrics: null };
  }
  const notes = lines.flatMap(l => Array.isArray(l.notes) ? l.notes : [])
    .sort((a, b) => (a.startTime[0] + a.startTime[1] / a.startTime[2]) - (b.startTime[0] + b.startTime[1] / b.startTime[2]));
  const duration = Number(chart.META && chart.META.duration) || 0;
  const bpm = Number(chart.BPMList && chart.BPMList[0] && chart.BPMList[0].bpm) || 120;
  const totalBeats = duration * bpm / 60;
  const toBeat = (f) => (Array.isArray(f) ? f[0] + f[1] / f[2] : Number(f));
  const types = { tap: 0, hold: 0, flick: 0, drag: 0 };
  const lanes = new Set();
  const byLane = new Map();
  const byTime = new Map();
  let minGap = Infinity;
  let prevStart = -Infinity;

  notes.forEach((n, i) => {
    const where = 'note[' + i + ']';
    const start = toBeat(n.startTime);
    const end = toBeat(n.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { violations.push(where + ' invalid time'); return; }
    if (start < 2 - 1e-6) violations.push(where + ' starts before lead-in');
    if (start > totalBeats - 1 + 1e-6) violations.push(where + ' starts after end margin');
    if (end < start - 1e-6) violations.push(where + ' end < start');
    if (![1, 2, 3, 4].includes(n.type)) violations.push(where + ' invalid type');
    if (free ? (n.positionX < -540 || n.positionX > 540) : !laneVals.includes(n.positionX)) violations.push(where + ' invalid lane ' + n.positionX);
    if (n.type === 2 && end - start < 0.25 - 1e-6) violations.push(where + ' hold too short');
    if (start < prevStart - 1e-6) violations.push(where + ' notes not sorted');
    prevStart = Math.max(prevStart, start);
    const lane = n.positionX;
    lanes.add(lane);
    const rec = byLane.get(lane);
    if (rec) {
      const gap = start - rec.start;
      /* ⚠ **free 模式也要查间隔。**
         以前这里是 `if (!free && gap < preset.minGap)` —— 而 2 指自由分散
         恰恰是最需要查的：x 可以落在任意位置，同一只手连打两个 0 间隔的音符
         完全"合法"。间隔的具体判定交给 playability（它会区分 error/warn），
         这里只统计 minGap 供 metrics 用。 */
      if (gap < (free ? 0.12 : preset.minGap) - 1e-6) {
        /* 硬冲突（同一时刻）由 playability 报 error，这里不重复报 */
      }
      if (rec.type === 2 && start < rec.end - 1e-6) violations.push(where + ' overlaps previous hold on lane ' + lane);
      minGap = Math.min(minGap, gap);
    }
    byLane.set(lane, { start, end, type: n.type });
    const key = start.toFixed(4);
    byTime.set(key, (byTime.get(key) || 0) + 1);
    if (n.type === 1) types.tap++;
    else if (n.type === 2) types.hold++;
    else if (n.type === 3) types.flick++;
    else if (n.type === 4) types.drag++;
  });

  let maxChord = 0;
  byTime.forEach((count) => { if (count > maxChord) maxChord = count; });
  if (maxChord > preset.maxChord) violations.push('chord ' + maxChord + ' > maxChord ' + preset.maxChord);
  if (notes.length === 0) violations.push('no notes');

  /* ── 可玩性审计 ──
     格式合法 ≠ 能好好打。三条实测过的「合法但没法玩」：
     12 NPS 挤在同一个 x、连续 40 个 90ms 间隔、音符落在 0.47/0.94 拍。
     审计把 error 折进 violations（不能下载），warn 折进 warnings（能下但提示）。 */
  const audit = auditPlayability(chart, {
    targetNps: Number.isFinite(o.targetNps) ? o.targetNps : preset.targetNps,
    minGapBeats: Number.isFinite(o.minGapBeats) ? o.minGapBeats : preset.minGap,
    maxChord: Number.isFinite(o.maxChord) ? o.maxChord : preset.maxChord,
    free, durationSec: duration,
  });
  /* 去重：lead-in / chord 这类两边都会查，别在 violations 里出现两遍 */
  const seen = new Set(violations.map(v => String(v).slice(0, 40)));
  for (const e of audit.errors) {
    const sig = (e.code + ':' + e.at).slice(0, 40);
    if (seen.has(sig)) continue;
    if (e.code === 'lead-in' || e.code === 'chord') continue;
    seen.add(sig);
    violations.push('[' + e.code + '] ' + e.msg);
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings: audit.warnings.map(w => '[' + w.code + '] ' + w.msg),
    playability: audit,
    metrics: {
      notes: notes.length,
      nps: duration ? notes.length / duration : 0,
      maxChord,
      minGap: minGap === Infinity ? null : minGap,
      types,
      lanes: [...lanes].sort((a, b) => a - b),
      /* 时间轴质量：直接来自审计，页面可以直接显示 */
      offGridRatio: audit.metrics ? audit.metrics.offGridRatio : null,
      peakNps: audit.metrics ? audit.metrics.peakNps : null,
      worstSameHandRun: audit.metrics ? audit.metrics.worstSameHandRun : null,
    },
  };
}

function writeU16(out, v) { out.push(v & 255, (v >>> 8) & 255); }
function writeU32(out, v) { out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

let CRC_TABLE = null;
function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();
export function zipStore(files) {
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const h = [0x50, 0x4b, 0x03, 0x04];
    writeU16(h, 20); writeU16(h, 0x0800); writeU16(h, 0); writeU16(h, 0); writeU16(h, 0);
    writeU32(h, crc); writeU32(h, data.length); writeU32(h, data.length);
    writeU16(h, name.length); writeU16(h, 0);
    local.push(new Uint8Array(h), name, data);
    const c = [0x50, 0x4b, 0x01, 0x02];
    writeU16(c, 20); writeU16(c, 20); writeU16(c, 0x0800); writeU16(c, 0); writeU16(c, 0); writeU16(c, 0);
    writeU32(c, crc); writeU32(c, data.length); writeU32(c, data.length);
    writeU16(c, name.length); writeU16(c, 0); writeU16(c, 0); writeU16(c, 0); writeU16(c, 0);
    writeU32(c, 0); writeU32(c, offset);
    central.push(new Uint8Array(c), name);
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const p of central) cdSize += p.length;
  const e = [0x50, 0x4b, 0x05, 0x06];
  writeU16(e, 0); writeU16(e, 0); writeU16(e, files.length); writeU16(e, files.length);
  writeU32(e, cdSize); writeU32(e, cdStart); writeU16(e, 0);
  const parts = local.concat(central, [new Uint8Array(e)]);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

function placeholderCover() { return b64bytes(COVER_PNG_BASE64); }

export function clickTrackWav(bpm, duration, sampleRate) {
  const sr = sampleRate || 22050;
  const n = Math.max(1, Math.floor(sr * duration));
  const samples = new Int16Array(n);
  const beatSec = 60 / bpm;
  for (let b = 0; b * beatSec < duration; b++) {
    const start = Math.floor(b * beatSec * sr);
    for (let i = 0; i < Math.min(sr * 0.03, n - start); i++) {
      const env = Math.exp(-i / (sr * 0.008));
      samples[start + i] = Math.round(Math.sin(2 * Math.PI * 1200 * i / sr) * 9000 * env);
    }
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) { dv.setInt16(off, samples[i], true); off += 2; }
  return bytes;
}

export function buildPez(chart, opts) {
  const o = opts || {};
  const meta = chart.META;
  const audio = o.audio || clickTrackWav(chart.BPMList[0].bpm, meta.duration);
  const audioName = o.audioName || 'audio.wav';
  meta.song = audioName;
  const cover = o.cover || placeholderCover();
  const info = '#\n'
    + 'Name: ' + meta.name + '\n'
    + 'Path: ' + meta.id + '\n'
    + 'Song: ' + audioName + '\n'
    + 'Picture: ' + meta.background + '\n'
    + 'Chart: ' + meta.id + '.json\n'
    + 'Level: ' + meta.level + '\n'
    + 'Composer: ' + meta.composer + '\n'
    + 'Charter: ' + meta.charter + '\n';
  const files = [
    { name: 'info.txt', data: enc.encode(info) },
    { name: meta.id + '.json', data: enc.encode(JSON.stringify(chart, null, 2)) },
    { name: audioName, data: audio },
    { name: meta.background, data: cover },
  ];
  return { pez: zipStore(files), chartJson: chart, info };
}

export { PRESETS, AUDIO_PRESETS, LANES, TYPE, RULES };
