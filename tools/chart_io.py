#!/usr/bin/env python3
"""谱面读取：RPE(JSON) 与 PEC(文本) 两种格式统一成事件列表。

━━━ 为什么需要 ━━━
按谱抓的 13,859 张里，有 **601 张是 PEC 文本格式**（官方谱面格式），
而 `build_seq_dataset.py` 只认 RPE 的 `judgeLineList`，于是这 601 张
被判成"解析失败"直接丢掉 —— 占可用样本的 11%，白丢。

━━━ 事件格式 ━━━
  (t_sec, x, type_char, above, hold_sec)
  type_char ∈ T(tap) / H(hold) / F(flick) / D(drag)，与 chart_dna 的 TY 表对应。

━━━ PEC 语法（从真实文件归纳，不是猜的）━━━
  bp <beat> <bpm>                              速度变更（累计生效）
  n1 <line> <beat> <x> <size> <above>          tap
  n2 <line> <beatStart> <beatEnd> <x> <size> <above>   hold（多一个结束拍）
  n3 <line> <beat> <x> <size> <above>          drag
  n4 <line> <beat> <x> <size> <above>          flick
  x 与 RPE 的 positionX 同一坐标（±675）。
"""
import bisect
import json
import math

# RPE 的 type → 字符。实测（对照 prpr 的 rpe.rs）：
#   1 = tap、2 = hold、3 = flick、4 = drag
# ⚠ 这里和 `build_seq_dataset.to_feats` 的**反向表**是一对，必须同时改：
#   只改一边会让 flick / drag 的 one-hot 列与 strain 权重整体互换（踩过一次）。
TYPE_MAP = {1: "T", 2: "H", 3: "F", 4: "D"}


def _beat_to_sec(bps, beat):
    """bps: [(beat, bpm), ...] 按 beat 升序；分段累加。"""
    sec = 0.0
    for i, (b, bpm) in enumerate(bps):
        if beat <= b:
            break
        nxt = bps[i + 1][0] if i + 1 < len(bps) else float("inf")
        sec += (min(beat, nxt) - b) * 60.0 / bpm
    return sec


def parse_rpe(raw, keep_fake=False):
    """RPE：judgeLineList[].notes[]，startTime 是 (bar, num, den) 的拍。"""
    d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        raise ValueError("not RPE")
    bpm = sorted(d.get("BPMList") or [{"bpm": 120.0, "startTime": [0, 0, 1]}],
                 key=lambda s: s.get("startTime", [0, 0, 1]))
    out = []
    skipped = 0
    for ln in d["judgeLineList"]:
        for nt in ln.get("notes") or []:
            # fake 音符不参与判定，但会出现在 JSON 里（演出谱里能占一半以上）。
            # 参考 PhiraiAd features.rs:204 的处置；不计入事件序列，否则演出谱
            # 会被系统性高估。计数留在 _FAKE_STAT 里供诊断，不影响返回值。
            fk = nt.get("isFake", 0)
            if not keep_fake and (fk is True or (isinstance(fk, (int, float)) and fk != 0)):
                skipped += 1
                continue
            t = _beat_to_sec([(_frac(s["startTime"]), float(s["bpm"])) for s in bpm],
                             _frac(nt["startTime"]))
            typ = nt.get("type", 1)
            ch = TYPE_MAP.get(typ, "T")
            hold = 0.0
            if typ == 2:
                hold = max(_beat_to_sec([(_frac(s["startTime"]), float(s["bpm"])) for s in bpm],
                                        _frac(nt.get("endTime") or nt["startTime"])) - t, 0.0)
            out.append((t, float(nt.get("positionX", 0.0)), ch,
                        1.0 if nt.get("above", 1) else 0.0, hold))
    return out


def _frac(st):
    """[bar, num, den] → 拍数。den 为 0 时按 1 处理（个别谱面见过）。"""
    if not st:
        return 0.0
    bar, num = float(st[0]), float(st[1])
    den = float(st[2]) if len(st) > 2 and st[2] else 1.0
    return bar + (num / den if den else 0.0)


