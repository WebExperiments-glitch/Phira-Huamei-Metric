/* ============================================================
 * public/js/rhythm.js —— 时间轴：拍网格 / 量化 / 乐句（纯函数，零依赖）
 * ============================================================
 * 【为什么需要这个文件】
 *   以前是「检测到 onset 就直接把它的时间当音符时间」。
 *   听起来很忠实，实际结果是**谱面永远不在拍上**：
 *     · onset 检测的峰值落在 0.47 拍、0.52 拍这种位置（检测误差 ±20ms 起）
 *     · Phira 判定线按拍走，音符落在格子外 = 玩家读不出来，只能靠背
 *     · 更要命的是**不可读**：一串 0.47 / 0.94 / 1.41 的音符看起来像乱按
 *
 *   所以时间轴必须经过两层：
 *     ① **拍点跟踪** → 一条拍网格（bpm + 相位 + 小节）
 *     ② **量化** → 把每个 onset 吸附到某个「人类能读的时值」上
 *
 * 【⚠ 量化不等于「全部吸到 1/4 网格」】
 *   切分、三连音、弱起都是真实存在的音乐写法。硬吸到 1/4 网格会把
 *   三连音变成两个音 + 一个空拍，听起来就是「卡不上」。
 *   所以网格层级里必须有 **1/3 与 1/6**（三连音、六连音），
 *   并且给更细的网格加**复杂度代价** —— 默认优先简单读法，
 *   只有当偏离省下的时间**明显大于**复杂度代价时才用三连音。
 *
 *   这正是「合理偏离」的可执行定义：
 *     代价 = |实际偏差| + λ × 该层级的读谱成本
 *   选代价最小的那一层。不是四舍五入，也不是无脑最细。
 *
 * 【纯函数】
 *   全部只吃数组、吐数组，不碰 DOM / 网络 / fs —— 所以能直接 Node 单测
 *   （tools/test-rhythm.mjs）。音频解码那条链路仍然在 audio-analysis.js。
 * ============================================================ */

/** 每拍的等分层级。
 *  1 = 整拍 / 2 = 八分 / 3 = **三连音** / 4 = 十六分 / 6 = **六连音**。
 *  ⚠ 3 与 6 是这张表的重点：没有它们，三连音只能被压成 1/4 或 1/8。
 *
 *  ⚠⚠ **故意不含 8（三十二分）**。
 *    早先有它，结果是「任何时间点都能被吸到某个格子上」——
 *    1/8 格宽 0.125 拍，半格只有 0.0625 拍，比任何合理的检测容差都小。
 *    于是"量化失败"在数学上不可能发生，容差形同虚设，
 *    连 0.42 拍这种勉强位置也会被"对上"。
 *    去掉之后最细是 1/6（格宽 0.167 拍），容差才有意义。 */
export const SUBDIVS = [1, 2, 3, 4, 6];

/** 各层级的**读谱成本**（毫秒等价物）。
 *  含义：用这一层能把偏差省下来多少毫秒，才值得让玩家多读一个更细的格子。
 *  数字不是拍脑袋：人类对 1/16 与 1/32 的分辨阈值大约在 40–60ms，
 *  三连音因为要「心里除以三」额外贵一档。 */
export const SUBDIV_COST_MS = { 1: 0, 2: 22, 3: 38, 4: 50, 6: 78, 8: 106 };

/** 默认量化容差（毫秒）。超过这个偏差就不认为它属于任何网格 ——
 *  宁可丢掉，也不要把一个明显的错音硬吸到拍上（那会让谱面「假」）。
 *
 *  ⚠ 40ms 不是随手取：最细网格 1/6 的**半格**在 120BPM 下约 42ms，
 *    所以容差必须**小于半格**，否则每个点都能被吸上，这条判据就废了。
 *    同时 40ms 也接近「人耳能听出偏」的量级，两边对得上。 */
const DEFAULT_TOL_MS = 40;

const finite = v => typeof v === 'number' && Number.isFinite(v);

