#!/usr/bin/env python3
"""在**事件序列**上训一个小 transformer，预测玩家实测难度 b。

━━━ 要回答的唯一问题 ━━━
序列里的信息，是否多于 49 维摘要？
判据：val 上的 Spearman 能否超过 ridge（49 维）的 **0.752**。
超不过，就说明"上 transformer"在这个数据集上不成立，后面租卡训 0.6B 也没意义。

━━━ 架构（为什么长这样）━━━
  逐事件 10 维 → Linear 64
    → 3 层**膨胀卷积**（dilation 1/2/4，kernel 5）
      感受野约 0.1s~2s：音符级手型、小节级连打都能覆盖，且比 attention 便宜
    → stride 4 下采样（2,000 事件 → 500 位）
    → 2 层 TransformerEncoder（d=64, 4 头）
      全序列两两交互：这一段难不难，跟前面 20 秒怎么排的有关
    → attention pooling（不是 mean：难段是稀疏的，平均会把尖峰抹平）
    → 标量

  参数量约 15 万 —— 故意小。目标是验证**信息**，不是刷分；
  样本只有几千张谱，再大就过拟合。

━━━ 标签 ━━━
  b（玩家实测难度，分半信度 0.9999）。**不用声明定数** —— 那把尺子一半是噪声。
"""
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DATA = os.path.join(ROOT, "seq-dataset.npz")
CKPT = os.path.join(ROOT, "seq-model.pt")
OUT = os.path.join(ROOT, "seq-result.json")
SEED = 20261028
D_MODEL = 64


class SeqNet(nn.Module):
    """先降采样再卷积 —— 实测这样快 6~8 倍。

    ⚠ 第一版是「卷积跑在原长度上、最后才 stride 4」，实测 30 样本/秒（L=300），
    原因不是注意力，是 64 通道 × kernel 5 × 3 块卷积在 1,000 长度上做了
    太多无用功（相邻音符之间信息高度冗余）。先把事件 4 个并 1 个，
    卷积再跑在 1/4 长度上，感受野不变但计算量掉到 1/4。
    """

    def __init__(self, d_in=10, d=D_MODEL):
        super().__init__()
        self.inp = nn.Sequential(nn.Linear(d_in, d), nn.GELU())
        self.stem = nn.Conv1d(d, d, 4, stride=4)          # 4 事件 → 1 位
        self.conv = nn.ModuleList()
        for dil in (1, 2, 4):
            self.conv.append(nn.Sequential(
                nn.Conv1d(d, d, 5, padding=2 * dil, dilation=dil, groups=4),  # 分组：再省 4 倍
                nn.GELU(), nn.Conv1d(d, d, 1)))
        self.norm = nn.LayerNorm(d)
        enc = nn.TransformerEncoderLayer(d, 4, 2 * d, dropout=0.1, batch_first=True,
                                         norm_first=True)
        self.enc = nn.TransformerEncoder(enc, 1)
        self.pool_q = nn.Parameter(torch.randn(1, 1, d) * 0.02)
        self.head = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 1))

    def forward(self, x, mask):
        """x: [B,L,F]  mask: [B,L] bool（True=有效）"""
        h = self.inp(x) * mask.unsqueeze(-1).float()      # [B,L,D]，padding 清零
        h = self.stem(h.transpose(1, 2)).transpose(1, 2)  # [B,L/4,D]
        m4 = mask[:, ::4][:, :h.shape[1]]
        h = h * m4.unsqueeze(-1).float()
        h = h.transpose(1, 2)                             # [B,D,L/4]
        for blk in self.conv:
            h = h + blk(h)
        h = self.norm(h.transpose(1, 2))                  # [B,L/4,D]
        h = self.enc(h, src_key_padding_mask=~m4)
        q = self.pool_q.expand(h.shape[0], -1, -1)
        att = (q @ h.transpose(1, 2)).squeeze(1) / math.sqrt(h.shape[-1])
        att = att.masked_fill(~m4, -1e4).softmax(-1)
        g = (att.unsqueeze(-1) * h).sum(1)
        return self.head(g).squeeze(-1)


def spearman(a, b):
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    ra -= ra.mean()
    rb -= rb.mean()
    return float((ra * rb).sum() / math.sqrt((ra * ra).sum() * (rb * rb).sum()))


def make_batches(idx, offs, order_by_len=True, bs=32):
    """按长度分桶，减少 padding 浪费（谱面长度从几百到几千不等）。"""
    idx = list(idx)
    if order_by_len:
        idx.sort(key=lambda i: offs[i + 1] - offs[i])
        for k in range(0, len(idx), bs):
            yield idx[k:k + bs]
    else:
        rng = np.random.default_rng(SEED)
        rng.shuffle(idx)
        for k in range(0, len(idx), bs):
            yield idx[k:k + bs]


