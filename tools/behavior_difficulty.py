#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
behavior_difficulty.py —— 从玩家行为反推谱面难度（双向固定效应）

【为什么要这个，不用 IRT】
  先试过两参数 IRT（响应变量 = ACC），Spearman 只有 **0.30**；
  而直接用「每谱平均 std」是 0.41。模型还不如朴素统计 ——
  因为 ACC 在 0.95 以上就饱和了，模型的方差信息全丢。

  换成 **log(std)（击打时间偏差）做双向固定效应**，Spearman 到 **0.66**。

       log(std_ij) = μ + α_i（玩家差） + β_j（谱面难） + ε

  std 是连续量：满分谱上 std 0.012 与 0.030 的差别就是真实水平差。
  交替更新 α 与 β（每轮去均值），收敛即可。

【为什么之前失败、现在成功：连通性】
  之前从「每谱前 30 名」取玩家 → 各谱的玩家几乎不重叠 → 矩阵是碎的，
  α（玩家水平）估不出来，β（谱面难度）就全是噪声。

  改成**从 uid=2 顺序穷举**之后，一个玩家打过的 10~20 张谱被连成一片，
  9,000 个玩家 × 60,000 条观测把矩阵接上了 —— 这才是 IRT/固定效应生效的前提。

【用法】
  python tools/behavior_difficulty.py
  python tools/behavior_difficulty.py --min-players 10
"""
import argparse
import json
import math
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "scores", "matrix.jsonl")
COMM = os.path.join(ROOT, "data", "community.jsonl")
OUT = os.path.join(ROOT, "data", "scores", "chart_difficulty_behavior.json")


def load_obs():
    """每人每谱取**最小 std** —— 那是他的最好一次。
    ⚠ 不取平均：一个玩家打崩的几次会把谱面难度算高，而"打崩"更多反映
       当天状态，不反映谱面。取最好一次更接近"这个水平的人能做到什么"。"""
    best = {}
    with open(SRC, encoding="utf-8") as f:
        for line in f:
            # ⚠ 抓取可能正在同时写这个文件：偶尔会读到半行。
            #   跳过就好 —— 一条坏行不该让整个分析挂掉。
            try:
                r = json.loads(line)
            except Exception:
                continue
            s = r.get("std")
            if s is None or s <= 0:
                continue
            k = (int(r["chart"]), int(r["player"]))
            if k not in best or s < best[k]:
                best[k] = float(s)
    obs = [(c, p, math.log(s)) for (c, p), s in best.items()]

    # ⚠ 剔掉「只有 1 条记录」的玩家。
    #   他们没法估出 α（玩家水平），噪声会整个漏进 β。
    #   实测：不过滤 Spearman 0.641，过滤后 **0.695**，而且覆盖不变（3,222 张）。
    #   这是纯赚 —— 少 2 万个没用的人，结果更准。
    per_player = defaultdict(set)
    for c, p, _ in obs:
        per_player[p].add(c)
    keep = {p for p, cs in per_player.items() if len(cs) >= 2}
    obs = [o for o in obs if o[1] in keep]
    return obs


def fit_two_way(obs, iters=80, min_chart=3, min_player=2):
    charts = sorted({c for c, _, _ in obs})
    players = sorted({p for _, p, _ in obs})
    beta = {c: 0.0 for c in charts}
    alpha = {p: 0.0 for p in players}
    mu = sum(o[2] for o in obs) / len(obs)

    for _ in range(iters):
        acc = defaultdict(float); cnt = defaultdict(int)
        for c, p, y in obs:
            acc[c] += y - mu - alpha[p]; cnt[c] += 1
        for c in charts:
            if cnt[c] >= min_chart:
                beta[c] = acc[c] / cnt[c]

        acc = defaultdict(float); cnt = defaultdict(int)
        for c, p, y in obs:
            acc[p] += y - mu - beta[c]; cnt[p] += 1
        for p in players:
            if cnt[p] >= min_player:
                alpha[p] = acc[p] / cnt[p]

        m = sum(beta.values()) / len(charts)
        mu += m
        for c in charts:
            beta[c] -= m
    return beta, alpha, mu


def spearman(a, b):
    def rk(xs):
        idx = sorted(range(len(xs)), key=lambda i: xs[i])
        o = [0] * len(xs)
        for j, i in enumerate(idx):
            o[i] = j + 1
        return o
    ra, rb = rk(a), rk(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    n = sum((ra[i] - ma) * (rb[i] - mb) for i in range(len(a)))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra)) * math.sqrt(sum((x - mb) ** 2 for x in rb))
    return n / den if den else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-players", type=int, default=10)
    args = ap.parse_args()

    if not os.path.exists(SRC):
        print("没有 " + SRC + "，先跑 crawl_player_scores.py --scan")
        return
    obs = load_obs()
    print("[behavior] 观测 %d 条（每人每谱取最小 std）" % len(obs))

    beta, alpha, mu = fit_two_way(obs)

    cnt = defaultdict(int)
    for c, _, _ in obs:
        cnt[c] += 1
    rows = {}
    with open(COMM, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = r.get("difficulty")
            if isinstance(d, (int, float)) and 0 < d <= 19.5:
                rows[int(r["id"])] = float(d)

    pairs = [(beta[c], rows[c], c, cnt[c]) for c in beta
             if c in rows and cnt[c] >= args.min_players]
    print("[behavior] 可用谱面 %d 张（≥%d 人），玩家 %d" % (len(pairs), args.min_players, len(alpha)))
    if pairs:
        print("  与谱师声明定数的 Spearman = %.3f" % spearman(
            [p[0] for p in pairs], [p[1] for p in pairs]))

        # 缩放到"像定数"的区间（只是报告口径，不改变排序）
        bs = sorted(p[0] for p in pairs)
        lo, hi = bs[int(len(bs) * 0.02)], bs[int(len(bs) * 0.98)]
        span = (hi - lo) or 1
        scaled = {c: round(8 + (b - lo) / span * 8, 2) for b, _, c, _ in pairs}

        json.dump({
            "note": "从玩家击打时间偏差(log std)双向固定效应反推的难度；scaled 只是报告口径",
            "raw": {str(c): round(b, 4) for b, _, c, _ in pairs},
            "scaled": scaled,
            "observations": len(obs),
            "players": len(alpha),
            "spearman_vs_declared": round(spearman([p[0] for p in pairs], [p[1] for p in pairs]), 4),
        }, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

        top = sorted(pairs, key=lambda x: -x[0])[:6]
        bot = sorted(pairs, key=lambda x: x[0])[:6]
        print("\n  行为上最难：")
        for b, d, c, n in top:
            print("    %-7s 声明 %4.1f   %d 人" % (c, d, n))
        print("  行为上最易：")
        for b, d, c, n in bot:
            print("    %-7s 声明 %4.1f   %d 人" % (c, d, n))
        print("\n  输出：%s" % OUT)


if __name__ == "__main__":
    main()
