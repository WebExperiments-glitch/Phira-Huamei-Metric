#!/usr/bin/env python3
"""序列模型 vs 岭回归：同一切分下的严格配对比较。

━━━ 要回答的唯一问题 ━━━
「时间顺序」（什么时候密集、什么时候喘息、密度怎么变化）里，
是否还有岭回归 142 维分位数池化没吃到、且**稳定**的信息？

━━━ 为什么是「patch 嵌入 + biGRU」而不是池化 ━━━
142 维池化把整条时间轴压成 7 个分位数 —— 分钟级的「第 40 秒有一段 12 连、
之后 8 秒空窗」这种结构在 p10/p50/p90 里消失。
本模型保留时间轴：每 8 个事件打成一个 token（含该片的真实时长 Σdt），
得到约 L/8 ≈ 155 个**有序** token，再交给双向 GRU 走一遍。
    · 不池化：token 之间的先后关系是模型的输入
    · 8 事件/片 ≈ 0.8 秒（中位谱 1,244 事件 ≈ 120 秒）—— 正好是「节奏型」的尺度
    · 片内保留全部 20 维原始值（20×8=160 维直接线性投影），不像前作那样先均值再进模型

━━━ 为什么这么小 ━━━
用户是 Intel CPU（高温降频 2.8 GHz）。参数量硬上限 100k：
30 epoch 全量要能在 40 分钟内跑完，否则迭代不动。
实测 CPU biGRU 在原始长度（L≈1,250）上 7.7 分钟/epoch —— 不可用；
patch 化到 L/8 后 0.9 分钟/epoch。这是唯一可行的口径。

━━━ 切分与选择协议（和前作不同，必须看清）━━━
    · 外层切分与本仓库全部实验一致：rng(20261028).permutation → 前 85% 训练 / 后 15% 测试
    · **模型选择只用训练集内部的 10%**（inner val），测试集 1,126 张只在最后看一次
    · 前作 ssm_seq.py 用测试集选 epoch（乐观偏差），本脚本不做这件事
    · 岭回归 alpha=10（与 export_engine_v3.py 一致），无超参选择

用法：
    python tools/train_seq_model.py --seeds 1              # 单种子
    python tools/train_seq_model.py --seeds 1,2,3 --epochs 25
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "seq-dataset-v0.1-beta.2.npz")
CACHE = os.path.join(ROOT, "data", "seq-pooled-cache.npz")
OUTDIR = os.path.join(ROOT, "data")

SEED = 20261028          # 外层切分（与本仓库其它实验一致，禁用其它值）
GROUP_SPLIT = os.environ.get("PHM_GROUP_SPLIT") == "1"   # 按内容哈希分组切分
ALPHA = 10.0             # 岭回归正则，与 export_engine_v3.py 一致
N_BOOT = 1000
BOOT_SEED = 20261029

PATCH = 8                # 8 事件 / token
D_MODEL = 64
HIDDEN = 32              # biGRU 单向隐藏，实际隐层 64
EPOCHS = 15              # 实测峰值在 ep2–6，之后稳定过拟合；15 已是过剩预算
BS = 32
INNER_FRAC = 0.10        # 训练集内部划出 10% 做 epoch 选择


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


# ────────────────────────── 岭回归基线（142 维）──────────────────────────
def pool(a):
    """与 bench_suite / ab_screen_coords 完全一致的池化：7×d + 事件数 + Σdt。"""
    q = np.percentile(a, [10, 50, 90], axis=0)
    return np.concatenate([a.mean(0), a.std(0), a.min(0), a.max(0),
                           q.ravel(), [len(a), a[:, 0].sum()]]).astype(np.float64)


class Ridge:
    def __init__(self, alpha=ALPHA):
        self.alpha = alpha

    def fit(self, X, y):
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-6
        Xs = (X - self.mu) / self.sd
        A = Xs.T @ Xs + self.alpha * np.eye(X.shape[1])
        self.w = np.linalg.solve(A, Xs.T @ (y - y.mean()))
        self.b = float(y.mean())
        return self

    def predict(self, X):
        return ((X - self.mu) / self.sd) @ self.w + self.b


def build_pooled(feats, offs):
    if os.path.exists(CACHE):
        c = np.load(CACHE, allow_pickle=False)
        if c["P"].shape == (len(offs) - 1, 142):
            print(f"复用池化缓存 {CACHE}")
            return c["P"]
    t0 = time.time()
    P = np.empty((len(offs) - 1, 142), dtype=np.float64)
    for i in range(len(P)):
        P[i] = pool(feats[offs[i]:offs[i + 1]].astype(np.float64))
    np.savez_compressed(CACHE, P=P)
    print(f"池化 142 维完成（{time.time() - t0:.0f}s）→ {CACHE}")
    return P


# ────────────────────────── 数据批处理 ──────────────────────────
def make_batches(idx, offs, bs=BS, shuffle=True, rng=None):
    """按长度排序后切块（减少 padding），块顺序打乱。"""
    idx = list(idx)
    idx.sort(key=lambda i: offs[i + 1] - offs[i])
    chunks = [idx[k:k + bs] for k in range(0, len(idx), bs)]
    if shuffle and rng is not None:
        rng.shuffle(chunks)
    return chunks


def stack_patches(feats, offs, batch, patch=PATCH, mu=None, sd=None):
    """返回 x[B,T,20]、tokmask[B,T]、padmask[B,L]。"""
    lens = [offs[i + 1] - offs[i] for i in batch]
    L = max(lens)
    T = (L + patch - 1) // patch
    Lp = T * patch
    x = np.zeros((len(batch), Lp, feats.shape[1]), dtype=np.float32)
    m = np.zeros((len(batch), Lp), dtype=bool)
    for j, i in enumerate(batch):
        n = lens[j]
        x[j, :n] = feats[offs[i]:offs[i + 1]]
        m[j, :n] = True
    if mu is not None:
        x = (x - mu) / sd          # 20 维量级差 2 个数量级（dim17 到 181、dim8 到 1），不标准化学不动
        x *= m[..., None]
    x = x.reshape(len(batch), T, patch * feats.shape[1])
    tok = m.reshape(len(batch), T, patch).any(-1)
    return (torch.from_numpy(x), torch.from_numpy(tok), torch.from_numpy(m))


def norm_stats(feats, offs, idx, chunk=1_000_000):
    """事件级逐维均值/标准差（只用训练谱统计，避免测试集泄漏）。"""
    s = np.zeros(feats.shape[1], dtype=np.float64)
    s2 = np.zeros(feats.shape[1], dtype=np.float64)
    cnt = 0
    buf = []
    for i in idx:
        buf.append(feats[offs[i]:offs[i + 1]])
        if sum(len(b) for b in buf) >= chunk:
            a = np.concatenate(buf).astype(np.float64)
            s += a.sum(0); s2 += (a * a).sum(0); cnt += len(a); buf = []
    if buf:
        a = np.concatenate(buf).astype(np.float64)
        s += a.sum(0); s2 += (a * a).sum(0); cnt += len(a)
    mu = s / cnt
    sd = np.sqrt(np.maximum(s2 / cnt - mu * mu, 0)) + 1e-3
    return mu.astype(np.float32), sd.astype(np.float32)


# ────────────────────────── 模型 ──────────────────────────
class SeqDiffNet(nn.Module):
    """patch 嵌入（8 事件 → 1 token）→ 深度可分离卷积 → biGRU → attention pooling。

    · patch 嵌入保留片内全部 20×8 原始值，不做均值 —— 均值会把「这一片里有没有一个
      跳跃距离 0.8 的甩手」这种尖峰抹平，而尖峰正是难度的来源。
    · 额外喂入该片的 Σdt（真实时长）与有效事件比例：同是 8 个事件，
      挤在 0.3 秒里和摊在 2 秒里难度完全不同，卷积看不见这件事。
    · attention pooling 而非 mean：难段是稀疏的。
    """

    def __init__(self, d_in=20, d=D_MODEL, hidden=HIDDEN, patch=PATCH, n_side=0):
        super().__init__()
        self.patch = patch
        self.n_side = n_side
        self.embed = nn.Sequential(
            nn.Linear(patch * d_in + 2, d),
            nn.LayerNorm(d),
            nn.GELU(),
        )
        # 深度可分离卷积：让相邻若干片（≈数秒）先在局部混一次，降低 GRU 的记忆负担
        self.dw = nn.Conv1d(d, d, 5, padding=2, groups=d)
        self.pw = nn.Conv1d(d, d, 1)
        self.norm = nn.LayerNorm(d)
        self.gru = nn.GRU(d, hidden, batch_first=True, bidirectional=True)
        self.att = nn.Linear(2 * hidden, 1)
        # n_side>0：谱级手型特征拼在池化向量后面再进线性头（见 --handshape）
        self.head = nn.Sequential(nn.LayerNorm(2 * hidden),
                                  nn.Linear(2 * hidden + n_side, 1))

    def forward(self, x, tok, padmask, side=None):
        B, T, Fp = x.shape
        P = self.patch
        d_in = Fp // P
        xf = x.view(B, T, P, d_in)
        pm = padmask.view(B, T, P)
        nvalid = pm.float().sum(-1)
        dt = (xf[..., 0] * pm.float()).sum(-1)                 # 片内真实时长（秒）
        frac = nvalid / P
        # 无效片清零，避免 dt 累加出伪信息
        z = self.embed(torch.cat([xf.reshape(B, T, Fp),
                                  dt.unsqueeze(-1),
                                  frac.unsqueeze(-1)], dim=-1))
        z = z * tok.unsqueeze(-1).float()
        h = z.transpose(1, 2)
        h = h + self.pw(F.gelu(self.dw(h)))
        h = self.norm(h.transpose(1, 2))
        h, _ = self.gru(h)
        a = self.att(h).squeeze(-1).masked_fill(~tok, -1e4)
        w = a.softmax(-1)
        g = self.head[0]((w.unsqueeze(-1) * h).sum(1))
        if self.n_side:
            if side is None:
                raise ValueError("模型带手型特征，但 forward 没收到 side")
            g = torch.cat([g, side], dim=-1)
        return self.head[1](g).squeeze(-1)


# ────────────────────────── 训练 ──────────────────────────
def side_z(S, hs_mu, hs_sd, clip=8.0):
    """谱级手型特征逐维标准化（只用训练谱的均值/方差），并裁 ±clip 挡极端值。"""
    if S is None:
        return None
    return np.clip((S - hs_mu) / hs_sd, -clip, clip).astype(np.float32)


def predict(model, feats, offs, idx, mu, sd, Z=None):
    """⚠ 必须按 idx 的原始顺序返回：make_batches 会按长度重排，
    直接 concat 会与标签错位（这曾让首版跑出 ρ≈0 的假结果）。"""
    idx = list(idx)
    pos = {int(i): k for k, i in enumerate(idx)}
    out = np.empty(len(idx), dtype=np.float64)
    model.eval()
    with torch.no_grad():
        for b in make_batches(idx, offs, bs=64, shuffle=False):
            x, tok, pm = stack_patches(feats, offs, b, mu=mu, sd=sd)
            side = torch.from_numpy(Z[b]) if Z is not None else None
            p = model(x, tok, pm, side).numpy()
            for j, i in enumerate(b):
                out[pos[int(i)]] = p[j]
    return out


def train_one(seed, tr, sel, feats, offs, yz, mu, sd, epochs, log=print, Z=None):
    """训练一个模型，用 inner-val 的 ρ 选 epoch，返回最佳权重与曲线。"""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    n_side = 0 if Z is None else Z.shape[1]
    model = SeqDiffNet(d_in=feats.shape[1], n_side=n_side)
    npar = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    lossf = nn.MSELoss()

    best, best_state, hist = -9.0, None, []
    t0 = time.time()
    for ep in range(1, epochs + 1):
        model.train()
        tot, nb = 0.0, 0
        for b in make_batches(tr, offs, bs=BS, shuffle=True, rng=rng):
            x, tok, pm = stack_patches(feats, offs, b, mu=mu, sd=sd)
            side = torch.from_numpy(Z[b]) if Z is not None else None
            loss = lossf(model(x, tok, pm, side), torch.from_numpy(yz[b]))
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tot += loss.item()
            nb += 1
        sched.step()
        ps = predict(model, feats, offs, sel, mu, sd, Z)
        rho = spearman(ps, yz[sel])
        hist.append({"epoch": ep, "train_mse": round(tot / max(nb, 1), 4),
                     "inner_rho": round(rho, 4)})
        mark = ""
        if rho > best:
            best, best_state = rho, {k: v.detach().clone() for k, v in model.state_dict().items()}
            mark = "  ← best"
        log(f"    ep{ep:2d} loss {tot / max(nb, 1):.4f} · inner_ρ {rho:.4f}{mark}"
            f" · {(time.time() - t0) / 60:.1f} min", flush=True)
    model.load_state_dict(best_state)
    return model, npar, best, hist, best_state


# ────────────────────────── 配对检验 ──────────────────────────
def paired_bootstrap(p_seq, p_ridge, y, n_boot=N_BOOT):
    n = len(y)
    rng = np.random.default_rng(BOOT_SEED)
    d_rho = np.empty(n_boot)
    d_mae = np.empty(n_boot)
    for b in range(n_boot):
        s = rng.integers(0, n, n)
        d_rho[b] = spearman(p_seq[s], y[s]) - spearman(p_ridge[s], y[s])
        d_mae[b] = mae(p_seq[s], y[s]) - mae(p_ridge[s], y[s])

    def ci(v):
        return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))

    return {"d_rho": float(spearman(p_seq, y) - spearman(p_ridge, y)),
            "ci_rho": ci(d_rho), "p_win_rho": float((d_rho > 0).mean()),
            "d_mae": float(mae(p_seq, y) - mae(p_ridge, y)),
            "ci_mae": ci(d_mae)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="1")
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    ap.add_argument("--threads", type=int, default=14)
    ap.add_argument("--out", default=os.path.join(OUTDIR, "seq-model-result.json"))
    ap.add_argument("--handshape", default=None,
                    help="谱级手型特征 npz（build_handshape_extent.py 产物）；给了就拼进头部")
    ap.add_argument("--tag", default="", help="输出文件名后缀，避免覆盖已有结果")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    torch.set_num_threads(args.threads)
    z = np.load(DATA, allow_pickle=False)
    feats, offs, y = z["feats"], z["offs"], z["y"].astype(np.float64)
    n = len(y)
    print(f"数据 {n:,} 张谱 · {len(feats):,} 事件 · {feats.shape[1]} 维")

    # ── 切分（外层，与全仓库一致）──
    if GROUP_SPLIT:
        # 按谱面内容哈希分组切分：同一份谱（不同 id 上传）不跨集。
        # 见 tools/group_split.py 与 docs/结果/数据审计-泄漏与标签.md
        from group_split import group_ids, split as gsplit
        zz = np.load(os.path.join(ROOT, "data", "seq-dataset-v0.1-beta.2.npz"), allow_pickle=True)
        all_ids = [str(x) for x in zz["ids"]]
        keep = [i for i in range(n) if i < len(all_ids)]
        gid = group_ids([all_ids[i] for i in keep])
        tr_g, te_g = gsplit(gid, test_frac=0.15, seed=SEED)
        tr_all, te = keep and np.array(tr_g), np.array(te_g)
        print(f"分组切分：训练 {len(tr_all)}，测试 {len(te)}")
    else:
        perm = np.random.default_rng(SEED).permutation(n)
        cut = int(n * 0.85)
        tr_all, te = perm[:cut], perm[cut:]
    # inner val：只在训练集内部，用于选 epoch
    rin = np.random.default_rng(SEED + 1).permutation(len(tr_all))
    n_in = int(len(tr_all) * INNER_FRAC)
    sel, tr = tr_all[rin[:n_in]], tr_all[rin[n_in:]]
    print(f"训练 {len(tr):,} · 内部验证 {len(sel):,} · 测试 {len(te):,}")

    # 长度分布：确认没有因为太长丢样本
    lens = np.diff(offs)
    print(f"长度 min {lens.min()} / 中位 {np.median(lens):.0f} / max {lens.max()}")

    mu, sd = norm_stats(feats, offs, tr)
    ym, ys = float(y[tr].mean()), float(y[tr].std())
    yz = ((y - ym) / ys).astype(np.float32)

    # ── 可选：谱级手型特征（256 维 A_extent）──
    S, Z, hs_mu, hs_sd = None, None, None, None
    if args.handshape:
        hs = np.load(args.handshape, allow_pickle=False)
        assert [str(k) for k in hs["ids"]] == [str(k) for k in z["ids"]], \
            "手型特征与数据集不同序"
        S = hs["E"].astype(np.float64)
        hs_mu, hs_sd = S[tr].mean(0), S[tr].std(0) + 1e-6
        Z = side_z(S, hs_mu, hs_sd)
        print(f"手型特征 {S.shape[1]} 维 · 已按训练集均值/方差标准化并裁 ±8")

    # ── 基线 ──
    P = build_pooled(feats, offs)
    ridge = Ridge().fit(P[tr], y[tr])
    p_ridge = ridge.predict(P[te])
    rho_r, mae_r = spearman(p_ridge, y[te]), mae(p_ridge, y[te])
    # 参照：岭回归不需要内部验证集，可以用满训练集（6,378 张）。
    # 主比较用 p_ridge（同样只吃 5,741 张），这一行只是交代「多给数据能到多少」。
    p_ridge_full = Ridge().fit(P[tr_all], y[tr_all]).predict(P[te])
    print(f"\n岭回归(142维) 测试：ρ {rho_r:.4f} · MAE {mae_r:.4f}   [同训练集 5,741 张]")
    print(f"  参照：岭回归吃满 {len(tr_all):,} 张 → ρ {spearman(p_ridge_full, y[te]):.4f} "
          f"· MAE {mae(p_ridge_full, y[te]):.4f}")

    # 可选：同一训练集上的「岭回归 + 手型特征」，用于和序列模型配对比 + 集成
    p_ridge_ext = None
    if S is not None:
        p_ridge_ext = Ridge().fit(np.concatenate([P, S], 1)[tr], y[tr]) \
            .predict(np.concatenate([P, S], 1)[te])
        print(f"岭回归(142+{S.shape[1]}维) 测试：ρ {spearman(p_ridge_ext, y[te]):.4f} "
              f"· MAE {mae(p_ridge_ext, y[te]):.4f}   [同训练集 {len(tr)} 张]")

    # ── 序列模型 ──
    results = []
    # ⚠ 这里曾写成 `for sd in seeds`，把上面的特征标准差数组 sd 覆盖成整数种子，
    # 导致三个 seed 各自用了完全不同的（错误的）输入缩放。变量名不得再叫 sd。
    assert isinstance(sd, np.ndarray) and sd.shape[1:] == () and sd.shape[0] == 20, \
        "特征标准差 sd 被覆盖了"
    for seed_k in seeds:
        print(f"\n── seed {seed_k} ──")
        model, npar, inner, hist, best_state = train_one(
            seed_k, tr, sel, feats, offs, yz, mu, sd, args.epochs, Z=Z)
        pz = predict(model, feats, offs, te, mu, sd, Z)
        p_seq = pz * ys + ym
        rho_s, mae_s = spearman(p_seq, y[te]), mae(p_seq, y[te])
        print(f"  测试：ρ {rho_s:.4f} · MAE {mae_s:.4f} · 参数量 {npar:,}")
        ck = {"model": best_state, "ym": ym, "ys": ys, "seed": seed_k,
              "mu": torch.from_numpy(mu), "sd": torch.from_numpy(sd)}
        if S is not None:
            ck["side_mu"] = torch.from_numpy(hs_mu.astype(np.float32))
            ck["side_sd"] = torch.from_numpy(hs_sd.astype(np.float32))
        torch.save(ck, os.path.join(OUTDIR, f"seq-model{args.tag}-s{seed_k}.pt"))
        np.save(os.path.join(OUTDIR, f"seq-pred{args.tag}-s{seed_k}.npy"), p_seq)
        results.append({"seed": seed_k, "params": npar, "inner_rho": inner,
                        "rho": rho_s, "mae": mae_s, "history": hist,
                        "pred": p_seq.tolist()})

    rhos = np.array([r["rho"] for r in results])
    print(f"\nρ 跨 {len(rhos)} 个 seed：{rhos.round(4).tolist()} "
          f"· 均值 {rhos.mean():.4f} · sd {rhos.std(ddof=1) if len(rhos) > 1 else float('nan'):.4f}")

    # ── 配对检验（多种子时用均值）──
    p_mean = np.mean([r["pred"] for r in results], axis=0)
    boot = paired_bootstrap(p_mean, p_ridge, y[te])
    print(f"配对 bootstrap（vs 142 维岭回归）：Δρ {boot['d_rho']:+.4f} · 95%CI "
          f"[{boot['ci_rho'][0]:+.4f}, {boot['ci_rho'][1]:+.4f}] · "
          f"ΔMAE {boot['d_mae']:+.4f} [{boot['ci_mae'][0]:+.4f}, {boot['ci_mae'][1]:+.4f}]")

    # 与「岭回归 + 手型特征」比：这才是"叠加了吗"的关键对照；顺带做等权集成
    boot_ext, boot_ens, p_ens = None, None, None
    if p_ridge_ext is not None:
        boot_ext = paired_bootstrap(p_mean, p_ridge_ext, y[te])
        print(f"配对 bootstrap（vs 142+{S.shape[1]} 岭回归）：Δρ {boot_ext['d_rho']:+.4f} "
              f"· 95%CI [{boot_ext['ci_rho'][0]:+.4f}, {boot_ext['ci_rho'][1]:+.4f}]")
        zs = lambda v: (v - v.mean()) / (v.std() + 1e-9)
        p_ens = 0.5 * (zs(p_mean) + zs(p_ridge_ext)) * ys + ym
        boot_ens = paired_bootstrap(p_ens, p_mean, y[te])
        print(f"等权集成（seq + 岭回归×手型）：ρ {spearman(p_ens, y[te]):.4f} "
              f"· 对 seq 的 Δρ {boot_ens['d_rho']:+.4f} "
              f"[{boot_ens['ci_rho'][0]:+.4f}, {boot_ens['ci_rho'][1]:+.4f}]")

    # ── 按谱长分组（阈值与岭回归那份一致：≤925 / ≥1327）──
    tl = np.diff(offs)[te]
    SHORT_MAX, LONG_MIN = 925, 1327
    masks = (("short", tl <= SHORT_MAX), ("all", np.ones(len(te), bool)),
             ("long", tl >= LONG_MIN))
    buckets = {}
    for name, m in masks:
        b = {"n": int(m.sum()), "events": [int(tl[m].min()), int(tl[m].max())],
             "rho_ridge": spearman(p_ridge[m], y[te][m]),
             "rho_seq": spearman(p_mean[m], y[te][m])}
        b["d_rho"] = b["rho_seq"] - b["rho_ridge"]
        if p_ridge_ext is not None:
            b["rho_ridge_ext"] = spearman(p_ridge_ext[m], y[te][m])
            b["rho_ens"] = spearman(p_ens[m], y[te][m])
        d = paired_bootstrap(p_mean[m], p_ridge[m], y[te][m])
        b["ci_vs_ridge"] = d["ci_rho"]
        b["boot_seq_vs_ridge"] = d
        if p_ridge_ext is not None:
            b["boot_seq_vs_ridge_ext"] = paired_bootstrap(p_mean[m], p_ridge_ext[m], y[te][m])
        buckets[name] = b
        extra = (f" · 岭回归+手型 {b['rho_ridge_ext']:.1%} · 集成 {b['rho_ens']:.1%}"
                 if p_ridge_ext is not None else "")
        print(f"  {name:5s} n={b['n']:4d} · ρ 岭回归 {b['rho_ridge']:.1%} → "
              f"seq {b['rho_seq']:.1%} ({b['d_rho']:+.4f}){extra}")

    out = {"n_total": int(n), "n_train": len(tr), "n_inner": len(sel), "n_test": len(te),
           "covered": int(len(te)), "ridge": {"rho": rho_r, "mae": mae_r},
           "ridge_full": {"rho": spearman(p_ridge_full, y[te]),
                          "mae": mae(p_ridge_full, y[te]), "n_train": len(tr_all)},
           "handshape": None if S is None else {"dims": int(S.shape[1]),
                                                "npz": os.path.basename(args.handshape)},
           "seq": {"params": results[0]["params"], "rho_mean": float(rhos.mean()),
                   "rho_sd": float(rhos.std(ddof=1)) if len(rhos) > 1 else None,
                   "per_seed": [{k: v for k, v in r.items() if k not in ("pred", "history")}
                                for r in results]},
           "paired": boot, "paired_vs_ridge_ext": boot_ext,
           "ensemble": None if p_ens is None else {
               "rho": spearman(p_ens, y[te]), "mae": mae(p_ens, y[te]),
               "vs_seq": boot_ens},
           "ridge_ext": None if p_ridge_ext is None else {
               "rho": spearman(p_ridge_ext, y[te]), "mae": mae(p_ridge_ext, y[te])},
           "buckets": buckets,
           "preds": {"ridge": p_ridge.tolist(), "seq": p_mean.tolist(),
                     "ridge_ext": None if p_ridge_ext is None else p_ridge_ext.tolist(),
                     "ens": None if p_ens is None else p_ens.tolist(),
                     "gold": y[te].tolist(), "ids": [str(i) for i in z["ids"][te]]}}
    json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
