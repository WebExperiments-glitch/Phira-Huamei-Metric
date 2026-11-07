"""把 15 GB 原始记录压成「保留判定构成」的定长表（替代只存 accuracy 的 pairs.bin）。

━━━ 为什么要重做 ━━━
旧 `pairs.bin` 只存 (player, chart, accuracy) 12 字节，
把 good / bad / miss / max_combo / full_combo / speed 全扔了。
而 good 与 miss 的比例区分了两种完全不同的难度来源：
    good 多 miss 少  →  打得到但打不准（判定窗口紧、读谱难）
    miss 多          →  根本打不到（物量/手法超纲）

输出：data/crawl/pairs-full.bin（结构化 float/int，约 1.8 GB）
字段：player, chart, acc, perfect, good, bad, miss, max_combo, full_combo, speed

用法：
    python tools/build_pairs_full.py
"""
import glob
import json
import os
import time

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "crawl")
SRC = os.path.join(ROOT, "records")
OUT = os.path.join(ROOT, "pairs-full.bin")

DT = np.dtype([
    ("player", "<i4"), ("chart", "<i4"), ("acc", "<f4"),
    ("perfect", "<i4"), ("good", "<i4"), ("bad", "<i4"), ("miss", "<i4"),
    ("max_combo", "<i4"), ("fc", "u1"), ("speed", "<f2"),
])


def main():
    files = sorted(glob.glob(os.path.join(SRC, "*.jsonl")))
    print(f"{len(files)} 个分片", flush=True)
    buf = []
    total = 0
    bad = 0
    fout = open(OUT, "wb")
    t0 = time.time()
    for p in files:
        n = 0
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    a = r["accuracy"]
                    if a is None or not (0.0 <= a <= 1.01):
                        bad += 1
                        continue
                    buf.append((
                        int(r["player"]), int(r["chart"]), float(a),
                        int(r.get("perfect") or 0), int(r.get("good") or 0),
                        int(r.get("bad") or 0), int(r.get("miss") or 0),
                        int(r.get("max_combo") or 0), 1 if r.get("full_combo") else 0,
                        float(r.get("speed") or 1.0),
                    ))
                    n += 1
                except Exception:
                    bad += 1
                if len(buf) >= 500_000:
                    np.array(buf, dtype=DT).tofile(fout)
                    total += len(buf)
                    buf = []
                    el = time.time() - t0
                    print(f"  {total:,} 条  {el/60:.1f} 分  {total/max(el,1)/1000:.0f}k 条/s", flush=True)
        total += len(buf)
        np.array(buf, dtype=DT).tofile(fout)
        buf = []
        print(f"  {os.path.basename(p)} 完成，累计 {total:,}", flush=True)
    fout.close()
    size = os.path.getsize(OUT)
    print(f"\n完成：{total:,} 条（跳过 {bad:,}），{size/1e9:.2f} GB，耗时 {(time.time()-t0)/60:.1f} 分")
    print(f"→ {OUT}")


def load(path=OUT):
    return np.memmap(path, dtype=DT, mode="r")


if __name__ == "__main__":
    main()
