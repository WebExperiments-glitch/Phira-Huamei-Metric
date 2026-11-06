#!/usr/bin/env python3
"""导出 142 + 256 维的岭回归给网页引擎 → `phm-web/public/data/engine-v4.json`。

与 `export_engine_v3.py` 的关系：
- v3 = 20 维事件 → 142 维池化 → 岭回归（α=10，线上现役，**本脚本不动它**）
- v4 = 同 142 维 + A_extent 256 维 → 岭回归（α 由训练集内部 3 折 CV 选）

产物是**新文件**，不会覆盖 v3；`engine-v3.mjs` / `engine-v3.json` / `engine.js` 一个字不动。

写进 JSON 的东西：
  1. mu / sd / w / b（398 维，顺序 = [pooled142, extent256]）
  2. 256 维的逐维名字与提取规格的定位（详细公式见 `tools/handshape_spec.md`）
  3. 自检样本：若干张测试谱的 pooled142 + extent256 + 期望 b / 定数，供 JS 逐位对拍

用法：python tools/export_engine_v4.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

from ridge_clip import CLIP_Z, RidgeClip, inner_alpha, spearman  # noqa: E402

SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
POOL = os.path.join(DATA, "seq-pooled-cache.npz")
EXT = os.path.join(DATA, "handshape-extent-v1.npz")
OUT = os.path.join(ROOT, "phm-web", "public", "data", "engine-v4.json")

SEED = 20261028
V3_ALPHA = 10.0
B2D_SLOPE, B2D_INTER = 1.12, 15.99
SHORT_MAX, LONG_MIN = 925, 1327


def live_pooled(cid):
    """现场从谱面文件算 142 维池化（与 JS 对拍的基准，和 v3 完全同法）。"""
    from build_seq_dataset import events_of, to_feats
    p = os.path.join(DATA, "charts", cid)
    path = None
    for f in os.listdir(p):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            path = os.path.join(p, f)
            break
    a = to_feats(events_of(path))[:, :20].astype(np.float64)
    q = np.percentile(a, [10, 50, 90], axis=0)
    return np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                           q.ravel(), [len(a), a[:, 0].sum()]])


def live_extent(cid):
    from handshape_features import chart_features
    from build_seq_dataset import events_of
    p = os.path.join(DATA, "charts", cid)
    path = next(os.path.join(p, f) for f in os.listdir(p)
                if f.lower().endswith((".json", ".pgr", ".pec")))
    names, v = chart_features(events_of(path))
    idx = [i for i, nm in enumerate(names)
           if nm.split("|")[2] in set(EXTENT_METRICS)]
    return v[idx].astype(np.float64)


EXTENT_METRICS = ["bbox_area", "diag", "span_x", "span_y", "aspect", "path", "disp", "eff"]


def main():
    z = np.load(SEQ, allow_pickle=False)
    ids = [str(x) for x in z["ids"]]
    y = z["y"].astype(np.float64)
    lens = np.diff(z["offs"]).astype(np.int64)
    P = np.load(POOL, allow_pickle=False)["P"].astype(np.float64)
    e = np.load(EXT, allow_pickle=False)
    assert [str(k) for k in e["ids"]] == ids, "extent 缓存与数据集不同序"
    E = e["E"].astype(np.float64)
    names = [str(k) for k in e["names"]]
    X = np.concatenate([P, E], axis=1)

    n = len(ids)
    perm = np.random.default_rng(SEED).permutation(n)
    cut = int(n * 0.85)
    tr, te = perm[:cut], perm[cut:]
    alpha, cv_rho = inner_alpha(X[tr], y[tr], seed=SEED)
    m = RidgeClip(alpha).fit(X[tr], y[tr])
    pred = m.predict(X[te])

    short = lens[te] <= SHORT_MAX
    long_ = lens[te] >= LONG_MIN
    # 参照：现役 v3 配方（142 维、α=10、无裁剪）
    base = RidgeClip(V3_ALPHA, clip=1e9).fit(P[tr], y[tr]).predict(P[te])
    metrics = {
        "alpha": alpha, "inner_cv_rho": cv_rho,
        "rho_all": spearman(pred, y[te]),
        "rho_short": spearman(pred[short], y[te][short]),
        "rho_long": spearman(pred[long_], y[te][long_]),
        "base_rho_all": spearman(base, y[te]),
        "base_rho_short": spearman(base[short], y[te][short]),
        "base_rho_long": spearman(base[long_], y[te][long_]),
        "n_test": int(len(te)), "n_short": int(short.sum()), "n_long": int(long_.sum()),
    }
    print(f"训练 {len(tr)} 张 · α={alpha:g} · 测试 {len(te)}")
    print(f"  ρ 全 {metrics['base_rho_all']:.4f} → {metrics['rho_all']:.4f}")
    print(f"  ρ 短 {metrics['base_rho_short']:.4f} → {metrics['rho_short']:.4f}")
    print(f"  ρ 长 {metrics['base_rho_long']:.4f} → {metrics['rho_long']:.4f}")

    # 自检样本：取 5 张测试谱，现场重算 398 维（不读 npz），供 JS 对拍
    checks = []
    for c in [ids[i] for i in perm[cut:cut + 5]]:
        pv, ev = live_pooled(c), live_extent(c)
        v = np.concatenate([pv, ev])
        b = float(np.clip((v - m.mu) / m.sd, -CLIP_Z, CLIP_Z) @ m.w + m.b)
        checks.append({"id": c,
                       "pooled": [round(float(t), 6) for t in pv],
                       "extent": [round(float(t), 6) for t in ev],
                       "b": round(b, 6),
                       "ding": round(B2D_SLOPE * b + B2D_INTER, 4)})

    payload = {
        "note": ("v4 引擎：20 维事件序列特征 → 142 维池化 + A_extent 片段手型 256 维 → "
                 "岭回归 → IRT 难度 b → 定数映射。规格见 tools/handshape_spec.md"),
        "target": "irt-b",
        "alpha": alpha,
        "clip_z": CLIP_Z,
        "split": {"seed": SEED, "trim": 0.85, "n_train": int(len(tr))},
        "dims": int(X.shape[1]),
        "dims_pooled": int(P.shape[1]),
        "dims_handshape": int(E.shape[1]),
        "rho_vs_b": round(float(spearman(pred, y[te])), 4),
        "metrics": {k: (round(v, 4) if isinstance(v, float) else v)
                    for k, v in metrics.items()},
        "mu": [round(float(t), 8) for t in m.mu],
        "sd": [round(float(t), 8) for t in m.sd],
        "w": [round(float(t), 8) for t in m.w],
        "b": float(m.b),
        "b2d": {"slope": B2D_SLOPE, "inter": B2D_INTER},
        "handshape": {
            "spec": "tools/handshape_spec.md",
            "version": 1,
            "metrics": EXTENT_METRICS,
            "segments": ["n8", "n16", "t05", "t10"],
            "stats": ["mean", "std", "min", "max", "p10", "p50", "p90", "skew"],
            "index": "((segIdx*8 + statIdx)*8 + metricIdx)；metricIdx 按 metrics 的顺序",
            "names": names,
        },
        "checks": checks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"写出 {OUT}（{os.path.getsize(OUT) / 1024:.0f} KB）")
    for c in checks:
        print(f"  自检 {c['id']}: b={c['b']:.4f} → 定数 {c['ding']:.2f}")


if __name__ == "__main__":
    main()
