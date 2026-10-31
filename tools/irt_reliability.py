#!/usr/bin/env python3
"""玩家公式能不能当主标度？—— 测「测量可靠性」，不需要任何标签。

为什么这个问题必须单独回答：
  我们一直在用「声明定数」当标准答案算 R²，但已经实测出它约一半是噪声。
  拿一把坏尺子去量另一把尺子，量出来的 0.46 既不能证明新尺子差，
  也不能证明它好。所以换一个判据：**同一把尺子量两次，一致吗？**

三个实验：
  A. 分半信度：把玩家随机劈成两半，各自独立估 b，比较两边的 b。
     这是经典 psychometrics 的 split-half reliability，与标签无关。
  B. 冷启动曲线：每张谱只用 k 个玩家的记录估 b，看和全量 b 差多少。
     → 这直接给出「多少玩家以上就够用」，也就是能不能删 kNN 的阈值。
  C. 与声明定数的分歧分布：不是为了求 R²，而是看「哪些谱两把尺子差得远」，
     这是产品价值所在（看着难其实能打）。

近似说明：
  B 里 b 是用**全量估出的 θ** 反推的（b = mean(θ_i − y_ij)），不是每换一次 k 就重拟合整个模型。
  这在 IRT 里是标准做法（θ 的估计比 b 稳定得多，因为玩家样本远大于谱面样本），
  误差量级远小于我们要测的差距。
"""
import json
import math
import os
import sys

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
PAIRS = os.path.join(ROOT, "crawl", "pairs.bin")
CHARTS = os.path.join(ROOT, "crawl", "charts.jsonl")

A0 = 0.5
EPS = 1e-3
LAM_B = 3.0
SEED = 20261026


def logit_acc(acc):
    u = np.clip((acc - A0) / (1.0 - A0), EPS, 1.0 - EPS)
    return np.log(u / (1.0 - u)).astype(np.float32)


def load_pairs():
    dt = np.dtype([("p", "<i4"), ("c", "<i4"), ("a", "<f4")])
    raw = np.fromfile(PAIRS, dtype=dt)
    order = np.lexsort((raw["a"], raw["c"], raw["p"]))
    p, c, a = raw["p"][order], raw["c"][order], raw["a"][order]
    keep = np.ones(p.size, dtype=bool)
    keep[:-1] = (p[1:] != p[:-1]) | (c[1:] != c[:-1])
    return p[keep], c[keep], a[keep]


def filter_support(p, c, a, min_players=20, min_charts=5):
    for _ in range(3):
        cp = np.bincount(c)
        k = cp[c] >= min_players
        p, c, a = p[k], c[k], a[k]
        pc = np.bincount(p)
        k = pc[p] >= min_charts
        p, c, a = p[k], c[k], a[k]
    return p, c, a


def als(p, c, y, np_, nc, iters=40, lam_t=3.0, lam_b=LAM_B):
    theta = np.zeros(np_)
    bias = np.zeros(nc)
    cnt_p = np.bincount(p, minlength=np_).astype(float)
    cnt_c = np.bincount(c, minlength=nc).astype(float)
    for _ in range(iters):
        theta = np.bincount(p, weights=(y + bias[c]), minlength=np_) / (cnt_p + lam_t)
        bias = np.bincount(c, weights=(theta[p] - y), minlength=nc) / (cnt_c + lam_b)
    return theta, bias


def spearman(x, y):
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean()
    ry -= ry.mean()
    return float((rx * ry).sum() / math.sqrt((rx * rx).sum() * (ry * ry).sum()))


def r2_of(pred, true):
    return float(1 - ((true - pred) ** 2).sum() / ((true - true.mean()) ** 2).sum())


