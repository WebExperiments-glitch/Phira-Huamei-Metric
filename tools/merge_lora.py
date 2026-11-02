#!/usr/bin/env python3
"""把 LoRA 适配器合并进 Qwen3-0.6B 基座，导出完整模型。

━━━ 为什么要合并 ━━━
LoRA 只有 18 MB，单独发出去别人还得自己写注入代码（我们就是手写的那 20 行）。
合并成完整权重后，`from_pretrained` 一行就能用 —— 对"可行性研究存档"来说，
可复现比体积重要。
（代价：1.2 GB vs 18 MB。所以两个都留：适配器给研究者，合并版给使用者。）

用法：
    python tools/merge_lora.py <adapter.pt> [输出目录]
"""
import os
import sys

import torch

BASE = "D:/models/Qwen3-0.6B"
OUT_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "release", "phm-difficulty-qwen3-0.6b")


class LoRALinear(torch.nn.Module):
    """必须与训练时逐字一致（键名、scale、初始化都不参与推理但要同构）。"""

    def __init__(self, base, r=16, alpha=32):
        super().__init__()
        self.base = base
        for p in base.parameters():
            p.requires_grad = False
        dev = base.weight.device
        self.A = torch.nn.Linear(base.in_features, r, bias=False).to(dev)
        self.B = torch.nn.Linear(r, base.out_features, bias=False).to(dev)
        self.scale = alpha / r

    def forward(self, x):
        d = self.B(self.A(x)) * self.scale
        return self.base(x) + d.to(x.dtype)


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python tools/merge_lora.py <adapter.pt> [输出目录]")
    ckpt_path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else OUT_DEFAULT

    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"载入基座 {BASE}")
    model = AutoModelForCausalLM.from_pretrained(
        BASE, torch_dtype=torch.float32, low_cpu_mem_usage=True)
    tok = AutoTokenizer.from_pretrained(BASE)

    # 注入与训练时同构的 LoRA 层
    n = 0
    for blk in model.model.layers:
        for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
            setattr(blk.self_attn, name, LoRALinear(getattr(blk.self_attn, name)))
            n += 1
    print(f"注入 {n} 层")

    ck = torch.load(ckpt_path, map_location="cpu")
    sd = ck["model"] if "model" in ck else ck
    missing, unexpected = model.load_state_dict(sd, strict=False)
    loaded = [k for k in sd if k.endswith(("A.weight", "B.weight"))]
    print(f"适配器键 {len(loaded)} 个 · 未匹配 {len(missing)} · 多余 {len(unexpected)}")
    if len(loaded) < n * 2:
        sys.exit(f"⚠ 适配器键数不足（期望 {n*2}），权重可能不完整")

    # 合并：W' = W + scale · B @ A，然后把 LoRA 层换回普通 Linear
    with torch.no_grad():
        for blk in model.model.layers:
            for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
                m = getattr(blk.self_attn, name)
                delta = (m.B.weight @ m.A.weight) * m.scale
                w = m.base.weight + delta.to(m.base.weight.dtype)
                lin = torch.nn.Linear(w.shape[1], w.shape[0], bias=False)
                lin.weight.copy_(w)
                lin = lin.to(m.base.weight.dtype)
                setattr(blk.self_attn, name, lin)
    print("合并完成")

    os.makedirs(out, exist_ok=True)
    model = model.half()
    model.save_pretrained(out, safe_serialization=True)
    tok.save_pretrained(out)
    size = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / 1e6
    print(f"导出到 {out}（{size:.0f} MB）")


if __name__ == "__main__":
    main()
