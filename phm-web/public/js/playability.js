/* ============================================================
 * public/js/playability.js —— 可玩性审计（纯函数，零依赖）
 * ============================================================
 * 【为什么需要这个文件】
 *   以前只有 `validateChart`，它查的是**格式合法**：
 *   时间有序、类型合法、轨道在范围内、Hold 够长……
 *   这些都对，但它回答不了「这张谱能不能好好打」。
 *
 *   实测过的三种「合法但没法玩」：
 *     · 一秒钟 12 个音符全挤在同一个 x 上 —— 格式全对，手不可能做到
 *     · 连续 40 个音、每个间隔 90ms —— 没有和弦、没有重叠，规则一条不犯
 *     · 音符落在 0.47 / 0.94 / 1.41 拍 —— 每一条都"在拍附近"，
 *       但没有任何一个落在玩家能读的格子上
 *
 * 【和 validateChart 的分工】
 *   playability 只回答「打起来怎么样」，不判格式。
 *   validateChart 调它，把 error 折进 violations、warn 折进 warnings。
 *   这样页面上既有「不能下载」的硬错误，也有「能下但难打」的提示。
 *
 * 【⚠ 两条铁律】
 *   ① **free 模式（2 指自由分散）也要查同轨间隔**。
 *      以前 `if (!free)` 直接跳过 —— 而 2 指模式恰恰是最需要查的：
 *      它让 x 落在任意位置，同一只手连打两个 0 间隔的音符完全合法。
 *   ② **不许用 BPM 或音符总数当难度**。
 *      10 秒里 60 个音和 60 秒里 360 个音，NPS 一样但手感完全不同。
 *      所以密度一律按**时间窗**算，并且要看**连续负担**而不是平均值。
 * ============================================================ */

/** 可读网格层级。与 rhythm.js 的 SUBDIVS 保持一致（这里独立列一份，
 *  因为 playability 要能审计**任意** chart，包括不是我们用 rhythm.js 生成的）。 */
const READABLE = [1, 2, 3, 4, 6, 8];

/** 判定某个拍号是否落在可读网格上，返回最小偏差（拍）。 */
export function gridDeviation(beat, tolBeats) {
  let best = Infinity;
  for (const sd of READABLE) {
    const scaled = beat * sd;
    const dev = Math.abs(scaled - Math.round(scaled)) / sd;
    if (dev < best) best = dev;
  }
  return best;
}

const beatOf = f => (Array.isArray(f) ? f[0] + f[1] / f[2] : Number(f));

/**
 * 审计一张 chart 的可玩性。
 *
 * @param {object} chart RPE v160 chart JSON
 * @param {{targetNps?:number, minGapBeats?:number, maxSameSide?:number,
 *          maxChord?:number, free?:boolean, readTolBeats?:number,
 *          durationSec?:number}} [opts]
 * @returns {{ok:boolean, errors:Array, warnings:Array, metrics:object}}
 */
