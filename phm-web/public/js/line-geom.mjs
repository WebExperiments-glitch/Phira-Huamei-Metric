/* ============================================================
 * js/line-geom.mjs —— 判定线运动 → 音符屏幕坐标（sx, sy）
 * ============================================================
 * 【为什么需要】
 *   v4 的手型特征（`engine-v3.mjs` 的 handshape256）算的是「这一段摊开多大」，
 *   必须在**判定线移动/旋转之后的屏幕坐标**上算。用 positionX 会漏掉整条
 *   判定线的位移与倾角 —— 那恰恰是特效谱难的地方（实测约 5% 的谱受影响明显，
 *   而这 5% 正是特效最多的那些）。
 *
 * 【口径：与 Python `tools/chart_io.py` 的 load_notes_ex 逐位一致】
 *   sx = x·cos(θ) + lineX，sy = x·sin(θ) + lineY
 *     θ / lineX / lineY = 该音符**拍**上的轨道值
 *   轨道求值与 `chart_io._Track` 同一套规则：
 *     · beat < 首事件 → 无值（按 0 处理）
 *     · 命中分段 → 线性插值；start==end 的保持型返回 end
 *     · beat 晚于所有分段 → 最后一个 start ≤ beat 的 end
 *     · 事件未按 start 升序（畸形谱）→ 退回线性扫描
 *   ⚠ **只做线性插值**，忽略 RPE 的 easingType —— 这不是偷懒，是**必须与
 *     Python 侧同一个近似**：特征是在那份坐标上训练出来的，这边用完整缓动
 *     反而会与训练分布对不上（见 handshape_spec.md 第 8 节）。
 *   ⚠ 不读 `judgeLineMoveEvents`（v160 那套 [x,y] 数组）：Python 的
 *     `_line_tracks` 只认 moveXEvents / moveYEvents / rotateEvents，
 *     所以老 schema 的谱在 Python 那边本来就退化成 sx=x, sy=0。照抄。
 *
 * 【为什么不写进 engine.js】
 *   那个文件有 900 行硬上限（lint-slop 第 6 条），而且它的 `loadChart` 牵着定数。
 *   这里只是一个**附加**步骤：算不出来（结构不认识）就什么都不做，
 *   下游退回 positionX —— 与 Python 对 PEC 的处理一致。
 * ============================================================ */

/* 拍三元组 → 拍数。den 缺失/为 0 时按 1 处理（与 chart_io._frac 一致）。 */
function pyFrac(st) {
  if (!st) return 0;
  const den = st.length > 2 && st[2] ? +st[2] : 1;
  return +st[0] + (+st[1] / den);
}

/* 一条轨道。结构与语义逐条对照 chart_io._Track。 */
class Track {
  constructor(events) {
    this.raw = [];
    for (const e of (events || [])) {
      if (!e || typeof e !== 'object') continue;
      const b0 = pyFrac(e.startTime);
      const b1 = pyFrac(e.endTime === undefined ? e.startTime : e.endTime);
      const v0 = +e.start || 0;
      const v1 = e.end == null ? v0 : (+e.end || 0);
      if (!isFinite(b0) || !isFinite(b1) || !isFinite(v0) || !isFinite(v1)) continue;
      this.raw.push([b0, b1, v0, v1]);
    }
    this.ordered = true;
    for (let i = 0; i + 1 < this.raw.length; i++) {
      if (!(this.raw[i][0] <= this.raw[i + 1][0])) { this.ordered = false; break; }
    }
    if (this.ordered && this.raw.length) {
      this.starts = this.raw.map(r => r[0]);
      this.ends = this.raw.map(r => r[1]);
      this.v0 = this.raw.map(r => r[2]);
      this.v1 = this.raw.map(r => r[3]);
      this.pmax = [];
      let m = -Infinity;
      for (const e of this.ends) { if (e > m) m = e; this.pmax.push(m); }
    }
  }

