#!/usr/bin/env python3
"""Qwen3-0.6B + LoRA，在 Intel Arc (XPU) 上做难度预测的 pilot。

━━━ 设计要点 ━━━
1. **loss 只算目标那几个 token**：prompt 部分全部 mask 成 -100。
   否则模型会把力气花在复述谱面事件流上 —— 那是抄写，不是判断。
2. **目标只输出 3~4 个字符**（如 "14.7"）。数值回归走文本必然有量化损失，
   所以把输出压到最短，评测时解析成浮点算 Spearman，和前面所有实验同一把尺子。
3. **手写 LoRA**（r=16，只挂在 q/k/v/o）：peft 0.21 与 transformers 4.56 不兼容。
4. 设备层注意：新建的 Linear 必须 `.to(dev, dtype)`，否则前向当场 device mismatch。

━━━ 判据 ━━━
val 上 ρ > 0.7506（序列小模型）/ 0.752（49 维 ridge）才算有增益。
"""
import argparse
import json
import math
import os
import random
import time

import torch

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MODEL = "D:/models/Qwen3-0.6B"
PILOT = os.path.join(ROOT, "llm-pilot.jsonl")
CKPT = os.path.join(ROOT, "qwen-lora.pt")
OUT = os.path.join(ROOT, "qwen-lora-result.json")


class LoRALinear(torch.nn.Module):
    def __init__(self, base, r=16, alpha=32):
        super().__init__()
        self.base = base
        for q in base.parameters():
            q.requires_grad = False
        # ⚠ 必须同设备同精度
        dev, dt = base.weight.device, base.weight.dtype
        self.A = torch.nn.Linear(base.in_features, r, bias=False).to(dev, dt)
        self.B = torch.nn.Linear(r, base.out_features, bias=False).to(dev, dt)
        torch.nn.init.kaiming_uniform_(self.A.weight, a=5 ** 0.5)
        torch.nn.init.zeros_(self.B.weight)
        self.scale = alpha / r

    def forward(self, x):
        return self.base(x) + self.B(self.A(x)) * self.scale


def inject_lora(model, r=16):
    n = 0
    for blk in model.model.layers:
        for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
            setattr(blk.self_attn, name, LoRALinear(getattr(blk.self_attn, name), r))
            n += 1
    for p in model.parameters():
        p.requires_grad = False
    for m in model.modules():
        if isinstance(m, LoRALinear):
            m.A.weight.requires_grad_(True)
            m.B.weight.requires_grad_(True)
    return n


def spearman(a, b):
    ra = sorted(range(len(a)), key=lambda i: a[i])
    rb = sorted(range(len(b)), key=lambda i: b[i])
    ka = [0.0] * len(a)
    kb = [0.0] * len(b)
    for rank, i in enumerate(ra):
        ka[i] = rank
    for rank, i in enumerate(rb):
        kb[i] = rank
    ma = sum(ka) / len(ka)
    mb = sum(kb) / len(kb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ka, kb))
    da = math.sqrt(sum((x - ma) ** 2 for x in ka))
    db = math.sqrt(sum((y - mb) ** 2 for y in kb))
    return num / (da * db + 1e-12)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--maxlen", type=int, default=384)
    ap.add_argument("--bs", type=int, default=2)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--val", type=int, default=40)
    a = ap.parse_args()

    torch.manual_seed(20261028)
    random.seed(20261028)
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"XPU: {torch.xpu.get_device_name(0)}")
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float16,
                                                 low_cpu_mem_usage=True).to("xpu")
    model.config.use_cache = False
    n = inject_lora(model)
    tr = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"LoRA 注入 {n} 层 · 可训练 {tr:,} 参数")
    model.train()

    rows = [json.loads(l) for l in open(PILOT, encoding="utf-8")][:a.n]
    random.shuffle(rows)
    val_rows, tr_rows = rows[:a.val], rows[a.val:]
    print(f"训练 {len(tr_rows)} · 验证 {len(val_rows)}")

    def encode(r):
        msgs = [{"role": "system", "content": r["system"]},
                {"role": "user", "content": r["prompt"]},
                {"role": "assistant", "content": r["target"]}]
        # 先算 prompt 长度，再把 prompt 部分 mask 掉
        pre = tok.apply_chat_template(msgs[:2], tokenize=False, add_generation_prompt=True)
        full = pre + r["target"] + tok.eos_token
        ids = tok(full, truncation=True, max_length=a.maxlen)["input_ids"]
        npre = len(tok(pre, truncation=True, max_length=a.maxlen)["input_ids"])
        labels = [-100] * min(npre, len(ids)) + ids[min(npre, len(ids)):]
        return ids, labels

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr)
    t0 = time.time()
    step = 0
    for ep in range(1, a.epochs + 1):
        random.shuffle(tr_rows)
        tot = 0.0
        for i in range(0, len(tr_rows) - a.bs + 1, a.bs):
            batch = tr_rows[i:i + a.bs]
            enc = [encode(r) for r in batch]
            L = max(len(e[0]) for e in enc)
            ids = torch.full((len(enc), L), tok.pad_token_id or 0, dtype=torch.long)
            lab = torch.full((len(enc), L), -100, dtype=torch.long)
            att = torch.zeros((len(enc), L), dtype=torch.long)
            for j, (x, y) in enumerate(enc):
                ids[j, :len(x)] = torch.tensor(x)
                lab[j, :len(y)] = torch.tensor(y)
                att[j, :len(x)] = 1
            out = model(input_ids=ids.to("xpu"), attention_mask=att.to("xpu"),
                        labels=lab.to("xpu"))
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
            opt.step()
            opt.zero_grad(set_to_none=True)
            tot += out.loss.item()
            step += 1
            if step % 20 == 0:
                print(f"  ep{ep} step {step} · loss {tot / 20:.4f} · "
                      f"{(time.time() - t0) / 60:.1f} 分钟", flush=True)
                tot = 0.0

        # 验证：贪心生成，解析数字
        model.eval()
        preds, gts, bad = [], [], 0
        with torch.no_grad():
            for r in val_rows:
                msgs = [{"role": "system", "content": r["system"]},
                        {"role": "user", "content": r["prompt"]}]
                pre = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
                enc = tok(pre, return_tensors="pt", truncation=True, max_length=a.maxlen).to("xpu")
                g = model.generate(**enc, max_new_tokens=6, do_sample=False,
                                   pad_token_id=tok.pad_token_id or tok.eos_token_id)
                txt = tok.decode(g[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
                try:
                    v = float("".join(ch for ch in txt if ch.isdigit() or ch == ".")[:5])
                except Exception:
                    v, bad = 0.0, bad + 1
                preds.append(v)
                gts.append(float(r["target"]))
        rho = spearman(preds, gts)
        mae = sum(abs(p - g) for p, g in zip(preds, gts)) / max(len(preds), 1)
        print(f"\n  == ep{ep} 验证：ρ {rho:.4f} · MAE {mae:.2f} 级 · 解析失败 {bad} · "
              f"总耗时 {(time.time() - t0) / 60:.0f} 分钟\n", flush=True)
        json.dump({"epoch": ep, "rho": round(rho, 4), "mae": round(mae, 2),
                   "bad": bad, "preds": preds[:20], "gts": gts[:20]},
                  open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        torch.save({"lora": {k: v for k, v in model.state_dict().items() if "A.weight" in k or "B.weight" in k}},
                   CKPT)
        model.train()

    print(f"判据：ρ > 0.7506（序列小模型）· 0.752（49 维 ridge）")
    print(f"写出 {OUT} / {CKPT}")


if __name__ == "__main__":
    main()
