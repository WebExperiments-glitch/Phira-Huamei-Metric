#!/usr/bin/env python3
"""选择性状态空间（S6）序列模型：把真实 Δt 放进离散化步长。

━━━ 一句话 ━━━
CfC 的 τ(x,h) 和 Mamba 的 Δ(x)·A 是同一个机制（输入决定的时间常数），
区别只是「A 是网络」还是「A 是学出来的对角常量」。选常量换来的是**可并行**。

━━━ 怎么压缩时间 ━━━
朴素实现 `for t in range(L)`，L≈1,254 → 一次前向 1,254 次 Python 迭代。
这里用**分块闭式扫描**：块内用 cumprod/cumsum 一次算完，块间只传一次状态。
    顺序深度 = L / CHUNK（默认 32 → 约 40 步，而非 1,254 步）

━━━ 数值风险（必须防）━━━
块内累乘 exp(Δ·A) 会下溢。做法：
  1. A 有下界（A ≤ -1e-3），保证每步都有衰减、不会恒等
  2. 除法前 clamp，避免 0 除
  3. 自检：与朴素逐步递推做 allclose 对比（`python ssm_seq.py --selftest`）
"""
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
sys.path.insert(0, HERE)
from train_seq import DATA, SEED, make_batches, spearman, stack   # noqa: E402

D_MODEL = 96
D_STATE = 16
CHUNK = 32
EPOCHS = 16         # 每 epoch 约 10 分钟；有早停（连续 5 个 epoch 不涨就停）
GROUP = 4          # 4 个事件并 1 组（组内 dt 求和 = 这一「步」在连续时间里走了多久）


def selective_scan_chunked(dA, dBx_x, C, chunk=CHUNK):
    """分块闭式扫描。

    dA:    [B,L,D,N]  exp(Δ·A)，每步的衰减
    dBx_x: [B,L,D,N]  Δ·B·x
    C:     [B,L,N]    输出投影
    返回 y: [B,L,D]
    """
    B_, L, D, N = dA.shape
    h = torch.zeros(B_, D, N, device=dA.device, dtype=torch.float32)
    ys = []
    for c0 in range(0, L, chunk):
        seg = dA[:, c0:c0 + chunk].float()
        v = dBx_x[:, c0:c0 + chunk].float()
        cum = torch.cumprod(seg.clamp_min(1e-30), dim=1)          # [B,c,D,N]
        # v_s / cum_s 后做 cumsum，再乘回 cum_t → 得到 Σ_{s≤t}(Π_{s<r≤t} dA_r)·v_s
        vs = (v / cum.clamp_min(1e-30)).cumsum(dim=1)
        hs = cum * (vs + h.unsqueeze(1))
        h = hs[:, -1]
        ys.append(torch.einsum("bcdn,bcn->bcd", hs, C[:, c0:c0 + chunk].float()))
    return torch.cat(ys, dim=1).to(dA.dtype)


def selective_scan_naive(dA, dBx_x, C):
    """朴素逐步递推 —— 只用于自检，确认分块版算的是同一个东西。"""
    B_, L, D, N = dA.shape
    h = torch.zeros(B_, D, N, dtype=torch.float32)
    ys = []
    for t in range(L):
        h = dA[:, t].float() * h + dBx_x[:, t].float()
        ys.append(torch.einsum("bdn,bn->bd", h, C[:, t].float()))
    return torch.stack(ys, 1)


class GroupStem(nn.Module):
    """4 个事件并 1 组：特征是组内均值，Δ 用组内 dt 之和。

    ⚠ 关键：基线用的是 `Conv1d(stride=4)`，它把 4 个事件当成等距的 4 个 token，
    组的真实时长（0.05 秒还是 0.8 秒）从模型里消失了。这里改为**求和**，
    把「这一步在连续时间里走了多久」原样交给 SSM。
    """

    def __init__(self, d_in, d, group=GROUP):
        super().__init__()
        self.group, self.d = group, d
        self.proj = nn.Linear(d_in, d)

    def forward(self, x, mask):
        B_, L, Fdim = x.shape
        g = self.group
        pad = (-L) % g
        if pad:
            x = F.pad(x, (0, 0, 0, pad))
            mask = F.pad(mask, (0, pad))
        x = x.view(B_, -1, g, Fdim)
        m = mask.view(B_, -1, g).float()
        dt_sum = (x[..., 0] * m).sum(-1)                  # 组内真实时长（秒）
        feat = (x * m.unsqueeze(-1)).sum(-2) / m.sum(-1, keepdim=True).clamp_min(1.0)
        gm = m.sum(-1) > 0
        return self.proj(feat), dt_sum, gm


