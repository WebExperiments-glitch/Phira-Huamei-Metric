/* ============================================================
 * js/chart-geom.js —— 把谱面解析成「可绘制的几何」
 * ============================================================
 * 【为什么不复用 engine.js】
 *   `engine.js` 的 `loadChart()` 是为了**算难度**：它只关心「多少音符、多密」，
 *   所以判定线事件只统计了数量（moveDisp / rotCount / alphaCount），
 *   **关键帧全丢了**。渲染要的是「任意时刻 t 线在哪、朝哪转」。
 *   两者的取舍相反：
 *     算难度 → 只要统计量，越省内存越好（一次跑 9,500 张）
 *     画出来 → 要完整时间轴，且能按 t 求值
 *   所以单独一份。**engine.js 那一份不许动** —— 它牵着定数。
 *
 * 【⚠ 两套 schema，这是本文件存在的第二个理由】
 *   同一个圈子里流行两种谱面结构，字段名完全不同：
 *
 *   v160（engine.js 认的那种）
 *     notesAbove / notesBelow            音符，分上下
 *     judgeLineMoveEvents[]              事件，start/end 是 **[x, y] 数组**
 *     judgeLineRotateEvents / AlphaEvents
 *
 *   v1（data/charts/1000 那种）
 *     notes[]                            单数组，靠 note.above 区分上下
 *     eventLayers[].moveXEvents[]        按图层分，start/end 是**标量**
 *     eventLayers[].moveYEvents / rotateEvents / alphaEvents
 *     posControl / alphaControl          控制点（x 是**拍**，不是秒）
 *
 *   只认一套的后果：另一套解析出 **0 个音符**，页面一片空白。
 *   （第一版就是这样，被 data/charts/1000 当场打脸。）
 *
 * 【时间单位】
 *   两种 schema 的时间都是「拍三元组」[整数, 分子, 分母]，按 BPM 表折成秒。
 *   只有 posControl.x 这类控制点用**裸拍数**，别混。
 * ============================================================ */

const LANE_HALF = 675;

/* ── 缓动（RPE 的 30 种，索引就是 easingType） ──
   【这份表从哪来】`Ivan-1F/phichain` 的 `phichain-format/src/rpe/schema.rs`
   里 `RPE_EASING: [Easing; 30]`（LGPL-3.0，与本项目 GPL-3 兼容）。
   **不是猜的**，是照着权威表的编号顺序逐条写的。

   ⚠ 第一版只有 6 种，而且编号全错：把索引 2 写成 `k*k`，
     而索引 2 实际是 EaseOutSine（`k*k` 是 EaseInQuad，在索引 5）。
     错位的结果是**动画节奏全歪**，但看起来"也在动"，很难发现。

   ⚠ 索引 0 和 1 都是 Linear —— 上游就是这么定的，别当重复删掉。 */
const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3;
const C5 = (2 * Math.PI) / 4.5;

function bounceOut(k) {
  const n1 = 7.5625, d1 = 2.75;
  if (k < 1 / d1) return n1 * k * k;
  if (k < 2 / d1) { k -= 1.5 / d1; return n1 * k * k + 0.75; }
  if (k < 2.5 / d1) { k -= 2.25 / d1; return n1 * k * k + 0.9375; }
  k -= 2.625 / d1;
  return n1 * k * k + 0.984375;
}

