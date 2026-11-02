#!/usr/bin/env python3
"""把 9.4 GB 的原始记录压成 IRT 需要的三元组 (player, chart, best_acc)。

为什么要单独一步：
  原始 JSONL 每行 ~200 字节，带 15 个字段；拟合只需要「谁、哪张谱、最好打到多少」。
  先落成定长二进制（int32,int32,float32 = 12 字节），之后 numpy 直接 memmap，
  既省内存又能用 lexsort 做去重 —— 4,200 万行用 Python dict 去重会吃掉 4 GB 以上。

输出：data/crawl/pairs.bin（紧凑三元组，未去重）
"""
import json
import os
import struct
import sys
import time

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "crawl")
SRC = os.path.join(ROOT, "records")
OUT = os.path.join(ROOT, "pairs.bin")


OLD = os.path.join(os.path.dirname(ROOT), "scores", "matrix.jsonl")   # 2026-10 之前按「玩家扩散」抓的 2,281 万对


def main():
    files = sorted(os.path.join(SRC, f) for f in os.listdir(SRC) if f.endswith(".jsonl"))
    total = 0
    bad = 0
    t0 = time.time()
    with open(OUT, "wb") as out:
        buf = bytearray()
        pack = struct.Struct("<iif").pack
        for p in files:
            n = 0
            with open(p, encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                        a = r["accuracy"]
                        if a is None:
                            continue
                        buf += pack(int(r["player"]), int(r["chart"]), float(a))
                        n += 1
                    except Exception:
                        bad += 1
                    if len(buf) >= 12 * 200_000:
                        out.write(buf)
                        buf.clear()
            total += n
            print(f"  {os.path.basename(p)}: {n:,} 行（累计 {total:,}，"
                  f"{time.time() - t0:.0f}s）", flush=True)
        out.write(buf)

    # ── 并入旧的玩家扩散矩阵 ──
    # 两种抓法覆盖的谱面不同：这轮是「按谱抓全」（1,2xx 张、每张几千人），
    # 旧数据是「按玩家扩散」（3,6xx 张、每张几十到几百人）。
    # 合并之后谱面范围才够宽 —— 定数标准差窄会把 R² 系统性压低。
    if os.path.exists(OLD) and "--no-old" not in sys.argv:
        n0 = 0
        with open(OLD, encoding="utf-8") as f, open(OUT, "ab") as out:
            buf = bytearray()
            pack = struct.Struct("<iif").pack
            for line in f:
                try:
                    r = json.loads(line)
                    buf += pack(int(r["player"]), int(r["chart"]), float(r["acc"]))
                    n0 += 1
                except Exception:
                    bad += 1
                if len(buf) >= 12 * 200_000:
                    out.write(buf)
                    buf.clear()
            out.write(buf)
        total += n0
        print(f"  并入 matrix.jsonl: {n0:,} 行（累计 {total:,}）")

    size = os.path.getsize(OUT)
    print(f"\n写出 {OUT}")
    print(f"三元组 {size // 12:,} 条 / {size / 1e9:.2f} GB · 坏行 {bad:,}")


main()