/**
 * 相位精调 —— 「拍点跟踪」里真正管用的那一步。
 *
 * 【为什么必须做】
 *   上游 `estimateTempo` 用**半拍网格**的圆均值求相位，精度只到半拍：
 *   实测一段 120BPM、每拍一个 kick 的音频，网格相位偏了 0.25 秒（= 半拍）。
 *   结果**所有音符都落在"半拍"上** —— 数学上仍在网格上（1/2 格），
 *   听感也不算错，但：
 *     · 小节头全部错位 → 显著性里「小节头重音」的判据全废
 *     · 乐句边界全错位
 *     · 用户看到 BPM 120 却觉得"哪里不对"
 *   所以相位必须在**给定 BPM** 的前提下，用实际 onset 重新对齐一次。
 *
 * 【做法】
 *   在粗相位 ±半拍内扫描（步长 2ms），用「强度加权贴合度」打分：
 *     score = Σ strength × max(0, 1 − |偏差| / 搜索窗)
 *   取峰值。这是最朴素的脉冲串对齐，但对「鼓点清晰」的流行乐足够准，
 *   而且完全可解释（不是黑箱）。
 *
 *   搜索窗取 40ms 左右：再宽会把相邻的弱拍也算进来。
 *
 * @param {Array<{time:number, strength?:number}>} onsets
 * @param {number} beatSec 每拍秒数
 * @param {number} coarseSec 粗相位
 * @param {{winMs?:number, stepMs?:number}} [opts]
 * @returns {number} 精调后的相位（已折算进 [0, beatSec)）
 */
function refinePhase(onsets, beatSec, coarseSec, opts) {
  const o = opts || {};
  const winMs = Number.isFinite(o.winMs) ? o.winMs : 40;
  const stepSec = (Number.isFinite(o.stepMs) ? o.stepMs : 2) / 1000;
  const arr = (onsets || []).filter(p => p && Number.isFinite(p.time));
  if (!arr.length || !Number.isFinite(beatSec) || beatSec <= 0) {
    return Number.isFinite(coarseSec) ? coarseSec : 0;
  }
  const win = winMs / 1000;
  /* 只在粗相位 ± 半拍 内找 —— 超过半拍就该调整的是 BPM 本身，不是相位 */
  const half = beatSec / 2;
  let bestPhase = coarseSec, bestScore = -Infinity;

  for (let d = -half; d <= half + 1e-9; d += stepSec) {
    const phase = coarseSec + d;
    let score = 0;
    for (const p of arr) {
      /* 到最近网格点的距离（用相位折算） */
      const k = Math.round((p.time - phase) / beatSec);
      const dev = Math.abs(p.time - (phase + k * beatSec));
      if (dev < win) score += (1 - dev / win) * (0.3 + (p.strength || 0.35));
    }
    if (score > bestScore + 1e-9) { bestScore = score; bestPhase = phase; }
  }

  let out = bestPhase % beatSec;
  if (out < 0) out += beatSec;
  return out;
}

/**
 * 建立拍网格。
 *
 * ⚠ 相位（offsetSec）决定「第一拍在哪」。这里不重算 BPM，只信任调用方给的
 *   bpm + offset：BPM 估计已经在上游做了（`estimateTempo` 的圆均值相位法），
 *   再估一次只会引入第二套互相矛盾的数字。
 *
 * @param {{bpm:number, offset?:number, duration:number, beats?:number[]}} analysis
 * @param {{beatsPerBar?:number}} [opts]
 * @returns {{bpm:number, beatSec:number, offsetSec:number, beatsPerBar:number,
 *            totalBeats:number, beats:number[], bars:object[], spb:number}}
 */
