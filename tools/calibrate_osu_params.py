#!/usr/bin/env python3
"""
校准 osu! 架构评分器的参数（在社区谱官方定数上，Nelder-Mead）

自由参数（6 个，形状固定沿用 osu! 结构）：
  a     速度系数      speed = min(cap_s, a/Δt)
  cap_s 速度上限
  b     和弦系数      chord = b × (同押数−1)
  c     位移系数      move  = min(cap_m, c×|Δx|/Δt)
  cap_m 位移上限
  d     长押干扰系数
m（标度乘数）在给定其余参数时按最小二乘过原点闭式求解。
目标：最小化 |PS − 官方定数| 的中位数（对异常定数稳健）。
"""
import json
import math
import os
import pickle
import sys

import numpy as np
from scipy.optimize import minimize

BASE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(BASE, "..", "data", ".stages", "osu_calib_cache.pkl")

with open(CACHE, "rb") as f:
    CHARTS = pickle.load(f)
OFF = np.array([c["off"] for c in CHARTS])
EVS = [c["events"] for c in CHARTS]
print(f"[load] {len(CHARTS)} 张谱，{sum(len(e) for e in EVS)} 事件")


def eval_params(params, return_ps=False):
    a, cap_s, b, c, cap_m, d = params
    if a <= 0.005 or cap_s <= 0.05 or b < 0 or c <= 0.0005 or cap_m <= 0.05 \
            or d < 0 or d > 2.0:
        return 1e9
    ps_list = []
    for ev in EVS:
        strains = []
        strain = 0.0
        prev_t = None
        for (t, chord, dx, hold) in ev:
            dt = 0.2 if prev_t is None else max(t - prev_t, 0.001)
            decay = 0.3 ** dt
            speed = cap_s if a / dt > cap_s else a / dt
            move = cap_m if c * dx / dt > cap_m else c * dx / dt
            diff = (speed + b * (chord - 1) + move
                    + (d if hold else 0.0))
            strain = strain * decay + diff * (1.0 - decay)
            strains.append(strain)
            prev_t = t
        strains.sort(reverse=True)
        total = 0.0
        index = 0
        S, E = 20.0, 0.9
        for v in strains:
            if v <= 0:
                break
            w = (1 + S / (1 + index)) / (index ** E + 1 + S / (1 + index))
            total += v * w
            index += 1
        ps_list.append(total)
    ps = np.array(ps_list)
    m = float((ps @ OFF) / (ps @ ps)) if (ps @ ps) > 0 else 0.0
    final = np.clip(ps * m, 0.5, 20.0)
    err = np.abs(final - OFF)
    if return_ps:
        return float(np.median(err)), float(m), final
    return float(np.median(err))


x0 = np.array([0.13, 3.0, 0.5, 0.012, 2.5, 0.35])
print(f"[init] 参数 {x0.tolist()}  中位偏差 {eval_params(x0):.3f}")

res = minimize(eval_params, x0, method="Nelder-Mead",
               options={"maxfev": 260, "xatol": 1e-3, "fatol": 1e-3})
print(f"\n[opt] 完成，{res.nfev} 次评估")
print(f"最优参数: {np.round(res.x, 4).tolist()}")
med, m, final = eval_params(res.x, return_ps=True)
print(f"中位偏差 {med:.3f}  m={m:.4f}")

# 验证：分位与包络
err = np.abs(final - OFF)
for t in (0.5, 0.75, 0.9):
    print(f"  p{int(t*100)}: {np.quantile(err, t):.3f}")
le1 = float(np.mean(err <= 1.0) * 100)
print(f"  ≤1.0 命中 {le1:.1f}%")
print("\n包络（官方定数 → PS 中位）:")
for target in (5, 8, 11, 13, 15.5, 17.5):
    band = final[np.abs(OFF - target) < 0.8]
    if len(band):
        print(f"  官方 ~{target:<5} → PS {np.median(band):.1f} (n={len(band)})")
print("\nPARAMS =", json.dumps({"a": float(res.x[0]), "cap_s": float(res.x[1]),
      "b": float(res.x[2]), "c": float(res.x[3]), "cap_m": float(res.x[4]),
      "d": float(res.x[5]), "m": float(m)}))
