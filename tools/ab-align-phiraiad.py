"""与 PhiraiAd 特征完全对齐的 A/B。

三组对照，逐层隔离：
  A  存盘基线（无 fake 过滤、只有 20 维）           ← 现在的生产口径
  B  A + 过滤 fake（20 维不变，只去掉不该算的音符）
  C  B + 对齐 PhiraiAd 的 18 个整谱统计 + 6 组特征
     （hold 覆盖 / hold 重叠 / 长空档占比 / 长条时长占比 / 按压权重 …）

判据：同一套切分、配对 bootstrap 1000 次、三个 seed。
用法：python tools/ab-align-phiraiad.py --n 1200
"""
import argparse, glob, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chart_io
from build_seq_dataset import to_feats

KIND_W = {"T": 1.0, "H": 1.0, "F": 0.5, "D": 0.0}   # PhiraiAd features.rs:251


def pool(a):
    a = np.asarray(a, np.float64)
    if a.ndim == 1:
        a = a[:, None]
    q = np.percentile(a, [10, 50, 90], axis=0)
    out = np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0), q[0], q[1], q[2]])
    return np.concatenate([out, [np.log1p(len(a)), float(a[:, 0].sum())]])


def aligned_stats(ev):
    """PhiraiAd features.rs:398-440 的 18 个整谱统计 + 6 个组级聚合。"""
    if not ev:
        return np.zeros(24)
    ev = sorted(ev, key=lambda e: e[0])
    t = np.array([e[0] for e in ev], float)
    x = np.array([e[1] for e in ev], float)
    ch = [e[2] for e in ev]
    hold = np.array([e[4] for e in ev], float)
    w = np.array([KIND_W.get(c, 1.0) for c in ch], float)
    n = len(ev)
    dur = max((t + hold).max() - t.min(), 1e-3)

    # 同刻组（±20ms 合并，与 to_feats 第 16 维同口径）
    gid = np.zeros(n, int)
    g = 0
    for i in range(1, n):
        if t[i] - t[i - 1] > 0.02:
            g += 1
        gid[i] = g
    gsz = np.bincount(gid)
    gw = np.bincount(gid, weights=w)

    # 1 秒窗按压权重（滑动，O(n)）
    press = np.zeros(n)
    s = 0.0; lo = 0
    for i in range(n):
        s += w[i]
        while t[lo] <= t[i] - 1.0:
            s -= w[lo]; lo += 1
        press[i] = s

    # 长条占用并集 / 重叠（事件扫描）
    evs = []
    for i in range(n):
        if hold[i] > 0:
            evs.append((t[i], 1)); evs.append((t[i] + hold[i], -1))
    evs.sort(key=lambda z: (z[0], z[1]))
    cov = ov = 0.0; run = 0; prev = t.min() if n else 0.0
    for tt, d in evs:
        if run > 0: cov += tt - prev
        if run > 1: ov += tt - prev
        prev = tt; run += d

    gaps = np.diff(t)
    kinds = [sum(1 for c in ch if c == k) / n for k in "THFD"]
    st = np.array([
        np.log1p(dur), np.log1p(n), n / dur, w.sum() / dur,
        press.max(), np.percentile(press, 90),
        *kinds,
        cov / dur, ov / dur,
        (gsz > 1).mean(), gsz.max(),
        np.median(gaps) if gaps.size else 0.0,
        gaps.min() if gaps.size else 0.0,
        gaps[gaps > 1.0].sum() / dur if gaps.size else 0.0,
        hold.sum() / dur,
    ], float)
    # 组级 6 个（他们的 group_features 是逐组的，这里聚合成整谱）
    grp = np.array([
        np.log1p(np.median(gsz)) if gsz.size else 0.0,
        np.log1p(gsz.max()) if gsz.size else 0.0,
        np.log1p(gw.mean()) if gw.size else 0.0,
        float(g > 0),
        np.log1p(n / max(g + 1, 1)),
        np.log1p(np.median(np.diff(t[gid == 0])) if (gid == 0).sum() > 1 else 0.0),
    ], float)
    return np.concatenate([st, grp])


