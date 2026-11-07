#!/usr/bin/env python3
"""片段手型特征的严格 A/B：现有 142 维池化 vs 142 + 新片段特征。

━━━ 口径（与仓库其它实验一致，不许改）━━━
- 数据：`data/seq-dataset-v0.1-beta.2.npz`（7,504 张，20 维事件）
- 基线：20 维 → 7 统计池化 = 142 维 → 岭回归
- 实验：142 + `handshape_features.py` 的 1,472 维 → 岭回归
- 切分：`np.random.default_rng(20261028).permutation(n)`，前 85% 训练（禁用其它 seed）
- 主指标：**短谱 ρ**（测试集里事件数 ≤925 的那批，n≈376）
- 配对 bootstrap 1,000 次只重采样测试集（模型固定），报 Δρ 的 95% CI
- α 一律用**训练集内部 3 折 CV** 选（不碰测试集），基线也选，保证公平

━━━ 必做的三张表 ━━━
1. 全量新特征 vs 基线
2. 分组累积消融（A / A+B / …）+ 单组消融（只看某一组）
3. 内层 top-k 子集（k=8/16/32/64，按训练集内 |Pearson| 排序）
   —— 短谱训练样本只有 2,257 张，1472 维新特征**几乎必然过拟合**，
      这张表比"全量"那张更重要。

用法：
    python tools/ab_handshape.py --n 1500 --workers 12     # 先跑通
    python tools/ab_handshape.py --n 0 --workers 12        # 全量
    python tools/ab_handshape.py --n 0 --reuse             # 复用特征缓存
"""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
CHARTS = os.path.join(DATA, "charts")
SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
POOL = os.path.join(DATA, "seq-pooled-cache.npz")
CACHE = os.path.join(DATA, "handshape-cache-v1.npz")
OUT = os.path.join(DATA, "handshape-ab.json")

SEED = 20261028
N_BOOT = 1000
BOOT_SEED = 20261029
SHORT_MAX = 925
LONG_MIN = 1327
SPLIT = 20261028          # 当前外层切分 seed（复核时才改）
ALPHAS = [1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0]
INNER_FOLDS = 3
BASE_ALPHA_PROD = 10.0        # export_engine_v3 的固定 α，仅作对照


# ────────────────────────── 指标 ──────────────────────────
def rankdata(x):
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


def mae(p, t):
    return float(np.abs(np.asarray(p) - np.asarray(t)).mean())


# ────────────────────────── 岭回归 ──────────────────────────
class Ridge:
    def __init__(self, alpha):
        self.alpha = alpha

    def fit(self, X, y):
        self.mu = X.mean(0)
        self.sd = X.std(0) + 1e-6
        Xs = (X - self.mu) / self.sd
        d = Xs.shape[1]
        A = Xs.T @ Xs
        A[np.diag_indices(d)] += self.alpha
        self.w = np.linalg.solve(A, Xs.T @ (y - y.mean()))
        self.b = float(y.mean())
        return self

    def predict(self, X):
        return ((X - self.mu) / self.sd) @ self.w + self.b


def inner_alpha(X, y, alphas=ALPHAS, folds=INNER_FOLDS, seed=None):
    """训练集内部 K 折，按平均 ρ 选 α。只用训练集。"""
    seed = SPLIT if seed is None else seed
    n = len(y)
    perm = np.random.default_rng(seed + 17).permutation(n)
    parts = np.array_split(perm, folds)
    best, best_s = alphas[0], -np.inf
    for a in alphas:
        sc = []
        for k in range(folds):
            va = parts[k]
            tr = np.concatenate([parts[j] for j in range(folds) if j != k])
            m = Ridge(a).fit(X[tr], y[tr])
            sc.append(spearman(m.predict(X[va]), y[va]))
        s = float(np.mean(sc))
        if s > best_s:
            best, best_s = a, s
    return best, best_s


def fit_eval(Xtr, ytr, Xte, yte, label):
    a, cv = inner_alpha(Xtr, ytr)
    m = Ridge(a).fit(Xtr, ytr)
    p = m.predict(Xte)
    return {"label": label, "alpha": a, "inner_rho": cv,
            "d": int(Xtr.shape[1]), "pred": p}