def parse_pec(raw):
    bps, notes = [], []
    for line in raw.split("\n"):
        t = line.split()
        if not t:
            continue
        k = t[0]
        try:
            if k == "bp" and len(t) >= 3:
                bps.append((float(t[1]), float(t[2])))
            elif k == "n1" and len(t) >= 5:      # tap
                notes.append((float(t[2]), float(t[3]), "T", float(t[5]) if len(t) > 5 else 1.0, 0.0))
            elif k == "n2" and len(t) >= 6:      # hold：beatStart beatEnd
                notes.append((float(t[2]), float(t[4]), "H",
                              float(t[6]) if len(t) > 6 else 1.0,
                              max(float(t[3]) - float(t[2]), 0.0)))
            elif k == "n3" and len(t) >= 5:      # drag
                notes.append((float(t[2]), float(t[3]), "D", float(t[5]) if len(t) > 5 else 1.0, 0.0))
            elif k == "n4" and len(t) >= 5:      # flick
                notes.append((float(t[2]), float(t[3]), "F", float(t[5]) if len(t) > 5 else 1.0, 0.0))
        except (ValueError, IndexError):
            continue
    if not notes:
        raise ValueError("PEC 里没有音符行")
    if not bps:
        bps = [(0.0, 120.0)]
    bps.sort()
    if bps[0][0] > 0:
        bps.insert(0, (0.0, bps[0][1]))
    # ⚠ 行尾那个数字**不是 above**（12 个文件里 13,172 个是 0、只有 4 个是 1），
    # PEC 的上下手由判定线的 Y 决定，不在音符行里。一律按「在上」处理，
    # 否则全部音符都会被标成 b（在下），把序列化文本整体带偏。
    out = []
    for beat, x, ch, above, hold_beats in notes:
        t = _beat_to_sec(bps, beat)
        hold = _beat_to_sec(bps, beat + hold_beats) - t if hold_beats else 0.0
        out.append((t, x, ch, 1.0, max(hold, 0.0)))
    return out


def load_events(path, max_events=100000, keep_fake=False):
    """统一入口：按内容自动判格式。返回按时间排序的事件列表。

    2026-11-14：支持 .json.gz。
      data/charts 下 11,709 个谱面 json 共 36.6 GB，但它们是纯文本的
      判定线/音符结构，gzip 能压到 1.4% —— 压完只剩约 0.5 GB。
      D 盘吃紧，把原文件换成 .gz，这里透明读。
      ⚠ 用 'rt' 模式：gzip 默认出 bytes，而 parse_rpe/parse_pec 要 str。
    """
    p = str(path)
    if p.endswith(".gz"):
        import gzip
        with gzip.open(p, "rt", encoding="utf-8", errors="replace") as f:
            raw = f.read()
    else:
        raw = open(p, encoding="utf-8", errors="replace").read()
    head = raw.lstrip()[:1]
    if head == "{":
        ev = parse_rpe(raw, keep_fake)
    else:
        ev = parse_pec(raw)
    ev.sort(key=lambda e: e[0])
    return ev[:max_events]


# ────────────────────────── 判定线运动（V0.1-beta.3 基础）──────────────────────────
class _Track:
    """一条运动轨道（分段线性），**预解析 + 二分**。

    语义与旧的逐事件线性扫描**逐位一致**：
      · 空轨道 → None；beat 早于首事件 → None
      · 命中分段（含端点）→ 线性插值；`start == end` 的保持型返回 end
      · beat 晚于所有分段 → 最后一个 `start ≤ beat` 的事件的 end
      · 事件未按 start 升序（畸形谱）→ 退回线性扫描，保证数值不变

    动机：8,000 事件的谱 × 每事件一次 O(E) 扫描 = **33 s/谱**，全量跑不动；
    预解析后 0.29 s/谱。
    """

    __slots__ = ("starts", "ends", "v0", "v1", "pmax", "ordered", "raw")

    def __init__(self, events):
        raw = []
        for e in events or []:
            if not isinstance(e, dict):
                continue
            try:
                b0 = _frac(e.get("startTime"))
                b1 = _frac(e.get("endTime", e.get("startTime")))
                v0 = float(e.get("start", 0.0))
                v1 = float(e.get("end") if e.get("end") is not None else v0)
            except (TypeError, ValueError):
                continue
            raw.append((b0, b1, v0, v1))
        self.raw = raw
        self.ordered = all(raw[i][0] <= raw[i + 1][0] for i in range(len(raw) - 1))
        if self.ordered and raw:
            self.starts = [x[0] for x in raw]
            self.ends = [x[1] for x in raw]
            self.v0 = [x[2] for x in raw]
            self.v1 = [x[3] for x in raw]
            pmax, m = [], -float("inf")
            for b1 in self.ends:
                if b1 > m:
                    m = b1
                pmax.append(m)
            self.pmax = pmax
        else:
            self.starts = self.ends = self.v0 = self.v1 = self.pmax = []

    def at(self, beat):
        if not self.raw:
            return None
        if not self.ordered:
            return self._linear(beat)
        if beat < self.starts[0]:
            return None
        j = bisect.bisect_right(self.starts, beat) - 1
        # 最早一个 end ≥ beat 的分段：pmax 单调不减，可二分
        k = bisect.bisect_left(self.pmax, beat, 0, j + 1)
        if k > j:
            return self.v1[j]
        b0, b1 = self.starts[k], self.ends[k]
        if b1 - b0 < 1e-9:
            return self.v1[k]
        return self.v0[k] + (self.v1[k] - self.v0[k]) * (beat - b0) / (b1 - b0)

    def _linear(self, beat):
        cur = None
        for b0, b1, v0, v1 in self.raw:
            if beat < b0:
                break
            if b0 <= beat <= b1:
                if b1 - b0 < 1e-9:
                    return v1
                return v0 + (v1 - v0) * (beat - b0) / (b1 - b0)
            cur = v1
        return cur


