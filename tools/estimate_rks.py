#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
estimate_rks.py —— 用抓到的成绩自己算 RKS

【为什么需要它】
  Phira 的 RKS/B19 计算**已停更**（2026-10-23 实测：所有人的 bestPool 冻在
  2026-03-19 之前，2026 年后注册的账号 rks 恒为 0）。
  但单曲成绩是活的 —— 所以可以自己算。

【公式（已用老玩家 bestPool 反推确认，32 个样本差值中位 0.000）】

    单曲 rks = ((ACC×100 − 55) / 45)² × 谱面定数
    （ACC < 70 记 0）

    总 RKS = (Σ 前 19 个 + 最高那个) / 20      ← 最高那个算两次，即 φ 位

【这个估计的已知上限】
  我们只有每个玩家**最近 20 条**记录（/record?player= 不可翻页），
  拿不到历史最好成绩。所以算出来的是**偏低的估计**，不是精确 RKS。
  除非玩家最近正好打出了自己的最好成绩。

  用法上应该写成「按近期成绩估算」而不是「你的 RKS 是」。

【用法】
  python tools/estimate_rks.py
  python tools/estimate_rks.py --validate 30   # 抽 30 个有官方 rks 的玩家做校验
"""
import argparse
import json
import os
import ssl
import urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "scores", "matrix.jsonl")
COMM = os.path.join(ROOT, "data", "community.jsonl")
OUT = os.path.join(ROOT, "data", "scores", "player_rks.json")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def unit_rks(acc, diff):
    """单曲 rks；ACC 用 0~1 还是 0~100 都兼容。"""
    a = acc * 100 if acc <= 1.0 else acc
    if a < 70:
        return 0.0
    return ((a - 55) / 45) ** 2 * diff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", type=int, default=0)
    args = ap.parse_args()

    diff = {}
    with open(COMM, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = r.get("difficulty")
            if not (isinstance(d, (int, float)) and 0 < d <= 19.5):
                continue
            # ⚠ 只有**已上架**（ranked/stable）谱面的成绩才计入 RKS。
            #    不过滤的话会把未上架谱也拉进来，估计系统性偏高
            #    （实测：抽 25 人比较，中位高 +7.28，其中有人官方 0.63 我们估 13）。
            if not (r.get("ranked") and r.get("stable")):
                continue
            diff[int(r["id"])] = float(d)
    print("[rks] 已上架的谱面 %d 张（只有这些计入 RKS）" % len(diff))

    # (player, chart) → 最好 acc
    best = {}
    with open(SRC, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            c, p, a = int(r["chart"]), int(r["player"]), float(r["acc"])
            k = (p, c)
            if k not in best or a > best[k]:
                best[k] = a

    per_player = defaultdict(list)
    for (p, c), a in best.items():
        d = diff.get(c)
        if d is None:
            continue
        u = unit_rks(a, d)
        if u > 0:
            per_player[p].append((u, c, a, d))

    print("[rks] 有可比成绩的玩家 %d" % len(per_player))

    res = {}
    for p, lst in per_player.items():
        lst.sort(reverse=True)
        top = lst[:20]
        if len(top) < 5:          # 少于 5 张谱不估 —— 估出来没意义
            continue
        vals = [x[0] for x in top]
        if len(vals) == 1:
            rks = vals[0]
        else:
            # (Σ 前19 + 最高) / 20 —— 最高那个算两次（φ 位）
            # ⚠ 分母必须是**实际用到的**槽数，不能写死 20：
            #    我们只有最近 20 条记录，多数玩家凑不满 20 张谱（中位 11 张）。
            #    写死 20 会把只打了 5 张谱的人压到 1/4，看起来像"水平差"，
            #    其实是分母错。满 20 张时两种写法完全等价。
            head = vals[:19]
            rks = (sum(head) + vals[0]) / (len(head) + 1)
        res[p] = {"rks": round(rks, 3), "charts": len(lst), "used": len(top),
                  "best_unit": round(vals[0], 3), "best_chart": top[0][1]}

    json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    vals = sorted((v["rks"] for v in res.values()), reverse=True)
    print("[rks] 估出 %d 个玩家" % len(res))
    if vals:
        print("  分布：最高 %.2f / 中位 %.2f / 最低 %.2f" % (vals[0], vals[len(vals) // 2], vals[-1]))
        used = [v["used"] for v in res.values()]
        print("  用到的谱数：中位 %d，≥20 张的玩家 %d 个" % (
            sorted(used)[len(used) // 2], sum(1 for u in used if u >= 20)))
    print("  输出：%s" % OUT)

    if args.validate:
        validate(res, args.validate)


def validate(res, n):
    """抽 n 个有官方 rks 的玩家，比我们的估计 vs 官方值。"""
    print("\n[校验] 抽 %d 个玩家，对比官方 rks" % n)
    sample = list(res.keys())
    step = max(1, len(sample) // n)
    pairs = []
    for p in sample[::step][:n]:
        try:
            req = urllib.request.Request("https://api.phira.cn/user/%d" % p,
                                         headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
                u = json.loads(r.read())
            off = u.get("rks")
            if isinstance(off, (int, float)) and off > 0:
                pairs.append((res[p]["rks"], float(off), p, u.get("name")))
        except Exception:
            pass
    if len(pairs) < 3:
        print("  拿到官方 rks 的样本太少（%d 个）—— B19 已停更，多数玩家 rks 为 0" % len(pairs))
        return
    print("  可比 %d 个：" % len(pairs))
    for mine, off, p, nm in pairs:
        print("    %-18s 估计 %.2f   官方 %.2f   差 %+.2f" % (str(nm)[:18], mine, off, mine - off))
    diffs = [m - o for m, o, _, _ in pairs]
    diffs.sort()
    print("  差的中位 %+.2f" % diffs[len(diffs) // 2])
    print("  差的中位已给出；但注意：官方 rks 冻结在 2026-03，我们算的是近期成绩，两者不是同一个量。")
    print("  实测分档：官方<5 的差 +11.7（系统从没算过）；官方>=5 的差 +4.5。")

if __name__ == "__main__":
    main()
