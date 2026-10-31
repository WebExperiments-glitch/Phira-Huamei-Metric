#!/usr/bin/env python3
"""把 Phira/RPE 谱面 JSON 序列化成**事件流文本**，供 transformer 类模型直接吃。

━━━ 为什么必须序列化 ━━━
实测：谱面 JSON 中位 1.98 MB（约 50 万 token），p99 26 MB（约 670 万 token）。
任何模型的上下文都装不下 —— 连 1M 上下文也不够。
而音符本身只有 1,093（中位）个，序列化后约 0.8 万 token。

━━━ 输出格式（刻意压到最短，每行 3 个字段）━━━
    #META lines=26 notes=1093 dur=142.5 bpm=180
    0.00  3.5 T          # 时间(秒) 位置(-8..8) 类型(T/H/F/D)
    0.27  5.0 T
    0.55 -2.5 H 0.9      # Hold 多一个时长
    ...

为什么要时间而不是拍号：模型要判断密度和间隔，秒是绝对量；
拍号还得先学 BPM，多一层无用的换算。

为什么要 above 而不只是位置：Phira 里 above 决定上下手，
同一个 x 在不同手上是完全不同的手型。
"""
import json
import os
import sys


def bpm_at(bpm_list, beat):
    """取该拍位生效的 BPM（RPE 的 BPMList 是分段常值）。"""
    cur = bpm_list[0]["bpm"] if bpm_list else 120.0
    for seg in bpm_list:
        if seg.get("startTime", [0, 0, 1]) <= beat:
            cur = seg["bpm"]
        else:
            break
    return float(cur)


def beat_to_sec(bpm_list, beat):
    """把 [小节, 拍, 分母] 换成秒。分段 BPM 下逐段累加。"""
    bar, num, den = beat[0], beat[1], (beat[2] if len(beat) > 2 else 1)
    pos = bar + (num / den if den else 0)
    sec = 0.0
    prev = 0.0
    cur = 120.0
    for seg in bpm_list:
        st = seg.get("startTime", [0, 0, 1])
        sp = st[0] + (st[1] / (st[2] if len(st) > 2 and st[2] else 1))
        if sp <= prev:
            cur = seg["bpm"]
            continue
        if pos <= sp:
            break
        sec += (sp - prev) * 60.0 / cur
        prev = sp
        cur = seg["bpm"]
    sec += (pos - prev) * 60.0 / cur
    return sec


TYPE = {1: "T", 2: "H", 3: "F", 4: "D"}


def serialize(path, max_notes=20000):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        # 有些包把多个 JSON 对象首尾相接（不换行），取第一个
        d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        raise ValueError("不是 RPE 格式")

    bpm_list = sorted(d.get("BPMList") or [{"bpm": 120.0, "startTime": [0, 0, 1]}],
                      key=lambda s: s.get("startTime", [0, 0, 1]))
    lines = d["judgeLineList"]

    events = []
    for li, ln in enumerate(lines):
        for nt in ln.get("notes") or []:
            t = beat_to_sec(bpm_list, nt["startTime"])
            typ = TYPE.get(nt.get("type"), "T")
            x = float(nt.get("positionX", 0.0))
            above = 1 if nt.get("above", 1) else 0
            item = (t, x, typ, above, li)
            if typ == "H":
                e = beat_to_sec(bpm_list, nt.get("endTime") or nt["startTime"])
                item = (t, x, typ, above, li, max(e - t, 0.0))
            events.append(item)
    events.sort(key=lambda e: (e[0], e[1]))
    n_all = len(events)
    truncated = n_all > max_notes
    events = events[:max_notes]

    dur = events[-1][0] if events else 0.0
    head = (f"#META lines={len(lines)} notes={n_all} dur={dur:.1f} "
            f"bpm={bpm_list[0]['bpm']:.1f}")
    body = []
    for e in events:
        t, x, typ, above, li = e[0], e[1], e[2], e[3], e[4]
        tag = "" if above else "b"          # 只标「在下」（默认上），省字符
        if typ == "H":
            body.append(f"{t:.2f} {x:+.1f}{tag} H {e[5]:.2f}")
        else:
            body.append(f"{t:.2f} {x:+.1f}{tag} {typ}")
    return head + "\n" + "\n".join(body), truncated, len(events)


def main():
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "charts")
    ids = sys.argv[1:] or sorted(os.listdir(root))[:3]
    for cid in ids:
        d = os.path.join(root, cid)
        if not os.path.isdir(d):
            continue
        cand = [f for f in os.listdir(d) if f.lower().endswith((".json", ".pec", ".pgr"))]
        if not cand:
            continue
        p = os.path.join(d, cand[0])
        try:
            text, trunc, n = serialize(p)
        except Exception as e:
            print(f"{cid}: 跳过（{e}）")
            continue
        raw = os.path.getsize(p)
        print(f"\n=== 谱 {cid} ===  原始 {raw / 1e6:.2f} MB · 音符 {n}"
              f"{'（已截断）' if trunc else ''} · 序列化 {len(text):,} 字符 "
              f"（约 {len(text) / 4 / 1000:.1f}k token）")
        print("\n".join(text.split("\n")[:8]))
        print("...")


if __name__ == "__main__":
    main()