# ────────────────────────── 特征缓存 ──────────────────────────
def _find_chart(d):
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def _work(cid):
    from build_seq_dataset import events_of
    from handshape_features import chart_features
    d = os.path.join(CHARTS, cid)
    if not os.path.isdir(d):
        return cid, None, "nodir"
    p = _find_chart(d)
    if not p:
        return cid, None, "nojson"
    try:
        ev = events_of(p)
        if len(ev) < 20:
            return cid, None, "short<20"
        _n, v = chart_features(ev)
    except Exception as e:                                   # noqa: BLE001
        return cid, None, "parse:" + type(e).__name__
    return cid, v, ""


def build_cache(ids, workers, reuse=True):
    old_ids, old_H, old_status = [], None, {}
    if os.path.exists(CACHE):
        c = np.load(CACHE, allow_pickle=False)
        old_ids = [str(k) for k in c["ids"]]
        old_H = c["H"]
        old_status = json.loads(str(c["status"]))
        have = set(old_ids)
        todo = [i for i in ids if i not in have]
        if not todo:
            print(f"复用特征缓存 {CACHE}（{len(old_ids)} 张）")
            return
        print(f"缓存已有 {len(old_ids)} 张，补算 {len(todo)} 张")
    else:
        todo = list(ids)

    from multiprocessing import Pool
    t0 = time.time()
    print(f"计算 {len(todo)} 张谱的片段特征（{workers} 进程）…", flush=True)
    rows, status, got = [], dict(old_status), []
    with Pool(workers) as pool:
        for k, (cid, v, why) in enumerate(pool.imap_unordered(_work, todo, chunksize=2)):
            if v is None:
                status[why] = status.get(why, 0) + 1
            else:
                rows.append(v)
                got.append(cid)
            if (k + 1) % 300 == 0:
                print(f"  {k + 1}/{len(todo)} · 收 {len(rows)} · {time.time() - t0:.0f}s",
                      flush=True)
    if rows:
        add = np.stack(rows).astype(np.float32)
        if old_H is not None and old_H.size:
            H = np.concatenate([old_H, add], axis=0)
            all_ids = old_ids + got
        else:
            H, all_ids = add, got
    else:
        H, all_ids = old_H, old_ids
    np.savez_compressed(CACHE, ids=np.array(all_ids), H=H,
                        status=json.dumps(status, ensure_ascii=False))
    print(f"缓存 → {CACHE}（{len(all_ids)} 张 × {H.shape[1]} 维，{time.time() - t0:.0f}s，"
          f"跳过累计 {status}）")


# ────────────────────────── 配对 bootstrap ──────────────────────────
def paired_boot(p_base, p_new, y, rng, n_boot=N_BOOT):
    idx = np.arange(len(y))
    d = np.empty(n_boot)
    for b in range(n_boot):
        s = rng.integers(0, len(idx), len(idx))
        d[b] = spearman(p_new[s], y[s]) - spearman(p_base[s], y[s])
    return {"d_rho": float(spearman(p_new, y) - spearman(p_base, y)),
            "ci": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
            "p_win": float((d > 0).mean()),
            "boot_mean": float(d.mean()), "boot_sd": float(d.std())}