def _track_prep(events):
    """事件列表 → `_Track`（已预解析则原样返回），供多音符复用同一轨道。"""
    return events if isinstance(events, _Track) else _Track(events)


def _track_value(events, beat):
    """在拍 `beat` 处取轨道值（分段线性）。口径与近似见 `_Track`。

    ⚠ 近似：RPE 的 easingType 有几十种缓动曲线，这里**只做线性插值**。
    对 `start == end` 的保持型事件（最常见）是精确的；缓动曲线类的偏差
    会在 beta.4 用完整 easing 表修正。宁可先有一个近似值，也不要继续用
    错误的坐标（原来直接拿 positionX 当屏幕坐标，判定线一动就全错）。
    """
    return _track_prep(events).at(beat)


def _line_tracks(line):
    """兼容两种 RPE 结构：老版直接挂在判定线上，v150+ 放在 eventLayers[0]。

    ⚠ prpr 的 `eventLayers` 是 `Vec<Option<...>>`：真实谱里会出现 `null` 元素
    （12 张谱，0.16%）。不跳过会让整张谱抛 AttributeError 被丢弃。
    """
    def pick(key):
        if line.get(key):
            return line[key]
        for el in (line.get("eventLayers") or []):
            if isinstance(el, dict) and el.get(key):
                return el[key]
        return []

    return pick("moveXEvents"), pick("moveYEvents"), pick("rotateEvents"), pick("speedEvents")


