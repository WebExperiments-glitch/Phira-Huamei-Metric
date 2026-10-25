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
  const drum = new Float32Array(nFrames);
  const piano = new Float32Array(nFrames);
  const prev = new Float32Array(FRAME / 2 + 1);
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const nyquist = sampleRate / 2;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = (samples[off + i] || 0) * t.win[i]; im[i] = 0; }
    fft(re, im, t);
    let low = 0, mid = 0, high = 0, magSum = 0, weighted = 0, logSum = 0;
    for (let k = 1; k <= FRAME / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const d = mag - prev[k];
      if (d > 0) {
        const hz = k * sampleRate / FRAME;
        if (hz < 200) low += d;
        else if (hz < 2000) mid += d;
        else high += d;
      }
      prev[k] = mag;
      magSum += mag;
      logSum += Math.log(mag + 1e-9);
      weighted += mag * ((k / (FRAME / 2)) * nyquist);
    }
    const flat = magSum > 1e-9 ? Math.exp(logSum / (FRAME / 2)) / (magSum / (FRAME / 2) + 1e-9) : 0;
    /* 低频 kick + 高频噪声 + 谱平坦度 → 鼓；中频谐波 + 低平坦度 → 钢琴/旋律 */
    drum[f] = low * 1.5 + high * 1.2 * (0.5 + flat * 2);
    piano[f] = mid * 1.2 + high * (1 - Math.min(1, flat)) * 0.8;
    env[f] = low + mid + high;
    centroid[f] = magSum > 1e-9 ? Math.max(0, Math.min(1, weighted / magSum / nyquist)) : 0.5;
  }
  return { env, centroid, drum, piano };
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

/* 在 60–200 BPM 内找“onset 最贴网格”的拍速；用半拍网格，
 * 避免 190 被误判成 152/95 这类非整数倍。 */
function estimateTempo(peaks, duration) {
  if (!peaks || peaks.length < 6) return null;

  /* ── 八度歧义的解法：先算全部候选，再按「偏好节奏」选一个 ──
     【为什么原来只有 78.6%】
       搜索范围写死 60~200 BPM。而音游曲常上 200+：
       实测 56 张谱里 12 张错，**11 张的标准值 ≥202**（202/210/215/220/230/252.9），
       检测值恰好是一半 —— 因为 200 以上它根本输出不了。
       这不是"算法不够聪明"，是**天花板设低了**。

     【为什么不能简单放宽】
       放到 260 之后，115 BPM 的歌会因为泛音也被 230 命中，反向出错。
       所以放宽范围必须配一个选八度的规则。

     【规则】同一条 onset 网格能同时支持 T、2T、T/2。三者的吻合度（conc）
       往往接近，这时人耳会取"听起来最自然"的那档 —— MIR 里对应
       **preferred tempo ≈ 120 BPM** 这个先验。
       做法：在 conc ≥ 0.85×最佳 的候选里，取离 120 最近的那个（对数尺度）。
       ⚠ 这是一个明确的主观先验，不是物理定律。若以后发现有系统性偏差，
         改 PREfERRED 就行。 */
  const PREFERRED = 120;
  const BPM_MIN = 60, BPM_MAX = 260;
  const cands = [];
  let best = null;
  for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 0.25) {
    const rate = 2 * bpm / 60;
    let re = 0, im = 0, sw = 0;
    for (const p of peaks) {
      const w = 0.25 + (p.strength || 0.3);
      const ang = 2 * Math.PI * rate * p.time;
      re += Math.cos(ang) * w;
      im += Math.sin(ang) * w;
      sw += w;
    }
    const conc = Math.hypot(re, im) / (sw || 1);
    cands.push({ bpm, conc, re, im });
    if (!best || conc > best.conc + 1e-9) best = { bpm, conc, re, im };
  }
  if (!best) return null;

  /* ⚠ 这里原本想用「离 120 BPM 最近」来选八度 —— 实测**无效**。
     原因：`conc` 衡量的是**半拍网格**的吻合度（angle 用 bpm/30），
     而 T 与 2T 的半拍网格完全相同，所以 conc 对八度天生不敏感。
     只用先验去挑，只会把「判一半」的错误换成「判两倍」的错误（实测 44/56 不动）。
     真正的判别器是**拍点强弱是否交替**，需要在拿到 env 之后做，
     见 resolveOctave()。这里只保留候选集。 */
  best.cands = cands;
  /* 用 onset 间隔中位数判断半拍/整拍：60→120、87→174、95→190，但 90 保持 90。 */
  const ts = peaks.map(p => p.time).sort((a, b) => a - b);
  const io = ts.slice(1).map((v, i) => v - ts[i]).filter(x => x > 0.02).sort((a, b) => a - b);
  if (io.length) {
    const med = io[Math.floor(io.length / 2)];
    const dist = (bpm) => {
      const bs = 60 / bpm;
      return Math.min(Math.abs(bs - med), Math.abs(bs / 2 - med), Math.abs(bs / 4 - med));
    };
    const dbl = best.bpm * 2;
    if (dbl <= BPM_MAX && dist(dbl) <= dist(best.bpm) + 1e-9) {
      const rate = 2 * dbl / 60;
      let re = 0, im = 0, sw = 0;
      for (const p of peaks) {
        const w = 0.25 + (p.strength || 0.3);
        const ang = 2 * Math.PI * rate * p.time;
        re += Math.cos(ang) * w; im += Math.sin(ang) * w; sw += w;
      }
      const conc = Math.hypot(re, im) / (sw || 1);
      if (conc >= best.conc * 0.5) best = { bpm: dbl, conc, re, im };
    }
  }
  const phase = Math.atan2(best.im, best.re) / (2 * Math.PI); // 半拍网格的相位
  const halfBeat = 30 / best.bpm;
  let first = phase * halfBeat;
  while (first < 0) first += halfBeat;
  const beats = [];
  for (let s = first; s < duration; s += 60 / best.bpm) beats.push(s);
  return { bpm: Math.round(best.bpm * 10) / 10, beats, offset: first, conc: best.conc };
}

