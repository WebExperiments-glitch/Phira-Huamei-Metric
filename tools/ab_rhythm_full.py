"""节奏时序特征：分组消融 + 三 seed 复核（带特征缓存）。

在 `ab_rhythm_feats.py` 的基础上补三件事，这是能不能上生产的分水岭：
  1. 特征缓存到 npz —— 否则每换一次切分都要重解析 6 分钟
  2. 分组消融 —— ① syncopation / ② burst_rest / ③ dens_slope 各自加一次
  3. 三个 seed —— 单切的 +0.027 不算数，要 3/3 都 CI 下界 > 0

用法：python tools/ab_rhythm_full.py 2500
"""
import glob
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chart_io
from build_seq_dataset import to_feats
from ab_rhythm_feats import new_feats

_spec = importlib.util.spec_from_file_location("abf", os.path.join(HERE, "ab-align-phiraiad.py"))
abf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(abf)

CACHE = "data/rhythm-feat-cache.npz"
SEEDS = [20261028, 12345, 777]
GROUPS = {"sync": slice(0, 4), "burst": slice(4, 8), "dens": slice(8, 12)}


def build(n):
    if os.path.exists(CACHE):
        c = np.load(CACHE, allow_pickle=True)
        print(f"复用缓存 {CACHE}（{len(c['ids'])} 张）", flush=True)
        return c["ids"], c["base"], c["new"], c["y"]
    z = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=True)
    ids = [str(x) for x in z["ids"]]
    y = np.asarray(z["y"], float)
    files = {os.path.basename(os.path.dirname(p)): p for p in glob.glob("data/charts/*/chart.*")}
    B, N, Y, K, miss = [], [], [], [], 0
    for k, cid in enumerate(ids[:n] if n else ids):
        p = files.get(cid)
        if not p:
            miss += 1
            continue
        try:
            ev = chart_io.load_events(p)
            if len(ev) < 20:
                miss += 1
                continue
            base = abf.pool(to_feats(ev))
            nf = new_feats(ev, p)
        except Exception:
            miss += 1
            continue
        B.append(base); N.append(nf); Y.append(y[k]); K.append(cid)
        if len(K) % 500 == 0:
            print(f"  {len(K)} 张…", flush=True)
    print(f"解析完成 {len(K)} 张（跳过 {miss}）", flush=True)
    ids, B, N, Y = np.array(K), np.stack(B), np.stack(N), np.array(Y)
    np.savez_compressed(CACHE, ids=ids, base=B, new=N, y=Y)
    return ids, B, N, Y


def run(base, new, y, seed):
    """返回 {名称: (rho, mae, pred, te)}。同一个 seed 下所有变体共用同一套切分。"""
    idx = np.random.RandomState(seed).permutation(len(y))
    cut = int(len(y) * 0.85)
    tr, te = idx[:cut], idx[cut:]
    out = {}
    variants = {"基线": base}
    for g, sl in GROUPS.items():
        variants["+" + g] = np.concatenate([base, new[:, sl]], 1)
    variants["+全部"] = np.concatenate([base, new], 1)
    for name, X in variants.items():
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
        Xs = np.clip((X - mu) / sd, -8, 8)
        ym = y[tr].mean()
        w = np.linalg.solve(Xs[tr].T @ Xs[tr] + 10.0 * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
        pred = Xs[te] @ w + ym
        out[name] = (abf.spearman(pred, y[te]), float(np.abs(pred - y[te]).mean()), pred, te)
    return out


def main(n):
    ids, base, new, y = build(n)
    print(f"样本 {len(y)} 张，基线 {base.shape[1]} 维 + 新 {new.shape[1]} 维\n", flush=True)

    all_res = {}
    for seed in SEEDS:
        r = run(base, new, y, seed)
        te = r["基线"][3]
        print(f"── seed {seed}（test n={len(te)}）", flush=True)
        for name, (rho, mae, _, _) in r.items():
            d = "" if name == "基线" else f"  Δρ={rho-r['基线'][0]:+.4f}"
            print(f"   {name:10s} ρ={rho:.4f}  MAE={mae:.4f}{d}", flush=True)
        for name in r:
            if name == "基线":
                continue
            lo, hi = abf.boot_ci(r["基线"][2], r[name][2], y[te], 1000)
            all_res.setdefault(name, []).append((r[name][0] - r["基线"][0], lo, hi))
            print(f"     {name:10s} 95%CI [{lo:+.4f}, {hi:+.4f}]  {'✓过' if lo > 0 else '✗跨0'}", flush=True)

    print("\n══ 三 seed 汇总 ══", flush=True)
    for name, v in all_res.items():
        ds = np.array([x[0] for x in v])
        ok = sum(1 for x in v if x[1] > 0)
        print(f"{name:10s} 平均 Δρ={ds.mean():+.4f}  sd={ds.std():.4f}  显著 {ok}/{len(v)}", flush=True)
    json.dump({k: [list(map(float, t)) for t in v] for k, v in all_res.items()},
              open("data/ab-rhythm-full.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("已写 data/ab-rhythm-full.json")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2500)
