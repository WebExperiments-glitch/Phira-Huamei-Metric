/* ============================================================
 * public/js/audio-analysis.js —— 浏览器端音频自动提取（纯 JS，零依赖）
 * ============================================================
 * 输入：MP3/WAV/OGG/FLAC（浏览器 decodeAudioData 支持即可）
 * 输出：BPM / duration / 拍点 / 踩音点 / 段落能量 / offset
 *
 * 流程：解码 → 单声道 22050Hz → 短时傅里叶 → 谱通量 onset envelope
 *       → 自相关估 BPM → 拍相位 → 峰值踩音 → RMS 分段
 * 不上传音频；全在本地完成。
 * ============================================================ */

const TARGET_RATE = 22050;
const FRAME = 1024;
const HOP = 512;

let _fftCache = null;
function fftTables(n) {
  if (_fftCache && _fftCache.n === n) return _fftCache;
  const rev = new Uint16Array(n);
  let bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  _fftCache = { n, rev, cos, sin, win };
  return _fftCache;
}

function fft(re, im, t) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const p = k * step;
        const c = t.cos[p], s = -t.sin[p];
        const a = i + k, b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
function std(a, m) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; } return Math.sqrt(a.length ? s / a.length : 0); }

function onsetEnvelope(samples, sampleRate) {
  const t = fftTables(FRAME);
  const nFrames = Math.max(1, Math.floor((samples.length - FRAME) / HOP) + 1);
  const env = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const prev = new Float32Array(FRAME / 2 + 1);
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const nyquist = sampleRate / 2;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = (samples[off + i] || 0) * t.win[i]; im[i] = 0; }
    fft(re, im, t);
    let flux = 0, magSum = 0, weighted = 0;
    for (let k = 1; k <= FRAME / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const d = mag - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag;
      magSum += mag;
      weighted += mag * ((k / (FRAME / 2)) * nyquist);
    }
    env[f] = flux;
    centroid[f] = magSum > 1e-9 ? Math.max(0, Math.min(1, weighted / magSum / nyquist)) : 0.5;
  }
  return { env, centroid };
}

function tempoAndBeats(env, fps, duration) {
  const m = mean(env), s = std(env, m) || 1;
  const e = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) e[i] = (env[i] - m) / s;

  const minLag = Math.max(2, Math.floor(fps * 60 / 200));
  const maxLag = Math.min(e.length - 2, Math.ceil(fps * 60 / 60));
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < e.length; i++) score += e[i] * e[i + lag];
    score /= (e.length - lag);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  let bpm = 60 * fps / bestLag;
  while (bpm < 80) { bpm *= 2; bestLag = Math.round(bestLag / 2); }
  while (bpm > 180) { bpm /= 2; bestLag = Math.round(bestLag * 2); }

  // 拍相位：让拍点尽量落在 onset 强处
  let bestPhase = 0, phaseScore = -Infinity;
  for (let p = 0; p < bestLag; p++) {
    let score = 0;
    for (let i = p; i < e.length; i += bestLag) score += e[i];
    if (score > phaseScore) { phaseScore = score; bestPhase = p; }
  }
  const beats = [];
  for (let f = bestPhase; f < e.length; f += bestLag) beats.push(f / fps);
  return { bpm, beats, offset: bestPhase / fps };
}

function detectPeaks(env, fps) {
  const m = mean(env), s = std(env, m) || 1;
  const out = [];
  const minGap = Math.max(1, Math.round(fps * 0.05));
  let last = -999;
  for (let i = 2; i < env.length - 2; i++) {
    if (env[i] < m + 0.7 * s) continue;
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    if (i - last < minGap) continue;
    out.push({ time: i / fps, strength: Math.max(0, Math.min(1, (env[i] - m) / (s * 3 + 1e-9))) });
    last = i;
  }
  return out;
}

function sections(samples, sampleRate, duration) {
  const win = Math.max(1, Math.floor(sampleRate * 0.5));
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = samples[i + j]; s += v * v; }
    rms.push(Math.sqrt(s / win));
  }
  const max = Math.max.apply(null, rms) || 1;
  const norm = rms.map(v => v / max);
  const n = 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * norm.length / n), b = Math.floor((i + 1) * norm.length / n);
    let e = 0;
    for (let j = a; j < b; j++) e += norm[j];
    e = e / Math.max(1, b - a);
    const label = i === 0 ? 'intro' : i === n - 1 ? 'outro' : e > 0.7 ? 'chorus' : 'verse';
    out.push({ start: i * duration / n, end: (i + 1) * duration / n, label, energy: e });
  }
  return { rms: norm, sections: out };
}

/** 纯函数：直接分析 Float32 单声道样本（测试/Node 可用）。 */
export function analyzeSamples(samples, sampleRate, durationSec) {
  const duration = durationSec || samples.length / sampleRate;
  const { env, centroid } = onsetEnvelope(samples, sampleRate);
  const fps = sampleRate / HOP;
  const tb = tempoAndBeats(env, fps, duration);
  const onsets = detectPeaks(env, fps).filter(p => p.time < duration).map(p => {
    const idx = Math.max(0, Math.min(centroid.length - 1, Math.round(p.time * fps)));
    return Object.assign({}, p, { centroid: centroid[idx] || 0.5 });
  });
  const sec = sections(samples, sampleRate, duration);
  return {
    bpm: Math.round(tb.bpm * 10) / 10,
    duration,
    beats: tb.beats,
    beatInterval: 60 / tb.bpm,
    offset: tb.offset,
    onsets,
    sections: sec.sections,
    centroid,
    avgCentroid: mean(centroid),
    fps,
  };
}

/** 浏览器：解码文件 → 单声道 22050Hz → 分析。 */
export async function analyzeFile(file) {
  const raw = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('浏览器不支持 Web Audio');
  const ctx = new AC();
  const audio = await ctx.decodeAudioData(raw.slice(0));
  const duration = audio.duration;
  const rate = TARGET_RATE;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  try { await ctx.close(); } catch (e) {}
  return analyzeSamples(data, rate, duration);
}