class SSMBlock(nn.Module):
    def __init__(self, d, d_state=D_STATE):
        super().__init__()
        self.d, self.n = d, d_state
        self.in_proj = nn.Linear(d, 2 * d)
        self.conv = nn.Conv1d(d, d, 4, padding=3, groups=d)      # 因果短卷积
        self.x_proj = nn.Linear(d, 2 * d_state + 1)              # Δ, B, C
        # ⚠ 关键初始化：Mamba 原论文把 dt_proj.bias 设到 dt_min≈0.001，
        # 让**初始记忆很长**，再由模型自己学短。不做这一步时：
        #   softplus(0)≈0.69 → Δ≈0.69×0.15s≈0.1 → Ā=exp(-0.1)=0.905
        #   → 记忆视界 ≈ 1/(1-Ā) ≈ 10 步 = **约 40 个音符**
        # 而中位谱面有 2,258 个音符 —— 模型一开始只能看局部，"难不难"却是全局属性。
        # 这里取 Δ_init=0.005 → 视界 ≈ 200 步 ≈ 800 个音符。
        with torch.no_grad():
            self.x_proj.bias[0] = math.log(math.exp(0.005) - 1.0)
        # 标准 Mamba 初始化：A[d,n] = -(n+1)，即第 n 个状态通道衰减率随 n 增大
        self.a_log = nn.Parameter(
            torch.log(torch.arange(1, d_state + 1, dtype=torch.float32).repeat(d, 1)))
        self.d_skip = nn.Parameter(torch.ones(d))
        self.out_proj = nn.Linear(d, d)
        self.norm = nn.LayerNorm(d)

    def forward(self, x, dt, gm):
        """x: [B,Lg,d]  dt: [B,Lg] 组内真实时长  gm: [B,Lg] 有效组掩码"""
        res = x
        u, z = self.in_proj(self.norm(x)).chunk(2, dim=-1)
        u = F.silu(u)
        u = self.conv(u.transpose(1, 2))[..., :x.shape[1]].transpose(1, 2)
        u = F.silu(u)

        dbl = self.x_proj(u)
        delta, Bm, Cm = dbl[..., :1], dbl[..., 1:1 + self.n], dbl[..., 1 + self.n:]
        # Δ = 真实时长 × softplus(内容决定的速度) —— 间隔越久，这一步走得越远
        delta = F.softplus(delta).squeeze(-1) * dt.clamp(min=0.0)
        delta = delta * gm.float()

        A = -torch.exp(self.a_log).clamp(max=-1e-3)                # [d,n]，恒为负
        # ⚠ delta 是 [B,L]，A 是 [d,n]：必须补齐成 [B,L,1,1] 才能广播到 [B,L,d,n]
        dA = torch.exp(delta.unsqueeze(-1).unsqueeze(-1) * A)
        dBx = delta.unsqueeze(-1).unsqueeze(-1) * Bm.unsqueeze(2) * u.unsqueeze(-1)
        y = selective_scan_chunked(dA, dBx, Cm) + self.d_skip * u
        y = y * F.silu(z)
        return res + self.out_proj(y)


class SSMNet(nn.Module):
    def __init__(self, d_in=24, d=D_MODEL, layers=2):
        super().__init__()
        self.stem = GroupStem(d_in, d)
        self.blocks = nn.ModuleList([SSMBlock(d) for _ in range(layers)])
        self.head = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 1))

    def forward(self, x, mask):
        h, dt, gm = self.stem(x, mask)
        for b in self.blocks:
            h = b(h, dt, gm)
        m = gm.unsqueeze(-1).float()
        feat = (h * m).sum(1) / m.sum(1).clamp_min(1.0)
        return self.head(feat).squeeze(-1)