/* ── 节拍网格质量：这个 BPM 到底能不能信 ──
 *
 * 用户看不到「78.6%」这种全局准确率，他只看得到**这一首歌**。
 * 所以我们能给的、也是唯一有用的，是「**这一首**的网格靠不靠得住」。
 *
 * 两个互补的量：
 *   ① 拍点命中率 —— 每个拍点附近有没有 onset。
 *      低 = 拍子本身找错了（BPM 或相位错）。
 *   ② onset 吸附率 —— 有多少强 onset 落在网格线附近。
 *      低 = 网格没有覆盖音乐（可能漏了半拍，或段落是变速的）。
 *
 * ⚠ 两者必须一起看：
 *   只看①，一段静音里瞎放的网格也能 100%（因为分母只有拍点）；
 *   只看②，把网格塞得极密（每 16 分一个）也能 100%。
 *   合起来才算「网格和音乐对上了」。
 *
 * ⚠ 这是**自评**，不是与标准答案比对。它衡量的是「网格与音频的一致性」，
 *   不是「BPM 数字对不对」。八度歧义在两档上都一样高 —— 因为两种写法
 *   时间点本来就重合。这点必须在界面上说清，别让它冒充准确率。
 */
function gridQuality(beats, onsets, duration) {
  if (!beats || beats.length < 8 || !onsets || onsets.length < 8) {
    return { ok: false, score: 0, hitRate: 0, coverRate: 0, devMs: null, verdict: 'unknown' };
  }
  /* 容差按拍长比例取，至少 40ms —— 与写谱时的量化容差同源 */
  const period = beats.length > 1 ? beats[1] - beats[0] : 0.5;
  const tol = Math.max(0.04, Math.min(0.09, period * 0.18));

  /* ① 拍点命中率：拍点附近 ±tol 内有没有 onset */
  const times = onsets.map((o) => (typeof o === 'object' ? o.time : o)).sort((x, y) => x - y);
  const strength = onsets.map((o) => (o && o.strength) || 0.3);
  const near = (t, w) => {
    /* 二分找最近 onset */
    let lo = 0, hi = times.length - 1, best = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = Math.abs(times[mid] - t);
      if (d < best) best = d;
      if (times[mid] < t) lo = mid + 1; else hi = mid - 1;
    }
    return best <= w ? best : Infinity;
  };
  let hit = 0, dev = 0, devN = 0;
  for (const bt of beats) {
    const d = near(bt, tol);
    if (d !== Infinity) { hit++; dev += d; devN++; }
  }
  const hitRate = hit / beats.length;

  /* ② onset 吸附率：只统计**强 onset**，弱的不要求踩在拍上。
     ⚠ 用**半容差**。实测全容差下这个值恒为 1（150 BPM 时容差 72ms，
        而拍距 400ms、onset 又天然聚在拍附近 → 全部命中），
        等于「两个指标都要」退化成只看一个。半容差才有区分度。 */
  const strongIdx = strength.map((v, i) => (v >= 0.45 ? i : -1)).filter((i) => i >= 0);
  const tight = tol * 0.5;
  let cover = 0;
  for (const i of strongIdx) {
    if (near(times[i], tight) !== Infinity) cover++;
  }
  const coverRate = strongIdx.length ? cover / strongIdx.length : hitRate;

  /* ⚠ 综合分**只用 hitRate**，不用 coverRate。
     原因是结构性的：网格本来就是「让 onset 对齐」拟合出来的，
     「onset 落在网格上」几乎是定义上的必然（实测恒为 1，半容差也一样）。
     拿它参与评分等于自我证明。
     真正有区分度的是 hitRate：
       · 拍点附近**没有** onset → 网格比音乐密（多半是把半拍当成了拍）
     以及 devMs：
       · 偏差大 → 相位错，音符会系统性对不上鼓点（这比 BPM 错更致命）
     ⚠ 所以这个分数衡量的是「网格与音乐的**一致性**」，不是「BPM 对不对」。
       八度写错时两种网格时间点相同，分数一样高 —— 界面上必须这么讲。 */
  const score = hitRate;
  const devMs = devN ? (dev / devN) * 1000 : null;

  /* 判定：说人话，不说百分比套路 */
  /* 阈值**从 56 首真人谱的音频标定**，不是拍的：
       网格分  p5 0.418 · p25 0.572 · 中位 0.640 · p75 0.729 · p95 0.914
       偏差    p5 6ms · 中位 8ms · p95 16ms
     按 p75 / p25 切 → 约 25% good / 50% fair / 25% weak。

     ⚠ 第一版写 0.8/0.55 是**凭空定的**，结果全部落在 fair —— 因为音乐里
       本来就有大量空拍（拍子上没有音），hitRate 到不了 0.8。
     ⚠ 偏差门槛用固定 25ms：实测 p95 才 16ms，说明相位错几乎不发生；
       真超过 25ms 就是异常，值得降档提醒。 */
  const devBad = devMs != null && devMs > 25;
  let verdict;
  if (score >= 0.73 && !devBad) verdict = 'good';
  else if (score >= 0.55) verdict = 'fair';
  else verdict = 'weak';

  return {
    ok: true, score: +score.toFixed(3),
    hitRate: +hitRate.toFixed(3), coverRate: +coverRate.toFixed(3),
    devMs: devMs == null ? null : Math.round(devMs),
    beats: beats.length, strongOnsets: strongIdx.length, tolMs: Math.round(tol * 1000), tightMs: Math.round(tight * 1000),
    verdict,
  };
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
  const { env, centroid, drum, piano } = onsetEnvelope(samples, sampleRate);
  const fps = sampleRate / HOP;
  const rawPeaks = detectPeaks(env, fps).filter(p => p.time < duration);
  const tb = estimateTempo(rawPeaks, duration) || tempoAndBeats(env, fps, duration);
  const withCentroid = (arr) => arr.filter(p => p.time < duration).map(p => {
    const idx = Math.max(0, Math.min(centroid.length - 1, Math.round(p.time * fps)));
    return Object.assign({}, p, { centroid: centroid[idx] || 0.5 });
  });
  const onsets = withCentroid(detectPeaks(env, fps));
  const drumOnsets = withCentroid(detectPeaks(drum, fps));
  const pianoOnsets = withCentroid(detectPeaks(piano, fps));
  const total = drumOnsets.length + pianoOnsets.length;
  const drumRatio = total ? drumOnsets.length / total : 0;
  const pianoRatio = total ? pianoOnsets.length / total : 0;
  const sec = sections(samples, sampleRate, duration);
  return {
    bpm: Math.round(tb.bpm * 10) / 10,
    /* ── 八度是**欠定**的，不是错误 ──
       实测（56 张真人谱）：对「声明 BPM」的命中率 78.6%，
       剩下 21.4% 里 11/12 恰好是 **2.00×**，标准值集中在 85~130。
       验证过：130 BPM 的 8 分音符网格 ≡ 260 BPM 的 4 分音符网格，**时间点完全相同**。
       所以同一段音频，"130 + 8分" 和 "260 + 4分" 是**两种都对的记法**，
       制谱者选哪个是他的自由，音频里没有答案。
       → 因此这里如实给出另一个合理八度，让调用方决定怎么显示，
         而不是假装能猜中作者的偏好。
       ⚠ 对我们真正重要的一件事：**八度不影响生成**。
         无论按哪档算，音符落点一致。 */
    bpmAlt: (tb.bpm * 2 <= 265 ? Math.round(tb.bpm * 20) / 10
            : Math.round(tb.bpm * 5) / 10),
    /* 网格自评：界面据此告诉用户「这个 BPM 能不能信」。
       ⚠ 它衡量的是「网格与音频是否对得上」，不是「BPM 数字对不对」——
         八度写错时两种网格时间点相同，这个分数也一样高。 */
    grid: gridQuality(tb.beats, onsets, duration),
    duration,
    beats: tb.beats,
    beatInterval: 60 / tb.bpm,
    offset: tb.offset,
    onsets,
    drumOnsets,
    pianoOnsets,
    drumRatio,
    pianoRatio,
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
  /* 注意：web-audio-beat-detector 的 worker 在长音频上会阻塞很久，不能放在分析主链路里。
   * 页面用本地 FFT 结果；库保留 vendored，离线/实验时再单独调用。 */
  return analyzeSamples(data, rate, duration);
}

