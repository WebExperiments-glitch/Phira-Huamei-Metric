#!/usr/bin/env python3
"""序列模型预测的标量校准（只用 inner-val，不碰测试集）。

为什么需要：训练用 MSE、模型选择用 ρ。ρ 对单调变换不敏感，所以选出来的
epoch 可能整体尺度过窄（过拟合模型的预测会向均值收缩）。
实测 seed1 的 ρ 0.8294 但 MAE 0.4582 反而比岭回归 0.4416 差 ——
排序更好、数值更偏。

做法：在 inner-val 上拟合 a·p+b（最小二乘），把 a,b 带到测试集。
这是纯内样本拟合，不构成对测试集的泄漏；不改变 ρ。

用法：python tools/eval_seq_calib.py --seeds 1,2,3
"""
import argparse
import json
import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from train_seq_model import (ALPHA, DATA, INNER_FRAC, N_BOOT, SEED, BOOT_SEED,  # noqa: E402
                             SeqDiffNet, Ridge, build_pooled, mae, norm_stats,
                             paired_bootstrap, predict, spearman)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="1,2,3")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "seq-calib.json"))
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    torch.set_num_threads(14)
    z = np.load(DATA, allow_pickle=False)
    feats, offs, y = z["feats"], z["offs"], z["y"].astype(np.float64)
    n = len(y)
    perm = np.random.default_rng(SEED).permutation(n)
    cut = int(n * 0.85)
    tr_all, te = perm[:cut], perm[cut:]
    rin = np.random.default_rng(SEED + 1).permutation(len(tr_all))
    ni = int(len(tr_all) * INNER_FRAC)
    sel, tr = tr_all[rin[:ni]], tr_all[rin[ni:]]
    mu, sd = norm_stats(feats, offs, tr)

    P = build_pooled(feats, offs)
    ridge = Ridge(ALPHA).fit(P[tr], y[tr])
    p_ridge = ridge.predict(P[te])
    yt = y[te]
    print(f"岭回归 ρ {spearman(p_ridge, yt):.4f} · MAE {mae(p_ridge, yt):.4f}")

    preds, cals, rows = [], [], []
    for s in seeds:
        ck = torch.load(os.path.join(ROOT, "data", f"seq-model-s{s}.pt"),
                        map_location="cpu", weights_only=False)
        model = SeqDiffNet(d_in=feats.shape[1])
        model.load_state_dict(ck["model"])
        # 标准化统计量以 checkpoint 里存的为准（与训练时完全一致）
        m_ = ck["mu"].numpy() if "mu" in ck else mu
        s_ = ck["sd"].numpy() if "sd" in ck else sd
        p_in = predict(model, feats, offs, sel, m_, s_) * ck["ys"] + ck["ym"]
        p_te = predict(model, feats, offs, te, m_, s_) * ck["ys"] + ck["ym"]
        # 最小二乘标量校准：a = cov/var, b = ȳ − a·p̄
        a = float(np.cov(p_in, y[sel], bias=True)[0, 1] / np.var(p_in))
        b = float(y[sel].mean() - a * p_in.mean())
        p_cal = a * p_te + b
        row = {"seed": s, "a": a, "b": b,
               "rho": spearman(p_te, yt), "mae_raw": mae(p_te, yt),
               "mae_cal": mae(p_cal, yt),
               "inner_rho": spearman(p_in, y[sel]),
               "pred_std": float(p_te.std()), "gold_std": float(yt.std())}
        print(f"  seed{s}: a={a:.3f} b={b:+.3f} · ρ {row['rho']:.4f} · "
              f"MAE {row['mae_raw']:.4f} → 校准后 {row['mae_cal']:.4f} "
              f"· pred_std {row['pred_std']:.3f}（真值 {row['gold_std']:.3f}）")
        preds.append(p_te)
        cals.append(p_cal)
        rows.append(row)

    rhos = np.array([r["rho"] for r in rows])
    pm = np.mean(preds, 0)
    pcm = np.mean(cals, 0)
    boot_raw = paired_bootstrap(pm, p_ridge, yt, N_BOOT)
    boot_cal = paired_bootstrap(pcm, p_ridge, yt, N_BOOT)
    print(f"\n3 seed ρ：{rhos.round(4).tolist()} · 均值 {rhos.mean():.4f} · "
          f"sd {rhos.std(ddof=1):.4f}")
    print(f"配对（原尺度）：Δρ {boot_raw['d_rho']:+.4f} "
          f"[{boot_raw['ci_rho'][0]:+.4f}, {boot_raw['ci_rho'][1]:+.4f}] · "
          f"ΔMAE {boot_raw['d_mae']:+.4f} "
          f"[{boot_raw['ci_mae'][0]:+.4f}, {boot_raw['ci_mae'][1]:+.4f}]")
    print(f"配对（校准后）：Δρ {boot_cal['d_rho']:+.4f} "
          f"[{boot_cal['ci_rho'][0]:+.4f}, {boot_cal['ci_rho'][1]:+.4f}] · "
          f"ΔMAE {boot_cal['d_mae']:+.4f} "
          f"[{boot_cal['ci_mae'][0]:+.4f}, {boot_cal['ci_mae'][1]:+.4f}]")

    out = {"per_seed": rows, "rho_mean": float(rhos.mean()),
           "rho_sd": float(rhos.std(ddof=1)), "n_test": len(te),
           "ridge": {"rho": spearman(p_ridge, yt), "mae": mae(p_ridge, yt)},
           "paired_raw": boot_raw, "paired_cal": boot_cal,
           "preds": {"ridge": p_ridge.tolist(), "seq_raw": pm.tolist(),
                     "seq_cal": pcm.tolist(), "gold": yt.tolist(),
                     "ids": [str(i) for i in z["ids"][te]]}}
    json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
