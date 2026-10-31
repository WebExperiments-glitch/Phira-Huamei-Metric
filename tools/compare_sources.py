#!/usr/bin/env python3
"""对比两种抓法的差别：按谱抓（这轮） vs 按 UID 扩散（旧数据）。

`pairs.bin` 的物理布局就是答案的一半：
  [0 : SPLIT)            这轮「按谱抓全」
  [SPLIT : 末尾)          旧的「按 UID 扩散」
所以不需要重新抓，切片即可。

要回答的问题不是"哪个多"，而是：
  **同一张谱，两种采样给出的难度估计一样吗？**
如果不一样，差在哪 —— 那是采样框（sampling frame）的问题，
直接影响 b 能不能当标度用。

判据：在两边的交集谱面上，比较各自独立拟合出的 b。
"""
import json
import math
import os

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
PAIRS = os.path.join(ROOT, "crawl", "pairs.bin")
SPLIT = 42_665_669          # 这轮「按谱抓」写在前面的三元组数
A0, EPS, LAM_T, LAM_B = 0.5, 1e-3, 3.0, 3.0


def logit(acc):
    u = np.clip((acc - A0) / (1.0 - A0), EPS, 1 - EPS)
    return np.log(u / (1 - u)).astype(np.float32)


def dedupe(p, c, a):
    o = np.lexsort((a, c, p))
    p, c, a = p[o], c[o], a[o]
    k = np.ones(p.size, bool)
    k[:-1] = (p[1:] != p[:-1]) | (c[1:] != c[:-1])
    return p[k], c[k], a[k]


def support(p, c, a, min_players=20, min_charts=5):
    for _ in range(3):
        cp = np.bincount(c)
        m = cp[c] >= min_players
        p, c, a = p[m], c[m], a[m]
        pc = np.bincount(p)
        m = pc[p] >= min_charts
        p, c, a = p[m], c[m], a[m]
    return p, c, a


def als(p, c, y, np_, nc, iters=40):
    th = np.zeros(np_)
    b = np.zeros(nc)
    cp = np.bincount(p, minlength=np_).astype(float)
    cc = np.bincount(c, minlength=nc).astype(float)
    for _ in range(iters):
        th = np.bincount(p, weights=(y + b[c]), minlength=np_) / (cp + LAM_T)
        b = np.bincount(c, weights=(th[p] - y), minlength=nc) / (cc + LAM_B)
    return th, b


def spearman(x, y):
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean()
    ry -= ry.mean()
    return float((rx * ry).sum() / math.sqrt((rx * rx).sum() * (ry * ry).sum()))


def load(sl):
    dt = np.dtype([("p", "<i4"), ("c", "<i4"), ("a", "<f4")])
    raw = np.fromfile(PAIRS, dtype=dt)
    seg = raw[sl]
    return seg["p"], seg["c"], seg["a"]


def describe(name, p, c, a):
    p, c, a = dedupe(p, c, a)
    n_pairs = p.size
    n_players = np.unique(p).size
    n_charts_all = np.unique(c).size
    p2, c2, a2 = support(p, c, a)
    cnt = np.bincount(np.unique(c2, return_inverse=True)[1])
    print(f"\n{name}")
    print(f"  对 {n_pairs:,} · 玩家 {n_players:,} · 谱面 {n_charts_all:,}"
          f"（其中 ≥20 人 {cnt.size:,} 张）")
    print(f"  每谱中位 {int(np.median(cnt)):,} 人 · p10 {int(np.percentile(cnt, 10)):,}"
          f" · p90 {int(np.percentile(cnt, 90)):,}")
    return p2, c2, a2, cnt


def main():
    print("── 同一条数据管线的两种采样框 ──")
    # A：按谱抓（这轮）
    pa, ca, aa = load(slice(0, SPLIT))
    pa, ca, aa, cntA = describe("A. 按谱抓（这轮）", pa, ca, aa)

    # B：按 UID 扩散（旧）
    pb, cb, ab = load(slice(SPLIT, None))
    pb, cb, ab, cntB = describe("B. 按 UID 扩散（旧）", pb, cb, ab)

    # 各自独立拟合
    print("\n各自独立拟合 IRT（同一套超参）…")
    def fit(p, c, a):
        up, pi = np.unique(p, return_inverse=True)
        uc, ci = np.unique(c, return_inverse=True)
        th, b = als(pi, ci, logit(a), up.size, uc.size)
        return dict(zip(uc.tolist(), b.tolist())), dict(zip(uc.tolist(), np.bincount(ci).tolist()))

    bA, nA = fit(pa, ca, aa)
    bB, nB = fit(pb, cb, ab)

    common = sorted(set(bA) & set(bB))
    print(f"交集谱面 {len(common):,} 张")
    if len(common) > 50:
        x = np.array([bA[k] for k in common])
        z = np.array([bB[k] for k in common])
        print(f"  两边 b 的 Spearman = {spearman(x, z):.4f}")
        d = x - z
        print(f"  b 差值：中位 {np.median(d):+.3f} · 标准差 {d.std():.3f}"
              f" · |差| > 0.5 的占 {100 * (np.abs(d) > 0.5).mean():.1f}%")

        # 支撑度低的那批谱，两边差多少 —— 这才是采样框的关键差异
        print("\n  按「旧数据的支撑度」分层（旧数据每谱人数）：")
        for lo, hi in [(20, 50), (50, 200), (200, 1000), (1000, 10 ** 9)]:
            sel = [k for k in common if lo <= nB.get(k, 0) < hi]
            if len(sel) < 30:
                continue
            xx = np.array([bA[k] for k in sel])
            zz = np.array([bB[k] for k in sel])
            dd = xx - zz
            print(f"    {lo:>5}–{hi if hi < 1e9 else '∞':>5} 人 · {len(sel):>4} 张 · "
                  f"ρ {spearman(xx, zz):.3f} · 差值 SD {dd.std():.3f}")

    # 覆盖面：这轮按谱抓的进度
    print(f"\n这轮按谱抓：{len(cntA):,} 张达标（≥20 人）；旧数据 {len(cntB):,} 张")
    onlyA = set(bA) - set(bB)
    onlyB = set(bB) - set(bA)
    print(f"只有这轮有的 {len(onlyA):,} 张 · 只有旧的 {len(onlyB):,} 张")


main()