/* ============================================================
 * 打包前的音频兜底 —— 「Phira 解不了这个编码」
 * ============================================================
 * 2026-10-25 用户实测：导入报
 *   `Failed to load resources / unsupported feature: core (codec):unsupported codec`
 * 谱面 JSON 这次是对的，**挂的是音频**。
 *
 * 【为什么不是我"转码转坏了"】
 *   我们从来没转过码 —— `buildPez` 把用户上传的**原始字节**直接塞进包里。
 *   所以如果那个文件是 AAC/M4A（手机录音、微信转存最常见的形态）只是被命名成
 *   `.mp3`，Phira 的 symphonia 解不了，就报 unsupported codec。
 *
 * 【策略：能不转就不转，转也只往无损方向转】
 *   mp3 / ogg / wav  → **原样透传**（再压一次纯属自残）
 *   flac / m4a / aac / 认不出 → 解码成 PCM，写成 16-bit WAV
 *     （PCM 是无损容器，解码后不再有新的质量损失；代价是体积变大）
 * ============================================================ */

/** 靠 magic bytes 认容器 —— 不能信扩展名，实测就栽在这上面。
 *
 *  ⚠⚠ **顺序决定对错**（2026-10-25 实机测出来的）：
 *    第一版先扫 MP3 帧同步、后判 `ftyp@4`，于是一个真正的 M4A/AAC 被判成 mp3 ——
 *    因为 AAC 载荷里 `FF Ex` 出现的概率极高。误判的后果是「原样透传、不转码」，
 *    Phira 依旧报 unsupported codec。**容器签名必须排在帧同步之前。**
 *    同时帧同步也要收紧：MP3 头里 version/layer/bitrate/samplerate 有保留值，
 *    随机字节同时满足四项的概率很低。 */