def selftest():
    torch.manual_seed(0)
    B_, L, D, N = 2, 100, 4, 3
    dA = torch.exp(-torch.rand(B_, L, D, N) * 0.3)
    v = torch.randn(B_, L, D, N) * 0.1
    C = torch.randn(B_, L, N)
    y1 = selective_scan_chunked(dA, v, C)
    y2 = selective_scan_naive(dA, v, C)
    err = (y1 - y2).abs().max().item()
    print(f"分块扫描 vs 朴素递推：最大误差 {err:.2e} → {'通过' if err < 1e-4 else '不通过'}")
    assert err < 1e-4, "分块扫描与朴素实现不一致，不能用于训练"


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    torch.manual_seed(SEED)
    torch.set_num_threads(max(1, min(14, os.cpu_count() or 4)))
    z = np.load(DATA, allow_pickle=False)
    feats, offs, y = z["feats"].astype(np.float32), z["offs"], z["y"]
    ym, ys = float(y.mean()), float(y.std() + 1e-9)
    yz = ((y - ym) / ys).astype(np.float32)
    rng = np.random.default_rng(SEED)
    perm = rng.permutation(len(y))
    cut = int(len(y) * 0.85)
    tr, va = perm[:cut], perm[cut:]
    print(f"数据 {len(y):,} 张 · 训练 {len(tr):,} · 验证 {len(va):,}")

    model = SSMNet(d_in=z["feats"].shape[1])
    print(f"模型参数量 {sum(p.numel() for p in model.parameters()):,}（基线 79k）")
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)
    lossf = nn.MSELoss()
    best, best_state, best_pred, best_gold = -9, None, None, None
    stall = 0                     # 连续多少个 epoch 没刷新最佳
    t0 = time.time()
    for ep in range(1, EPOCHS + 1):
        if stall >= 5:
            print(f"  连续 5 个 epoch 没有刷新最佳，早停（省下 {EPOCHS - ep + 1} 个 epoch）")
            break
        model.train()
        tot, nb = 0.0, 0
        for batch in make_batches(tr, offs, order_by_len=True, bs=32):
            x, m = stack(feats, offs, batch)
            loss = lossf(model(x, m), torch.from_numpy(yz[batch]))
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            tot += loss.item()
            nb += 1
        sched.step()
        model.eval()
        ps, gs = [], []
        with torch.no_grad():
            for batch in make_batches(va, offs, order_by_len=False, bs=64):
                x, m = stack(feats, offs, batch)
                ps.extend((model(x, m).numpy() * ys + ym).tolist())
                gs.extend(y[batch].tolist())
        rho, mae = spearman(ps, gs), float(np.mean(np.abs(np.array(ps) - np.array(gs))))
        if rho > best:                      # 存最佳权重与预测，供事后做配对检验
            best, stall = rho, 0
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            best_pred, best_gold = list(ps), list(gs)
            # ⚠ 立即落盘：上一次跑到 ep6(0.7549) 被回收，全部丢失，白烧 80 分钟
            torch.save({"model": best_state, "rho": best, "ep": ep},
                       os.path.join(ROOT, "data", "ssm-best.pt"))
            json.dump({"rho": best, "ep": ep, "pred": best_pred, "gold": best_gold},
                      open(os.path.join(ROOT, "data", "ssm-preds.json"), "w"))
        else:
            stall += 1
        print(f"  ep{ep:2d} loss {tot / max(nb,1):.4f} · ρ {rho:.4f} · MAE {mae:.3f} "
              f"· {(time.time() - t0) / 60:.1f} 分", flush=True)
    print(f"\n最佳 ρ {best:.4f} · 判据：> 0.7506（基线） / 0.752（49 维 ridge）")

    # ── 落盘：权重 + 预测 ──
    # 为什么必须存：上一次跑到 ep6（ρ 0.7549）进程被回收，**全部丢失**，
    # 只能从头再来。没有 checkpoint 的长训练等于赌博。
    out = os.path.join(ROOT, "data")
    torch.save({"model": best_state, "rho": best}, os.path.join(out, "ssm-best.pt"))
    json.dump({"rho": best, "pred": best_pred, "gold": best_gold},
              open(os.path.join(out, "ssm-preds.json"), "w"))
    print(f"已保存 {out}/ssm-best.pt 与 ssm-preds.json（ρ {best:.4f}）")


if __name__ == "__main__":
    main()