def _clip(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _anchor_dx_015(ts, hits):
    """每个音符与 `[t−0.15s, t)` 那批音符**平均屏幕 x** 之差（已 /675）。

    ts/hits 已按时间升序。同一时刻的音符互相不算（右端开区间）。
    窗口内没有更早音符 → 0。复杂度 O(n log n)。
    """
    n = len(ts)
    pre = [0.0] * (n + 1)
    for i, h in enumerate(hits):
        pre[i + 1] = pre[i] + h
    out = [0.0] * n
    for i in range(n):
        lo = bisect.bisect_left(ts, ts[i] - 0.15)
        hi = bisect.bisect_left(ts, ts[i])
        if hi > lo:
            out[i] = hits[i] - (pre[hi] - pre[lo]) / (hi - lo)
    return out


def load_notes_ex(path, max_events=200000, extra=False):
    """返回事件，附带**判定线运动后的屏幕坐标**。

    每项：(t, x_note, sx, sy, rot_deg, type_char, above, hold)
      x_note   谱面坐标系里的 positionX（±675）
      sx, sy   判定线移动/旋转后的屏幕坐标（同一尺度）
      rot_deg  该时刻判定线旋转角

    extra=True 时每项再追加 4 个值（下标 8–11，见 `docs/结果/屏幕坐标特征-A-B.md`）：
      8  hit_x           含父链的屏幕 x / 675，裁 ±4
      9  anchor_dx_015   与 [t−0.15s, t) 音符平均屏幕 x 之差 / 675，裁 ±8
      10 line_speed      判定线位移速度 / 675（半屏宽/秒），上限 200
      11 line_rot_speed  判定线角速度（度/秒），上限 36000
    PEC 没有判定线运动信息，这 4 个值恒为 0（与报告口径一致）。
    """
    raw = open(path, encoding="utf-8", errors="replace").read()
    if raw.lstrip()[:1] != "{":
        # PEC 暂不解析 cm/cr（beta.4）；退回原始坐标，sx=x, sy=0
        # ⚠ **必须按时间排序**：parse_pec 按文件行序返回（按判定线交错），
        # 不排序会让 to_feats 的 dt 出现负值被 clamp 成 0 —— 密度窗与 strain 全错
        # （实测 1027 号谱 Σdt 4,922 s → 215.5 s）。
        base = parse_pec(raw)
        base.sort(key=lambda e: e[0])
        pad = (0.0, 0.0, 0.0, 0.0) if extra else ()
        return [(t, x, x, 0.0, 0.0, ch, ab, h) + pad
                for t, x, ch, ab, h in base][:max_events]

    d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        raise ValueError("not RPE")
    bpm = sorted(d.get("BPMList") or [{"bpm": 120.0, "startTime": [0, 0, 1]}],
                 key=lambda s: s.get("startTime", [0, 0, 1]))
    bps = [(_frac(x["startTime"]), float(x["bpm"])) for x in bpm]

    geom = None
    if extra:
        from line_geometry import ChartGeometry
        geom = ChartGeometry(d)

    out = []
    for li, ln in enumerate(d["judgeLineList"]):
        mx, my, rot, _spd = _line_tracks(ln)
        # 预解析一次，后面每个音符 O(log E) 而不是 O(E)
        mx, my, rot = _track_prep(mx), _track_prep(my), _track_prep(rot)
        for nt in ln.get("notes") or []:
            beat = _frac(nt["startTime"])
            x = float(nt.get("positionX", 0.0))
            r = _track_value(rot, beat)
            lx = _track_value(mx, beat)
            ly = _track_value(my, beat)
            r = 0.0 if r is None else r
            th = math.radians(r)
            # 判定线旋转后，音符的水平偏移沿旋转方向铺开
            sx = x * math.cos(th) + (lx or 0.0)
            sy = x * math.sin(th) + (ly or 0.0)
            typ = nt.get("type", 1)
            ch = TYPE_MAP.get(typ, "T")
            hold = 0.0
            if typ == 2:
                e = _beat_to_sec(bps, _frac(nt.get("endTime") or nt["startTime"]))
                hold = max(e - _beat_to_sec(bps, beat), 0.0)
            ev = (_beat_to_sec(bps, beat), x, sx, sy, r, ch,
                  1.0 if nt.get("above", 1) else 0.0, hold)
            if extra:
                hx, _hy = geom.screen_xy(li, beat, x)
                hit_x = hx / 675.0
                spd = geom.line_speed(li, beat, bps) / 675.0
                rspd = geom.rot_speed(li, beat, bps)
                # hit_x 先存原始值（anchor 要拿它算均值），排序后再统一裁剪
                ev += (hit_x, 0.0, _clip(spd, 0.0, 200.0), _clip(rspd, 0.0, 36000.0))
            out.append(ev)
    out.sort(key=lambda e: e[0])
    out = out[:max_events]
    if extra and out:
        ts = [e[0] for e in out]
        anchor = _anchor_dx_015(ts, [e[8] for e in out])
        out = [e[:8] + (_clip(e[8], -4.0, 4.0), _clip(anchor[i], -8.0, 8.0), e[10], e[11])
               for i, e in enumerate(out)]
    return out


# ── 2026-11-14：谱面文件路径解析 ────────────────────────────────
# D 盘吃紧，data/charts 下 11,709 个 chart.json 共 36.6 GB。
# 它们是纯文本结构（判定线 + 音符），gzip 能压到 1.4% → 约 0.5 GB。
# 压缩后原文件名变成 chart.json.gz，所有「拼路径」的地方都要能认出来。
#
# 用法：把原来的
#     os.path.join(root, str(cid), "chart.json")
# 换成
#     chart_path(root, cid)
# 找不到就返回原路径（让调用方报它熟悉的「文件不存在」，不要静默变成 None）。

def chart_path(root, cid):
    """返回 {root}/{cid}/chart.json 或 chart.json.gz，哪个存在给哪个。"""
    import os
    base = os.path.join(str(root), str(cid))
    plain = os.path.join(base, "chart.json")
    if os.path.exists(plain):
        return plain
    gz = plain + ".gz"
    if os.path.exists(gz):
        return gz
    return plain          # 都不在 → 返回原名，让上层按原逻辑报错


def read_text(path):
    """读谱面文本，自动处理 .gz。给不用 load_events 的地方用。"""
    if str(path).endswith(".gz"):
        import gzip
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            return f.read()
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()