export function buildGrid(analysis, opts) {
  const o = opts || {};
  const bpm = Math.max(20, Math.min(400, Number(analysis && analysis.bpm) || 120));
  const beatSec = 60 / bpm;
  const duration = Math.max(0, Number(analysis && analysis.duration) || 0);
  const beatsPerBar = Math.max(1, Math.min(16, Math.floor(o.beatsPerBar || 4)));

  /* 相位优先用上游给的 offset；没有就用第一个 beat。
     ⚠ 必须**按拍长取模**收敛到 [0, beatSec) —— 上游可能给一个负数或
       大于一拍的相位（都合法，但后面的拍号计算会因此整体偏移）。 */
  let raw = Number(analysis && analysis.offset);
  if (!finite(raw)) {
    const bs = (analysis && analysis.beats) || [];
    raw = bs.length && finite(bs[0]) ? bs[0] : 0;
  }
  let offsetSec = raw % beatSec;
  if (offsetSec < 0) offsetSec += beatSec;

  /* ⚠ 再对齐一次。上游给的相位精度只到半拍（它是在半拍网格上估的），
     不精调的话所有音符会整体落在"半拍"上 —— 见 refinePhase 的注释。 */
  if (Array.isArray(analysis && analysis.onsets) && analysis.onsets.length) {
    offsetSec = refinePhase(analysis.onsets, beatSec, offsetSec, o);
  }

  /* 网格延伸到 duration 之后半小节，保证尾巴上的音符也有格子可落 */
  const totalBeats = duration > 0 ? Math.ceil((duration - offsetSec) / beatSec) + 2 : 0;
  const beats = [];
  for (let i = 0; i < totalBeats; i++) beats.push(offsetSec + i * beatSec);

  const bars = [];
  for (let i = 0; i < Math.ceil(totalBeats / beatsPerBar); i++) {
    bars.push({
      index: i,
      startBeat: i * beatsPerBar,
      startSec: offsetSec + i * beatsPerBar * beatSec,
    });
  }
  return { bpm, beatSec, offsetSec, beatsPerBar, totalBeats, beats, bars, spb: beatSec };
}

/**
 * 把「秒」换算成「拍号（含小数）」。
 * 拍 0 = 网格相位所在的那一拍。
 */
export function secToBeat(sec, grid) {
  return (Number(sec) - grid.offsetSec) / grid.beatSec;
}

/** 拍号 → 秒。与 secToBeat 互为逆运算（单测里有一条专门验这个）。 */
export function beatToSec(beat, grid) {
  return grid.offsetSec + Number(beat) * grid.beatSec;
}

/**
 * 量化：把 onset 吸附到可读网格上。
 *
 * 对每个 onset 遍历「最近若干拍 × 所有层级」的格子，取
 *   代价 = |偏差ms| × devWeight + 层级成本
 * 最小且偏差在容差内的那个。**这一条就是「合理偏离」的全部机制**。
 *
 * @param {Array<{time:number, strength?:number, layer?:string}>} onsets
 * @param {object} grid buildGrid 的返回
 * @param {{tolMs?:number, devWeight?:number, subdivs?:number[],
 *          minBeat?:number, maxBeat?:number, maxShiftBeats?:number}} [opts]
 * @returns {Array<{sec:number, beat:number, bar:number, beatInBar:number,
 *                  subdiv:number, sub:number, devMs:number, cost:number,
 *                  value:string, strength:number, layer:string,
 *                  conf:number, dropped:boolean, rawSec:number}>}
 */
