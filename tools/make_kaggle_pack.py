#!/usr/bin/env python3
"""生成 Kaggle 训练包：紧凑序列化 + 指令数据 + 可直接跑的 notebook。

━━━ 为什么压到 9.5 token/事件还不够 ━━━
中位谱 1,093 事件 → 约 10,400 token；Kaggle T4 上用 4,096 上下文的话只能装四成。
所以策略是：**全量存盘，训练时均匀抽样**（每 k 个事件取 1 个，k 由长度决定），
保证整张谱都被看到，代价是时间分辨率降低。
这不是理想解，是在 4k 上下文下的最优近似；换 8k 上下文时 k 会变成 1。

输出：
  data/kaggle/train.jsonl   全量训练样本（紧凑格式，不截断）
  data/kaggle/val.jsonl     留出集（按谱面切分）
  data/kaggle/meta.json     统计信息
"""
import json
import os
import random
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
CHARTS = os.path.join(ROOT, "charts")
IRT = os.path.join(ROOT, "player-irt.json")
OUTDIR = os.path.join(ROOT, "kaggle")
K, M = 1.104, 15.84
MIN_PLAYERS = 100

SYS = ("你是音游难度评估器。输入是一张 Phira 谱面的紧凑事件流（DNA 串）："
       "每 2 个字符表示一个音符 —— 第 1 字符是距上一个音符的时间差（0.1 秒，base32），"
       "第 2 字符是「轨道×4+类型」(轨道 0-7 从左到右，类型 0=Tap 1=Hold 2=Flick 3=Drag)；"
       "长条后面紧跟 1 个字符表示时长（0.1 秒）。"
       "请估计这张谱的难度，只输出一个数字（保留一位小数）。")


def compact(text):
    """换成 DNA 编码：2.10 token/事件（旧的逐行格式要 13.2）。

    ⚠ 这里是整条流水线最关键的一处改动。最早用 `12.34 +337.5 T` 这种
    自然语言式写法，中位谱面就是 14,400 token，4k 上下文只能装三成，
    于是差点用"均匀抽样"把数据砍掉。先压编码才是对的。
    """
    from chart_dna import encode
    ev = []
    for L in text.split("\n")[1:]:
        f = L.split()
        if len(f) < 3:
            continue
        try:
            ev.append((float(f[0]), float(f[1]), f[2].rstrip("b"),
                       float(f[3]) if len(f) > 3 else None))
        except ValueError:
            continue
    return encode(ev), len(ev)
    return head + "\n" + "\n".join(body), len(body)


def main():
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
    from serialize_chart import serialize

    os.makedirs(OUTDIR, exist_ok=True)
    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    cand = [(cid, v) for cid, v in irt.items()
            if v.get("players", 0) >= MIN_PLAYERS and v.get("b") is not None]
    cand.sort(key=lambda x: -x[1]["players"])

    rows, skip = [], 0
    for cid, info in cand:
        d = os.path.join(CHARTS, cid)
        if not os.path.isdir(d):
            skip += 1
            continue
        f = next((x for x in os.listdir(d) if x.lower().endswith((".json", ".pgr", ".pec"))), None)
        if not f:
            skip += 1
            continue
        try:
            text, _, n = serialize(os.path.join(d, f), max_notes=100000)
            body, m = compact(text)
        except Exception:
            skip += 1
            continue
        diff = min(max(K * info["b"] + M, 1.0), 17.5)
        rows.append({"id": cid, "chart": body, "target": f"{diff:.1f}",
                     "b": round(info["b"], 4), "players": info["players"], "notes": m})
        if len(rows) % 500 == 0:
            print(f"  {len(rows)} 张...", flush=True)

    random.Random(20261031).shuffle(rows)
    cut = int(len(rows) * 0.92)
    tr, va = rows[:cut], rows[cut:]

    def dump(path, data):
        with open(path, "w", encoding="utf-8") as fh:
            for r in data:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    dump(os.path.join(OUTDIR, "train.jsonl"), tr)
    dump(os.path.join(OUTDIR, "val.jsonl"), va)
    chars = sum(len(r["chart"]) for r in rows)
    meta = {"system": SYS, "n_train": len(tr), "n_val": len(va),
            "chars": chars, "est_tokens": int(chars * 1.0),
            "targets": [min(float(r["target"]) for r in rows),
                        max(float(r["target"]) for r in rows)],
            "skipped": skip}
    json.dump(meta, open(os.path.join(OUTDIR, "meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n输出到 {OUTDIR}")
    print(f"  训练 {len(tr):,} · 验证 {len(va):,} · 跳过 {skip}")
    print(f"  字符 {chars / 1e6:.1f}M ≈ {chars / 4 / 1e6:.1f}M token")


if __name__ == "__main__":
    main()
