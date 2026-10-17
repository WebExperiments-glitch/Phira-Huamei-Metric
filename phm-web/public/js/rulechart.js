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
  2: [-225, 225],
  4: [-225, -75, 75, 225],
  6: [-450, -300, -150, 150, 300, 450],
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

  return {
    chart: {
      BPMList: [{ startTime: [0, 0, 1], bpm }],
      META: {
        RPEVersion: 160, background: 'background.png',
        charter: String(o.charter || 'P.H.M. rulechart'), composer: String(o.artist || 'Unknown'),
        illustration: '', id: chartId, level: preset.label, name: String(o.name || 'Rule Chart'),
        offset: Number(o.offset) || 0, song: 'audio.wav', duration,
      },
      judgeLineGroup: ['Default'], judgeLineList: [mainLine],
    },
    stats: { notes: notes.length, bpm, duration, difficulty: preset.label, lanes, density },
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

export { PRESETS, LANES, TYPE };