export function auditPlayability(chart, opts) {
  const o = opts || {};
  const errors = [];
  const warnings = [];
  const push = (level, code, msg, at) => {
    const item = { level, code, msg, at };
    (level === 'error' ? errors : warnings).push(item);
  };

  const lines = (chart && chart.judgeLineList) || [];
  if (!Array.isArray(lines) || !lines.length) {
    return {
      ok: false,
      errors: [{ level: 'error', code: 'no-line', msg: 'chart has no judge line' }],
      warnings: [],
      metrics: null,
    };
  }

  const bpm = Number(chart.BPMList && chart.BPMList[0] && chart.BPMList[0].bpm) || 120;
  const beatSec = 60 / bpm;
  const durationSec = Number(o.durationSec || (chart.META && chart.META.duration)) || 0;
  const beatsPerBar = 4;

  /* 同轨最小间隔：**free 模式也给一个默认值**，不再跳过。
     free 下 x 是连续值，所以"同轨"实际是"同一只手" —— 用 sign(x) 归一。 */
  const free = !!o.free;
  const minGapBeats = Number.isFinite(o.minGapBeats)
    ? o.minGapBeats
    : (free ? 0.12 : 0.25);
  const maxChord = Number.isFinite(o.maxChord) ? o.maxChord : 3;
  const maxSameSide = Number.isFinite(o.maxSameSide) ? o.maxSameSide : 8;
  /* ⚠ 容差不能大于最细网格的半格（1/8 是 0.125 拍一格 → 半格 0.0625）。
     早先用 0.08，比半格还大 —— 于是**任何位置都算可读**，这条检查永远不触发。
     0.035 大约等于 120BPM 下的 17ms，是「人耳能听出偏」的量级。 */
  const readTolBeats = Number.isFinite(o.readTolBeats) ? o.readTolBeats : 0.035;

  /* 收集所有音符（带来源线与序号，报错时能指回去） */
  const notes = [];
  lines.forEach((l, li) => {
    (Array.isArray(l.notes) ? l.notes : []).forEach((n, ni) => {
      const s = beatOf(n.startTime);
      const e = beatOf(n.endTime);
      notes.push({
        line: li, idx: ni, note: n, start: s, end: e,
        x: Number(n.positionX) || 0, type: Number(n.type) || 1,
        /* 手：x<0 左手，x>0 右手。x=0 归左手（无所谓，只是要一致） */
        hand: (Number(n.positionX) || 0) < 0 ? 'L' : 'R',
      });
    });
  });
  notes.sort((a, b) => a.start - b.start || a.line - b.line || a.idx - b.idx);

  if (!notes.length) {
    push('error', 'no-notes', 'chart has no notes');
    return { ok: false, errors, warnings, metrics: emptyMetrics() };
  }

  /* ── ① 时间冲突 / 同轨过近 ── */
  const byX = new Map();
  const byTime = new Map();
  let minGapFound = Infinity;
  for (const r of notes) {
    const key = free ? r.hand : r.x.toFixed(2);
    const prev = byX.get(key);
    if (prev) {
      const gap = r.start - prev.start;
      if (gap < minGapBeats - 1e-6) {
        /* 间隔 ≤ 0 是**硬冲突**（同一只手同时按两个点）→ error
           只是偏近 → warn（能打但手感差） */
        const level = gap <= 1e-6 ? 'error' : 'warn';
        push(level, gap <= 1e-6 ? 'time-conflict' : 'same-hand-gap',
          (gap <= 1e-6 ? '同一只手在同一时刻有两个音符' : '同一只手间隔过近')
          + '：' + gap.toFixed(3) + ' 拍 < ' + minGapBeats
          + '（' + (free ? '手 ' + key : 'x=' + key) + '，第 ' + r.start.toFixed(2) + ' 拍）',
          r.start);
        if (gap > 0) minGapFound = Math.min(minGapFound, gap);
      } else {
        minGapFound = Math.min(minGapFound, gap);
      }
      /* Hold 与下一个音重叠 */
      if (prev.type === 2 && r.start < prev.end - 1e-6) {
        push('error', 'hold-overlap',
          '长条与同手下个音符重叠：第 ' + prev.start.toFixed(2) + ' 拍的长条持续到 '
          + prev.end.toFixed(2) + '，但第 ' + r.start.toFixed(2) + ' 拍又有音符', r.start);
      }
    }
    byX.set(key, r);
    const tk = r.start.toFixed(4);
    byTime.set(tk, (byTime.get(tk) || 0) + 1);
  }

  /* ── ② 和弦 ── */
  let maxChordFound = 0;
  byTime.forEach(v => { if (v > maxChordFound) maxChordFound = v; });
  if (maxChordFound > maxChord) {
    push('error', 'chord', '同一时刻有 ' + maxChordFound + ' 个音符 > 上限 ' + maxChord);
  }

  /* ── ③ 密度：一律按**时间窗**算，不看总数 ── */
  const winSec = 0.2;
  let peakNps = 0, peakAt = 0;
  for (let i = 0; i < notes.length; i++) {
    let j = i;
    while (j < notes.length && notes[j].start - notes[i].start <= winSec) j++;
    const nps = (j - i) / winSec;
    if (nps > peakNps) { peakNps = nps; peakAt = notes[i].start; }
  }
  /* 连续负担：任意 2 秒窗口的平均 NPS。
     这一条是关键 —— 平均 NPS 达标但"有 2 秒特别密"就是手感崩的地方。 */
  const midWin = 2.0;
  let peakSustained = 0, sustainedAt = 0;
  for (let i = 0; i < notes.length; i++) {
    let j = i;
    while (j < notes.length && notes[j].start - notes[i].start <= midWin) j++;
    const nps = (j - i) / midWin;
    if (nps > peakSustained) { peakSustained = nps; sustainedAt = notes[i].start; }
  }

  const targetNps = Number.isFinite(o.targetNps) ? o.targetNps : null;
  if (targetNps) {
    /* 瞬时密度：允许短爆发（鼓点过门），但超过目标 2 倍就是设计问题 */
    if (peakNps > targetNps * 2.0 + 0.5) {
      push('warn', 'density-spike',
        '有 0.2 秒内 ' + peakNps.toFixed(1) + ' NPS 的瞬时爆发（目标 ' + targetNps.toFixed(1)
        + '），第 ' + peakAt.toFixed(2) + ' 拍', peakAt);
    }
    if (peakSustained > targetNps * 1.35 + 0.3) {
      push('warn', 'density-sustained',
        '有 2 秒区间的平均密度 ' + peakSustained.toFixed(1) + ' NPS 明显高于目标 '
        + targetNps.toFixed(1) + '，第 ' + sustainedAt.toFixed(2) + ' 拍', sustainedAt);
    }
    const avgNps = durationSec > 0 ? notes.length / durationSec : 0;
    if (avgNps > 0 && Math.abs(avgNps - targetNps) / targetNps > 0.35) {
      push('warn', 'target-mismatch',
        '整曲平均 ' + avgNps.toFixed(2) + ' NPS 与目标 ' + targetNps.toFixed(1)
        + ' 偏离超过 35%（不是错误，但说明谱面密度与你选的难度档不匹配）', 0);
    }
  }

  /* ── ④ 同侧连续操作负担 ── */
  /* ⚠ 两个计数器必须分开：
     `run` 会在报警后清零（避免刷屏），如果 worstRun 也跟着它走，
     20 个同侧连打会被记成 9 —— 而 metrics 是给用户看"最坏情况"的。
     早先就踩过这个（测试里 20 → 9）。 */
  let runHand = null, run = 0, streak = 0, worstRun = 0, worstAt = 0;
  for (const r of notes) {
    run = r.hand === runHand ? run + 1 : 1;
    streak = r.hand === runHand ? streak + 1 : 1;
    runHand = r.hand;
    if (streak > worstRun) { worstRun = streak; worstAt = r.start; }
    if (run > maxSameSide) {
      /* 只在真正"连续"时才算负担：如果中间有超过 1 拍的休息，
         同侧 20 个也不累（一只手的瀑布流是合法写法）。 */
      push('warn', 'same-hand-run',
        '同一只手连续 ' + streak + ' 个音符（上限 ' + maxSameSide + '），第 '
        + r.start.toFixed(2) + ' 拍', r.start);
      run = 0;  /* 报一次就够，别刷屏；streak 继续累计 */
    }
  }

  /* ── ⑤ 异常长串：间隔很短的连续音符 ── */
  let stream = 0, streamStart = 0, worstStream = 0, worstStreamAt = 0;
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].start - notes[i - 1].start;
    if (gap <= 0.25 + 1e-6) {
      if (stream === 0) streamStart = notes[i - 1].start;
      stream++;
      if (stream > worstStream) { worstStream = stream; worstStreamAt = streamStart; }
    } else {
      if (stream >= 16) {
        push('warn', 'long-stream',
          '第 ' + streamStart.toFixed(2) + ' 拍起有连续 ' + (stream + 1)
          + ' 个间隔 ≤ 1/4 拍的音符，没有任何换气口', streamStart);
      }
      stream = 0;
    }
  }
  if (stream >= 16) {
    push('warn', 'long-stream',
      '第 ' + streamStart.toFixed(2) + ' 拍起有连续 ' + (stream + 1)
      + ' 个间隔 ≤ 1/4 拍的音符，没有任何换气口', streamStart);
  }

  /* ── ⑥ 节奏可读性 ── */
  let offGrid = 0, worstDev = 0, worstDevAt = 0;
  for (const r of notes) {
    const dev = gridDeviation(r.start, readTolBeats);
    if (dev > readTolBeats) {
      offGrid++;
      if (dev > worstDev) { worstDev = dev; worstDevAt = r.start; }
    }
  }
  const offRatio = notes.length ? offGrid / notes.length : 0;
  if (offRatio > 0.05) {
    push('warn', 'unreadable-rhythm',
      offGrid + ' / ' + notes.length + ' 个音符（' + Math.round(offRatio * 100)
      + '%）不落在可读网格上（1/1 · 1/2 · 1/3 · 1/4 · 1/6 · 1/8），最偏的是第 '
      + worstDevAt.toFixed(2) + ' 拍偏 ' + worstDev.toFixed(3) + ' 拍', worstDevAt);
  }

  /* ── ⑦ lead-in / 结尾余量 ── */
  const first = notes[0].start;
  if (first < 2 - 1e-6) {
    push('error', 'lead-in', '第一个音符在第 ' + first.toFixed(2) + ' 拍，早于 2 拍起手');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      notes: notes.length,
      avgNps: durationSec > 0 ? Math.round(notes.length / durationSec * 100) / 100 : 0,
      peakNps: Math.round(peakNps * 10) / 10,
      peakSustainedNps: Math.round(peakSustained * 10) / 10,
      maxChord: maxChordFound,
      minGap: minGapFound === Infinity ? null : Math.round(minGapFound * 1000) / 1000,
      worstSameHandRun: worstRun,
      worstStream: worstStream + 1,
      offGrid,
      offGridRatio: Math.round(offRatio * 1000) / 1000,
      bpm,
      beatSec,
      beatsPerBar,
      durationSec,
    },
  };
}

function emptyMetrics() {
  return {
    notes: 0, avgNps: 0, peakNps: 0, peakSustainedNps: 0, maxChord: 0,
    minGap: null, worstSameHandRun: 0, worstStream: 0, offGrid: 0,
    offGridRatio: 0, bpm: 120, beatSec: 0.5, beatsPerBar: 4, durationSec: 0,
  };
}

/** 把审计结果压成一句人话（页面上直接显示）。 */
export function summaryOf(audit) {
  if (!audit || !audit.metrics) return '无法审计';
  const m = audit.metrics;
  const parts = [
    m.notes + ' 个音符',
    m.avgNps + ' NPS',
  ];
  if (audit.errors.length) parts.push(audit.errors.length + ' 个硬错误');
  if (audit.warnings.length) parts.push(audit.warnings.length + ' 条提醒');
  if (!audit.errors.length && !audit.warnings.length) parts.push('未发现问题');
  return parts.join(' · ');
}
