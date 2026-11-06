#!/usr/bin/env python3
"""把四个模型放到**同一张表**上：岭回归 / 序列模型 / 两者都用。

数据来源（全部是同一套外层切分 seed=20261028、同一份测试集）：
- `data/_prod-ridge-s20261028.npz` —— `eval_handshape_prod.py` 存的预测（v3 / base / base_clip / ext）
- `data/seq-model-baseline3.json` —— 142 维序列模型（3 seed 平均）
- `data/seq-model-hs3.json` —— 序列模型 + 256 维手型特征（3 seed 平均）

"两者都用" = **等权集成**：两路预测各自 z-score 后取平均，再乘回标签尺度。
这是最朴素的融合；如果连它都不比单路好，说明两路信息高度重合。

用法：python tools/combine_handshape_models.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

from ab_handshape import paired_boot  # noqa: E402
from ridge_clip import spearman  # noqa: E402

SHORT_MAX, LONG_MIN = 925, 1327
N_BOOT = 1000


def mae(p, t):
    return float(np.abs(np.asarray(p) - np.asarray(t)).mean())


def load_seq(path):
    d = json.load(open(path, encoding="utf-8"))
    return d, np.array(d["preds"]["seq"], dtype=np.float64), np.array(d["preds"]["gold"])


def zs(v):
    return (v - v.mean()) / (v.std() + 1e-9)


def main():
    z = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=False)
    lens = np.diff(z["offs"]).astype(np.int64)
    y_all = z["y"].astype(np.float64)

    r = np.load(os.path.join(DATA, "_prod-ridge-s20261028.npz"))
    te = r["te"]
    y = r["y"]
    p_v3, p_base, p_ext = r["p_v3"], r["p_base"], r["p_ext"]

    d_b, p_seq, gold_b = load_seq(os.path.join(DATA, "seq-model-baseline3.json"))
    d_h, p_hs, gold_h = load_seq(os.path.join(DATA, "seq-model-hs3.json"))

    assert np.allclose(gold_b, y) and np.allclose(gold_h, y), "测试集顺序不一致"
    assert len(p_seq) == len(p_hs) == len(y)

    p_ens = 0.5 * (zs(p_hs) + zs(p_ext))
    p_ens = p_ens * y.std() + y.mean()

    short = lens[te] <= SHORT_MAX
    long_ = lens[te] >= LONG_MIN
    masks = (("短", short), ("全", np.ones(len(y), bool)), ("长", long_))

    models = [("ridge-v3", p_v3), ("ridge-v4(142+256)", p_ext),
              ("seq", p_seq), ("seq+手型", p_hs), ("两者都用(等权)", p_ens)]

    print(f"测试 {len(y)}（短 {int(short.sum())} / 长 {int(long_.sum())}）")
    tab = {}
    for name, m in masks:
        print(f"\n[{name}]  n={int(m.sum())}")
        for k, p in models:
            print(f"  {k:<18s} ρ {spearman(p[m], y[m]):.4f} · MAE {mae(p[m], y[m]):.4f}")
            tab.setdefault(name, {})[k] = {"rho": spearman(p[m], y[m]),
                                           "mae": mae(p[m], y[m])}
        rng = np.random.default_rng(20261029)
        for k, p in models[1:]:
            d = paired_boot(p_v3[m], p[m], y[m], rng, n_boot=N_BOOT)
            tab[name][k]["d_vs_v3"] = d
            print(f"    Δ vs ridge-v3   {d['d_rho']:+.4f} "
                  f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}] 胜率 {d['p_win']:.1%}")
        d = paired_boot(p_ext[m], p_hs[m], y[m], rng, n_boot=N_BOOT)
        tab[name]["seq+手型"]["d_vs_ridge_v4"] = d
        print(f"    seq+手型 vs ridge-v4  {d['d_rho']:+.4f} "
              f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]")
        # 关键问题：序列模型自己加手型特征，涨了多少（与岭回归的 +0.05 比）
        d = paired_boot(p_seq[m], p_hs[m], y[m], rng, n_boot=N_BOOT)
        tab[name]["seq+手型"]["d_vs_seq"] = d
        print(f"    seq+手型 vs seq       {d['d_rho']:+.4f} "
              f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]")
        d = paired_boot(p_ext[m], p_ens[m], y[m], rng, n_boot=N_BOOT)
        tab[name]["两者都用(等权)"]["d_vs_ridge_v4"] = d
        print(f"    集成 vs ridge-v4      {d['d_rho']:+.4f} "
              f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]")
        d = paired_boot(p_hs[m], p_ens[m], y[m], rng, n_boot=N_BOOT)
        tab[name]["两者都用(等权)"]["d_vs_seq_hs"] = d
        print(f"    集成 vs seq+手型      {d['d_rho']:+.4f} "
              f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]")

    # 序列模型侧的 3 seed 方差（用每个 seed 的 ρ 而不是平均值）
    print("\n序列模型 3 seed 的 ρ（全量测试集）：")
    for tag, d in (("seq", d_b), ("seq+手型", d_h)):
        rh = [s["rho"] for s in d["seq"]["per_seed"]]
        print(f"  {tag:<10s} {[round(v, 4) for v in rh]} · 均值 {np.mean(rh):.4f} "
              f"· sd {np.std(rh, ddof=1):.4f} · 参数 {d['seq']['params']:,}")

    json.dump({"note": "同一测试集（seed 20261028）上的四模型对比；Δ 为配对 bootstrap 95% CI",
               "n_test": int(len(y)), "n_short": int(short.sum()), "n_long": int(long_.sum()),
               "table": tab,
               "seq_3seed": {"seq": [s["rho"] for s in d_b["seq"]["per_seed"]],
                             "seq_hs": [s["rho"] for s in d_h["seq"]["per_seed"]]}},
              open(os.path.join(DATA, "handshape-prod-final.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n→ data/handshape-prod-final.json")


if __name__ == "__main__":
    main()