  /* 二分：最后一个 start ≤ beat 的下标（bisect_right − 1）。 */
  at(beat) {
    if (!this.raw.length) return null;
    if (!this.ordered) return this.linear(beat);
    const st = this.starts;
    if (beat < st[0]) return null;
    let lo = 0, hi = st.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (st[m] <= beat) lo = m + 1; else hi = m; }
    const j = lo - 1;
    /* 最早一个 end ≥ beat 的分段（pmax 单调不减，可二分） */
    lo = 0; hi = j + 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.pmax[m] < beat) lo = m + 1; else hi = m; }
    const k = lo;
    if (k > j) return this.v1[j];
    const b0 = this.starts[k], b1 = this.ends[k];
    if (b1 - b0 < 1e-9) return this.v1[k];
    return this.v0[k] + (this.v1[k] - this.v0[k]) * (beat - b0) / (b1 - b0);
  }

  linear(beat) {
    let cur = null;
    for (const [b0, b1, v0, v1] of this.raw) {
      if (beat < b0) break;
      if (b0 <= beat && beat <= b1) {
        if (b1 - b0 < 1e-9) return v1;
        return v0 + (v1 - v0) * (beat - b0) / (b1 - b0);
      }
      cur = v1;
    }
    return cur;
  }
}

/* 取轨道来源：优先判定线上直接挂的，其次 eventLayers 里第一个非空的。
   与 chart_io._line_tracks 一致（含 eventLayers 里可能夹 null 的情况）。 */
function pickTrack(list, key) {
  if (list[key] && list[key].length) return list[key];
  for (const el of (list.eventLayers || [])) {
    if (el && typeof el === 'object' && el[key] && el[key].length) return el[key];
  }
  return [];
}

/* 拍 → 秒，**逐行照抄** chart_io._beat_to_sec 的累加顺序（分段累加）。
   【为什么不用 loadChart 已经算好的 sec】
     两者数学等价，但浮点**结合顺序不同**，差 1e-14 级。手型特征按
     `floor((t − t0) / 0.5)` 分箱 —— 正好落在边界上的音符会被这 1e-14
     推到相邻箱，于是该箱的包围盒整体变掉（aspect 量纲几百，肉眼差 7）。
     训练数据是 Python 这批箱号训出来的，所以这里必须重现 Python 的算法。
     实测 12,365 号谱有 48 个音符卡在边界上；用这份 t 之后 0 个。 */
function pySec(beat, bps) {
  let sec = 0;
  for (let i = 0; i < bps.length; i++) {
    const [b0, bpm] = bps[i];
    if (beat <= b0) break;
    const nxt = i + 1 < bps.length ? bps[i + 1][0] : Infinity;
    sec += (Math.min(beat, nxt) - b0) * 60.0 / bpm;
  }
  return sec;
}

/* 给归一化后的谱面对象 `r` 附上逐音符屏幕坐标：r.screen = {sx, sy, t}。
   返回 r 本身（方便在 return 里套一层，见 engine.js 的 loadChart）。
   依赖音符上的 line（判定线下标）与 beat（拍数）—— 两者都由 loadChart 写入。
   任一步对不上（缺 beat、线号越界）就**什么都不做**，下游退回 positionX。 */
export function withScreenCoords(r, j) {
  const notes = r && r.notes;
  const lines = (j && j.judgeLineList) || [];
  if (!notes || !notes.length) return r;
  const sx = new Float64Array(notes.length);
  const sy = new Float64Array(notes.length);
  const t = new Float64Array(notes.length);
  /* Python 侧 BPM 表：按 startTime 的拍数稳定排序（与 _beat_to_sec 的输入一致） */
  const rawBpm = (j.BPMList && j.BPMList.length) ? j.BPMList : [{ startTime: [0, 0, 1], bpm: 120 }];
  const bps = rawBpm.map(b => [pyFrac(b.startTime), +b.bpm])
    .sort((a, b) => a[0] - b[0]);
  const tracks = new Array(lines.length);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.beat == null) return r;
    const li = n.line | 0;
    if (li < 0 || li >= lines.length) return r;
    let tr = tracks[li];
    if (!tr) {
      const ln = lines[li] || {};
      tr = tracks[li] = {
        mx: new Track(pickTrack(ln, 'moveXEvents')),
        my: new Track(pickTrack(ln, 'moveYEvents')),
        rt: new Track(pickTrack(ln, 'rotateEvents')),
      };
    }
    const x = +n.x || 0;
    let deg = tr.rt.at(n.beat); deg = deg == null ? 0 : deg;
    let lx = tr.mx.at(n.beat); lx = lx == null ? 0 : lx;
    let ly = tr.my.at(n.beat); ly = ly == null ? 0 : ly;
    const th = deg * Math.PI / 180;
    sx[i] = x * Math.cos(th) + lx;
    sy[i] = x * Math.sin(th) + ly;
    t[i] = pySec(n.beat, bps);
  }
  r.screen = { sx: sx, sy: sy, t: t };
  return r;
}
