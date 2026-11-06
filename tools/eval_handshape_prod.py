#!/usr/bin/env python3
"""A_extent 256 维的**生产口径**评测。

四个模型，同一套切分、同一份测试集，逐对配对 bootstrap：

| 代号 | 定义 | 用途 |
|---|---|---|
| `v3` | 142 维 + α=10（**线上现役配方**，无裁剪） | 产品口径的「装之前/装之后」 |
| `base` | 142 维 + 训练集内 CV 选 α（无裁剪） | 与 `片段手型特征-A-B.md` 完全同口径的基线 |
| `base_clip` | 142 维 + CV 选 α + z 裁 ±8 | 排除"裁剪本身"的干扰 |
| `ext` | 142+256 维 + CV 选 α + z 裁 ±8 | 待上线的 v4 |

为什么有 `clip`：398 维里有十几列在某个训练集上近似常量，`sd + 1e-6`
会把 1e-4 的偏离放大到 z≈4,000。实测切分 12345 未裁剪时短谱预测 sd 5.2、
MAE 0.744（基线 0.529）。裁 z 到 ±8 后三个切分的短谱 ρ 全部更高、
MAE 全部更低。详见 `tools/ridge_clip.py`。

切分/口径与仓库其它实验一致：`permutation(seed)` 前 85% 训练；主指标短谱 ρ
（测试集事件 ≤925）；长谱 = ≥1327；配对 bootstrap 1,000 次只重采样测试集。

用法：python tools/eval_handshape_prod.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

from ab_handshape import Ridge, inner_alpha as inner_alpha_nc, paired_boot  # noqa: E402
from ridge_clip import RidgeClip, inner_alpha, spearman  # noqa: E402

SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
POOL = os.path.join(DATA, "seq-pooled-cache.npz")
EXT = os.path.join(DATA, "handshape-extent-v1.npz")
OUT = os.path.join(DATA, "handshape-prod-ridge.json")

SPLITS = [20261028, 12345, 777]
BOOT_SEED = 20261029
N_BOOT = 1000
SHORT_MAX, LONG_MIN = 925, 1327
V3_ALPHA = 10.0
REGIMES = ("v3", "base", "base_clip", "ext")


def mae(p, t):
    return float(np.abs(np.asarray(p) - np.asarray(t)).mean())


def run_split(P, E, y, lens, seed):
    n = len(y)
    perm = np.random.default_rng(seed).permutation(n)
    cut = int(n * 0.85)
    tr, te = perm[:cut], perm[cut:]
    short, long_ = lens[te] <= SHORT_MAX, lens[te] >= LONG_MIN
    ytr, yte = y[tr], y[te]

    Xb, Xe = P, np.concatenate([P, E], axis=1)
    a_nc, _ = inner_alpha_nc(Xb[tr], ytr, seed=seed)      # 不裁剪基线
    a_bc, _ = inner_alpha(Xb[tr], ytr, seed=seed)         # 裁剪基线
    a_ex, _ = inner_alpha(Xe[tr], ytr, seed=seed)         # 裁剪实验组
    alphas = {"v3": V3_ALPHA, "base": a_nc, "base_clip": a_bc, "ext": a_ex}

    preds = {
        "v3": Ridge(V3_ALPHA).fit(Xb[tr], ytr).predict(Xb[te]),
        "base": Ridge(a_nc).fit(Xb[tr], ytr).predict(Xb[te]),
        "base_clip": RidgeClip(a_bc).fit(Xb[tr], ytr).predict(Xb[te]),
        "ext": RidgeClip(a_ex).fit(Xe[tr], ytr).predict(Xe[te]),
    }

    rng = np.random.default_rng(BOOT_SEED)
    out = {"seed": seed, "n_test": int(len(te)),
           "n_short": int(short.sum()), "n_long": int(long_.sum()), "alphas": alphas}
    for tag, m in (("short", short), ("all", np.ones(len(te), bool)), ("long", long_)):
        blk = {k: {"rho": spearman(p[m], yte[m]), "mae": mae(p[m], yte[m])}
               for k, p in preds.items()}
        for ref in ("base", "base_clip", "v3"):
            blk["delta_vs_" + ref] = paired_boot(preds[ref][m], preds["ext"][m], yte[m],
                                                 rng, n_boot=N_BOOT)
        out[tag] = blk
    out["te"] = te.tolist()
    return out, preds, yte


def main():
    z = np.load(SEQ, allow_pickle=False)
    ids = [str(x) for x in z["ids"]]
    y = z["y"].astype(np.float64)
    lens = np.diff(z["offs"]).astype(np.int64)
    P = np.load(POOL, allow_pickle=False)["P"].astype(np.float64)
    e = np.load(EXT, allow_pickle=False)
    assert [str(k) for k in e["ids"]] == ids, "extent 缓存与数据集不同序"
    E = e["E"].astype(np.float64)

    print(f"谱面 {len(ids)} · 基线 {P.shape[1]} 维 · 新特征 {E.shape[1]} 维 "
          f"· 合计 {P.shape[1] + E.shape[1]} 维")

    res = {"n": len(ids), "n_dims_base": int(P.shape[1]), "n_dims_ext": int(E.shape[1]),
           "short_max": SHORT_MAX, "long_min": LONG_MIN, "v3_alpha": V3_ALPHA,
           "clip_z": 8.0, "splits": {}}
    keys = ("short", "all", "long")

    for s in SPLITS:
        r, preds, yte = run_split(P, E, y, lens, s)
        res["splits"][str(s)] = r
        np.savez_compressed(os.path.join(DATA, f"_prod-ridge-s{s}.npz"),
                            y=yte, te=np.array(r["te"]),
                            **{f"p_{k}": v for k, v in preds.items()})
        print(f"\n── 切分 {s} ── 测试 {r['n_test']}（短 {r['n_short']} / 长 {r['n_long']}）"
              f" · α {r['alphas']}")
        for tag in keys:
            b = r[tag]
            print(f"  {tag:5s} ρ  v3 {b['v3']['rho']:.4f} | base {b['base']['rho']:.4f} | "
                  f"base_clip {b['base_clip']['rho']:.4f} | ext {b['ext']['rho']:.4f}")
            for ref in ("base", "base_clip", "v3"):
                d = b["delta_vs_" + ref]
                print(f"        Δ vs {ref:<9s} {d['d_rho']:+.4f} "
                      f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}] 胜率 {d['p_win']:.1%}")
            print(f"        MAE {b['base']['mae']:.4f} → {b['ext']['mae']:.4f}")

    agg = {}
    for tag in keys:
        a = {}
        for k in REGIMES:
            v = np.array([res["splits"][str(s)][tag][k]["rho"] for s in SPLITS])
            a[k] = {"mean": float(v.mean()), "sd": float(v.std(ddof=1)), "each": v.tolist()}
        for ref in ("base", "base_clip", "v3"):
            d = np.array([res["splits"][str(s)][tag]["delta_vs_" + ref]["d_rho"]
                          for s in SPLITS])
            lo = np.array([res["splits"][str(s)][tag]["delta_vs_" + ref]["ci"][0]
                           for s in SPLITS])
            a["d_vs_" + ref] = {"mean": float(d.mean()), "sd": float(d.std(ddof=1)),
                                "each": d.tolist(), "n_sig": int((lo > 0).sum())}
        agg[tag] = a
    res["agg"] = agg

    print("\n三 seed 汇总")
    for tag in keys:
        a = agg[tag]
        print(f"  {tag:5s} v3 {a['v3']['mean']:.4f} | base {a['base']['mean']:.4f} | "
              f"base_clip {a['base_clip']['mean']:.4f} | ext {a['ext']['mean']:.4f} "
              f"(sd {a['ext']['sd']:.4f})")
        for ref in ("base", "base_clip", "v3"):
            d = a["d_vs_" + ref]
            print(f"        Δ vs {ref:<9s} {d['mean']:+.4f} sd {d['sd']:.4f} "
                  f"显著 {d['n_sig']}/3")

    json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
