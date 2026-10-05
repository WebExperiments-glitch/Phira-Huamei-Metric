#!/usr/bin/env python3
"""诊断：官方难度标签的谱面数据可区分度"""
import collections
import json
import os
import statistics as st

BASE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(
    os.path.join(BASE, "..", "data", "official.jsonl"),
    encoding="utf-8")]

print("=== 各难度标签的谱面数据画像 ===")
print("LV    n   物量中位  NPS中位  Hold%中位  时长中位  定数中位")
for lv in ["EZ", "HD", "IN", "AT"]:
    s = [r for r in rows if r["level"] == lv]
    if not s:
        continue
    print("%-4s %4d %8.0f %8.2f %10.1f %9.0f %9.1f" % (
        lv, len(s),
        st.median([r["notes_real"] for r in s]),
        st.median([r["nps"] for r in s]),
        st.median([r["t_hold"] / r["notes_real"] * 100 for r in s]),
        st.median([r["duration_s"] for r in s]),
        st.median([r["difficulty"] for r in s])))

print()
print("=== 定数区间的难度标签分布（重叠度）===")
d = collections.defaultdict(list)
for r in rows:
    d[round(r["difficulty"] * 2) / 2].append(r["level"])
for k in sorted(d):
    if 6.0 <= k <= 12.0:
        c = collections.Counter(d[k])
        tot = sum(c.values())
        pure = max(c.values()) / tot
        mark = "  ← 单一难度" if pure == 1.0 else ("  ← 混杂 %.0f%%" % ((1 - pure) * 100))
        print("  %4.1f  n=%-4d %-46s%s" % (
            k, tot, str(dict(c)), mark))

print()
print("=== 结论 ===")
mix = sum(1 for k, v in d.items()
          if 6.0 <= k <= 12.0 and len(set(v)) > 1)
print("定数 6~12 区间内，有 %d 个 0.5 档位混了多个难度标签" % mix)
print("→ 这些档位内「谱面数据」与「难度标签」信息重叠，公式无法完全替代标签")
