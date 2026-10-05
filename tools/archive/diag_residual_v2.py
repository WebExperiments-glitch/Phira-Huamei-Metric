#!/usr/bin/env python3
"""v2 公式残差归因：剩下的误差来自哪里"""
import json
import os
import statistics as st

BASE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(
    os.path.join(BASE, "..", "data", "official.jsonl"),
    encoding="utf-8")]
rows = [r for r in rows if r["notes_real"] > 0]

NPS_EDGES = [0, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 8, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]


def bucket(v, edges):
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


print("=== 残差 TOP15 的特征画像（找未纳入的变量）===")
# 用全量表预测（分层，含 AT），LOO 简化：留出自身样本
import collections
cells = collections.defaultdict(list)
for r in rows:
    k = ((r.get("level") or "").upper()[:2],
         bucket(r["nps"], NPS_EDGES),
         bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES))
    cells[k].append(r["difficulty"])

GLOBAL = st.median([x["difficulty"] for x in rows])
# 逐级回退：(lv,ni,hi) -> (lv,ni) -> (lv) -> global
t3 = {k: (st.median(v), len(v)) for k, v in cells.items() if len(v) >= 4}
t2 = {}
t1 = {}
for k, v in cells.items():
    if len(v) >= 4:
        t2.setdefault((k[0], k[1]), (st.median(v), len(v)))
        t1.setdefault(k[0], (st.median(v), len(v)))

for r in rows:
    lv = (r.get("level") or "").upper()[:2]
    ni = bucket(r["nps"], NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    if (lv, ni, hi) in t3:
        r["_p"] = t3[(lv, ni, hi)][0]
        r["_c"] = "high"
    elif (lv, ni) in t2:
        r["_p"] = t2[(lv, ni)][0]
        r["_c"] = "mid"
    elif lv in t1:
        r["_p"] = t1[lv][0]
        r["_c"] = "low"
    else:
        r["_p"] = GLOBAL
        r["_c"] = "none"
    r["_e"] = abs(r["_p"] - r["difficulty"])

print("  置信分布: %s" % dict(collections.Counter(r["_c"] for r in rows)))
print()
print("%-22s %-4s %3s %5s %5s %6s %7s %6s %7s %7s" % (
    "曲名", "LV", "C", "实际", "预测", "误差", "物量", "时长", "NPS", "Hold%"))
for r in sorted(rows, key=lambda x: -x["_e"])[:15]:
    print("%-22s %-4s %3s %5.1f %5.1f %6.1f %7d %7.0f %7.2f %6.1f%%" % (
        r["name"][:20], r["level"], r["_c"], r["difficulty"], r["_p"], r["_e"],
        r["notes_real"], r["duration_s"], r["nps"],
        r["t_hold"] / r["notes_real"] * 100))

print()
print("=== 未纳入但可能有判别力的特征 ===")
# chord_ratio 同押
for lo, hi in [(0, 1), (1, 5), (5, 12), (12, 25), (25, 100)]:
    sub = [r for r in rows if lo <= r.get("chord_ratio", 0) < hi]
    if len(sub) < 10:
        continue
    print("  chord_ratio %2d-%-3d%%  n=%4d  残差中位 %.2f" % (
        lo, hi, len(sub), st.median([r["_e"] for r in sub])))
print()
# fast_ratio
for lo, hi in [(0, 15), (15, 35), (35, 60), (60, 101)]:
    sub = [r for r in rows if lo <= r.get("fast_ratio", 0) < hi]
    if len(sub) < 10:
        continue
    print("  fast_ratio %2d-%-3d%%  n=%4d  残差中位 %.2f" % (
        lo, hi, len(sub), st.median([r["_e"] for r in sub])))
print()
# lines
for lo, hi in [(0, 15), (15, 25), (25, 40), (40, 300)]:
    sub = [r for r in rows if lo <= r["lines"] < hi]
    if len(sub) < 10:
        continue
    print("  判定线 %3d-%-3d    n=%4d  残差中位 %.2f" % (
        lo, hi, len(sub), st.median([r["_e"] for r in sub])))
print()
# strain_peak
for lo, hi in [(0, 10), (10, 20), (20, 30), (30, 200)]:
    sub = [r for r in rows if lo <= r.get("strain_peak", 0) < hi]
    if len(sub) < 10:
        continue
    print("  strain_peak %3d-%-3d  n=%4d  残差中位 %.2f" % (
        lo, hi, len(sub), st.median([r["_e"] for r in sub])))

print()
print("=== 残差 >1.5 的样本里，各维度分布是否偏移？===")
big = [r for r in rows if r["_e"] > 1.5]
sml = [r for r in rows if r["_e"] <= 0.5]
print("  残差>1.5: n=%d" % len(big))
for lab, k in (("chord%", "chord_ratio"), ("fast%", "fast_ratio"),
               ("线数", "lines"), ("NPS", "nps"), ("BPM", "bpm")):
    a = st.median([r.get(k, 0) for r in big])
    b = st.median([r.get(k, 0) for r in sml])
    print("    %-8s 大残差 %7.2f   小残差 %7.2f" % (lab, a, b))
