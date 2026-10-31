#!/usr/bin/env python3
"""在 Intel Arc (XPU) 上实测 Qwen3-0.6B 的 LoRA 训练吞吐。

为什么要实测：之前的估算（55–110 token/s）是从峰值算力推的，
而 iGPU 跟独显差别很大（共享内存、驱动开销、算子覆盖）。
跑一次真实的前向+反向，比任何估算都可靠。

输出：token/s、显存占用、以及按这个速度「一个 epoch 要多久」。
"""
import json
import os
import time

import torch

MODEL = "D:/models/Qwen3-0.6B"
PILOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "llm-pilot.jsonl")


def main():
    from transformers import AutoModelForCausalLM, AutoTokenizer

    assert torch.xpu.is_available(), "XPU 不可用"
    print(f"设备: {torch.xpu.get_device_name(0)}")

    tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.float16,
                                                 low_cpu_mem_usage=True)
    model = model.to("xpu")
    torch.xpu.empty_cache()
    print(f"加载耗时 {time.time() - t0:.1f}s · 参数量 {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M")
    print(f"权重精度 {next(model.parameters()).dtype} · 已占 "
          f"{torch.xpu.memory_allocated() / 1e9:.2f} GB · 总容量 "
          f"{torch.xpu.get_device_properties(0).total_memory / 1e9:.1f} GB")
    model.config.use_cache = False

    # 手写 LoRA：peft 0.21 与 transformers 5.21 不兼容（BloomPreTrainedModel 已被移除），
    # 而 LoRA 本身只有 20 行 —— 少一个依赖就少一类版本地狱。
    class LoRALinear(torch.nn.Module):
        def __init__(self, base, r=16, alpha=32):
            super().__init__()
            self.base = base
            for q in self.base.parameters():
                q.requires_grad = False
            # ⚠ 必须跟基础层同设备同精度：模型已经 .to("xpu") 了，
            # 新建的 Linear 默认在 CPU，前向会当场报 device mismatch。
            dev, dt = base.weight.device, base.weight.dtype
            self.A = torch.nn.Linear(base.in_features, r, bias=False).to(dev, dt)
            self.B = torch.nn.Linear(r, base.out_features, bias=False).to(dev, dt)
            torch.nn.init.kaiming_uniform_(self.A.weight, a=5 ** 0.5)
            torch.nn.init.zeros_(self.B.weight)
            self.scale = alpha / r

        def forward(self, x):
            return self.base(x) + self.B(self.A(x)) * self.scale

    n_rep = 0
    for blk in model.model.layers:
        for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
            setattr(blk.self_attn, name, LoRALinear(getattr(blk.self_attn, name)))
            n_rep += 1
    for q in model.parameters():
        q.requires_grad = False
    for m in model.modules():
        if isinstance(m, LoRALinear):
            m.A.weight.requires_grad_(True)
            m.B.weight.requires_grad_(True)
    model.train()
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()   # 开了检查点时必须：否则计算图在此断开
    print(f"注入 LoRA 到 {n_rep} 个投影层")
    tr = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"LoRA 可训练参数 {tr:,}")

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4)

    rows = [json.loads(l) for l in open(PILOT, encoding="utf-8")][:2]
    for maxlen in (256, 512):
        # 组装 batch：system + prompt → target
        texts = []
        for r in rows:
            msgs = [{"role": "system", "content": r["system"]},
                    {"role": "user", "content": r["prompt"]},
                    {"role": "assistant", "content": r["target"]}]
            texts.append(tok.apply_chat_template(msgs, tokenize=False))
        enc = tok(texts, return_tensors="pt", padding=True, truncation=True,
                  max_length=maxlen)
        ids = enc["input_ids"].to("xpu")
        att = enc["attention_mask"].to("xpu")
        labels = ids.clone()

        # 预热一次（首次有 kernel 编译开销，不能计入）
        out = model(input_ids=ids, attention_mask=att, labels=labels)
        out.loss.backward()
        opt.zero_grad(set_to_none=True)
        torch.xpu.synchronize()

        t0 = time.time()
        K = 2
        for _ in range(K):
            out = model(input_ids=ids, attention_mask=att, labels=labels)
            out.loss.backward()
            opt.step()
            opt.zero_grad(set_to_none=True)
        torch.xpu.synchronize()
        dt = (time.time() - t0) / K

        ntok = int(att.sum())
        print(f"\nmaxlen={maxlen}  batch={len(texts)}  实际 token {ntok}")
        print(f"  每步 {dt * 1000:.0f} ms → **{ntok / dt:.0f} token/秒**")
        print(f"  显存占用 {torch.xpu.memory_allocated() / 1e9:.2f} GB "
              f"(峰值 {torch.xpu.max_memory_allocated() / 1e9:.2f} GB)")

        # 换算：pilot 300 条 ≈ 893k token（含 target），一个 epoch 多久
        for name, toks in (("pilot 300 条约 893k token", 893_000),
                           ("全量 5,411 条约 16M token", 16_000_000)):
            h = toks / (ntok / dt) / 3600
            print(f"  {name} → 一个 epoch 约 {h:.1f} 小时")


if __name__ == "__main__":
    main()
