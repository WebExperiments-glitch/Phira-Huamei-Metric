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

const LANES = {
  /* 2K = 两根手指可打，不是两根固定轨道：x 分散在整屏，左右手交替。 */
  2: [-540, -450, -360, -270, -180, -90, 0, 90, 180, 270, 360, 450, 540],
  4: [-225, -75, 75, 225],
  6: [-450, -300, -150, 150, 300, 450],
  7: [-450, -300, -150, 0, 150, 300, 450],
};

const PRESETS = {
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
  ez: { label: 'EZ 7',  keep: 0.55, targetNps: 2.0,  subdivision: 4,  minGap: 1.0,  maxChord: 1, lanes: 2,
        weights: { tap: .58, hold: .12, flick: .06, drag: .24 }, holds: [.5, 1],       phrase: 12 },
  hd: { label: 'HD 11', keep: 0.68, targetNps: 2.6,  subdivision: 8,  minGap: 0.5,  maxChord: 1, lanes: 2,
        weights: { tap: .58, hold: .10, flick: .07, drag: .25 }, holds: [.5, .75, 1],  phrase: 10 },
  in: { label: 'IN 14', keep: 0.82, targetNps: 3.6,  subdivision: 8,  minGap: 0.25, maxChord: 1, lanes: 2,
        weights: { tap: .56, hold: .10, flick: .07, drag: .27 }, holds: [.25, .5, .75], phrase: 8 },
  at: { label: 'AT 16', keep: 0.94, targetNps: 4.0,  subdivision: 16, minGap: 0.2,  maxChord: 1, lanes: 2,
        weights: { tap: .57, hold: .08, flick: .08, drag: .27 }, holds: [.25, .5], phrase: 8 },
};

