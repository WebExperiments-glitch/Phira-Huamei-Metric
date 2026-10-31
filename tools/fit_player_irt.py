#!/usr/bin/env python3
"""玩家公式：用 IRT 从成绩反推谱面难度（不依赖 kNN、不用谱面特征）。

━━━ 为什么换这条路 ━━━
现有引擎（37 维特征 + kNN / 岭回归 / GBDT）R² 都卡在 0.46。
原因不是模型不行：**监督信号是谱师自己标的定数**，而我们已经实测出
「声明定数里约一半是噪声」（同一谱两把尺子差 0.8 以上的屡见不鲜）。
标签一半是噪声时，任何回归器的天花板都在 0.5 附近。

kNN 还有两个独立的问题：
  1. 它输出的是「跟参照集里哪几张像」→ 本质是社区共识，不是难度本身；
  2. 新谱没有近邻就没有数，泛化靠「参照集够不够密」。

IRT（项目反应理论）换的是**观测量**，不是模型：
  每个玩家有一个水平 θ，每张谱有一个难度 b，
  玩家 i 打谱 j 的准确率由 (θ_i − b_j) 决定。
  → 拟合出 b_j，就是「这张谱客观上需要多高水平的玩家才打得好」。
  → 玩家的水平被**联立估计**掉了，所以强玩家打简单谱不会被误当成「谱难」。

━━━ 模型 ━━━
    y_ij = logit( (acc − A0) / (1 − A0) ) ≈ θ_i − b_j + ε
    （A0 是「基准准确率」，低于它按地板处理，默认 0.5）
用交替最小二乘（ALS）解：固定 b 解 θ，固定 θ 解 b，闭式更新，带 L2 收缩。
**没有超参数搜索**，只有两个正则系数和支撑度阈值，全部可解释。

━━━ 评估 ━━━
按谱面切分（不是按记录切）：test 里的谱在训练时**完全不参与**校准系数拟合，
但它的 b 是 IRT 用该谱的玩家记录估出来的 —— 这正是「新谱怎么办」的真实场景。
指标：R² / RMSE / Spearman（对声明定数），并给「冷启动」曲线：
每个谱只有 k 个玩家时，R² 是多少。
"""
import argparse
import json
import math
import os
import time

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
PAIRS = os.path.join(ROOT, "crawl", "pairs.bin")
CHARTS = os.path.join(ROOT, "crawl", "charts.jsonl")
OUT = os.path.join(ROOT, "player-irt.json")

A0 = 0.5          # 基准准确率：低于它当作「完全不会」
EPS = 1e-3
LAM_T = 3.0       # 玩家水平正则（收缩到 0，避免只打一张谱的玩家爆掉）
LAM_B = 3.0       # 谱面难度正则
ITERS = 40


def logit_acc(acc, a0=None):
    a0 = A0 if a0 is None else a0
    u = np.clip((acc - a0) / (1.0 - a0), EPS, 1.0 - EPS)
    return np.log(u / (1.0 - u)).astype(np.float32)


def load_pairs():
    """读紧凑三元组，去重成「每人每谱最好成绩」。"""
    dt = np.dtype([("p", "<i4"), ("c", "<i4"), ("a", "<f4")])
    raw = np.fromfile(PAIRS, dtype=dt)
    print(f"原始三元组 {raw.size:,}")
    # 按 (p, c, a) 排序后，每组 (p,c) 的最后一条就是最高 acc
    order = np.lexsort((raw["a"], raw["c"], raw["p"]))
    p = raw["p"][order]
    c = raw["c"][order]
    a = raw["a"][order]
    keep = np.ones(p.size, dtype=bool)
    keep[:-1] = (p[1:] != p[:-1]) | (c[1:] != c[:-1])
    p, c, a = p[keep], c[keep], a[keep]
    print(f"去重后（每人每谱最好）{p.size:,}")
    return p, c, a


def filter_support(p, c, a, min_players, min_charts):
    """反复过滤：谱面玩家数不够 → 去掉；玩家打过的谱不够 → 再去掉。"""
    for _ in range(3):
        cp = np.bincount(c)
        keep = cp[c] >= min_players
        p, c, a = p[keep], c[keep], a[keep]
        pc = np.bincount(p)
        keep = pc[p] >= min_charts
        p, c, a = p[keep], c[keep], a[keep]
    return p, c, a


def als(p, c, a, n_players, n_charts, iters=ITERS, a0=None):
    """y ≈ θ_p − b_c。两边都带 L2 收缩，交替闭式解。"""
    y = logit_acc(a, a0)
    theta = np.zeros(n_players, dtype=np.float64)
    bias = np.zeros(n_charts, dtype=np.float64)
    cnt_p = np.bincount(p, minlength=n_players).astype(np.float64)
    cnt_c = np.bincount(c, minlength=n_charts).astype(np.float64)

    # 预排序的索引，让每次更新都是一次 bincount（不写 Python 循环）
    for it in range(iters):
        # θ_i = Σ_j (y_ij + b_j) / (n_i + λ)
        s = np.bincount(p, weights=(y + bias[c]), minlength=n_players)
        theta = s / (cnt_p + LAM_T)
        # b_j = Σ_i (θ_i − y_ij) / (m_j + λ)
        s2 = np.bincount(c, weights=(theta[p] - y), minlength=n_charts)
        bias = s2 / (cnt_c + LAM_B)
        if it % 10 == 9:
            pred = theta[p] - bias[c]
            mse = float(np.mean((pred - y) ** 2))
            print(f"  iter {it + 1:2d}  MSE {mse:.4f}")
    pred = theta[p] - bias[c]
    return theta, bias, float(np.mean((pred - y) ** 2)), y


