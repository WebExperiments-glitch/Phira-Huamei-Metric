#!/usr/bin/env python3
"""短谱残差诊断：判断 ρ 低是「随机误差」还是「可修的系统偏差」。

只用已经产出的预测值（data/seq-model-result.json），不训练任何东西。

口径：
  残差 r = 预测 − 真实（b 尺度，1 个 b ≈ 1.12 定数）
  分组：测试集 1,126 张按事件数三分位 → 短 / 中 / 长（与主报告同一分组）
  显著性：bootstrap 1,000 次求均值 CI；另给 t 统计量
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from train_seq_model import SEED, spearman  # noqa: E402

DATA = os.path.join(ROOT, "data", "seq-dataset-v0.1-beta.2.npz")
RES = os.path.join(ROOT, "data", "seq-model-result.json")
OUT = os.path.join(ROOT, "data", "short-residual-diag.json")
N_BOOT = 1000
BOOT_SEED = 20261029


def skew(v):
    m = v.mean()
    s = v.std()
    return float(((v - m) ** 3).mean() / (s ** 3 + 1e-12))


def boot_mean_ci(v, n_boot=N_BOOT, seed=BOOT_SEED):
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(v), (n_boot, len(v)))
    m = v[idx].mean(1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def dist(v, label):
    lo, hi = boot_mean_ci(v)
    mu = float(v.mean())
    sd = float(v.std(ddof=1))
    t = mu / (sd / np.sqrt(len(v)) + 1e-12)
    return {"label": label, "n": int(len(v)), "mean": mu, "sd": sd, "skew": skew(v),
            "ci_mean": [lo, hi], "t": float(t),
            "p5": float(np.percentile(v, 5)), "p25": float(np.percentile(v, 25)),
            "p50": float(np.percentile(v, 50)), "p75": float(np.percentile(v, 75)),
            "p95": float(np.percentile(v, 95)),
            "frac_abs_gt_1": float((np.abs(v) > 1).mean())}


def ols(x, y):
    """y = a·x + b，返回 a, b, a 的标准误。"""
    xm = x - x.mean()
    ym = y - y.mean()
    a = float((xm * ym).sum() / (xm * xm).sum())
    b = float(y.mean() - a * x.mean())
    resid = y - (a * x + b)
    se = float(np.sqrt((resid ** 2).sum() / (len(x) - 2) / (xm * xm).sum()))
    return a, b, se


def main():
    z = np.load(DATA, allow_pickle=False)
    feats = z["feats"]           # ⚠ 必须先取出来：NpzFile 每次 __getitem__ 都重新解压整个数组
    y_all = z["y"].astype(np.float64)
    offs = z["offs"]
    declared = z["declared"].astype(np.float64)
    n_ev = np.diff(offs).astype(np.float64)          # 每谱事件数
    dt_sum = np.array([feats[offs[i]:offs[i + 1], 0].astype(np.float64).sum()
                       for i in range(len(y_all))])   # Σdt ≈ 时长（秒，单步截断 3s）

    r = json.load(open(RES, encoding="utf-8"))
    perm = np.random.default_rng(SEED).permutation(len(y_all))
    cut = int(len(y_all) * 0.85)
    te = perm[cut:]
    assert len(te) == r["n_test"]
    ids = [str(i) for i in z["ids"][te]]
    assert ids == r["preds"]["ids"], "测试集顺序与结果文件不一致"

    gold = np.array(r["preds"]["gold"])
    models = {"seq": np.array(r["preds"]["seq"]), "ridge": np.array(r["preds"]["ridge"])}
    ev, dur = n_ev[te], dt_sum[te]
    dec = declared[te]
    nps = ev / np.maximum(dur, 1e-6)

    q1, q2 = np.percentile(ev, [100 / 3, 200 / 3])
    groups = {"short": ev <= q1, "mid": (ev > q1) & (ev <= q2), "long": ev > q2}

    out = {"n_test": int(len(te)), "cuts_events": [float(q1), float(q2)],
           "declared_missing": int((dec <= 0).sum()), "models": {}}

    for mname, pred in models.items():
        res = pred - gold
        rec = {"overall": dist(res, "all"), "groups": {}, "resid_vs_events": {},
               "by_declared": {}, "shrink": {}, "short_split": {}}

        for gname, m in groups.items():
            rec["groups"][gname] = dist(res[m], gname)
            rec["groups"][gname]["rho"] = spearman(pred[m], gold[m])
            rec["groups"][gname]["ev_range"] = [int(ev[m].min()), int(ev[m].max())]
            rec["groups"][gname]["gold_mean"] = float(gold[m].mean())
            rec["groups"][gname]["pred_mean"] = float(pred[m].mean())

        # 残差 vs 事件数：分箱均值 + 线性斜率（对 log 事件数）
        x = np.log(ev)
        a, b, se = ols(x, res)
        rec["resid_vs_events"]["log_slope"] = {"a": a, "b": b, "se": se, "t": a / se}
        bins = np.percentile(ev, np.linspace(0, 100, 9))
        rows = []
        for k in range(8):
            m = (ev >= bins[k]) & (ev <= bins[k + 1] if k == 7 else ev < bins[k + 1])
            if m.sum() >= 20:
                rows.append({"n": int(m.sum()), "ev_mid": float(np.median(ev[m])),
                             "mean": float(res[m].mean()),
                             "ci": boot_mean_ci(res[m])})
        rec["resid_vs_events"]["bins"] = rows

        # 残差 vs 定数档位（declared 缺失的谱单列）
        tiers = {"<12": dec < 12, "12-15": (dec >= 12) & (dec <= 15), ">15": dec > 15,
                 "缺 declared": dec <= 0}
        for tname, m in tiers.items():
            if m.sum() >= 10:
                rec["by_declared"][tname] = dist(res[m], tname)
                rec["by_declared"][tname]["rho"] = spearman(pred[m], gold[m])

        # 向均值收缩：pred = a·gold + b，a<1 即收缩
        for gname, m in [("all", np.ones(len(te), bool))] + list(groups.items()):
            aa, bb, ss = ols(gold[m], pred[m])
            rec["shrink"][gname] = {"slope": aa, "intercept": bb, "se": ss,
                                    "n": int(m.sum()),
                                    "pred_sd": float(pred[m].std()),
                                    "gold_sd": float(gold[m].std())}

        # 短谱内部再二分：按每秒事件数 / 按时长
        ms = groups["short"]
        for fname, feat in (("nps", nps), ("duration", dur)):
            med = float(np.median(feat[ms]))
            hi = ms & (feat > med)
            lo = ms & (feat <= med)
            rec["short_split"][fname] = {
                "median": med,
                "hi": {**dist(res[hi], f"{fname}>中位"), "rho": spearman(pred[hi], gold[hi])},
                "lo": {**dist(res[lo], f"{fname}≤中位"), "rho": spearman(pred[lo], gold[lo])},
            }
        out["models"][mname] = rec

    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # ── 附加：分组的偏置差（短 − 长）与整体偏移分解 ──
    extra = {}
    for mname, pred in models.items():
        res = pred - gold
        rng = np.random.default_rng(BOOT_SEED)
        ids_short = np.where(groups["short"])[0]
        ids_long = np.where(groups["long"])[0]
        diffs = []
        for _ in range(N_BOOT):
            a_ = rng.choice(ids_short, len(ids_short), replace=True)
            b_ = rng.choice(ids_long, len(ids_long), replace=True)
            diffs.append(res[a_].mean() - res[b_].mean())
        diffs = np.array(diffs)
        # 收缩方向：按真实 b 的五分位看平均残差（向均值收缩 → 低分位为正、高分位为负）
        qs = np.percentile(gold, np.linspace(0, 100, 6))
        shrink_rows = []
        for k in range(5):
            m = (gold >= qs[k]) & (gold <= qs[k + 1] if k == 4 else gold < qs[k + 1])
            shrink_rows.append({"q": k + 1, "n": int(m.sum()),
                                "gold_mid": float(np.median(gold[m])),
                                "mean_resid": float(res[m].mean())})
        extra[mname] = {
            "short_minus_long": {"d": float(res[groups["short"]].mean()
                                            - res[groups["long"]].mean()),
                                 "ci": [float(np.percentile(diffs, 2.5)),
                                        float(np.percentile(diffs, 97.5))]},
            "global_mean": float(res.mean()),
            "group_dev_from_global": {g: float(res[m].mean() - res.mean())
                                      for g, m in groups.items()},
            "resid_by_gold_quintile": shrink_rows,
        }
    out["extra"] = extra
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # ── 打印 ──
    print(f"测试集 {len(te)} 张 · 分组切点（事件数）{q1:.0f} / {q2:.0f} · "
          f"declared 缺失 {(dec <= 0).sum()}")
    for mname in ("ridge", "seq"):
        rec = out["models"][mname]
        print(f"\n{'=' * 78}\n{mname.upper()}\n{'=' * 78}")
        print(f"{'组':6s} {'n':>5s} {'残差均值':>9s} {'95%CI':>20s} {'t':>6s} "
              f"{'sd':>6s} {'偏度':>6s} {'ρ':>6s}")
        for gname in ("short", "mid", "long", "all"):
            d = rec["groups"].get(gname) or rec["overall"]
            print(f"{gname:6s} {d['n']:5d} {d['mean']:+9.3f} "
                  f"[{d['ci_mean'][0]:+.3f},{d['ci_mean'][1]:+.3f}] {d['t']:6.2f} "
                  f"{d['sd']:6.3f} {d['skew']:+6.2f} {d.get('rho', float('nan')):6.3f}")
        print("\n分位数：")
        for gname in ("short", "mid", "long"):
            d = rec["groups"][gname]
            print(f"  {gname:5s} p5 {d['p5']:+.2f} p25 {d['p25']:+.2f} p50 {d['p50']:+.2f} "
                  f"p75 {d['p75']:+.2f} p95 {d['p95']:+.2f} · |r|>1 占 {d['frac_abs_gt_1']:.1%}")
        print(f"\n残差 ~ log(事件数)：斜率 {rec['resid_vs_events']['log_slope']['a']:+.4f} "
              f"± {rec['resid_vs_events']['log_slope']['se']:.4f} "
              f"(t {rec['resid_vs_events']['log_slope']['t']:+.2f})")
        for row in rec["resid_vs_events"]["bins"]:
            print(f"   事件≈{row['ev_mid']:6.0f} n={row['n']:4d} "
                  f"残差 {row['mean']:+.3f} [{row['ci'][0]:+.3f},{row['ci'][1]:+.3f}]")
        print("\n按定数档位：")
        for tname, d in rec["by_declared"].items():
            print(f"   {tname:10s} n={d['n']:4d} 残差 {d['mean']:+.3f} "
                  f"[{d['ci_mean'][0]:+.3f},{d['ci_mean'][1]:+.3f}] ρ {d['rho']:.3f}")
        print("\n收缩（pred = a·gold + b，a<1 即向均值收缩）：")
        for gname, d in rec["shrink"].items():
            print(f"   {gname:5s} a={d['slope']:.3f}±{d['se']:.3f} b={d['intercept']:+.3f} "
                  f"· pred_sd/gold_sd = {d['pred_sd'] / d['gold_sd']:.3f} (n={d['n']})")
        print("\n短谱内部二分：")
        for fname, d in rec["short_split"].items():
            print(f"   {fname:8s} 中位 {d['median']:.2f} | 高: n={d['hi']['n']} "
                  f"残差 {d['hi']['mean']:+.3f} ρ {d['hi']['rho']:.3f} | "
                  f"低: n={d['lo']['n']} 残差 {d['lo']['mean']:+.3f} ρ {d['lo']['rho']:.3f}")
        e = extra[mname]
        print(f"\n偏置检验：整体偏移 {e['global_mean']:+.3f} b；"
              f"各组相对整体 {({k: round(v,3) for k, v in e['group_dev_from_global'].items()})}")
        print(f"   短 − 长 残差均值差 = {e['short_minus_long']['d']:+.3f} "
              f"[{e['short_minus_long']['ci'][0]:+.3f}, {e['short_minus_long']['ci'][1]:+.3f}]")
        print("   按真实 b 五分位的平均残差（向均值收缩 → 低分位正、高分位负）：")
        for row in e["resid_by_gold_quintile"]:
            print(f"     Q{row['q']} n={row['n']:4d} b≈{row['gold_mid']:+.2f} "
                  f"残差 {row['mean_resid']:+.3f}")
    print(f"\n→ {OUT}")


if __name__ == "__main__":
    main()