# ────────────────────────── 主流程 ──────────────────────────
def _finish(a, res, base_blk, full_blk, cum, single, topk, ac):
    json.dump(res, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    def show(b):
        d = b.get("delta_short") or {}
        ci = d.get("ci", [float("nan")] * 2)
        return (f"{b['label']:<22s} ρ短 {b['rho_short']:.4f} "
                f"(Δ {d.get('d_rho', float('nan')):+.4f} [{ci[0]:+.4f},{ci[1]:+.4f}]) "
                f"ρ全 {b['rho_all']:.4f} ρ长 {b['rho_long']:.4f} d={b['d']} α={b['alpha']:g}")

    print()
    print(f"切分 seed {SPLIT} · 谱面 {res['n']} / 训练 {res['n_train']} / 测试 {res['n_test']}")
    print()
    print(show(base_blk))
    print(show(full_blk))
    if cum:
        print()
        print("累积消融")
        for v in cum.values():
            print("  " + show(v))
    if single:
        print()
        print("单组消融")
        for v in single.values():
            print("  " + show(v))
    if res.get("A_split"):
        print()
        print("A 组内部拆分（Δ 相对 base；loo 的 Δ 相对 extent）")
        for k, v in res["A_split"].items():
            d = v.get("delta_short") or v.get("delta_vs_extent")
            print(f"  {k:<14s} ρ短 {v['rho_short']:.4f} (Δ {d['d_rho']:+.4f} "
                  f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]) ρ全 {v['rho_all']:.4f} "
                  f"ρ长 {v['rho_long']:.4f} d={v['d']}")
    if res.get("leave_one_group_out"):
        print()
        print("留一组（Δ 相对 full）")
        for k, v in res["leave_one_group_out"].items():
            d = v["delta_short"]
            print(f"  drop_{k:<3s} ρ短 {v['rho_short']:.4f} (Δ {d['d_rho']:+.4f} "
                  f"[{d['ci'][0]:+.4f},{d['ci'][1]:+.4f}]) ρ全 {v['rho_all']:.4f} "
                  f"ρ长 {v['rho_long']:.4f}")
    print()
    print("top-k（corr = 与标签的边际相关；resid = 与 base 的 out-of-fold 残差相关）")
    for v in topk.values():
        for tag, b in v.items():
            print(f"  [{tag}] " + show(b))
    if ac:
        print()
        print("α 曲线（只用 142 维基线）")
        for al, v in ac.items():
            print(f"  α={al:<6s} ρ短 {v['rho_short']:.4f} ρ全 {v['rho_all']:.4f} "
                  f"ρ长 {v['rho_long']:.4f}")
    if "noise_block" in res:
        print()
        print("随机噪声块对照（同维度同流程）")
        print("  " + show(res["noise_block"]))
    if "shuffled" in res:
        print()
        print("打乱对照")
        print("  " + show(res["shuffled"]))
    if "short_only_train" in res:
        print()
        print("只用短谱训练")
        for v in res["short_only_train"].values():
            print("  " + show(v))
    print()
    print(f"→ {a.out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1500, help="前 n 张；0 = 全量")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--reuse", action="store_true", help="只用已有缓存，缺就报错")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--split-seed", type=int, default=SEED,
                    help="仅用于稳健性复核；主结论必须用 20261028")
    ap.add_argument("--fast", action="store_true",
                    help="只跑 base/full/top-k（用于换 seed 复核，省 3 分钟）")
    a = ap.parse_args()
    global SPLIT
    SPLIT = a.split_seed

    z = np.load(SEQ, allow_pickle=False)
    ids_all = [str(x) for x in z["ids"]]
    y_all = z["y"].astype(np.float64)
    lens_all = np.diff(z["offs"]).astype(np.int64)
    row_of = {c: i for i, c in enumerate(ids_all)}

    ids = ids_all[:a.n] if (a.n and a.n < len(ids_all)) else ids_all

    build_cache(ids, a.workers, reuse=a.reuse or True)
    zc = np.load(CACHE, allow_pickle=False)
    have = {str(k): i for i, k in enumerate(zc["ids"])}
    hinr = np.array([have.get(i, -1) for i in ids])
    miss = [i for i, r in zip(ids, hinr) if r < 0]
    if miss:
        # 不丢样本：丢样本会改变 n → 改变 permutation → 切分与仓库其它实验不可比。
        # 缺失谱的新特征填 0（标准化后等于"谱均水平"），base 的 142 维仍是真值。
        print(f"⚠ {len(miss)} 张谱的新特征缺失（解析失败），按谱均填充 0：{miss[:5]}…")
        H = np.zeros((len(ids), zc["H"].shape[1]), dtype=np.float64)
        ok = hinr >= 0
        H[ok] = zc["H"][hinr[ok]]
    else:
        H = zc["H"][hinr].astype(np.float64)
    status = json.loads(str(zc["status"]))
    src = np.array([row_of[i] for i in ids])
    y = y_all[src]
    lens = lens_all[src]

    zp = np.load(POOL, allow_pickle=False)
    P_all = zp["P"].astype(np.float64)
    if P_all.shape[0] != len(ids_all):
        raise SystemExit(f"池化缓存行数 {P_all.shape[0]} ≠ 数据集 {len(ids_all)}")
    P = P_all[src]

    from handshape_features import feature_names, METRIC_NAMES, METRIC_GROUPS
    names = feature_names()
    gm = dict(zip(METRIC_NAMES, METRIC_GROUPS))
    groups = np.array([gm[nm.split("|")[2]] for nm in names])

    n = len(ids)
    perm = np.random.default_rng(SPLIT).permutation(n)
    cut = int(n * 0.85)
    tr, te = perm[:cut], perm[cut:]
    ytr, yte = y[tr], y[te]
    short_te = lens[te] <= SHORT_MAX
    long_te = lens[te] >= LONG_MIN
    short_tr = lens[tr] <= SHORT_MAX

    print(f"\n谱面 {n}（训练 {len(tr)} / 测试 {len(te)}）· 新特征 {H.shape[1]} 维")
    print(f"测试集：短 {int(short_te.sum())} · 长 {int(long_te.sum())} · "
          f"训练集短谱 {int(short_tr.sum())}")

    res = {"n": n, "n_train": int(len(tr)), "n_test": int(len(te)),
           "n_test_short": int(short_te.sum()), "n_test_long": int(long_te.sum()),
           "n_train_short": int(short_tr.sum()),
           "n_new_dims": int(H.shape[1]), "status": status,
           "n_handshape_missing": len(miss), "handshape_missing_ids": miss,
           "dims_by_group": {g: int((groups == g).sum()) for g in "ABCDEF"}}

    Xb = P                                                       # 142
    Xn = np.concatenate([P, H.astype(np.float64)], axis=1)       # 1614

    base = fit_eval(Xb[tr], ytr, Xb[te], yte, "base")
    full = fit_eval(Xn[tr], ytr, Xn[te], yte, "full")

    # 生产固定 α 的基线（对照）
    base_prod = {"label": "base_a10", "alpha": BASE_ALPHA_PROD,
                 "pred": Ridge(BASE_ALPHA_PROD).fit(Xb[tr], ytr).predict(Xb[te])}

    def block(pred, label, extra=None):
        o = {"label": label,
             "rho_all": spearman(pred, yte),
             "rho_short": spearman(pred[short_te], yte[short_te]),
             "rho_long": spearman(pred[long_te], yte[long_te]),
             "mae_all": mae(pred, yte),
             "mae_short": mae(pred[short_te], yte[short_te])}
        if extra:
            o.update(extra)
        return o

    base_blk = block(base["pred"], "base",
                     {"alpha": base["alpha"], "inner_rho": base["inner_rho"], "d": 142})
    base_blk["vs_prod_a10"] = {
        "alpha": BASE_ALPHA_PROD,
        "rho_all": spearman(base_prod["pred"], yte),
        "rho_short": spearman(base_prod["pred"][short_te], yte[short_te]),
    }

    rng = np.random.default_rng(BOOT_SEED)
    full_blk = block(full["pred"], "full", {"alpha": full["alpha"], "d": full["d"]})
    full_blk["delta"] = paired_boot(base["pred"], full["pred"], yte, rng)
    full_blk["delta_short"] = paired_boot(base["pred"][short_te], full["pred"][short_te],
                                          yte[short_te], rng)
    full_blk["delta_long"] = paired_boot(base["pred"][long_te], full["pred"][long_te],
                                         yte[long_te], rng)
    res["base"] = base_blk
    res["full"] = full_blk

    # ── 分组累积消融 + 单组消融 ──
    cum, single, cur, logo = {}, {}, [], {}
    for g in ("ABCDEF" if not a.fast else ""):
        idx = np.flatnonzero(groups == g)
        cur.append(idx)
        Xg = np.concatenate([Xb] + [H[:, i] for i in cur], axis=1)
        r = fit_eval(Xg[tr], ytr, Xg[te], yte, f"cum_{g}")
        b = block(r["pred"], f"cum_through_{g}", {"alpha": r["alpha"], "d": r["d"]})
        b["delta_short"] = paired_boot(base["pred"][short_te], r["pred"][short_te],
                                       yte[short_te], rng)
        cum[f"through_{g}"] = b

        X1 = np.concatenate([Xb, H[:, idx]], axis=1)
        r1 = fit_eval(X1[tr], ytr, X1[te], yte, f"only_{g}")
        b1 = block(r1["pred"], f"only_{g}", {"alpha": r1["alpha"], "d": r1["d"]})
        b1["delta_short"] = paired_boot(base["pred"][short_te], r1["pred"][short_te],
                                        yte[short_te], rng)
        single[g] = b1

        # 留一组（全量减去该组）：直接回答"这一组到底贡献了多少"
        keep = np.flatnonzero(groups != g)
        Xl = np.concatenate([Xb, H[:, keep]], axis=1)
        rl = fit_eval(Xl[tr], ytr, Xl[te], yte, f"drop_{g}")
        bl = block(rl["pred"], f"drop_{g}", {"alpha": rl["alpha"], "d": rl["d"]})
        bl["delta_short"] = paired_boot(full["pred"][short_te], rl["pred"][short_te],
                                        yte[short_te], rng)
        logo[g] = bl

    res["cumulative"] = cum
    res["single_group"] = single
    res["leave_one_group_out"] = logo

    # ── A 组内部拆分：转角/曲率  vs  包围盒/跨度 ──
    # drop_A 掉 0.059 说明 A 是唯一必需的组；这里再看 A 里到底是哪一半在起作用。
    A_EXTENT = {"bbox_area", "diag", "span_x", "span_y", "aspect", "path", "disp", "eff"}
    A_TURN = {"step_mean", "step_max", "step_cv", "turn_mean", "turn_p90",
              "turn_signed", "turn_sharp", "turn_straight", "curv", "curv_max"}
    metric = np.array([nm.split("|")[2] for nm in names])
    asplit = {}
    for tag, keep in (("extent", A_EXTENT), ("turn", A_TURN)):
        cols = np.flatnonzero(np.isin(metric, list(keep)))
        X = np.concatenate([Xb, H[:, cols]], axis=1)
        r = fit_eval(X[tr], ytr, X[te], yte, "A_" + tag)
        b = block(r["pred"], f"A_{tag}", {"alpha": r["alpha"], "d": r["d"]})
        b["delta_short"] = paired_boot(base["pred"][short_te], r["pred"][short_te],
                                       yte[short_te], rng)
        b["delta_vs_full"] = paired_boot(full["pred"][short_te], r["pred"][short_te],
                                         yte[short_te], rng)
        asplit[tag] = b
        if tag == "extent":
            preds_ext = r["pred"]
    # 在 extent 内部逐指标留一（8 个指标 → 8 次拟合）
    cols_e = np.flatnonzero(np.isin(metric, list(A_EXTENT)))
    p_ext = preds_ext
    for mt in sorted(A_EXTENT):
        drop = np.flatnonzero(metric[cols_e] == mt)
        keep = np.setdiff1d(cols_e, cols_e[drop])
        X = np.concatenate([Xb, H[:, keep]], axis=1)
        r = fit_eval(X[tr], ytr, X[te], yte, "A_ext_" + mt)
        b = block(r["pred"], f"A_extent_no_{mt}", {"alpha": r["alpha"], "d": r["d"]})
        b["delta_vs_extent"] = paired_boot(p_ext[short_te], r["pred"][short_te],
                                           yte[short_te], rng)
        asplit["loo_" + mt] = b
    res["A_split"] = asplit

    # ── 内层 top-k（只用训练集算 |Pearson|）──
    Htr = H[tr].astype(np.float64)
    yy = ytr - ytr.mean()
    hh = Htr - Htr.mean(0)
    den = np.sqrt((hh * hh).sum(0) * (yy @ yy)) + 1e-12
    corr = (hh * yy[:, None]).sum(0) / den
    corr = np.nan_to_num(corr)
    order = np.argsort(-np.abs(corr))

    # 排序口径 2：与「base 的 out-of-fold 残差」的相关（更接近"新信息"）
    oof = np.zeros(len(tr))
    perm_t = np.random.default_rng(SEED + 31).permutation(len(tr))
    folds_t = np.array_split(perm_t, INNER_FOLDS)
    for k in range(INNER_FOLDS):
        va = folds_t[k]
        trn = np.setdiff1d(np.arange(len(tr)), va)
        am, _ = inner_alpha(Xb[tr][trn], ytr[trn])
        oof[va] = Ridge(am).fit(Xb[tr][trn], ytr[trn]).predict(Xb[tr][va])
    rr = ytr - oof
    rr = rr - rr.mean()
    hr = Htr - Htr.mean(0)
    den2 = np.sqrt((hr * hr).sum(0) * (rr @ rr)) + 1e-12
    corr_res = np.nan_to_num((hr * rr[:, None]).sum(0) / den2)
    order_res = np.argsort(-np.abs(corr_res))

    topk = {}
    for k in (8, 16, 32, 64):
        entry = {}
        for tag, ordr, cv_ in (("corr", order, corr), ("resid", order_res, corr_res)):
            ix = ordr[:k]
            Xk = np.concatenate([Xb, H[:, ix]], axis=1)
            r = fit_eval(Xk[tr], ytr, Xk[te], yte, f"top{k}_{tag}")
            b = block(r["pred"], f"top{k}_{tag}", {"alpha": r["alpha"], "d": r["d"]})
            b["delta_short"] = paired_boot(base["pred"][short_te], r["pred"][short_te],
                                           yte[short_te], rng)
            b["dims"] = [{"name": names[i], "corr": float(cv_[i])} for i in ix]
            entry[tag] = b
        topk[k] = entry
    res["topk"] = {str(k): v for k, v in topk.items()}
    res["rank"] = [{"name": names[i], "corr": float(corr[i]),
                    "corr_resid": float(corr_res[i])} for i in order[:80]]
    res["rank_resid"] = [{"name": names[i], "corr": float(corr[i]),
                          "corr_resid": float(corr_res[i])} for i in order_res[:80]]

    # ── 对照 1：α 曲线（只有 142 维时，不同正则强度的短谱 ρ）──
    # 若 base 在 α≈1000 上短谱 ρ 也能到 0.74，说明"增益"只是收缩强度，不是新信息。
    ac = {}
    for al in (ALPHAS if not a.fast else []):
        p = Ridge(al).fit(Xb[tr], ytr).predict(Xb[te])
        ac[f"{al:g}"] = {"rho_short": spearman(p[short_te], yte[short_te]),
                         "rho_all": spearman(p, yte),
                         "rho_long": spearman(p[long_te], yte[long_te])}
    res["alpha_curve_base"] = ac

    # ── 对照 2：随机噪声块（同维度、同流程）──
    # 这是判定"增益来自信息还是来自正则化路径"的决定性对照。
    if not a.fast:
        noise = np.random.default_rng(BOOT_SEED + 7).standard_normal((n, H.shape[1]))
        Xz = np.concatenate([Xb, noise], axis=1)
        rz = fit_eval(Xz[tr], ytr, Xz[te], yte, "noise")
        res["noise_block"] = block(rz["pred"], "noise_block",
                                   {"alpha": rz["alpha"], "d": rz["d"]})
        res["noise_block"]["delta_short"] = paired_boot(
            base["pred"][short_te], rz["pred"][short_te], yte[short_te], rng)
        res["noise_block"]["delta_all"] = paired_boot(base["pred"], rz["pred"], yte, rng)

    # ── 打乱对照（新特征按谱整行打乱，保留边缘分布）──
    if a.fast:
        return _finish(a, res, base_blk, full_blk, cum, single, topk, ac)
    rng2 = np.random.default_rng(BOOT_SEED + 1)
    Hs = H[rng2.permutation(n)].astype(np.float64)
    Xs = np.concatenate([P, Hs], axis=1)
    rs = fit_eval(Xs[tr], ytr, Xs[te], yte, "shuffled")
    res["shuffled"] = block(rs["pred"], "shuffled",
                            {"alpha": rs["alpha"], "d": rs["d"]})
    res["shuffled"]["delta_short"] = paired_boot(base["pred"][short_te],
                                                 rs["pred"][short_te], yte[short_te], rng)

    # ── 只用短谱训练（短谱样本 2,257，看新特征在"数量少 + 目标域"下的表现）──
    if short_tr.sum() > 200 and not a.fast:
        s_tr = tr[short_tr]
        variants = {"base": P, "full": Xn}
        ix64 = order[:64]
        variants["top64"] = np.concatenate([P, H[:, ix64]], axis=1)
        ix16 = order[:16]
        variants["top16"] = np.concatenate([P, H[:, ix16]], axis=1)
        sh, preds = {}, {}
        for nm, X in variants.items():
            r = fit_eval(X[s_tr], y[s_tr], X[te], yte, "short_" + nm)
            preds[nm] = r["pred"]
            sh[nm] = block(r["pred"], "short_train_" + nm,
                           {"alpha": r["alpha"], "d": r["d"]})
        for nm in variants:
            if nm == "base":
                continue
            sh[nm]["delta_short"] = paired_boot(
                preds["base"][short_te], preds[nm][short_te], yte[short_te], rng)
        res["short_only_train"] = sh

    _finish(a, res, base_blk, full_blk, cum, single, topk, ac)


if __name__ == "__main__":
    main()