def spearman(x, y):
    rx = np.argsort(np.argsort(x))
    ry = np.argsort(np.argsort(y))
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    return float((rx * ry).sum() / math.sqrt((rx * rx).sum() * (ry * ry).sum()))


def load_declared():
    """声明定数。只取 regular / plain，且定数在合理区间 —— troll/visual 的
    difficulty 中位数正常但均值上百（谱师当玩梗写），会污染评估。"""
    out = {}
    with open(CHARTS, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = r.get("difficulty")
            if not isinstance(d, (int, float)):
                continue
            if r.get("_division") not in ("regular", "plain"):
                continue
            if not (1.0 <= d <= 20.0):
                continue
            out[r["id"]] = float(d)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-players", type=int, default=20)
    ap.add_argument("--min-charts", type=int, default=5)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--a0", type=float, default=A0)
    a = ap.parse_args()

    t0 = time.time()
    p, c, acc = load_pairs()
    p, c, acc = filter_support(p, c, acc, a.min_players, a.min_charts)
    print(f"过滤后 {p.size:,} 对（谱面 ≥{a.min_players} 人、玩家 ≥{a.min_charts} 谱）")

    up, pi = np.unique(p, return_inverse=True)
    uc, ci = np.unique(c, return_inverse=True)
    print(f"玩家 {up.size:,} · 谱面 {uc.size:,}")

    theta, bias, mse, y = als(pi, ci, acc, up.size, uc.size, a0=a.a0)
    print(f"拟合完成 MSE {mse:.4f}（y 的方差 {y.var():.3f}）· {time.time() - t0:.0f}s")

    declared = load_declared()
    have = np.array([cid in declared for cid in uc])
    d = np.array([declared.get(cid, np.nan) for cid in uc])
    print(f"有声明定数且样本够的谱面 {have.sum():,} / {uc.size:,}")

    # 按谱面切分：test 的谱在拟合校准系数时完全不出场
    rng = np.random.default_rng(20261026)
    idx = np.where(have)[0]
    rng.shuffle(idx)
    cut = int(len(idx) * 0.8)
    tr, te = idx[:cut], idx[cut:]

    # 线性校准 b → 定数（只有斜率截距两个参数）
    k, m = np.polyfit(bias[tr], d[tr], 1)
    pred = k * bias[te] + m
    resid = d[te] - pred
    ss = ((d[te] - d[te].mean()) ** 2).sum()
    r2 = 1 - (resid ** 2).sum() / ss
    rmse = float(np.sqrt((resid ** 2).mean()))
    rho = spearman(bias[te], d[te])
    print("\n──── 结果（test 谱面 %d 张）────" % len(te))
    print(f"  R²       {r2:.3f}")
    print(f"  RMSE     {rmse:.3f} 级")
    print(f"  Spearman {rho:.3f}")
    # 范围修正：我们只拿到高播放量的一小撮谱，定数分布被压窄 → R² 系统性偏低。
    # 用全站定数标准差做 Thorndike 修正，给出「抓全之后大概会是多少」。
    sd_all = float(np.std([v for v in declared.values()]))
    sd_our = float(np.std(d[have]))
    u = sd_all / max(sd_our, 1e-6)
    r_corr = rho * u / math.sqrt(1 + rho * rho * (u * u - 1))
    print(f"  范围修正   SD {sd_our:.2f} → 全站 {sd_all:.2f}，"
          f"ρ 修正为 {r_corr:.3f} · R² 约 {r_corr ** 2:.3f}")
    print(f"            （修正只说明偏差方向，不作为最终结论 —— 等抓全再跑）")
    print(f"  校准式   定数 = {k:.3f} × b + {m:.3f}")

    # 冷启动：只有 k 个玩家时还准不准（这才是「泛化」的真实问题）
    cnt = np.bincount(ci, minlength=uc.size)
    print("\n──── 冷启动（每谱玩家数 vs R²）────")
    curve = []
    for lo, hi in [(20, 30), (30, 50), (50, 100), (100, 300), (300, 10 ** 9)]:
        sel = [j for j in te if lo <= cnt[j] < hi]
        if len(sel) < 15:
            continue
        pr = k * bias[sel] + m
        r = 1 - ((d[sel] - pr) ** 2).sum() / ((d[sel] - d[sel].mean()) ** 2).sum()
        print(f"  {lo:>4}–{hi if hi < 1e9 else '∞':>4} 人 · {len(sel):>4} 张 · R² {r:.3f}")
        curve.append({"lo": lo, "hi": None if hi >= 1e9 else hi, "n": len(sel), "r2": round(float(r), 4)})

    # 落盘：给每张谱一个 b 和它的支撑度
    charts_out = {}
    for j, cid in enumerate(uc):
        charts_out[str(cid)] = {
            "b": round(float(bias[j]), 4),
            "players": int(cnt[j]),
            "declared": declared.get(cid),
        }
    json.dump({
        "fitted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "pairs": int(p.size),
        "players": int(up.size),
        "charts": int(uc.size),
        "calib": {"k": float(k), "m": float(m)},
        "metrics": {"r2": round(float(r2), 4), "rmse": round(rmse, 4),
                    "spearman": round(rho, 4), "n_test": int(len(te))},
        "cold_start": curve,
        "items": charts_out,
    }, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"\n写出 {a.out}（{uc.size:,} 张谱）")


if __name__ == "__main__":
    main()
