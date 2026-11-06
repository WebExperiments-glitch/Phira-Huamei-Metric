#!/usr/bin/env python3
"""屏幕坐标特征 A/B：20 维（线上现役）vs 24 维（追加 4 维判定线世界坐标）。

━━━ 口径 ━━━
- 基线 20 维 = `to_feats` 的第 0-19 列（与 beta.2 数据集、线上 v3 权重同源）。
- 实验 24 维 = 同样 20 列 + 第 24-27 列（hit_x / anchor_dx_015 / line_speed /
  line_rot_speed，见 `line_geometry.py`）。
- 两者池化方式完全相同（mean/std/min/max/p10/p50/p90 + 事件数 + Σdt），
  所以是 142 维 vs 170 维。
- 切分：`np.random.default_rng(20261028).permutation(n)`，前 85% 训练。
- 岭回归 alpha=10（与 `export_engine_v3.py` 一致）。
- 配对 bootstrap 1000 次**只重采样测试集**（模型固定），报 Δρ / ΔMAE 的 95% CI。

用法：
    python tools/ab_screen_coords.py --n 1500 --workers 12   # 子集
    python tools/ab_screen_coords.py --n 0 --workers 12      # 全量
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
CHARTS = os.path.join(DATA, "charts")
SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
CACHE = os.path.join(DATA, "ab-screen-cache.npz")
SEED = 20261028
ALPHA = 10.0
N_BOOT = 1000
BOOT_SEED = 20261029
DIM_BASE = 20
NEW_COLS = [24, 25, 26, 27]
NEW_NAMES = ["hit_x", "anchor_dx_015", "line_speed", "line_rot_speed"]


# ────────────────────────── 指标 ──────────────────────────
def rankdata(x):
    """平均秩（与 scipy.stats.rankdata 的 'average' 一致），纯 numpy 实现。"""
    x = np.asarray(x, dtype=np.float64)
    order = np.argsort(x, kind="mergesort")
    sx = x[order]
    obs = np.r_[True, sx[1:] != sx[:-1], True]
    idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x), dtype=np.float64)
    out[order] = np.repeat(avg, np.diff(idx))
    return out


def spearman(a, b):
    ra, rb = rankdata(a), rankdata(b)
    ra = ra - ra.mean()
    rb = rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def mae(pred, truth):
    return float(np.abs(np.asarray(pred) - np.asarray(truth)).mean())


# ────────────────────────── 池化 / 岭回归 ──────────────────────────
def pool(a):
    """与 bench_suite.pooled_vector 完全一致：7×d 统计 + 事件数 + Σdt。"""
    if len(a) == 0:
        return None
    q = np.percentile(a, [10, 50, 90], axis=0)
    return np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                           q.ravel(), [len(a), a[:, 0].sum()]]).astype(np.float64)


class Ridge:
    def __init__(self, alpha=ALPHA):
        self.alpha = alpha

    def fit(self, X, y):
        self.mu = X.mean(0)
        self.sd = X.std(0) + 1e-6
        Xs = (X - self.mu) / self.sd
        d = Xs.shape[1]
        A = Xs.T @ Xs + self.alpha * np.eye(d)
        self.w = np.linalg.solve(A, Xs.T @ (y - y.mean()))
        self.b = float(y.mean())
        return self

    def predict(self, X):
        return ((X - self.mu) / self.sd) @ self.w + self.b


# ────────────────────────── 特征计算（多进程）──────────────────────────
def _find_chart_file(d):
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def _work(cid):
    from build_seq_dataset import MAX_EVENTS, to_feats
    from chart_io import load_notes_ex

    d = os.path.join(CHARTS, cid)
    if not os.path.isdir(d):
        return cid, None, "nodir"
    p = _find_chart_file(d)
    if not p:
        return cid, None, "nojson"
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            is_rpe = f.read(1).strip() == "{"
        ev = load_notes_ex(p, max_events=MAX_EVENTS, extra=True)
        if len(ev) < 20:
            return cid, None, "short"
        a = to_feats(ev).astype(np.float64)
    except Exception as e:                                # noqa: BLE001
        return cid, None, "parse:" + type(e).__name__
    p20 = pool(a[:, :DIM_BASE])
    p4 = pool(a[:, NEW_COLS])
    if p20 is None or p4 is None:
        return cid, None, "empty"
    return cid, (p20, p4, 1 if is_rpe else 0), ""


def build_cache(n, workers):
    z = np.load(SEQ, allow_pickle=False)
    ids = [str(x) for x in z["ids"]]
    if n and n < len(ids):
        ids = ids[:n]
    if os.path.exists(CACHE):
        c = np.load(CACHE, allow_pickle=False)
        have = {str(k): i for i, k in enumerate(c["ids"])}
        if all(i in have for i in ids):
            print(f"复用缓存 {CACHE}（{len(have)} 张）")
            return c["ids"], c["p20"], c["p4"], c["rpe"], json.loads(str(c["status"]))

    from multiprocessing import Pool
    print(f"计算 {len(ids)} 张谱的特征（{workers} 进程）…", flush=True)
    p20s, p4s, rpes, kept, status = [], [], [], [], {}
    with Pool(workers) as pool_:
        for k, (cid, res, why) in enumerate(pool_.imap_unordered(_work, ids, chunksize=4)):
            if res is None:
                status[why] = status.get(why, 0) + 1
                continue
            kept.append(cid)
            p20s.append(res[0])
            p4s.append(res[1])
            rpes.append(res[2])
            if (k + 1) % 200 == 0:
                print(f"  {k + 1}/{len(ids)} · 收 {len(kept)}", flush=True)
    order = {c: i for i, c in enumerate(ids)}
    idx = sorted(range(len(kept)), key=lambda i: order[kept[i]])
    P20 = np.stack([p20s[i] for i in idx])
    P4 = np.stack([p4s[i] for i in idx])
    RPE = np.array([rpes[i] for i in idx], dtype=np.int8)
    kept = [kept[i] for i in idx]
    np.savez_compressed(CACHE, ids=np.array(kept), p20=P20, p4=P4, rpe=RPE,
                        status=json.dumps(status, ensure_ascii=False))
    print(f"缓存 → {CACHE}（{len(kept)} 张，跳过 {status}）")
    return np.array(kept), P20, P4, RPE, status


# ────────────────────────── A/B ──────────────────────────
def ab(P20, P4, y, label):
    n = len(y)
    perm = np.random.default_rng(SEED).permutation(n)
    cut = int(n * 0.85)
    tr, te = perm[:cut], perm[cut:]

    X20, X24 = P20, np.concatenate([P20, P4], axis=1)
    m20 = Ridge().fit(X20[tr], y[tr])
    m24 = Ridge().fit(X24[tr], y[tr])
    p20 = m20.predict(X20[te])
    p24 = m24.predict(X24[te])
    yt = y[te]

    rho20, rho24 = spearman(p20, yt), spearman(p24, yt)
    mae20, mae24 = mae(p20, yt), mae(p24, yt)

    rng = np.random.default_rng(BOOT_SEED)
    d_rho, d_mae = np.empty(N_BOOT), np.empty(N_BOOT)
    for b in range(N_BOOT):
        s = rng.integers(0, len(te), len(te))
        d_rho[b] = spearman(p24[s], yt[s]) - spearman(p20[s], yt[s])
        d_mae[b] = mae(p24[s], yt[s]) - mae(p20[s], yt[s])

    def ci(v):
        return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))

    out = {
        "label": label, "n": n, "n_train": len(tr), "n_test": len(te),
        "rho20": rho20, "rho24": rho24, "d_rho": rho24 - rho20,
        "ci_rho": ci(d_rho),
        "mae20": mae20, "mae24": mae24, "d_mae": mae24 - mae20,
        "ci_mae": ci(d_mae),
        "p_win_rho": float((d_rho > 0).mean()),
        "p_win_mae": float((d_mae < 0).mean()),
    }

    # 子组：按 max line_speed 的中位数切两半（阈值事先定，不看结果挑）
    # P4 布局 = mean(4)|std(4)|min(4)|max(4)|p10|p50|p90|n|Σdt，
    # max 块从 12 起，line_speed 是第 3 个新列 → 14。
    sp_col = 14
    thr = float(np.median(P4[te, sp_col]))
    mask = P4[te, sp_col] > thr
    for name, m in (("fast_line", mask), ("slow_line", ~mask)):
        if int(m.sum()) >= 30:
            out[name] = {
                "n": int(m.sum()), "median_of": "max(line_speed)",
                "rho20": spearman(p20[m], yt[m]),
                "rho24": spearman(p24[m], yt[m]),
                "d_rho": spearman(p24[m], yt[m]) - spearman(p20[m], yt[m]),
            }

    # 子组：屏幕坐标真的偏离本地坐标的谱（|mean(hit_x) − mean(x)| > 0.05 半屏宽）
    shift = np.abs(P4[:, 0] - P20[:, 2])
    big = shift[te] > 0.05
    out["big_shift"] = {
        "n": int(big.sum()), "frac": float(big.mean()),
        "rho20": spearman(p20[big], yt[big]) if big.sum() >= 20 else None,
        "rho24": spearman(p24[big], yt[big]) if big.sum() >= 20 else None,
        "d_rho": (spearman(p24[big], yt[big]) - spearman(p20[big], yt[big])
                  if big.sum() >= 20 else None),
    }

    # 单特征消融：每次只加 1 个新维（7 个池化量）。
    # P4 是**按统计量分块**的：mean(4)|std(4)|min(4)|max(4)|p10|p50|p90，
    # 所以第 k 个特征的 7 个位置是 k, k+4, k+8, ... 而不是连续 7 个。
    abl = {}
    for k, nm in enumerate(NEW_NAMES):
        idx_k = [k + 4 * j for j in range(7)]
        X = np.concatenate([P20, P4[:, idx_k]], axis=1)
        mm = Ridge().fit(X[tr], y[tr])
        pp = mm.predict(X[te])
        abl[nm] = {"rho": spearman(pp, yt), "d_rho": spearman(pp, yt) - rho20,
                   "mae": mae(pp, yt), "d_mae": mae(pp, yt) - mae20}
    out["ablation"] = abl

    # 对照：把新特征按谱整体打乱（破坏对应关系，保留边缘分布）
    rng2 = np.random.default_rng(BOOT_SEED + 1)
    Xs = np.concatenate([P20, P4[rng2.permutation(len(P4))]], axis=1)
    ps = Ridge().fit(Xs[tr], y[tr]).predict(Xs[te])
    out["shuffled_ctrl"] = {"rho": spearman(ps, yt), "d_rho": spearman(ps, yt) - rho20}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1500, help="前 n 张；0 = 全量")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    z = np.load(SEQ, allow_pickle=False)
    all_ids = {str(x): i for i, x in enumerate(z["ids"])}
    y_all = z["y"].astype(np.float64)

    ids, P20, P4, RPE, status = build_cache(args.n, args.workers)
    ids = [str(x) for x in ids]
    if args.n and len(ids) > args.n:
        keep = set(str(x) for x in z["ids"][:args.n])
        m = np.array([c in keep for c in ids])
        ids = [c for c, k in zip(ids, m) if k]
        P20, P4, RPE = P20[m], P4[m], RPE[m]
    y = np.array([y_all[all_ids[c]] for c in ids])

    n_rpe = int(RPE.sum())
    print(f"\n可用谱 {len(ids)}（RPE {n_rpe} · PEC/其他 {len(ids) - n_rpe}）"
          f" · 跳过 {status}")

    # 主分析：RPE 子集（新特征只在 RPE 上有定义）
    rpe = RPE == 1
    res_rpe = ab(P20[rpe], P4[rpe], y[rpe], f"RPE 子集 {n_rpe} 张")
    # 次分析：含 PEC（PEC 的 4 个新维恒为 0）
    res_all = ab(P20, P4, y, f"全部 {len(ids)} 张")
    print("\n[主] RPE 子集")
    print(json.dumps(res_rpe, ensure_ascii=False, indent=1))
    print("\n[次] 含 PEC")
    print(json.dumps({k: res_all[k] for k in
                      ("n", "n_train", "n_test", "rho20", "rho24", "d_rho",
                       "ci_rho", "mae20", "mae24", "d_mae", "ci_mae")},
                     ensure_ascii=False, indent=1))

    # 与 beta.2 数据集对拍：RPE 谱应逐位一致；PEC 谱因 one-hot 语义修正会变
    # ⚠ NpzFile 每次 __getitem__ 都会解压整个数组，必须先取出来再切片。
    feats, offs = z["feats"], z["offs"]
    d_rpe, d_pec = [], []
    for i, c in enumerate(ids):
        j = all_ids[c]
        seg = feats[offs[j]:offs[j + 1]].astype(np.float64)
        if len(seg) < 20:
            continue
        d = float(np.abs(pool(seg[:, :20]) - P20[i]).max())
        (d_rpe if RPE[i] else d_pec).append(d)
    print(f"\n前 20 维池化 vs beta.2：RPE max|Δ|={max(d_rpe or [0]):.3e} "
          f"(n={len(d_rpe)}) · PEC max|Δ|={max(d_pec or [0]):.3f} "
          f"(n={len(d_pec)}, >0.2 的 {sum(1 for x in d_pec if x > 0.2)} 张)")

    out = os.path.join(DATA, "ab-screen-result.json")
    json.dump({"rpe": res_rpe, "all": res_all, "status": status,
               "n_rpe": n_rpe,
               "maxdiff_beta2_rpe": max(d_rpe or [0]),
               "maxdiff_beta2_pec": max(d_pec or [0]),
               "n_pec_drift": sum(1 for x in d_pec if x > 0.2)},
              open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"→ {out}")


if __name__ == "__main__":
    main()