const EASINGS = [
  (k) => k,                                                              // 0  Linear
  (k) => k,                                                              // 1  Linear（上游如此）
  (k) => Math.sin((k * Math.PI) / 2),                                    // 2  EaseOutSine
  (k) => 1 - Math.cos((k * Math.PI) / 2),                                // 3  EaseInSine
  (k) => 1 - (1 - k) * (1 - k),                                          // 4  EaseOutQuad
  (k) => k * k,                                                          // 5  EaseInQuad
  (k) => -(Math.cos(Math.PI * k) - 1) / 2,                               // 6  EaseInOutSine
  (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),        // 7  EaseInOutQuad
  (k) => 1 - Math.pow(1 - k, 3),                                         // 8  EaseOutCubic
  (k) => k * k * k,                                                      // 9  EaseInCubic
  (k) => 1 - Math.pow(1 - k, 4),                                         // 10 EaseOutQuart
  (k) => k * k * k * k,                                                  // 11 EaseInQuart
  (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),    // 12 EaseInOutCubic
  (k) => (k < 0.5 ? 8 * k * k * k * k : 1 - Math.pow(-2 * k + 2, 4) / 2),// 13 EaseInOutQuart
  (k) => 1 - Math.pow(1 - k, 5),                                         // 14 EaseOutQuint
  (k) => Math.pow(k, 5),                                                 // 15 EaseInQuint
  (k) => (k === 1 ? 1 : 1 - Math.pow(2, -10 * k)),                       // 16 EaseOutExpo
  (k) => (k === 0 ? 0 : Math.pow(2, 10 * k - 10)),                       // 17 EaseInExpo
  (k) => Math.sqrt(1 - Math.pow(k - 1, 2)),                              // 18 EaseOutCirc
  (k) => 1 - Math.sqrt(1 - k * k),                                       // 19 EaseInCirc
  (k) => 1 + C3 * Math.pow(k - 1, 3) + C1 * Math.pow(k - 1, 2),          // 20 EaseOutBack
  (k) => C3 * k * k * k - C1 * k * k,                                    // 21 EaseInBack
  (k) => (k < 0.5                                                        // 22 EaseInOutCirc
    ? (1 - Math.sqrt(1 - Math.pow(2 * k, 2))) / 2
    : (Math.sqrt(1 - Math.pow(-2 * k + 2, 2)) + 1) / 2),
  (k) => (k < 0.5                                                        // 23 EaseInOutBack
    ? (Math.pow(2 * k, 2) * ((C2 + 1) * 2 * k - C2)) / 2
    : (Math.pow(2 * k - 2, 2) * ((C2 + 1) * (k * 2 - 2) + C2) + 2) / 2),
  (k) => (k === 0 ? 0 : k === 1 ? 1                                      // 24 EaseOutElastic
    : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * C4) + 1),
  (k) => (k === 0 ? 0 : k === 1 ? 1                                      // 25 EaseInElastic
    : -Math.pow(2, 10 * k - 10) * Math.sin((k * 10 - 10.75) * C4)),
  (k) => bounceOut(k),                                                   // 26 EaseOutBounce
  (k) => 1 - bounceOut(1 - k),                                           // 27 EaseInBounce
  (k) => (k < 0.5                                                        // 28 EaseInOutBounce
    ? (1 - bounceOut(1 - 2 * k)) / 2
    : (1 + bounceOut(2 * k - 1)) / 2),
  (k) => (k === 0 ? 0 : k === 1 ? 1                                      // 29 EaseInOutElastic
    : k < 0.5
      ? -(Math.pow(2, 20 * k - 10) * Math.sin((20 * k - 11.125) * C5)) / 2
      : (Math.pow(2, -20 * k + 10) * Math.sin((20 * k - 11.125) * C5)) / 2 + 1),
];

function ease(k, type) {
  if (!(k > 0)) return 0;
  if (k >= 1) return 1;
  const f = EASINGS[type];
  return typeof f === 'function' ? f(k) : k;
}

/* 拍三元组 → 秒。分段积分，因为一张谱里 BPM 会变。 */
function secAtBeat(beat, bpmList) {
  let sec = 0;
  for (let i = 0; i < bpmList.length; i++) {
    const seg = bpmList[i];
    const next = bpmList[i + 1];
    const endBeat = next ? next.beat : Infinity;
    if (beat <= seg.beat) break;
    const to = Math.min(beat, endBeat);
    sec += (to - seg.beat) * 60 / seg.bpm;
    if (beat <= endBeat) break;
  }
  return sec;
}

const triple = (t) => (Array.isArray(t) ? t[0] + (t[1] || 0) / (t[2] || 1) : (+t || 0));

/* 一条轨 = 一串区间，每段从 v0 过渡到 v1。
   求值时找包含 t 的那段；找不到就取端点。 */
function makeTrack() { return { frames: [], dflt: 0 }; }
function pushFrame(track, s, e, v0, v1, easingType) {
  if (!isFinite(s)) return;
  const end = isFinite(e) && e > s ? e : s;
  track.frames.push({ s, e: end, v0, v1: (v1 == null ? v0 : v1), et: easingType || 1 });
}
function finishTrack(track, dflt) {
  track.frames.sort((a, b) => a.s - b.s);
  track.dflt = dflt;
  return track;
}
function at(track, t) {
  const f = track.frames;
  if (!f.length) return track.dflt;
  if (t <= f[0].s) return f[0].v0;
  for (let i = 0; i < f.length; i++) {
    const k = f[i];
    if (t <= k.e) {
      if (k.e <= k.s) return k.v1;
      return k.v0 + (k.v1 - k.v0) * ease((t - k.s) / (k.e - k.s), k.et);
    }
  }
  return f[f.length - 1].v1;
}

