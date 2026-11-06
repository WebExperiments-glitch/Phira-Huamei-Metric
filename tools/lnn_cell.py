"""液态时间常数单元（LNN 路线的核心，可独立自测）。

━━━ 它和 GRU 的唯一实质区别 ━━━
GRU 的"忘多快"是学出来的**离散比例**：h' = (1-z)·n + z·h，z 无量纲。
这里改成**有量纲的时间常数**：h' = h + (g - h)/τ · dt，τ 单位是秒。

为什么值得试：我们的 dt 极不规则（谱面密度在 0.02s 与 2s 之间跳），
而 τ 让模型能对"密度突变"作出与绝对时间尺度相关的反应，
这是无 Mass 的离散门控做不到的。

━━━ 与 CfC 原文的差异（必须先承认）━━━
Liquid Time-Constant Networks (Hasani 2021) 与 CfC (2022) 用闭式解
h(t) = σ(-f)t · g + [1 - σ(-f)t] · h0 来避免 ODE 求解。
这里用的是**一阶欧拉离散**（h + (g-h)/τ·dt），不是闭式解：
  · 好处：可读、可微、无需求 exp，数值稳定
  · 代价：dt 很大时与闭式解有偏差（已用 dt 截断缓解）
所以严格说这是「LTC 风格的一阶近似」，不是原版 CfC。文档与结论都按这个口径写。
"""
import torch
import torch.nn as nn


class LiquidCell(nn.Module):
    """单层液态单元。门控三路：f（衰减）、g（候选）、tau（时间常数）。"""

    def __init__(self, d_in, d_h, dt_scale=1.0):
        super().__init__()
        self.d_h = d_h
        self.dt_scale = dt_scale
        self.wx = nn.Linear(d_in, 3 * d_h)   # f, g, tau 一次算完
        self.wh = nn.Linear(d_h, 3 * d_h, bias=False)
        self.wt = nn.Parameter(torch.zeros(d_h))  # dt 对衰减门的直接调制

    def forward(self, xs, dts):
        """xs: (B, T, d_in)   dts: (B, T) 秒   返回 (B, T, d_h)"""
        B, T, _ = xs.shape
        h = xs.new_zeros(B, self.d_h)
        out = []
        for t in range(T):
            dt = dts[:, t].clamp(0.0, 3.0) * self.dt_scale          # 与 to_feats 的 3s 截断同口径
            z = self.wx(xs[:, t]) + self.wh(h)
            f_logit, g, tau_raw = z.chunk(3, dim=-1)
            f = torch.sigmoid(f_logit + self.wt * torch.log1p(dt).unsqueeze(-1))
            tau = nn.functional.softplus(tau_raw) + 1e-2            # 保证 > 0
            # 欧拉步：dt 归一化到「一个特征时间」的尺度，避免 dt 小时几乎不更新
            dtv = dt.unsqueeze(-1)                                  # (B,1) 对齐 (B,d_h)
            step = dtv / (tau + dtv)                                # ∈(0,1)，dt≫τ 时趋于 1
            h = h + (f * g - h) * step
            out.append(h)
        return torch.stack(out, dim=1)


def selftest():
    torch.manual_seed(0)
    B, T, d_in, d_h = 3, 12, 20, 8
    xs = torch.randn(B, T, d_in, requires_grad=True)
    dts = torch.rand(B, T) * 0.5 + 0.01
    cell = LiquidCell(d_in, d_h)

    y = cell(xs, dts)
    assert y.shape == (B, T, d_h), f"形状错：{y.shape}"
    assert torch.isfinite(y).all(), "出现 inf/nan"
    print(f"[OK ] 形状 {tuple(y.shape)}，数值有限")

    # 1) dt 敏感：同样的输入，dt 大 10 倍，状态应该走得更远
    y_small = cell(xs, dts * 0.1)
    y_big = cell(xs, dts * 10.0)
    d_small = (y_small[:, -1] - y_small[:, 0]).abs().mean().item()
    d_big = (y_big[:, -1] - y_big[:, 0]).abs().mean().item()
    assert d_big > d_small, "dt 不影响状态演化 = 没起到连续时间的作用"
    print(f"[OK ] dt 敏感：dt×0.1 位移 {d_small:.4f} < dt×10 位移 {d_big:.4f}")

    # 2) 梯度能回传（否则训练不动）
    y.sum().backward()
    g = xs.grad.abs().mean().item()
    assert g > 0 and torch.isfinite(xs.grad).all(), "梯度为 0 或非有限"
    print(f"[OK ] 梯度回传，|grad| 均值 {g:.6f}")

    # 3) 稳定性：极端 dt（0 与 3 秒）不应发散
    for name, dd in [("dt=0", torch.zeros(B, T)), ("dt=3s", torch.full((B, T), 3.0))]:
        yy = cell(xs, dd)
        assert torch.isfinite(yy).all() and yy.abs().max() < 1e3, f"{name} 发散"
        print(f"[OK ] {name} 稳定，max|h|={yy.abs().max():.3f}")

    # 4) 参数量
    n = sum(p.numel() for p in cell.parameters())
    print(f"[OK ] 单元参数量 {n}（d_in=20, d_h=8）")


if __name__ == "__main__":
    selftest()