export function quantizeOnsets(onsets, grid, opts) {
  const o = opts || {};
  const tolMs = finite(o.tolMs) ? Math.max(1, o.tolMs) : DEFAULT_TOL_MS;
  const devWeight = finite(o.devWeight) ? o.devWeight : 1;
  const subdivs = Array.isArray(o.subdivs) && o.subdivs.length ? o.subdivs : SUBDIVS;
  const maxShift = finite(o.maxShiftBeats) ? o.maxShiftBeats : 1.0;
  const minBeat = finite(o.minBeat) ? o.minBeat : -Infinity;
  const maxBeat = finite(o.maxBeat) ? o.maxBeat : Infinity;
  const bs = grid.beatSec;

  const out = [];
  for (const p of onsets || []) {
    if (!p || !finite(p.time)) continue;
    const rawBeat = secToBeat(p.time, grid);
    if (rawBeat < minBeat || rawBeat > maxBeat) continue;

    const strength = Math.max(0, Math.min(1, Number(p.strength) || 0.35));
    const layer = p.layer || 'onset';

    /* 只在最近的两个整拍里找 —— maxShift 默认 1 拍，
       再远就该算「另一个音」而不是「这个音偏了」。 */
    const base = Math.round(rawBeat);
    let best = null;
    for (let b = base - Math.ceil(maxShift); b <= base + Math.ceil(maxShift); b++) {
      for (const sd of subdivs) {
        for (let sub = 0; sub < sd; sub++) {
          const qBeat = b + sub / sd;
          const devMs = (rawBeat - qBeat) * bs * 1000;
          if (Math.abs(devMs) > tolMs) continue;
          const cost = Math.abs(devMs) * devWeight + (SUBDIV_COST_MS[sd] || 0);
          if (!best || cost < best.cost - 1e-9) {
            best = { beat: qBeat, subdiv: sd, sub, devMs, cost };
          }
        }
      }
    }

    if (!best) {
      /* 离线太多 → **丢掉**，不硬吸。
         保留它会让整张谱「看起来有音符但谁也打不准」。 */
      out.push({
        sec: p.time, rawSec: p.time, beat: rawBeat, bar: NaN, beatInBar: NaN,
        subdiv: 0, sub: 0, devMs: 0, cost: Infinity, value: 'off-grid',
        strength, layer, conf: 0, dropped: true,
      });
      continue;
    }

    const bar = Math.floor(best.beat / grid.beatsPerBar);
    const beatInBar = best.beat - bar * grid.beatsPerBar;
    /* 置信度：强度 × 贴合度。两个都重要 ——
       一个很强的 onset 偏了 80ms，可信度也该打折。 */
    const conf = strength * (1 - Math.abs(best.devMs) / tolMs);
    out.push({
      sec: best.beat === null ? p.time : beatToSec(best.beat, grid),
      rawSec: p.time,
      beat: best.beat,
      bar,
      beatInBar,
      subdiv: best.subdiv,
      sub: best.sub,
      devMs: best.devMs,
      cost: best.cost,
      value: valueName(best.subdiv),
      strength,
      layer,
      conf: Math.max(0, Math.min(1, conf)),
      dropped: false,
    });
  }
  return out;
}

/** 层级 → 人类读得懂的时值名。
 *  ⚠ 这些名字会出现在报告里给用户看，别写成 "sd3" 这种。 */
export function valueName(subdiv) {
  switch (subdiv) {
    case 1: return '1/1';
    case 2: return '1/2';
    case 3: return '1/3';
    case 4: return '1/4';
    case 6: return '1/6';
    case 8: return '1/8';
    default: return '?';
  }
}

/**
 * 找出连续的三连音 / 六连音组，给它们打标记。
 *
 * 为什么要单独做：量化是**逐点**决策，它不知道「这三个音是一组三连音」。
 * 报告里能说出「第 3 小节有一组三连音」才算真的理解了节奏，
 * 而不是碰巧吸到了 1/3 网格上。
 *
 * @returns 同一批事件数组（原地加 tuplet 字段），便于链式调用
 */
export function markTuplets(events, opts) {
  const o = opts || {};
  const minRun = Math.max(2, Math.floor(o.minRun || 3));
  let i = 0;
  const arr = events || [];
  while (i < arr.length) {
    const sd = arr[i].subdiv;
    if (sd !== 3 && sd !== 6) { i++; continue; }
    let j = i;
    while (j + 1 < arr.length
           /* ⚠ 组内下一个音的层级可以是 sd 本身，**也可以是整拍** ——
              三连音 4+1/3、4+2/3、5.0 的最后一个音正好落在整拍上。
              早先要求 subdiv 相等，于是每组都被截在 2 个音、永远成不了组。 */
           && (arr[j + 1].subdiv === sd || arr[j + 1].subdiv === 1)
           && Math.abs(arr[j + 1].beat - arr[j].beat - 1 / sd) < 1e-6) j++;
    const run = j - i + 1;
    if (run >= minRun) {
      for (let k = i; k <= j; k++) arr[k].tuplet = sd === 3 ? 3 : 6;
    }
    i = j + 1;
  }
  return arr;
}