const RULE_VERSION = '1.0';

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
  const potential = Math.max(2.5, Math.min(12.5,
    rate * 1.55 + energy * 1.8 + centroid * 0.8 + strength * 0.9 + Math.min(0.8, Math.abs(bpm - 120) / 120) + 0.6));
  /* 难度阈值与 2K 目标 NPS 解耦：先判档，再按该档 2K 密度生成。 */
  const key = potential < 4.2 ? 'ez' : potential < 5.6 ? 'hd' : potential < 7.0 ? 'in' : 'at';
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
  const lanes = preset.lanes;
  const name = String(o.name || 'Auto Chart');
  const rng = mulberry32(hashSeed(name + '|' + bpm + '|' + duration + '|' + (analysis.onsets || []).length + '|' + o.difficulty));
  const sections = analysis.sections || [];
  const sectionAt = (sec) => sections.find(s => sec >= s.start && sec < s.end) || null;
  const laneSet = LANES[lanes];
  const left = laneSet.filter(x => x < 0);
  const right = laneSet.filter(x => x > 0);

  /* ── 候选时刻：以检测到的拍点网格为骨架；onset 先吸附到 1/4 或 1/8 拍，避免“听起来不在拍上”。 ── */
  const beats = (analysis.beats || []).filter(x => Number.isFinite(x));
  const phase = beats.length ? beats[0] / beatSec : 0;
  const snapStep = 1 / preset.subdivision;
  const snapBeat = (b) => phase + Math.round((b - phase) / snapStep) * snapStep;
  const candidates = new Map();
  const add = (time, strength, source) => {
    if (!Number.isFinite(time) || time < 2 * beatSec || time > (totalBeats - 1) * beatSec) return;
    const beat = time / beatSec;
    const key = Math.round(beat * 32) / 32;
    const old = candidates.get(key);
    if (!old || strength > old.strength) candidates.set(key, { beat, time, strength, source });
  };
  for (const p of (analysis.onsets || [])) {
    const raw = p.time / beatSec;
    const snapped = beats.length ? snapBeat(raw) : raw;
    const dist = Math.abs(snapped - raw);
    /* 离拍网格太远的 onset 视为噪声/装饰音，不强行当主拍 */
    if (dist > snapStep * 0.62) continue;
    add(snapped * beatSec, p.strength || 0.35, 'onset');
  }
  if (beats.length) {
    for (const bt of beats) {
      for (let s = 0; s < preset.subdivision; s++) {
        add(bt + s * beatSec / preset.subdivision, 0.22, 'grid');
      }
    }
  } else {
    for (let b = 2; b < totalBeats - 1; b += 1 / preset.subdivision) add(b * beatSec, 0.22, 'grid');
  }
  let events = [...candidates.values()].sort((a, b) => a.beat - b.beat);
  const target = Math.max(1, Math.round(preset.targetNps * duration));
  const selectCap = Math.round(target * 1.6);
  if (events.length > selectCap) {
    /* 优先保留真实 onset + 强拍，再按时间排序 */
    events = events
      .map(e => ({ ...e, score: (e.source === 'onset' ? 2 : 0) + e.strength + (Math.abs(e.beat - Math.round(e.beat)) < 1e-6 ? 0.4 : 0) }))
      .sort((a, b) => b.score - a.score || a.beat - b.beat)
      .slice(0, selectCap)
      .sort((a, b) => a.beat - b.beat);
  }

  const notes = [];
  const lastLaneBeat = {};
  const holdUntil = {};
  let noteIndex = 0;

  const place = (beat, lane, type, holdBeats) => {
    const endBeat = type === 2 ? Math.min(totalBeats - 0.5, beat + (holdBeats || 0.5)) : beat;
    if (beat < (holdUntil[lane] || -1) - 1e-6) return false;
    if (lastLaneBeat[lane] != null && beat - lastLaneBeat[lane] < preset.minGap - 1e-6) return false;
    notes.push({
      above: 1, alpha: 255, endTime: frac(endBeat), isFake: 0,
      positionX: lane, size: 1, speed: 1,
      startTime: frac(beat), type, visibleTime: 999999, yOffset: 0,
    });
    lastLaneBeat[lane] = endBeat;
    if (type === 2) holdUntil[lane] = endBeat;
    return true;
  };

  for (const e of events) {
    if (notes.length >= target) break;
    const beat = e.beat;
    const sec = e.time;
    const section = sectionAt(sec);
    const chorus = section && section.label === 'chorus';
    const phrase = Math.floor(beat / 8);
    const hand = (noteIndex + phrase) % 2;
    const pool = hand === 0 ? left : right;

    /* 手内选轨：优先未在 Hold 中的轨道；同轨太近换一条 */
    let lane = null;
    const start = (noteIndex * 2 + phrase) % pool.length;
    const order = pool.map((_, i) => pool[(start + i) % pool.length]);
    for (const px of order) {
      if (beat < (holdUntil[px] || -1) - 1e-6) continue;
      if (lastLaneBeat[px] != null && beat - lastLaneBeat[px] < preset.minGap - 1e-6) continue;
      lane = px; break;
    }
    /* 当前手被 Hold/间隔挡住时，允许换到另一只手，避免 2K 直接漏音。 */
    if (lane == null) {
      for (const px of (hand === 0 ? right : left)) {
        if (beat < (holdUntil[px] || -1) - 1e-6) continue;
        if (lastLaneBeat[px] != null && beat - lastLaneBeat[px] < preset.minGap - 1e-6) continue;
        lane = px; break;
      }
    }
    if (lane == null) continue;

    /* 类型先按真实谱面权重抽，再对 Hold 加结构约束（副歌/非乐句起点降级为 Tap）。 */
    let type = TYPE[pickWeighted(rng, preset.weights)];
    let holdBeats = 0;
    if (type === 2) {
      if (chorus || beat < 4) {
        type = 1;
      } else {
        holdBeats = preset.holds[Math.floor(rng() * preset.holds.length)];
        if (beat + holdBeats > totalBeats - 1) { type = 1; holdBeats = 0; }
      }
    }
    if (!place(beat, lane, type, holdBeats)) continue;
    noteIndex++;

    /* 强拍和弦：一左一右，最多 maxChord，且不同轨 */
    if (preset.maxChord > 1 && Math.abs(beat - Math.round(beat)) < 1e-6 && Math.round(beat) % 4 === 0 && notes.length < target && rng() < 0.10) {
      const other = hand === 0 ? right : left;
      for (const px of other) {
        if (beat < (holdUntil[px] || -1) - 1e-6) continue;
        if (lastLaneBeat[px] != null && beat - lastLaneBeat[px] < preset.minGap - 1e-6) continue;
        place(beat, px, 1, 0);
        break;
      }
    }
  }

  notes.sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] / a.startTime[2] - b.startTime[1] / b.startTime[2]);
  /* 结构修复：丢掉落入同轨 Hold 的 note */
  const holdEnd = {};
  const fixed = [];
  for (const n of notes) {
    const s = n.startTime[0] + n.startTime[1] / n.startTime[2];
    const e = n.endTime[0] + n.endTime[1] / n.endTime[2];
    if (holdEnd[n.positionX] != null && s < holdEnd[n.positionX] - 1e-6) continue;
    fixed.push(n);
    if (n.type === 2) holdEnd[n.positionX] = Math.max(holdEnd[n.positionX] || 0, e);
  }
  notes.length = 0;
  for (const n of fixed) notes.push(n);

  const slug = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'chart';
  const chartId = slug + '_' + hashSeed(name + '|' + bpm).toString(16).slice(0, 6) + '_' + o.difficulty;
  const lineLayers = buildLineData(analysis, bpm, totalBeats);
  const mainLine = {
    Group: 0, Name: '主判定线', Texture: 'line.png',
    alphaControl: [{ alpha: 1, easing: 1, x: 0 }, { alpha: 1, easing: 1, x: 9999999 }],
    bpmfactor: 1, eventLayers: [lineLayers.main],
    extended: { inclineEvents: [incline()] }, father: -1, isCover: 1,
    notes, numOfNotes: notes.length,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
    zOrder: 0,
  };
  const decoLines = [0, 1, 2].map((i) => ({
    Group: 1 + i, Name: '装饰线' + i, Texture: 'line.png',
    alphaControl: [{ alpha: 1, easing: 1, x: 0 }, { alpha: 1, easing: 1, x: 9999999 }],
    bpmfactor: 1, eventLayers: [lineLayers.deco],
    extended: { inclineEvents: [incline()] }, father: -1, isCover: 0,
    notes: [], numOfNotes: 0,
    posControl: [{ easing: 1, pos: 1, x: 0 }, { easing: 1, pos: 1, x: 9999999 }],
    sizeControl: [{ easing: 1, size: 1, x: 0 }, { easing: 1, size: 1, x: 9999999 }],
    skewControl: [{ easing: 1, skew: 0, x: 0 }, { easing: 1, skew: 0, x: 9999999 }],
    yControl: [{ easing: 1, x: 0, y: 1 }, { easing: 1, x: 9999999, y: 1 }],
    zOrder: -1 - i,
  }));
  const chart = {
    BPMList: [{ startTime: [0, 0, 1], bpm }],
    META: {
      RPEVersion: 160, background: 'background.png',
      charter: String(o.charter || 'P.H.M. rulechart'), composer: String(o.artist || 'Unknown'),
      illustration: '', id: chartId, level: preset.label, name,
      offset: 0, song: 'audio.wav', duration,
    },
    judgeLineGroup: ['Default', 'Deco'], judgeLineList: [mainLine].concat(decoLines),
  };
  const validation = validateChart(chart, { difficulty: o.difficulty, lanes });
  const typeCounts = { tap: 0, hold: 0, flick: 0, drag: 0 };
  for (const n of notes) for (const [k, v] of Object.entries(TYPE)) if (v === n.type) typeCounts[k]++;
  return {
    chart,
    stats: {
      notes: notes.length, bpm, duration, difficulty: preset.label, lanes, onsets: (analysis.onsets || []).length,
      nps: notes.length / duration, targetNps: preset.targetNps, targetNotes: target,
      typeCounts, valid: validation.ok,
      violations: validation.violations, metrics: validation.metrics, ruleVersion: RULE_VERSION,
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
  const violations = [];
  const line = chart && chart.judgeLineList && chart.judgeLineList[0];
  if (!line || !Array.isArray(line.notes)) {
    return { ok: false, violations: ['chart has no judge line notes'], metrics: null };
  }
  const notes = line.notes;
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
    if (!laneVals.includes(n.positionX)) violations.push(where + ' invalid lane ' + n.positionX);
    if (n.type === 2 && end - start < 0.25 - 1e-6) violations.push(where + ' hold too short');
    if (start < prevStart - 1e-6) violations.push(where + ' notes not sorted');
    prevStart = Math.max(prevStart, start);
    const lane = n.positionX;
    lanes.add(lane);
    const rec = byLane.get(lane);
    if (rec) {
      const gap = start - rec.start;
      if (gap < preset.minGap - 1e-6) violations.push(where + ' same-lane gap ' + gap.toFixed(3) + ' < ' + preset.minGap);
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

  return {
    ok: violations.length === 0,
    violations,
    metrics: {
      notes: notes.length,
      nps: duration ? notes.length / duration : 0,
      maxChord,
      minGap: minGap === Infinity ? null : minGap,
      types,
      lanes: [...lanes].sort((a, b) => a - b),
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