/* ── 控制点（v1 的 posControl / alphaControl）：[{x: 拍, pos|alpha, easing}] ──
   与事件不同：事件是「从 A 变到 B」，控制点是「到这一刻为止的常量」。
   折成区间轨，让两种 schema 走同一条求值路径。 */
function trackFromControl(pts, bpmList, key) {
  const tr = makeTrack();
  const list = (pts || []).slice().sort((a, b) => (a.x || 0) - (b.x || 0));
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const s = secAtBeat(p.x || 0, bpmList);
    const next = list[i + 1];
    const e = next ? secAtBeat(next.x || 0, bpmList) : s;
    pushFrame(tr, s, e, p[key], p[key], p.easing);
  }
  return tr;
}

/**
 * @param {object} j 已 JSON.parse 的谱面
 * @returns {{notes:Array, lines:Array, duration:number, bpm:number, schema:string}}
 */
export function extractGeometry(j) {
  const raw = j.judgeLineList || [];
  if (!raw.length) throw new Error('没有 judgeLineList（不是 RPE/PGR 谱面）');

  const bpmList = (j.BPMList || [{ startTime: [0, 0, 1], bpm: 120 }])
    .map(b => ({ beat: triple(b.startTime), bpm: +b.bpm || 120 }))
    .filter(b => b.bpm > 0)
    .sort((a, b) => a.beat - b.beat);
  if (!bpmList.length) bpmList.push({ beat: 0, bpm: 120 });

  /* 判 schema：有 eventLayers 或 notes（单数组）就是 v1 */
  const isV1 = raw.some(l => Array.isArray(l.eventLayers) || Array.isArray(l.notes));

  const notes = [];
  const lines = [];

  raw.forEach((ln, li) => {
    const toSec = (t) => secAtBeat(triple(t), bpmList);
    const tx = makeTrack();
    const ty = makeTrack();
    const tr = makeTrack();
    const ta = makeTrack();

    if (isV1) {
      /* ── v1：事件分散在 eventLayers 里，start/end 是标量 ── */
      for (const layer of (ln.eventLayers || [])) {
        /* ⚠ eventLayers 里可能夹着 null（实测 data/charts/1000），直接解引用会崩 */
        if (!layer) continue;
        for (const e of (layer.moveXEvents || [])) pushFrame(tx, toSec(e.startTime), toSec(e.endTime), e.start, e.end, e.easingType);
        for (const e of (layer.moveYEvents || [])) pushFrame(ty, toSec(e.startTime), toSec(e.endTime), e.start, e.end, e.easingType);
        for (const e of (layer.rotateEvents || [])) pushFrame(tr, toSec(e.startTime), toSec(e.endTime), e.start, e.end, e.easingType);
        for (const e of (layer.alphaEvents || [])) pushFrame(ta, toSec(e.startTime), toSec(e.endTime), e.start, e.end, e.easingType);
      }
      /* 控制点兜底：一条事件都没有时，至少把线停在它该在的位置 */
      if (!tx.frames.length && ln.posControl) {
        for (const f of trackFromControl(ln.posControl, bpmList, 'x').frames) tx.frames.push(f);
      }
      if (!ta.frames.length && ln.alphaControl) {
        for (const f of trackFromControl(ln.alphaControl, bpmList, 'alpha').frames) ta.frames.push(f);
      }
    } else {
      /* ── v160：move 事件的 start/end 是 [x, y] 数组 ── */
      for (const e of (ln.judgeLineMoveEvents || [])) {
        const a = Array.isArray(e.start) ? e.start : [0, 1];
        const b = Array.isArray(e.end) ? e.end : a;
        const s = toSec(e.startTime);
        const d = toSec(e.endTime);
        pushFrame(tx, s, d, a[0] ?? 0, b[0] ?? 0, e.easingType);
        pushFrame(ty, s, d, a[1] ?? 1, b[1] ?? 1, e.easingType);
      }
      for (const e of (ln.judgeLineRotateEvents || [])) pushFrame(tr, toSec(e.startTime), toSec(e.endTime), e.start ?? 0, e.end ?? 0, e.easingType);
      for (const e of (ln.judgeLineAlphaEvents || [])) pushFrame(ta, toSec(e.startTime), toSec(e.endTime), e.start ?? 1, e.end ?? 1, e.easingType);
    }

    finishTrack(tx, 0);
    finishTrack(ty, 1);
    finishTrack(tr, 0);
    finishTrack(ta, 1);

    lines.push({
      i: li, tx, ty, tr, ta,
      at(t) {
        return { x: at(tx, t), y: at(ty, t), rot: at(tr, t), alpha: at(ta, t) };
      },
    });

    /* ── 音符 ── */
    const push = (n, aboveFlag) => {
      if (n.isFake) return;
      const t = toSec(n.startTime);
      const tEnd = n.endTime ? toSec(n.endTime) : t;
      const isHold = n.type === 2 || tEnd > t + 1e-6;
      notes.push({
        t, x: n.positionX || 0, line: li,
        above: aboveFlag !== undefined ? aboveFlag : (n.above !== 0),
        /* type 只分 hold/tap —— 绘图只关心"有没有尾巴"。 */
        type: isHold ? 'hold' : 'tap',
        /* ⚠ kind 才是**真实音符类型**：RPE 1=Tap 2=Hold 3=Flick 4=Drag。
           之前体检拿 type 当类型统计，于是 Flick/Drag 全被算成 Tap，
           一张「Tap 84 / Hold 12 / Drag 12 / Flick 12」的谱被报成
           「tap 84 / hold 12」，模型以为生成器吞掉了类型，白查两轮。
           （2026-10-25 用户在真实使用中发现。） */
        kind: isHold ? 'hold'
          : n.type === 3 ? 'flick'
            : n.type === 4 ? 'drag' : 'tap',
        holdSec: Math.max(0, tEnd - t),
      });
    };
    if (isV1) {
      for (const n of (ln.notes || [])) push(n);
    } else {
      for (const n of (ln.notesAbove || [])) push(n, true);
      for (const n of (ln.notesBelow || [])) push(n, false);
    }
  });

  notes.sort((a, b) => a.t - b.t);
  const duration = notes.length ? notes[notes.length - 1].t : 0;
  return { notes, lines, duration, bpm: bpmList[0].bpm, laneHalf: LANE_HALF, schema: isV1 ? 'v1' : 'v160' };
}