def load_npz():
    d = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=True)
    return d["feats"].astype(np.float64), d["offs"], d["ids"], d["y"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--alpha", type=float, default=10.0)
    ap.add_argument("--boot", type=int, default=1000)
    a = ap.parse_args()

    feats, offs, ids, y = load_npz()
    ids = np.asarray(ids).astype(str)
    y = np.asarray(y, float)
    n_chart = len(offs) - 1
    files = {}
    for f in glob.glob("data/charts/*/chart.*"):
        # data/charts/<id>/chart.json | chart.pec
        files[os.path.basename(os.path.dirname(f))] = f

    limit = n_chart if a.n <= 0 else min(a.n, n_chart)
    rows = []
    for i in range(limit):
        cid = ids[i]
        f = files.get(cid)
        if not f:
            continue
        try:
            ev_all = chart_io.load_events(f, keep_fake=True)   # 现役口径（含 fake）
            ev = chart_io.load_events(f, keep_fake=False)      # 去 fake
            if len(ev) < 20:
                continue
            A = pool(to_feats(ev_all))
            base = pool(to_feats(ev))
            extra = aligned_stats(ev)
        except Exception:
            continue
        rows.append((cid, y[i], A, base, extra))
        if len(rows) % 200 == 0:
            print(f"  {len(rows)} 张…", flush=True)

    print(f"可用谱 {len(rows)}", flush=True)
    if len(rows) < 200:
        print("样本太少，退出"); return
    cid = [r[0] for r in rows]; yy = np.array([r[1] for r in rows])
    A = np.stack([r[2] for r in rows]); B = np.stack([r[3] for r in rows])
    C = np.concatenate([B, np.stack([r[4] for r in rows])], 1)

    res = {}
    for name, X in [("A_含fake", A), ("B_去fake", B), ("C_对齐全套", C)]:
        rho, mae, pred, te = cv_eval(X, yy, a.alpha)
        res[name] = dict(rho=rho, mae=mae, n=int(len(te)))
        res[name + "_pred"] = pred
        print(f"{name:12s} ρ={rho:.4f}  MAE={mae:.4f}  n_test={len(te)}", flush=True)

    for name in ["B_去fake", "C_对齐全套"]:
        lo, hi = boot_ci(res["A_含fake_pred"], res[name + "_pred"], yy[te], a.boot)
        print(f"{name} vs A：Δρ={res[name]['rho']-res['A_含fake']['rho']:+.4f}  95%CI [{lo:+.4f}, {hi:+.4f}]", flush=True)
        res[name]["d_rho"] = res[name]["rho"] - res["A_含fake"]["rho"]
        res[name]["ci"] = [lo, hi]

    json.dump({k: v for k, v in res.items() if not k.endswith("_pred")},
              open("data/ab-align-phiraiad.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("已写 data/ab-align-phiraiad.json")


def rankdata(x):
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort"); sx = x[o]
    obs = np.r_[True, sx[1:] != sx[:-1], True]
    idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x)); out[o] = np.repeat(avg, np.diff(idx))
    return out


def spearman(a, b):
    """平均秩，与 scipy.stats.rankdata 一致（不能用 argsort(argsort)）。"""
    ra, rb = rankdata(a), rankdata(b)
    ra = ra - ra.mean(); rb = rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def cv_eval(X, y, alpha):
    n = len(y)
    rng = np.random.RandomState(20261028)
    idx = rng.permutation(n)
    cut = int(n * 0.85)
    tr, te = idx[:cut], idx[cut:]
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    # ⚠ 必须中心化 y 并加回截距（与 export_engine_v3.Ridge 一致）。
    # 不加截距时预测均值恒为 0，而 b 的均值约 -1.5，MAE 会被凭空放大 3 倍。
    ym = y[tr].mean()
    w = np.linalg.solve(Xs[tr].T @ Xs[tr] + alpha * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
    pred = Xs[te] @ w + ym
    return spearman(pred, y[te]), float(np.abs(pred - y[te]).mean()), pred, te


def boot_ci(p0, p1, y, B):
    """按谱重采样，比较两个模型的 ρ 差。"""
    n = len(y); rng = np.random.RandomState(7); ds = []
    for _ in range(B):
        i = rng.randint(0, n, n)
        ds.append(spearman(p1[i], y[i]) - spearman(p0[i], y[i]))
    return float(np.percentile(ds, 2.5)), float(np.percentile(ds, 97.5))


if __name__ == "__main__":
    main()
