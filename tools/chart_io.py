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
import json


def _beat_to_sec(bps, beat):
    """bps: [(beat, bpm), ...] 按 beat 升序；分段累加。"""
    sec = 0.0
    for i, (b, bpm) in enumerate(bps):
        if beat <= b:
            break
        nxt = bps[i + 1][0] if i + 1 < len(bps) else float("inf")
        sec += (min(beat, nxt) - b) * 60.0 / bpm
    return sec


def parse_rpe(raw):
    """RPE：judgeLineList[].notes[]，startTime 是 (bar, num, den) 的拍。"""
    d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        raise ValueError("not RPE")
    bpm = sorted(d.get("BPMList") or [{"bpm": 120.0, "startTime": [0, 0, 1]}],
                 key=lambda s: s.get("startTime", [0, 0, 1]))
    out = []
    for ln in d["judgeLineList"]:
        for nt in ln.get("notes") or []:
            t = _beat_to_sec([(_frac(s["startTime"]), float(s["bpm"])) for s in bpm],
                             _frac(nt["startTime"]))
            typ = nt.get("type", 1)
            ch = {1: "T", 2: "H", 3: "D", 4: "F"}.get(typ, "T")
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


def load_events(path, max_events=100000):
    """统一入口：按内容自动判格式。返回按时间排序的事件列表。"""
    raw = open(path, encoding="utf-8", errors="replace").read()
    head = raw.lstrip()[:1]
    if head == "{":
        ev = parse_rpe(raw)
    else:
        ev = parse_pec(raw)
    ev.sort(key=lambda e: e[0])
    return ev[:max_events]