export function sniffAudioKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const at = (i, s) => {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  /* ── 1. 有明确容器签名的，先认 ── */
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'fLaC')) return 'flac';
  if (at(4, 'ftyp')) return 'm4a';            /* MP4 系：AAC / ALAC */
  if (at(0, 'ID3')) return 'mp3';             /* MP3 带 ID3 头 */
  if (b[0] === 0xFF && (b[1] === 0xF1 || b[1] === 0xF9)) return 'aac';  /* ADTS */
  /* ── 2. 没有签名的，才去扫 MP3 帧同步（严格版）── */
  for (let i = 0; i < Math.min(b.length - 4, 8192); i++) {
    if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) continue;
    const ver = (b[i + 1] >> 3) & 3;     /* 1 = 保留，不合法 */
    const lay = (b[i + 1] >> 1) & 3;     /* 0 = 保留，不合法 */
    const br = (b[i + 2] >> 4) & 0xF;    /* 0 = free，15 = 非法 */
    const sr = (b[i + 2] >> 2) & 3;      /* 3 = 保留，不合法 */
    if (ver !== 1 && lay !== 0 && br !== 0 && br !== 15 && sr !== 3) return 'mp3';
  }
  return 'unknown';
}

/** 内容类型 → 文件扩展名（Phira 按扩展名发现文件，必须对得上） */
function matchExt(kind) {
  return { mp3: '.mp3', ogg: '.ogg', wav: '.wav', flac: '.flac' }[kind] || '.wav';
}

