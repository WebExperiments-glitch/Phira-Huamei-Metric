"""把历史基线在「按内容分组切分」下重跑，得到诚实版数字。

对比两组：
  A 随机切分（历史口径，含同谱泄漏）
  B 分组切分（tools/group_split.py，同内容谱不跨集）

模型三个：
  v3   20 维池化 = 142
  v4   v3 + 手型 extent 256 = 398
  （序列模型不在这里，它需要重新训练，另开）

特征：20 维从谱面重算（缓存到 data/base170-cache.npz），
手型从 data/handshape-extent-v1.npz 按 id 对齐。
"""
import glob
import os
import sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from group_split import group_ids, split, report

CACHE = os.path.join(os.path.dirname(HERE), "data", "base170-cache.npz")
_FILES = {}


def _init(files):
    global _FILES
    _FILES = files


def _work(cid):
    """模块级函数（Windows spawn 不能 pickle 局部函数）。"""
    import chart_io
    from build_seq_dataset import to_feats
    p = _FILES.get(cid)
    if not p:
        return cid, None
    try:
        ev = chart_io.load_events(p)
        if len(ev) < 20:
            return cid, None
        a = to_feats(ev).astype(np.float64)
        q = np.percentile(a, [10, 50, 90], axis=0)
        return cid, np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                                    q.ravel(), [len(a), a[:, 0].sum()]])
    except Exception:
        return cid, None


def build_base(workers=10):
    if os.path.exists(CACHE):
        c = np.load(CACHE, allow_pickle=True)
        print(f"复用 {CACHE}（{len(c['ids'])} 张）")
        return [str(x) for x in c["ids"]], c["base"]
    from multiprocessing import Pool
    import chart_io
    from build_seq_dataset import to_feats
    z = np.load(os.path.join(os.path.dirname(HERE), "data", "seq-dataset-v0.1-beta.2.npz"), allow_pickle=True)
    ids = [str(x) for x in z["ids"]]
    files = {os.path.basename(os.path.dirname(p)): p for p in glob.glob("data/charts/*/chart.*")}

    global _FILES
    _FILES = files
    out_ids, rows = [], []
    with Pool(workers, initializer=_init, initargs=(files,)) as pool_:
        for k, (cid, v) in enumerate(pool_.imap_unordered(_work, ids, chunksize=8)):
            if v is None:
                continue
            out_ids.append(cid); rows.append(v)
            if len(out_ids) % 1000 == 0:
                print(f"  {len(out_ids)}…", flush=True)
    np.savez_compressed(CACHE, ids=np.array(out_ids), base=np.stack(rows))
    return out_ids, np.stack(rows)


def rankdata(x):
    x = np.asarray(x, float); o = np.argsort(x, kind="mergesort"); sx = x[o]
    obs = np.r_[True, sx[1:] != sx[:-1], True]; idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x)); out[o] = np.repeat(avg, np.diff(idx)); return out


def rho(a, b):
    ra, rb = rankdata(a), rankdata(b)
    ra, rb = ra - ra.mean(), rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def fit(X, y, tr, te, alpha=10.0):
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    ym = y[tr].mean()
    w = np.linalg.solve(Xs[tr].T @ Xs[tr] + alpha * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
    p = Xs[te] @ w + ym
    return rho(p, y[te]), float(np.abs(p - y[te]).mean())


def main():
    ids, base = build_base()
    z = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=True)
    ymap = {str(k): float(v) for k, v in zip(z["ids"], z["y"])}
    y = np.array([ymap[i] for i in ids])
    print(f"基线特征 {base.shape}")

    hs = np.load("data/handshape-extent-v1.npz", allow_pickle=True)
    hmap = {str(k): v for k, v in zip(hs["ids"], hs["E"])}
    E = np.stack([hmap[i] for i in ids])
    X3 = base[:, :140 + 2]                      # 20 维 × 7 统计 + 2 = 142
    X4 = np.concatenate([X3, E], 1)
    print(f"v3 {X3.shape}   v4 {X4.shape}")

    gid = group_ids(ids)
    report(ids, gid)
    trg, teg = split(gid)

    idx = np.random.RandomState(20261028).permutation(len(ids))
    cut = int(len(ids) * 0.85)
    trr, ter = idx[:cut], idx[cut:]

    print(f"\n{'模型':6s} {'切分':10s} {'ρ':>8s} {'MAE':>8s}  n_test")
    for name, X in [("v3", X3), ("v4", X4)]:
        r1, m1 = fit(X, y, trr, ter)
        r2, m2 = fit(X, y, trg, teg)
        print(f"{name:6s} {'随机':10s} {r1:8.4f} {m1:8.4f}  {len(ter)}")
        print(f"{name:6s} {'分组':10s} {r2:8.4f} {m2:8.4f}  {len(teg)}")
        print(f"{name:6s} {'泄漏虚高':10s} {r1-r2:+8.4f}")


if __name__ == "__main__":
    main()
