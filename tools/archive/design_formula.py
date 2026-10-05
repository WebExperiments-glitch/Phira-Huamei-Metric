#!/usr/bin/env python3
"""
官谱定数规则推导 —— 查表公式设计

思路：不用回归（外推失效），改用**官谱实测映射表**。
  主轴 = 物量（与定数 r=+0.85，最强且单调）
  档内细分 = NPS
  修正项 = 谱型（Hold 占比高 = 强度分散）

优点：
  · 100% 可解释，每个格子都能追溯到具体官谱
  · 在官谱覆盖范围内零外推
  · 不依赖任何优化器，无随机性

本脚本只做「表结构探索」，输出用于设计公式。
"""
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
OFFICIAL = os.path.abspath(os.path.join(BASE, "..", "data", "official",
                                         "manifest_enhanced.jsonl"))


def main():
    rows = [json.loads(l) for l in open(OFFICIAL, encoding="utf-8")]
    print(f"[load] 官谱 {len(rows)} 条\n")

    # ---- 1. 物量分档，看定数分布 ----
    NB = [0, 200, 400, 600, 800, 1100, 1500, 2000, 100000]
    print("=" * 72)
    print("1. 按物量分档的定数分布")
    print("=" * 72)
    print(f"  {'物量区间':<14}{'n':>5}{'定数中位':>9}{'P25':>7}{'P75':>7}"
          f"{'IQR':>7}{'NPS中位':>9}")
    print("  " + "-" * 58)
    bins = []
    for i in range(len(NB) - 1):
        sub = [r for r in rows if NB[i] <= r["notes_real"] < NB[i + 1]]
        if len(sub) < 8:
            continue
        d = sorted(r["difficulty"] for r in sub)
        p25 = d[len(d) // 4]
        p75 = d[len(d) * 3 // 4]
        med = st.median(d)
        nps = st.median([r["nps"] for r in sub])
        bins.append((NB[i], NB[i + 1], med, p25, p75, p75 - p25, nps, len(sub)))
        print(f"  {NB[i]}-{NB[i+1]:<10}{len(sub):>5}{med:>9.1f}"
              f"{p25:>7.1f}{p75:>7.1f}{p75-p25:>7.1f}{nps:>9.2f}")
    print()
    print("  → IQR 就是「物量能解释的不确定性」，这是公式精度的下界")

    # ---- 2. 物量档内按 NPS 再分 ----
    print("\n" + "=" * 72)
    print("2. 物量档 × NPS 档 → 定数（中位数）")
    print("=" * 72)
    NPSB = [0, 3, 5, 7, 9, 12, 100]
    header = "  " + "物量区间".ljust(12) + "".join(
        f"{NPSB[i]}-{NPSB[i+1] if NPSB[i+1]<100 else '+'}".rjust(11)
        for i in range(len(NPSB) - 1))
    print(header)
    print("  " + "-" * (12 + 11 * (len(NPSB) - 1)))
    table = {}
    for lo, hi, _, _, _, _, _, _ in bins:
        sub = [r for r in rows if lo <= r["notes_real"] < hi]
        line = "  " + f"{lo}-{hi}".ljust(12)
        for j in range(len(NPSB) - 1):
            cell = [r for r in sub if NPSB[j] <= r["nps"] < NPSB[j + 1]]
            if len(cell) < 4:
                line += "     —     "
            else:
                m = st.median([r["difficulty"] for r in cell])
                table[(lo, NPSB[j])] = (m, len(cell))
                line += f"{m:>10.1f} "
        print(line)

    # ---- 3. 谱型修正：Hold 占比 ----
    print("\n" + "=" * 72)
    print("3. 谱型修正：Hold 占比对定数的影响（控制物量）")
    print("=" * 72)
    med = st.median([r["notes_real"] for r in rows])
    band = [r for r in rows if med * 0.75 <= r["notes_real"] <= med * 1.25]
    print(f"  物量中位 {med:.0f} 附近共 {len(band)} 张")
    HB = [(0, .15), (.15, .30), (.30, .45), (.45, .60), (.60, 1.01)]
    print(f"  {'Hold占比':<14}{'n':>5}{'定数中位':>9}{'NPS中位':>9}{'相对全档':>10}")
    base = st.median([r["difficulty"] for r in band])
    for lo, hi in HB:
        sub = [r for r in band if lo <= r["t_hold"] / r["notes_real"] < hi]
        if len(sub) < 8:
            continue
        m = st.median([r["difficulty"] for r in sub])
        nps = st.median([r["nps"] for r in sub])
        print(f"  {lo:.0%}-{hi:<8.0%}{len(sub):>5}{m:>9.1f}{nps:>9.2f}"
              f"{m-base:>+10.2f}")
    print()
    print("  → 若 Hold 高时定数明显偏低，说明需加「强度分散」修正")

    # ---- 4. 候选公式的精度上界 ----
    print("\n" + "=" * 72)
    print("4. 候选公式精度上界（查表法能做到多好）")
    print("=" * 72)

    def lookup(r):
        """纯查表：物量档 → NPS档 → 中位定数"""
        n = r["notes_real"]
        nps = r["nps"]
        for lo, hi, m, p25, p75, iqr, _, _ in bins:
            if lo <= n < hi:
                for j in range(len(NPSB) - 1):
                    if NPSB[j] <= nps < NPSB[j + 1]:
                        v = table.get((lo, NPSB[j]))
                        if v:
                            return v[0]
                return m            # NPS 档无样本时回退到物量档中位
        return st.median([r["difficulty"] for r in rows])

    errs = sorted(abs(lookup(r) - r["difficulty"]) for r in rows)
    print(f"  查表法 |误差| 中位 {errs[len(errs)//2]:.3f}")
    print(f"          p75    {errs[int(len(errs)*.75)]:.3f}")
    print(f"          p90    {errs[int(len(errs)*.90)]:.3f}")
    print(f"          p95    {errs[int(len(errs)*.95)]:.3f}")
    print(f"          ≤0.5   {sum(1 for e in errs if e<=0.5)/len(errs)*100:.1f}%")
    print(f"          ≤1.0   {sum(1 for e in errs if e<=1.0)/len(errs)*100:.1f}%")
    print()
    print("  对比回归模型：MAE 1.021 / p95 2.664")
    print("  → 查表法若 p95 能压到 1.0 以内，就达到「差值>1 判虚标」的要求")
    return 0


if __name__ == "__main__":
    sys.exit(main())