/* ── 画一帧 ──
   ⚠ 这是**简化视图**，不是 Phira 的渲染器：没有特效、没有音符贴图。
     目的：① 一眼看出这谱长什么样 ② 导出视频的地基。
     刻意不做视觉糖 —— 做一半的特效比没有更难看。 */
export function drawFrame(ctx, geom, t, W, H, opts = {}) {
  const lookahead = opts.lookahead ?? 1.4;
  const laneW = W * 0.86;
  const laneX = (W - laneW) / 2;
  const baseY = H * 0.78;
  const toScreenX = (x) => laneX + ((x + LANE_HALF) / (2 * LANE_HALF)) * laneW;

  ctx.fillStyle = opts.bg || '#0b0d12';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(laneX, 0, laneW, H);

  for (const L of geom.lines) {
    const s = L.at(t);
    if (!(s.alpha > 0.01)) continue;
    ctx.save();
    ctx.globalAlpha = Math.min(1, s.alpha);
    ctx.translate(toScreenX(s.x), baseY - (s.y - 1) * H * 0.25);
    ctx.rotate(-s.rot * Math.PI / 180);
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-laneW / 2, 0);
    ctx.lineTo(laneW / 2, 0);
    ctx.stroke();
    ctx.restore();
  }

  for (const n of geom.notes) {
    const dt = n.t - t;
    if (dt < -0.06 || dt > lookahead) continue;
    const L = geom.lines[n.line];
    const ls = L ? L.at(n.t) : { x: 0, y: 1, rot: 0, alpha: 1 };
    const yLine = baseY - (ls.y - 1) * H * 0.25;
    const y = yLine - (dt / lookahead) * (yLine + 40);
    const x = toScreenX(n.x);
    const r = Math.max(7, W * 0.012);
    ctx.fillStyle = n.type === 'hold' ? 'rgba(120,200,255,0.95)' : 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(x, y, dt <= 0 ? r * 1.25 : r, 0, Math.PI * 2);
    ctx.fill();
  }
}
