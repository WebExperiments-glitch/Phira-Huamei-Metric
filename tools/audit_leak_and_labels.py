"""两件事：
  ① 泄漏审计：随机切分 vs 按内容哈希分组切分，看 ρ 被同谱重复虚高了多少
  ② 标签对比：用同一套特征，分别预测「标量 b」和「五档 acc 曲线」，看哪个更可学

为什么这两件事要一起做：
  ① 决定我们报出去的 0.8323 里有多少是假的
  ② 决定「换标签」这条路的收益上限

特征直接用 `data/rhythm-feat-cache.npz` 里的 base（170 维，20 维 × 7 统计 + 2），
不重算，避免又落入「重写已验证管线」的坑（AI-PITFALLS D4）。
"""
import glob
import hashlib
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def rankdata(x):
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort")
    sx = x[o]
    obs = np.r_[True, sx[1:] != sx[:-1], True]
    idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x))
    out[o] = np.repeat(avg, np.diff(idx))
    return out


def spearman(a, b):
    ra, rb = rankdata(a), rankdata(b)
    ra, rb = ra - ra.mean(), rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def fit(X, y, tr, te, alpha=10.0):
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    ym = y[tr].mean()
    w = np.linalg.solve(Xs[tr].T @ Xs[tr] + alpha * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
    return Xs[te] @ w + ym


def boot_rho(p, y, B=1000, seed=7):
    rng = np.random.RandomState(seed)
    n = len(y)
    return np.percentile([spearman(p[i], y[i]) for i in (rng.randint(0, n, n) for _ in range(B))], [2.5, 97.5])


def main():
    c = np.load("data/rhythm-feat-cache.npz", allow_pickle=True)
    ids = [str(x) for x in c["ids"]]
    X = c["base"]
    y_b = c["y"]
    print(f"特征 {X.shape}，谱 {len(ids)}")

    # ── ① 内容哈希分组 ──
    grp = {}
    for cid in ids:
        ps = glob.glob(f"data/charts/{cid}/chart.*")
        h = hashlib.md5(open(ps[0], "rb").read()).hexdigest()[:12] if ps else cid
        grp[cid] = h
    g = np.array([grp[i] for i in ids])
    uq, gid = np.unique(g, return_inverse=True)
    n_dup_groups = sum(1 for k in range(len(uq)) if (gid == k).sum() > 1)
    print(f"内容组 {len(uq)}，其中重复组 {n_dup_groups}，涉及谱 {sum((gid==k).sum() for k in range(len(uq)) if (gid==k).sum()>1)}")

    seed = 20261028
    # A：随机切分（现役做法）
    idx = np.random.RandomState(seed).permutation(len(ids))
    cut = int(len(ids) * 0.85)
    tr, te = idx[:cut], idx[cut:]
    p_a = fit(X, y_b, tr, te)
    rho_a = spearman(p_a, y_b[te])
    lo_a, hi_a = boot_rho(p_a, y_b[te])
    print(f"\nA 随机切分        ρ={rho_a:.4f}  95%CI [{lo_a:.4f}, {hi_a:.4f}]  test={len(te)}")

    # B：按内容组切分（同一份谱只落在一边）
    order = np.random.RandomState(seed).permutation(len(uq))
    cutg = int(len(uq) * 0.85)
    gtr, gte = set(order[:cutg]), set(order[cutg:])
    trb = np.array([i for i in range(len(ids)) if gid[i] in gtr])
    teb = np.array([i for i in range(len(ids)) if gid[i] in gte])
    p_b = fit(X, y_b, trb, teb)
    rho_b = spearman(p_b, y_b[teb])
    lo_b, hi_b = boot_rho(p_b, y_b[teb])
    print(f"B 按内容组切分    ρ={rho_b:.4f}  95%CI [{lo_b:.4f}, {hi_b:.4f}]  test={len(teb)}")
    print(f"→ 泄漏虚高 {rho_a-rho_b:+.4f}")

    # ── ② 标签对比 ──
    pc = np.load("data/passcurve-v1.npz", allow_pickle=True)
    pmap = {str(k): v for k, v in zip(pc["ids"], pc["curve"])}
    has = np.array([i in pmap for i in ids])
    print(f"\n有曲线的谱 {has.sum()}/{len(ids)}")

    Xi, yi = X[has], y_b[has]
    Ci = np.stack([pmap[i] for i in np.array(ids)[has]])
    ok = np.isfinite(Ci).all(1)
    Xi, yi, Ci = Xi[ok], yi[ok], Ci[ok]
    print(f"曲线完整 {len(yi)} 张")

    idx = np.random.RandomState(seed).permutation(len(yi))
    cut = int(len(yi) * 0.85)
    tr, te = idx[:cut], idx[cut:]

    print("\n目标对比（同一套特征、同一套切分）：")
    r_b = spearman(fit(Xi, yi, tr, te), yi[te])
    print(f"  标量 b                    ρ={r_b:.4f}")
    lvl = Ci.mean(1)               # 五档平均 acc：越难越低
    r_l = spearman(fit(Xi, lvl, tr, te), lvl[te])
    print(f"  曲线水平（五档均值 acc）   ρ={r_l:.4f}")
    for k, name in enumerate(["最低档", "低档", "中档", "高档", "最高档"]):
        r = spearman(fit(Xi, Ci[:, k], tr, te), Ci[te, k])
        print(f"  {name} acc                ρ={r:.4f}")

    # 曲线能否反推 b
    slope = Ci[:, -1] - Ci[:, 0]
    print(f"\n  斜率的独立信息：与 b 的相关 {spearman(slope[ok], yi):+.4f}")


if __name__ == "__main__":
    main()
