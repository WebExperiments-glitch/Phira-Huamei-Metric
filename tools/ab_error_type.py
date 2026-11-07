"""决定性实验：我们的特征到底能看到「哪种难」。

两种失误来源：
    miss 率  根本没打到 → 物量 / 手法超纲
    good 率  打得到但差一点 → 判定窗口紧 / 读谱难

若特征能预测 miss 率、预测不了 good 率 → 证明我们只看到「物量」，
和「最高档 acc 只有 0.560」的发现互相印证。

全部走分组切分。特征用 data/base170-cache.npz（7,504 张，与基线同源）。
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from build_pairs_full import DT


def rank(x):
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort")
    sx = x[o]
    obs = np.r_[True, sx[1:] != sx[:-1], True]
    ix = np.flatnonzero(obs)
    avg = (ix[:-1] + ix[1:] - 1) / 2.0 + 1.0
    r = np.empty(len(x))
    r[o] = np.repeat(avg, np.diff(ix))
    return r


def rho(a, b):
    ra, rb = rank(a), rank(b)
    ra -= ra.mean(); rb -= rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def fit(X, y, tr, te, alpha=10.0):
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    ym = y[tr].mean()
    w = np.linalg.solve(Xs[tr].T @ Xs[tr] + alpha * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
    return Xs[te] @ w + ym


def main():
    d = np.memmap(os.path.join(ROOT, "data", "crawl", "pairs-full.bin"), dtype=DT, mode="r")
    print(f"读入 {len(d):,} 条", flush=True)
    p = d["player"].astype(np.int64)
    c = d["chart"].astype(np.int64)
    acc = d["acc"].astype(np.float32)
    notes = (d["perfect"] + d["good"] + d["bad"] + d["miss"]).astype(np.float32)
    good = d["good"].astype(np.float32)
    miss = d["miss"].astype(np.float32)
    fc = d["fc"].astype(np.float32)
    mcombo = d["max_combo"].astype(np.float32)

    ok = np.isfinite(acc) & (notes > 0) & (acc >= 0) & (acc <= 1.01)
    p, c, acc, notes, good, miss, fc, mcombo = p[ok], c[ok], acc[ok], notes[ok], good[ok], miss[ok], fc[ok], mcombo[ok]
    print(f"有效 {len(acc):,} 条", flush=True)

    # 去重：同一 (玩家, 谱) 只留 acc 最高的一条（其余字段跟着那条走）
    key = p * (c.max() + 1) + c
    o = np.lexsort((-acc, key))
    key, c, acc, notes, good, miss, fc, mcombo = (a[o] for a in (key, c, acc, notes, good, miss, fc, mcombo))
    first = np.r_[True, key[1:] != key[:-1]]
    c, acc, notes, good, miss, fc, mcombo = (a[first] for a in (c, acc, notes, good, miss, fc, mcombo))
    print(f"去重 {len(acc):,} 对（玩家×谱）", flush=True)

    # 每张谱在全体玩家上的失误构成
    uq, inv = np.unique(c, return_inverse=True)
    def agg(v):
        return np.bincount(inv, weights=v)
    N = agg(notes)
    G = agg(good) / np.maximum(N, 1)
    M = agg(miss) / np.maximum(N, 1)
    F = agg(fc) / np.maximum(np.bincount(inv), 1)
    MC = agg(mcombo) / np.maximum(N, 1)
    print(f"谱 {len(uq):,}", flush=True)

    # 与标签 b 对齐
    z = np.load(os.path.join(ROOT, "data", "seq-dataset-v0.1-beta.2.npz"), allow_pickle=True)
    ymap = {str(k): float(v) for k, v in zip(z["ids"], z["y"])}
    ids = [str(x) for x in uq]
    has = np.array([i in ymap for i in ids])
    print(f"其中在数据集内 {has.sum():,}")
    y = np.array([ymap[i] for i in np.array(ids)[has]])

    print("\n── 三种指标与 b 的相关（全体玩家） ──")
    for name, v in [("good 率", G), ("miss 率", M), ("FC 率", F), ("连击完成度", MC)]:
        print(f"  {name:10s} vs b : ρ = {rho(v[has], y):+.4f}")
    print(f"  good 率 vs miss 率 : ρ = {rho(G[has], M[has]):+.4f}  ← 若接近 0 说明是两个独立轴")

    # 特征对比：同一套特征预测不同目标
    b = np.load(os.path.join(ROOT, "data", "base170-cache.npz"), allow_pickle=True)
    fids = [str(x) for x in b["ids"]]
    fmap = {k: v for k, v in zip(fids, b["base"])}
    tgt = {"b（现役标签）": None, "good 率": G, "miss 率": M, "FC 率": F}
    idx = [i for i, k in enumerate(ids) if k in fmap]
    X = np.stack([fmap[ids[i]] for i in idx])
    print(f"\n特征对齐 {X.shape}")

    from group_split import group_ids, split
    gid = group_ids([ids[i] for i in idx])
    tr, te = split(gid)
    print(f"分组切分 训练 {len(tr)} 测试 {len(te)}")

    print("\n── 同一套特征，能预测哪一个 ──")
    for name, v in tgt.items():
        yy = y if v is None else v[has]
        # 注意：has 与 idx 都是「在数据集内」的谱，顺序一致
        pred = fit(X, yy, tr, te)
        print(f"  {name:14s} ρ = {rho(pred, yy[te]):.4f}")


if __name__ == "__main__":
    main()
