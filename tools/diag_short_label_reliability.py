#!/usr/bin/env python3
"""短谱的标签是不是更不可靠？—— 按谱长分组重算 split-half 信度。

━━━ 为什么要做这个 ━━━
短谱 ρ 低（0.72 vs 长谱 0.88）。两种解释：
  (a) 标注瓶颈 —— 短谱的 b 本身就估不准，ρ 的天花板低
  (b) 模型缺陷 —— 标签很准，是我们的特征/模型抓不住短谱的难度
两者对下一步的指示完全相反：(a) 无解，(b) 值得继续投入。

能分辨它们的数据只有一份：**同一把尺子量两次**。
把玩家随机劈成两半，各自独立估 b，看两半的 b 在短谱上是否更不一致。
  · 短谱的 split-half 相关明显更低 → 标注瓶颈成立
  · 三组都接近 1          → 标签没问题，短谱的低 ρ 是模型误差

口径与 `tools/irt_reliability.py` 的 A 实验完全一致（同 SEED、同 A0/EPS/LAM_B、
同 filter_support、同 ALS），只是把结果按谱长分组统计。

用法：python tools/diag_short_label_reliability.py
"""
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

PAIRS = os.path.join(ROOT, "data", "crawl", "pairs.bin")
CHARTS = os.path.join(ROOT, "data", "crawl", "charts.jsonl")
DATASET = os.path.join(ROOT, "data", "seq-dataset-v0.1-beta.2.npz")
OUT = os.path.join(ROOT, "data", "short-label-reliability.json")

A0, EPS, LAM_B, SEED = 0.5, 1e-3, 3.0, 20261026


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


def main():
    t0 = time.time()
    rng = np.random.default_rng(SEED)
    p, c, a = load_pairs()
    p, c, a = filter_support(p, c, a)
    y = logit_acc(a)
    up, pi = np.unique(p, return_inverse=True)
    uc, ci = np.unique(c, return_inverse=True)
    n_p, n_c = up.size, uc.size
    print(f"样本：{p.size:,} 对 · 玩家 {n_p:,} · 谱面 {n_c:,}（{time.time()-t0:.0f}s）", flush=True)

    theta, _ = als(pi, ci, y, n_p, n_c)
    print(f"全量拟合完成（{time.time()-t0:.0f}s）", flush=True)

    cache = os.path.join(ROOT, "data", "_halves.npz")
    halves = []
    if os.path.exists(cache):
        h = np.load(cache)
        halves = [{str(k): float(v) for k, v in zip(h[f"id{i}"], h[f"b{i}"])} for i in (0, 1)]
        print(f"复用分半缓存 {cache}", flush=True)
    else:
        half = rng.random(n_p) < 0.5
        for name, mask in (("半 1", half[pi]), ("半 2", ~half[pi])):
            sub_p, sub_c, sub_y = pi[mask], ci[mask], y[mask]
            up2, pi2 = np.unique(sub_p, return_inverse=True)
            uc2, ci2 = np.unique(sub_c, return_inverse=True)
            _, b2 = als(pi2, ci2, sub_y, up2.size, uc2.size)
            halves.append({str(int(cid)): float(b2[j]) for j, cid in enumerate(uc2)})
            print(f"  {name}: {sub_y.size:,} 对（{time.time()-t0:.0f}s）", flush=True)
        np.savez(cache,
                 id0=np.array(list(halves[0]), dtype=object).astype(str),
                 b0=np.array(list(halves[0].values())),
                 id1=np.array(list(halves[1]), dtype=object).astype(str),
                 b1=np.array(list(halves[1].values())))

    # 谱长：从我们自己的数据集拿（id → 事件数）
    z = np.load(DATASET, allow_pickle=False)
    ids = [str(i) for i in z["ids"]]
    ev = np.diff(z["offs"])
    length = dict(zip(ids, ev))            # 键统一成 str

    common = sorted(set(halves[0]) & set(halves[1]) & set(length))
    x = np.array([halves[0][k] for k in common])
    zz = np.array([halves[1][k] for k in common])
    n_ev = np.array([length[k] for k in common])
    print(f"\n两半共有、且能对上谱长的谱面：{len(common):,} 张", flush=True)

    q1, q2 = np.percentile(ev, [100 / 3, 200 / 3])   # 与主报告同一组切点
    groups = {"short": n_ev <= q1, "mid": (n_ev > q1) & (n_ev <= q2), "long": n_ev > q2}

    out = {"n_common": len(common), "cuts_events": [float(q1), float(q2)], "groups": {},
           "overall": {"n": len(common), "spearman": spearman(x, zz),
                       "pearson": float(np.corrcoef(x, zz)[0, 1])}}
    print(f"\n全体：Spearman {out['overall']['spearman']:.4f} · "
          f"Pearson {out['overall']['pearson']:.4f}（n={len(common):,}）")
    print(f"{'组':6s} {'n':>5s} {'Spearman':>9s} {'Pearson':>8s} {'观测差 sd':>10s} "
          f"{'两半 sd':>16s}")
    for gname, m in groups.items():
        sub_x, sub_z = x[m], zz[m]
        d = sub_x - sub_z
        out["groups"][gname] = {
            "n": int(m.sum()), "spearman": spearman(sub_x, sub_z),
            "pearson": float(np.corrcoef(sub_x, sub_z)[0, 1]),
            "diff_sd": float(d.std(ddof=1)),
            "sd_half1": float(sub_x.std(ddof=1)), "sd_half2": float(sub_z.std(ddof=1)),
            "ev_range": [int(n_ev[m].min()), int(n_ev[m].max())]}
        g = out["groups"][gname]
        print(f"{gname:6s} {g['n']:5d} {g['spearman']:9.4f} {g['pearson']:8.4f} "
              f"{g['diff_sd']:10.4f} {g['sd_half1']:7.3f} / {g['sd_half2']:6.3f}")

    # 测量误差的绝对量级：SEM ≈ sd(两半差)/√2 —— 直接是 b 尺度上的噪声
    for gname, g in out["groups"].items():
        g["sem"] = g["diff_sd"] / math.sqrt(2.0)
        print(f"  {gname}: 单次测量的标准误 SEM ≈ {g['sem']:.4f} b "
              f"（≈ {g['sem'] * 1.12:.3f} 定数）")

    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n→ {OUT}（{time.time()-t0:.0f}s）")


if __name__ == "__main__":
    main()
