"""曲线标签当辅助任务：真的能帮主任务（预测 b）吗？

三个对照，全部走分组切分（tools/group_split.py）：

  ① 直接回归 b（岭）                   —— 现役口径
  ② 两阶段：先回归 5 维曲线，再线性映射到 b
  ③ 多任务 MLP：共享隐层，主头 b + 辅头 5 维曲线，λ 控制辅助权重
     λ=0 就是「同样容量的单任务 MLP」，是 ③ 的严格对照

━━━ 为什么 ③ 才是真正的检验 ━━━
岭回归是线性的，多个输出之间没有共享表示，多任务对它没有意义。
只有带共享隐层的模型，「用曲线当辅助任务」才可能反过来改善主任务——
这也是文献里辅助任务起作用的机制。

用法：python tools/ab_curve_aux.py
"""
import os
import sys
import numpy as np
import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from group_split import group_ids, split, report


def rankdata(x):
    x = np.asarray(x, float); o = np.argsort(x, kind="mergesort"); sx = x[o]
    obs = np.r_[True, sx[1:] != sx[:-1], True]; idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x)); out[o] = np.repeat(avg, np.diff(idx)); return out


def rho(a, b):
    ra, rb = rankdata(a), rankdata(b)
    ra, rb = ra - ra.mean(), rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


def ridge(X, y, tr, te, alpha=10.0):
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    ym = y[tr].mean()
    w = np.linalg.solve(Xs[tr].T @ Xs[tr] + alpha * np.eye(X.shape[1]), Xs[tr].T @ (y[tr] - ym))
    return Xs[te] @ w + ym, Xs[tr] @ w + ym


class Multi(nn.Module):
    def __init__(self, d_in, h=64):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(d_in, h), nn.ReLU(), nn.Linear(h, h), nn.ReLU())
        self.head_b = nn.Linear(h, 1)
        self.head_c = nn.Linear(h, 5)

    def forward(self, x):
        z = self.body(x)
        return self.head_b(z).squeeze(-1), self.head_c(z)


def run_mlp(Xtr, ytr, Ctr, Xte, yte, lam, seed, epochs=200):
    torch.manual_seed(seed)
    m = Multi(Xtr.shape[1])
    opt = torch.optim.Adam(m.parameters(), lr=2e-3, weight_decay=1e-4)
    Xt = torch.tensor(Xtr, dtype=torch.float32)
    yt = torch.tensor(ytr, dtype=torch.float32)
    Ct = torch.tensor(Ctr, dtype=torch.float32)
    Xv = torch.tensor(Xte, dtype=torch.float32)
    n = len(yt)
    bs = 256
    for ep in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n, bs):
            j = perm[i:i + bs]
            pb, pc = m(Xt[j])
            loss = nn.functional.mse_loss(pb, yt[j])
            if lam > 0:
                loss = loss + lam * nn.functional.mse_loss(pc, Ct[j])
            opt.zero_grad(); loss.backward(); opt.step()
    with torch.no_grad():
        pb, _ = m(Xv)
    return pb.numpy()


def main():
    b = np.load("data/base170-cache.npz", allow_pickle=True)
    ids = [str(x) for x in b["ids"]]
    X = b["base"]
    z = np.load("data/seq-dataset-v0.1-beta.2.npz", allow_pickle=True)
    ymap = {str(k): float(v) for k, v in zip(z["ids"], z["y"])}
    y = np.array([ymap[i] for i in ids])
    pc = np.load("data/passcurve-v1.npz", allow_pickle=True)
    pmap = {str(k): v for k, v in zip(pc["ids"], pc["curve"])}
    C = np.stack([pmap[i] for i in ids])
    ok = np.isfinite(C).all(1)
    print(f"谱 {len(ids)}，曲线完整 {ok.sum()}")

    # ⚠ 先按 ok 过滤，再切分——否则下标错位（踩过的坑）
    kept = [i for i in range(len(ids)) if ok[i]]
    ids, X, y, C = [ids[i] for i in kept], X[ok], y[ok], C[ok]
    gid = group_ids(ids)
    tr, te = split(gid)
    # 特征标准化（训练集统计）
    mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
    Xs = np.clip((X - mu) / sd, -8, 8)
    # 曲线逐档标准化，让 MSE 的量纲一致
    cmu, csd = C[tr].mean(0), C[tr].std(0) + 1e-6
    Cs = (C - cmu) / csd
    print(f"训练 {len(tr)}，测试 {len(te)}（分组切分）\n")

    p1, _ = ridge(Xs, y, tr, te)
    print(f"① 直接回归 b（岭）              ρ={rho(p1, y[te]):.4f}  MAE={np.abs(p1-y[te]).mean():.4f}")

    # ② 两阶段：岭回归曲线 → 线性映射到 b
    Pm = np.zeros((len(te), 5))
    for k in range(5):
        w = np.linalg.solve(Xs[tr].T @ Xs[tr] + 10.0 * np.eye(Xs.shape[1]), Xs[tr].T @ (Cs[tr, k] - Cs[tr, k].mean()))
        Pm[:, k] = Xs[te] @ w + Cs[tr, k].mean()
    Ct_tr = Cs[tr]
    A = np.c_[Ct_tr, np.ones(len(tr))]
    coef = np.linalg.lstsq(A, y[tr], rcond=None)[0]
    p2 = np.c_[Pm, np.ones(len(te))] @ coef
    print(f"② 两阶段（曲线→b）              ρ={rho(p2, y[te]):.4f}  MAE={np.abs(p2-y[te]).mean():.4f}")

    print("\n③ 多任务 MLP（3 seed）：")
    for lam in [3.0, 10.0, 30.0]:
        rs, ms = [], []
        for seed in [0, 1, 2]:
            p = run_mlp(Xs[tr], y[tr], Cs[tr], Xs[te], y[te], lam, seed)
            rs.append(rho(p, y[te])); ms.append(np.abs(p - y[te]).mean())
        tag = "单任务对照" if lam == 0 else f"λ={lam}"
        print(f"   {tag:12s} ρ={np.mean(rs):.4f} (sd {np.std(rs):.4f})  MAE={np.mean(ms):.4f}")


if __name__ == "__main__":
    main()
