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
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from serialize_chart import beat_to_sec, TYPE   # noqa: E402

ROOT = os.path.join(os.path.dirname(HERE), "data")
CHARTS = os.path.join(ROOT, "charts")
IRT = os.path.join(ROOT, "player-irt.json")
OUT = os.environ.get("PHM_SEQ_OUT") or os.path.join(ROOT, "seq-dataset.npz")
MAX_EVENTS = 8000          # 极端谱（5 万物量）截断，避免单样本过大
MIN_PLAYERS = 50           # 2026-11-01：100 → 50。冷启动曲线 20 人 ρ0.975 / 100 人 0.995，
                           # 50 人在两者之间；换来的是可用谱面 7,153 → 9,161（+28%）。


def find_chart_file(d):
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def events_of(path):
    """返回带**判定线屏幕坐标**的事件（V0.1-beta.3 起）。

    改用 chart_io.load_notes_ex：它同时给 positionX 与判定线运动后的 (sx, sy)。
    之前直接用 positionX 当屏幕坐标，判定线一移动/旋转，跳跃距离与夹角就全错。
    （实测只有约 5% 的谱面受影响明显，但这 5% 恰恰是特效多的谱。）
    """
    from chart_io import load_notes_ex
    return load_notes_ex(path, max_events=MAX_EVENTS)


def to_feats(ev):
    """事件 → 24 维特征（V0.1-beta.3）。目标：与 PhiraiAd 的 41 维等效。

    ━━━ 设计要点 ━━━
    它把特征分成「17 事件 + 6 同刻组 + 18 整谱统计」。我们不另存整谱统计，
    而是**把整谱量表达成事件通道**，用池化（max 取峰值、mean 取平均）还原 ——
    这样数据格式不用改，任何模型都能直接用。

      · 它要的「1 秒窗口最大密度」= 对通道 20 取 max
      · 它要的「长条覆盖/重叠」= 通道 21 的 mean / 正比例
      · 它要的「加权 NPS」= 通道 22 的 mean

    每事件 24 维：
      0  dt（截断 3s）           1  log1p(dt→ms)
      2  x/675                   3  |x|/675
      4-7 类型 one-hot           8  above        9  log1p(hold→ms)
     10  Δx/675                 11  跳跃距离     12  跳跃速度（25ms 下限）
     13  三连音夹角 cos         14  三连音夹角 sin
     15  同侧连续               16  同按数(±20ms)
     17  局部密度(±250ms)       18  running strain(log1p)
     19  相对时间(log1p)
     20  1 秒窗口按键数         21  当前按住的长条数
     22  1 秒窗口加权数         23  屏幕坐标位移 |Δsx|/675
    """
    n = len(ev)
    a = np.zeros((n, 24), dtype=np.float32)
    # 兼容两种输入：load_events 的 (t,x,ch,ab,hold) 与 load_notes_ex 的
    # (t,x,sx,sy,rot,ch,ab,hold)
    wide = len(ev[0]) >= 8
    ts = np.array([e[0] for e in ev], dtype=np.float64)
    xs = np.array([e[1] for e in ev], dtype=np.float64)
    prev_t, prev_x, prev_sx, strain = -1.0, 0.0, 0.0, 0.0
    w1s = 0.0
    held = []           # 正在按住的长条结束时间
    for i, e in enumerate(ev):
        t, x = e[0], e[1]
        if wide:
            ch, above, hold = e[5], e[6], e[7]
        else:
            ch, above, hold = e[2], e[3], e[4]
        typ = {"T": 1, "H": 2, "D": 3, "F": 4}.get(ch, 1)
        sx = e[2] if wide else x
        dt = min(max(t - prev_t, 0.0), 3.0) if prev_t >= 0 else 0.0
        a[i, 0] = dt
        a[i, 1] = np.log1p(dt * 1000.0)
        a[i, 2] = x / 675.0
        a[i, 3] = abs(x) / 675.0
        k = {1: 0, 2: 1, 3: 2, 4: 3}.get(typ, 0)
        a[i, 4 + k] = 1.0
        a[i, 8] = above
        a[i, 9] = np.log1p(hold * 1000.0)

        if prev_t >= 0:
            dx = (x - prev_x) / 675.0
            dist = abs(dx)
            speed = min(dist / max(dt, 0.025), 10.0)   # osu 的 25ms 下限
            a[i, 10] = dx
            a[i, 11] = dist
            a[i, 12] = speed
            a[i, 15] = 1.0 if (x >= 0) == (prev_x >= 0) else 0.0
            a[i, 23] = min(abs(sx - prev_sx) / 675.0, 5.0)
            w = (0.2 + 2.0 * speed) * (1.0 if k in (0, 2) else 0.5)
            strain = strain * math.exp(-dt / 0.4) + w
            a[i, 18] = math.log1p(min(strain, 200.0))
        if 0 < i < n - 1:
            v1 = np.array([xs[i] - xs[i - 1], max(ts[i] - ts[i - 1], 0.025)])
            v2 = np.array([xs[i + 1] - xs[i], max(ts[i + 1] - ts[i], 0.025)])
            cs = float(v1 @ v2 / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9))
            a[i, 13] = cs
            a[i, 14] = math.sqrt(max(0.0, 1 - cs * cs))
        a[i, 16] = float(np.sum(np.abs(ts - t) <= 0.02))
        a[i, 17] = float(np.sum(np.abs(ts - t) <= 0.25))
        # 1 秒窗口：用滚动和，避免每点 O(n)
        w1s += 1.0
        lo = np.searchsorted(ts, t - 1.0, side="right")
        if i >= lo:
            w1s = float(i - lo + 1)
        a[i, 20] = w1s
        a[i, 22] = w1s * (1.0 if k in (0, 2) else 0.5)
        while held and held[0] <= t:
            held.pop(0)
        if hold > 0:
            held.append(t + hold)
            held.sort()
        a[i, 21] = float(len(held))
        a[i, 19] = np.log1p(max(t - ts[0], 0.0))
        prev_t, prev_x, prev_sx = t, x, sx
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