def main():
    rng = np.random.default_rng(SEED)
    p, c, a = load_pairs()
    p, c, a = filter_support(p, c, a)
    y = logit_acc(a)
    up, pi = np.unique(p, return_inverse=True)
    uc, ci = np.unique(c, return_inverse=True)
    n_p, n_c = up.size, uc.size
    print(f"样本：{p.size:,} 对 · 玩家 {n_p:,} · 谱面 {n_c:,}\n")

    theta, bias = als(pi, ci, y, n_p, n_c)
    print("全量拟合完成（b 标准差 %.3f）\n" % bias.std())

    # ── A. 分半信度：玩家随机劈两半，各自独立估 θ 和 b ──
    half = rng.random(n_p) < 0.5
    m1 = half[pi]
    res = []
    for name, mask in (("半 1", m1), ("半 2", ~m1)):
        sub_p, sub_c, sub_y = pi[mask], ci[mask], y[mask]
        up2, pi2 = np.unique(sub_p, return_inverse=True)
        uc2, ci2 = np.unique(sub_c, return_inverse=True)
        th2, b2 = als(pi2, ci2, sub_y, up2.size, uc2.size)
        res.append({int(cid): b2[j] for j, cid in enumerate(uc2)})
        print(f"  {name}: {sub_y.size:,} 对 · 玩家 {up2.size:,} · 谱面 {uc2.size:,}")
    common = sorted(set(res[0]) & set(res[1]))
    x = np.array([res[0][k] for k in common])
    z = np.array([res[1][k] for k in common])
    print(f"\n── A. 分半信度（{len(common):,} 张共有谱面）──")
    print(f"  Spearman ρ = {spearman(x, z):.4f}")
    print(f"  Pearson  r = {np.corrcoef(x, z)[0, 1]:.4f}")
    print(f"  两半各自的 b 标准差：{x.std():.3f} / {z.std():.3f}")

    # ── B. 冷启动：只用 k 个玩家估 b ──
    print("\n── B. 冷启动（每谱抽 k 个玩家，与全量 b 比）──")
    order = np.argsort(ci, kind="stable")
    c_sorted = ci[order]
    bounds = np.searchsorted(c_sorted, np.arange(n_c + 1))
    full_b = bias
    print("     k      张数     Spearman   与全量 b 的 RMSE")
    curve = []
    for k in (3, 5, 10, 20, 30, 50, 100, 300):
        est = np.full(n_c, np.nan)
        for j in range(n_c):
            lo, hi = bounds[j], bounds[j + 1]
            if hi - lo < k:
                continue
            idx = order[lo + rng.choice(hi - lo, size=k, replace=False)]
            # b_j = mean(θ_i − y_ij)，带同样的 L2 收缩
            est[j] = (theta[pi[idx]] - y[idx]).sum() / (k + LAM_B)
        ok = ~np.isnan(est)
        rho = spearman(est[ok], full_b[ok])
        rmse = float(np.sqrt(np.mean((est[ok] - full_b[ok]) ** 2)))
        print(f"  {k:>5}   {ok.sum():>6,}   {rho:.4f}     {rmse:.3f}")
        curve.append({"k": k, "n": int(ok.sum()), "spearman": round(rho, 4), "rmse": round(rmse, 4)})

    # ── C. 与声明定数的分歧 ──
    declared = {}
    with open(CHARTS, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = r.get("difficulty")
            if isinstance(d, (int, float)) and 1 <= d <= 20 and r.get("_division") in ("regular", "plain"):
                declared[r["id"]] = float(d)
    have = [(j, declared[cid]) for j, cid in enumerate(uc) if cid in declared]
    bj = np.array([bias[j] for j, _ in have])
    dj = np.array([d for _, d in have])
    k_, m_ = np.polyfit(bj, dj, 1)
    gap = dj - (k_ * bj + m_)
    print(f"\n── C. 与声明定数的分歧（{len(have):,} 张）──")
    print(f"  Spearman ρ = {spearman(bj, dj):.3f} · 线性校准后 R² = {r2_of(k_ * bj + m_, dj):.3f}")
    for t in (0.5, 0.8, 1.0, 1.5):
        n = int((np.abs(gap) > t).sum())
        print(f"  |玩家 − 声明| > {t:.1f} 级：{n:,} 张（{100 * n / len(have):.1f}%）")

    json.dump({"split_half": {"n": len(common), "spearman": round(spearman(x, z), 4)},
               "cold_start": curve,
               "disagree": {"spearman": round(spearman(bj, dj), 3),
                            "r2": round(r2_of(k_ * bj + m_, dj), 3),
                            "n": len(have)}},
              open(os.path.join(ROOT, "irt-reliability.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n写出 {os.path.join(ROOT, 'irt-reliability.json')}")


main()
