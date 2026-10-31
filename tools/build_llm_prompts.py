#!/usr/bin/env python3
"""造 LLM 微调用的指令数据：谱面事件流 → 难度数字（文本）。

━━━ 为什么目标是「数字」而不是「解释」━━━
我们要的是可评测的量。让模型输出一段解释，评测就得再请一个模型当裁判，
成本高且不可复现。让它只输出 3~5 个字符的数字，loss 只算这几个 token，
评测就是"解析数字 → 算 Spearman"，和前面所有实验同一把尺子。

━━━ 标签用 b 换算的定数，不用声明定数 ━━━
b 是玩家实测（分半信度 0.9999），换算是线性的：定数 = 1.104 × b + 15.84。
声明定数一半是噪声，教给模型等于教它猜。

━━━ 输出 ━━━
JSONL，每行 {"id":..., "prompt":..., "target":"14.7", "b":..., "players":...}
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from serialize_chart import serialize   # noqa: E402

ROOT = os.path.join(os.path.dirname(HERE), "data")
CHARTS = os.path.join(ROOT, "charts")
IRT = os.path.join(ROOT, "player-irt.json")
OUT = os.path.join(ROOT, "llm-pilot.jsonl")

K, M = 1.104, 15.84          # b → 定数（fit_player_irt 里拟合的校准式）
MIN_PLAYERS = 100

SYSTEM = ("你是音游难度评估器。给你一张 Phira 谱面的事件流，"
          "估计它的难度。只输出一个数字（保留一位小数），不要解释。")


def chart_path(cid):
    d = os.path.join(CHARTS, cid)
    if not os.path.isdir(d):
        return None
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            return os.path.join(d, f)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--max-events", type=int, default=400,
                    help="每谱只保留前 N 个事件（控制 token 预算）")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    cand = [(cid, v) for cid, v in irt.items()
            if v.get("players", 0) >= MIN_PLAYERS and v.get("b") is not None]
    cand.sort(key=lambda x: -x[1]["players"])       # 先取支撑度最高的
    cand = cand[:a.n * 4]                            # 多备一些，失败的跳过

    rows = []
    tok_est = 0
    for cid, info in cand:
        if len(rows) >= a.n:
            break
        p = chart_path(cid)
        if not p:
            continue
        try:
            text, trunc, n = serialize(p, max_notes=a.max_events)
        except Exception:
            continue
        d = K * info["b"] + M
        d = min(max(d, 1.0), 17.5)
        rows.append({
            "id": cid,
            "system": SYSTEM,
            "prompt": text,
            "target": f"{d:.1f}",
            "b": round(info["b"], 4),
            "players": info["players"],
            "notes": n,
        })
        tok_est += len(text) // 2                    # 中文/数字混合，约 2 字符 1 token
        if len(rows) % 50 == 0:
            print(f"  {len(rows)}/{a.n} · 约 {tok_est / 1000:.0f}k token", flush=True)

    with open(a.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\n写出 {a.out}")
    print(f"  {len(rows)} 条 · 每条 ≤{a.max_events} 事件 · 语料约 {tok_est / 1000:.0f}k token")
    if rows:
        print(f"  目标分布：{min(float(r['target']) for r in rows):.1f} ~ "
              f"{max(float(r['target']) for r in rows):.1f}")


if __name__ == "__main__":
    main()