def stack(feats, offs, batch):
    lens = [offs[i + 1] - offs[i] for i in batch]
    L = max(lens)
    x = np.zeros((len(batch), L, feats.shape[1]), dtype=np.float32)
    m = np.zeros((len(batch), L), dtype=bool)
    for j, i in enumerate(batch):
        n = lens[j]
        x[j, :n] = feats[offs[i]:offs[i + 1]]
        m[j, :n] = True
    return torch.from_numpy(x), torch.from_numpy(m)


def main():
    torch.manual_seed(SEED)
    torch.set_num_threads(max(1, min(14, os.cpu_count() or 4)))
    if not os.path.exists(DATA):
        sys.exit("缺少 seq-dataset.npz，先跑 tools/build_seq_dataset.py")

    z = np.load(DATA, allow_pickle=False)
    feats = z["feats"].astype(np.float32)
    offs = z["offs"]
    y = z["y"]
    ids = z["ids"]
    n = len(y)
    print(f"数据：{n:,} 张谱 · {feats.shape[0]:,} 个事件 · {feats.shape[1]} 维特征")

    # 标准化标签（MSE 才好优化），并按谱面切分
    ym, ys = float(y.mean()), float(y.std() + 1e-9)
    yz = ((y - ym) / ys).astype(np.float32)
    rng = np.random.default_rng(SEED)
    perm = rng.permutation(n)
    cut = int(n * 0.85)
    tr, va = perm[:cut], perm[cut:]
    print(f"训练 {len(tr):,} · 验证 {len(va):,}")

    model = SeqNet()
    npar = sum(p.numel() for p in model.parameters())
    print(f"模型参数量 {npar:,}")

    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=30)
    lossf = nn.MSELoss()

    best = {"rho": -9, "epoch": -1}
    hist = []
    t0 = time.time()
    for ep in range(1, 31):
        model.train()
        tot = 0.0
        nb = 0
        for batch in make_batches(tr, offs, order_by_len=True, bs=32):
            x, m = stack(feats, offs, batch)
            t = torch.from_numpy(yz[batch])
            pred = model(x, m)
            loss = lossf(pred, t)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tot += loss.item()
            nb += 1
            if nb % 40 == 0:
                print(f"    batch {nb} · loss {tot / nb:.4f}", flush=True)
        sched.step()

        model.eval()
        ps, ts = [], []
        with torch.no_grad():
            for batch in make_batches(va, offs, order_by_len=True, bs=64):
                x, m = stack(feats, offs, batch)
                ps.append(model(x, m).numpy())
                ts.append(yz[batch])
        p = np.concatenate(ps)
        t = np.concatenate(ts)
        rho = spearman(p, t)
        mse = float(((p - t) ** 2).mean())
        hist.append({"epoch": ep, "loss": round(tot / max(nb, 1), 4),
                     "val_mse": round(mse, 4), "val_rho": round(rho, 4)})
        mark = ""
        if rho > best["rho"]:
            best = {"rho": rho, "epoch": ep, "mse": mse}
            torch.save({"model": model.state_dict(), "ym": ym, "ys": ys,
                        "d_model": D_MODEL, "epoch": ep, "rho": rho}, CKPT)
            mark = "  ← best"
        print(f"  epoch {ep:2d}  loss {tot / max(nb, 1):.4f}  val_mse {mse:.4f}  "
              f"val_ρ {rho:.4f}{mark}  ({time.time() - t0:.0f}s)", flush=True)

        if ep - best["epoch"] >= 8:
            print("  连续 8 个 epoch 无提升，早停。")
            break

    # 换算回原始尺度算最终指标
    model.load_state_dict(torch.load(CKPT)["model"])
    model.eval()
    ps, ts = [], []
    with torch.no_grad():
        for batch in make_batches(va, offs, order_by_len=False, bs=64):
            x, m = stack(feats, offs, batch)
            ps.append(model(x, m).numpy() * ys + ym)
            ts.append(y[batch])
    p = np.concatenate(ps)
    t = np.concatenate(ts)
    r2 = 1 - ((t - p) ** 2).sum() / ((t - t.mean()) ** 2).sum()
    rho = spearman(p, t)
    print("\n──── 最终（验证集，原始尺度）────")
    print(f"  Spearman {rho:.4f}   R² {r2:.4f}   RMSE {np.sqrt(((t - p) ** 2).mean()):.4f}")
    print(f"  基线（49 维 ridge）：ρ 0.752 / R² 0.532")
    print(f"  结论：{'序列更好' if rho > 0.752 else '序列没有更好'}（Δρ {rho - 0.752:+.4f}）")

    json.dump({"n_charts": int(n), "params": int(npar), "best": best, "history": hist,
               "final": {"spearman": round(rho, 4), "r2": round(float(r2), 4),
                         "rmse": round(float(np.sqrt(((t - p) ** 2).mean())), 4)},
               "baseline": {"spearman": 0.752, "r2": 0.532}},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"写出 {OUT}")


if __name__ == "__main__":
    main()