/**
 * 乐句边界。
 *
 * 两条来源：
 *   ① **小节线** —— 每 `phraseBars` 小节一句（音乐的骨架，永远可信）
 *   ② **段落能量转折** —— analysis.sections 的边界，落进最近的网格
 * 两条取并集，再合并过近的边界（< 1 小节就合并，否则会碎成一句一断）。
 *
 * @param {object} grid
 * @param {Array<{startSec:number,endSec:number,energy?:number}>} sections
 * @param {{phraseBars?:number, duration?:number, minGapBeats?:number}} [opts]
 */
export function phraseBounds(grid, sections, opts) {
  const o = opts || {};
  const phraseBars = Math.max(1, Math.floor(o.phraseBars || 4));
  const minGapBeats = finite(o.minGapBeats) ? o.minGapBeats : grid.beatsPerBar;
  const duration = finite(o.duration) ? o.duration : Infinity;

  const cands = [];
  for (const bar of grid.bars) {
    if (bar.index % phraseBars === 0) {
      cands.push({ beat: bar.startBeat, kind: 'bar', energy: null });
    }
  }
  for (const s of sections || []) {
    if (!s || !finite(s.startSec)) continue;
    const beat = secToBeat(s.startSec, grid);
    if (!finite(beat) || beat < 0) continue;
    /* 吸到最近的小节线 —— 段落边界很少刚好落在任意拍上 */
    const snapped = Math.round(beat / grid.beatsPerBar) * grid.beatsPerBar;
    cands.push({ beat: snapped, kind: 'section', energy: finite(s.energy) ? s.energy : null });
  }

  cands.sort((a, b) => a.beat - b.beat);
  const kept = [];
  for (const c of cands) {
    if (c.beat < 0 || beatToSec(c.beat, grid) > duration) continue;
    const last = kept[kept.length - 1];
    if (last && c.beat - last.beat < minGapBeats - 1e-6) {
      /* 太近：留「段落边界」（更有音乐意义），否则留先来的 */
      if (c.kind === 'section' && last.kind !== 'section') kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }

  return kept.map((c, i) => ({
    index: i,
    startBeat: c.beat,
    startSec: beatToSec(c.beat, grid),
    endBeat: i + 1 < kept.length ? kept[i + 1].beat : grid.totalBeats,
    endSec: i + 1 < kept.length ? beatToSec(kept[i + 1].beat, grid) : beatToSec(grid.totalBeats, grid),
    kind: c.kind,
    energy: c.energy,
  }));
}

/** 某个拍号落在哪一句里（没有乐句信息时返回 null）。 */
export function phraseAt(phrases, beat) {
  for (const p of phrases || []) {
    if (beat >= p.startBeat - 1e-6 && beat < p.endBeat - 1e-6) return p;
  }
  return null;
}

/**
 * 量化质量报告 —— 给用户看的「这次时间轴靠不靠谱」。
 * @param {Array} events quantizeOnsets 的返回
 */
export function quantizeReport(events) {
  const arr = (events || []).filter(Boolean);
  const kept = arr.filter(e => !e.dropped);
  const dropped = arr.length - kept.length;
  const abs = kept.map(e => Math.abs(e.devMs));
  const mean = abs.length ? abs.reduce((s, v) => s + v, 0) / abs.length : 0;
  const max = abs.length ? Math.max.apply(null, abs) : 0;
  const byValue = {};
  for (const e of kept) byValue[e.value] = (byValue[e.value] || 0) + 1;
  return {
    input: arr.length,
    kept: kept.length,
    dropped,
    meanDevMs: Math.round(mean * 10) / 10,
    maxDevMs: Math.round(max * 10) / 10,
    byValue,
    tuplets: kept.filter(e => e.tuplet).length,
  };
}