/** AudioBuffer → 16-bit PCM WAV */export function encodeWavFromBuffer(ab) {
  const ch = ab.numberOfChannels;
  const n = ab.length;
  const sr = ab.sampleRate;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(bytes.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(ab.getChannelData(c));
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
  }
  return bytes;
}

/**
 * 保证这份音频 Phira 能解。
 * @returns {Promise<{bytes:Uint8Array, name:string, kind:string, from?:string}>}
 */
export async function ensurePlayableAudio(bytes, name = 'audio.wav') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const kind = sniffAudioKind(b);
  /* ⚠ 这份白名单是**对着 Phira 源码抄的**，不是猜的：
       prpr/Cargo.toml:65
       symphonia = { features = ["flac","mp3","ogg","vorbis","wav","pcm"] }
     —— 没有 aac / m4a / opus / adpcm。名单外的进来必报
     `unsupported feature: core (codec):unsupported codec`。
     名单内的**原样透传**：再压一次纯属自残，转成 WAV 也只是白白变大。 */
  const OK_KINDS = new Set(['mp3', 'ogg', 'wav', 'flac']);
  if (OK_KINDS.has(kind)) {
    /* ⚠ Phira 靠**扩展名**发现音频文件（prpr/src/fs.rs 里按 mp3/ogg/wav/flac/aac 匹配），
       而解码按内容。所以扩展名必须和真实内容一致 —— 一个 OGG 内容叫 `.mp3`
       能过发现、也能解码，但一个 AAC 内容叫 `.mp3` 就是「找得到、解不开」。
       这里顺手把扩展名改对，成本为零。 */
    const ext = matchExt(kind);
    const fixed = /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, ext) : name + ext;
    return { bytes: b, name: fixed, kind, renamed: fixed !== name };
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('浏览器不支持 Web Audio，无法转成 WAV');
  const ctx = new AC();
  let ab;
  try {
    /* ⚠ decodeAudioData 会 **detach** 传入的 ArrayBuffer，必须给副本，
       否则后面还要用的原始字节就不见了。 */
    ab = await ctx.decodeAudioData(b.slice().buffer);
  } finally {
    try { await ctx.close(); } catch (e) { /* 关不掉就算了 */ }
  }
  return {
    bytes: encodeWavFromBuffer(ab),
    name: name.replace(/\.[^.]+$/, '') + '.wav',
    kind: 'wav',
    from: kind,
  };
}
