#!/usr/bin/env python3
"""把谱面 JSON 变成模型能吃的**事件序列张量**（不是 49 维摘要）。

━━━ 为什么不用现成的 49 维 ━━━
那 49 维是**摘要**（平均密度、峰值、连打比例…）。同样的物量，
排成楼梯和排成纵连是两种难度，摘要把这个差别扔掉了。
这里保留逐事件的 (时间间隔, 位置, 类型, 上下手)，让模型自己学排列。

━━━ 每个事件 10 维 ━━━
  0 dt(s, 截断 0~3)       1 log1p(dt→ms)
  2 x/675 (-1~1)          3 |x|/675
  4..7 类型 one-hot (T/H/F/D)
  8 above (0/1)            9 hold 时长 log1p

━━━ 输出（ragged，扁平存储）━━━
  feats.float16  [总事件数, 10]
  offs.int32     [n_charts+1]     第 i 张谱是 feats[offs[i]:offs[i+1]]
  y.float32      [n_charts]       标签 b（玩家实测难度，信度 0.9999）
  meta           ids / declared / players
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from serialize_chart import beat_to_sec, TYPE   # noqa: E402

ROOT = os.path.join(os.path.dirname(HERE), "data")
CHARTS = os.path.join(ROOT, "charts")
IRT = os.path.join(ROOT, "player-irt.json")
OUT = os.path.join(ROOT, "seq-dataset.npz")
MAX_EVENTS = 8000          # 极端谱（5 万物量）截断，避免单样本过大
MIN_PLAYERS = 100          # 标签可信度阈值（k=100 时 ρ 0.995）


def find_chart_file(d):
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def events_of(path):
    """返回 [(t, x, type_id, above, hold_dur), ...]，按时间排序。"""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        d = json.JSONDecoder().raw_decode(raw.lstrip())[0]
    if not isinstance(d, dict) or "judgeLineList" not in d:
        raise ValueError("not RPE")

    bpm = sorted(d.get("BPMList") or [{"bpm": 120.0, "startTime": [0, 0, 1]}],
                 key=lambda s: s.get("startTime", [0, 0, 1]))
    out = []
    for ln in d["judgeLineList"]:
        for nt in ln.get("notes") or []:
            t = beat_to_sec(bpm, nt["startTime"])
            typ = nt.get("type", 1)
            x = float(nt.get("positionX", 0.0))
            above = 1.0 if nt.get("above", 1) else 0.0
            hold = 0.0
            if typ == 2:
                e = beat_to_sec(bpm, nt.get("endTime") or nt["startTime"])
                hold = max(e - t, 0.0)
            out.append((t, x, typ, above, hold))
    out.sort(key=lambda e: e[0])
    return out[:MAX_EVENTS]


def to_feats(ev):
    n = len(ev)
    a = np.zeros((n, 10), dtype=np.float32)
    prev = -1.0
    for i, (t, x, typ, above, hold) in enumerate(ev):
        dt = t - prev if prev >= 0 else 0.0
        dt = min(max(dt, 0.0), 3.0)
        a[i, 0] = dt
        a[i, 1] = np.log1p(dt * 1000.0)
        a[i, 2] = x / 675.0
        a[i, 3] = abs(x) / 675.0
        k = {1: 0, 2: 1, 3: 2, 4: 3}.get(typ, 0)
        a[i, 4 + k] = 1.0
        a[i, 8] = above
        a[i, 9] = np.log1p(hold * 1000.0)
        prev = t
    return a


def main():
    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    ids = sorted(os.listdir(CHARTS))
    feats, offs, ys, kept, decl, npl = [], [0], [], [], [], []
    skip = {"nojson": 0, "nolabel": 0, "parse": 0, "fewplayers": 0}
    for i, cid in enumerate(ids):
        d = os.path.join(CHARTS, cid)
        if not os.path.isdir(d):
            continue
        info = irt.get(cid)
        if not info:
            skip["nolabel"] += 1
            continue
        if info.get("players", 0) < MIN_PLAYERS:
            skip["fewplayers"] += 1
            continue
        p = find_chart_file(d)
        if not p:
            skip["nojson"] += 1
            continue
        try:
            ev = events_of(p)
        except Exception:
            skip["parse"] += 1
            continue
        if len(ev) < 20:
            skip["parse"] += 1
            continue
        a = to_feats(ev)
        feats.append(a.astype(np.float16))
        offs.append(offs[-1] + a.shape[0])
        ys.append(info["b"])
        kept.append(cid)
        decl.append(info.get("declared") or 0.0)
        npl.append(info["players"])
        if (i + 1) % 1000 == 0:
            print(f"  {i + 1}/{len(ids)} · 已收 {len(kept)} 张", flush=True)

    F = np.concatenate(feats, axis=0)
    np.savez_compressed(OUT,
                        feats=F, offs=np.array(offs, dtype=np.int32),
                        y=np.array(ys, dtype=np.float32),
                        ids=np.array(kept), declared=np.array(decl, dtype=np.float32),
                        players=np.array(npl, dtype=np.int32))
    print(f"\n写出 {OUT}")
    print(f"  谱面 {len(kept):,} 张 · 事件 {F.shape[0]:,} · 特征 {F.shape[1]} 维")
    print(f"  平均每谱 {F.shape[0] / max(len(kept), 1):.0f} 个事件 · 文件 {os.path.getsize(OUT) / 1e6:.0f} MB")
    print(f"  跳过：{skip}")


if __name__ == "__main__":
    main()
