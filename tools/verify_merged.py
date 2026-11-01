#!/usr/bin/env python3
"""校验合并后的模型：不是空壳，且仍记得任务。

为什么必须做：LoRA 合并若写错（scale 漏乘、B@A 顺序反了、键没载上），
产出的模型会**安静地等于基座** —— 体积对、能加载、不报错，只是不会做事。
唯一可靠的判据是：**在同一批样本上重新算 ρ，看是否接近训练时的 0.598**。

    python tools/verify_merged.py [模型目录] [样本数]
"""
import json
import os
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from bench_suite import spearman      # 复用同一套指标实现

# ⚠ 必须用训练时的原文，不能手写近似版。
# 我第一次就是手打了一份措辞不同的 prompt，模型当成分布外输入，
# 全部输出众数 14.0（ρ 0.15），差点误判成"合并失败"。
_META = json.load(open(os.path.join(ROOT, "data", "kaggle", "meta.json"), encoding="utf-8"))
SYS_PROMPT = _META["system"]


def predict(path, rows, tok, maxlen=4096):
    from transformers import AutoModelForCausalLM
    model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.float16)
    model.eval()
    out = []
    for r in rows:
        pre = tok.apply_chat_template(
            [{"role": "system", "content": SYS_PROMPT},
             {"role": "user", "content": r["chart"]}],
            tokenize=False, add_generation_prompt=True)
        enc = tok(pre, return_tensors="pt", truncation=True, max_length=maxlen)
        with torch.no_grad():
            g = model.generate(**enc, max_new_tokens=8, do_sample=False,
                               pad_token_id=tok.eos_token_id)
        txt = tok.decode(g[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
        digits = "".join(c for c in txt if c.isdigit() or c == ".")
        out.append(float(digits[:5]) if digits.strip(".") else 15.0)
    del model
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        ROOT, "release", "phm-difficulty-qwen3-0.6b")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(path)
    rows = [json.loads(l) for l in
            open(os.path.join(ROOT, "data", "kaggle", "val.jsonl"), encoding="utf-8")][:n]
    gold = [float(r["target"]) for r in rows]
    pred = predict(path, rows, tok)

    rho = spearman(pred, gold)
    mae = sum(abs(p - g) for p, g in zip(pred, gold)) / len(pred)
    print(f"样本 {n} · ρ {rho:.4f} · MAE {mae:.3f}")
    print(f"  pred {[round(p,1) for p in pred[:8]]}")
    print(f"  gt   {[round(g,1) for g in gold[:8]]}")
    print()
    print("判据：训练时全量验证集 ρ 0.598。")
    print("  0.50~0.68 → 合并正确（子集抽样有波动）")
    print("  < 0.3     → 合并失败，模型等于基座，不能发布")


if __name__ == "__main__":
    main()
