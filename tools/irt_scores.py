#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
irt_scores.py —— 从「玩家×谱面×ACC」矩阵里反推**客观难度**

【要解决的问题】
  之前的评价一直拿"引擎值 vs 谱师声明定数"，这是范畴错误：
  客观计算不该以"等于主观声明"为目标。
  这份脚本换一个参照系：**只从玩家行为里反推谱面难度**，不用任何声明值。

【模型】
  两参数 logistic（IRT/Rasch 的连续版）：

      acc_ij ≈ L · sigmoid( β · (θ_i − d_j) )

      θ_i = 第 i 个玩家能打到多准（能力）
      d_j = 第 j 张谱有多难（难度，我们要的）
      L   = 该谱的可达上限（用谱面内最高 ACC 近似）
      β   = 斜率

  **θ 和 d 是同时估出来的**，所以 d 是"相对玩家的难度"，
  不依赖任何人的主观判断。用交替最小二乘（ALS）求解。

【为什么这对】
  玩家强弱会污染"平均 ACC"，但不会污染 d —— 因为 θ_i 把玩家能力吸收掉了。
  这正是"客观标度"该有的样子：换一批玩家来打，d 基本不变。

【用法】
  python tools/irt_scores.py                 # 读 data/scores/matrix.jsonl
  python tools/irt_scores.py --min-players 5 # 只保留至少有 5 人打的谱
"""
import argparse
import json
import math
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "scores", "matrix.jsonl")


def load(min_players):
    by_chart = defaultdict(list)
    with open(SRC, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            by_chart[int(r["chart"])].append((int(r["player"]), float(r["acc"])))
    charts = {c: v for c, v in by_chart.items() if len(v) >= min_players}
    return charts


def sigmoid(x):
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def fit(charts, iters=60, lr=0.15, beta=6.0):
    """交替最小二乘：固定 d 估 θ，固定 θ 估 d。"""
    # 初始化：d 用「该谱平均 ACC 越低越难」的粗估；θ 全 0
    diffs = {}
    for c, obs in charts.items():
        diffs[c] = -sum(a for _, a in obs) / len(obs)      # 平均 ACC 高 → d 小
    thetas = defaultdict(float)

    rows = [(c, p, a) for c, obs in charts.items() for (p, a) in obs]

    for it in range(iters):
        # 1) 更新 θ（玩家能力）：只用他打过的谱
        grad = defaultdict(float)
        cnt = defaultdict(int)
        for c, p, a in rows:
            pred = sigmoid(beta * (thetas[p] - diffs[c]))
            grad[p] += (a - pred)
            cnt[p] += 1
        for p in grad:
            thetas[p] += lr * grad[p] / max(cnt[p], 1)
        # 2) 更新 d（谱面难度）：注意方向相反
        grad2 = defaultdict(float)
        cnt2 = defaultdict(int)
        for c, p, a in rows:
            pred = sigmoid(beta * (thetas[p] - diffs[c]))
            grad2[c] -= (a - pred)
            cnt2[c] += 1
        for c in grad2:
            diffs[c] += lr * grad2[c] / max(cnt2[c], 1)
        # 3) 居中，防止整体漂移（θ 均值归零）
        m = sum(thetas.values()) / max(len(thetas), 1)
        for p in thetas:
            thetas[p] -= m
        for c in diffs:
            diffs[c] -= m
        if it % 20 == 19:
            err = sum((a - sigmoid(beta * (thetas[p] - diffs[c]))) ** 2 for c, p, a in rows)
            print(f"    iter {it + 1:3d}  MSE {err / len(rows):.5f}")
    return diffs, thetas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-players", type=int, default=5)
    args = ap.parse_args()

    if not os.path.exists(SRC):
        print("没有矩阵文件：" + SRC)
        return
    charts = load(args.min_players)
    n_obs = sum(len(v) for v in charts.values())
    players = {p for v in charts.values() for p, _ in v}
    print(f"[irt] 谱面 {len(charts)} 张（≥{args.min_players} 人）、观测 {n_obs} 条、玩家 {len(players)}")

    diffs, thetas = fit(charts)

    # 把潜变量线性映射到"看起来像定数"的区间（只是报告口径，不改变排序）
    ds = sorted(diffs.values())
    lo, hi = ds[int(len(ds) * 0.02)], ds[int(len(ds) * 0.98)]
    span = (hi - lo) or 1
    scaled = {c: 8 + (v - lo) / span * 8 for c, v in diffs.items()}   # 映射到 8~16

    out = os.path.join(ROOT, "data", "scores", "chart_difficulty_irt.json")
    json.dump({
        "note": "IRT 反推的客观难度（只看玩家表现，不用任何声明定数）；scaled 只是报告口径",
        "raw": {str(c): round(v, 4) for c, v in diffs.items()},
        "scaled": {str(c): round(v, 2) for c, v in scaled.items()},
        "players": len(players),
        "observations": n_obs,
    }, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    top = sorted(scaled.items(), key=lambda kv: -kv[1])[:8]
    bot = sorted(scaled.items(), key=lambda kv: kv[1])[:8]
    print("\n  最难的 8 张（IRT 客观）:")
    for c, v in top:
        print(f"    {c}  {v:.2f}   ({len(charts[c])} 人)")
    print("  最易的 8 张:")
    for c, v in bot:
        print(f"    {c}  {v:.2f}   ({len(charts[c])} 人)")
    print(f"\n  输出：{out}")


if __name__ == "__main__":
    main()
