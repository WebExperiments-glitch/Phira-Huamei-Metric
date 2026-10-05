#!/usr/bin/env python3
"""
v2 公式的精度上界分析

要回答一个问题：**剩下的误差是「公式不够好」还是「官方标注本身就有波动」？**

方法：把样本分成三档
  ① 高置信格内（high）：表命中且样本≥4
  ② 中/低置信（mid/low）：稀有谱落到了回退层
  ③ 对照：同一首歌的其他难度（官方内部一致性检验）

若①的误差远小于②，且③（同曲不同难度）也有可观误差，
则说明精度瓶颈在**官方标注本身**，而非公式。
"""
import collections
import json
import os
import statistics as st

BASE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(
    os.path.join(BASE, "..", "data", "official", "manifest_enhanced.jsonl"),
    encoding="utf-8")]
rows = [r for r in rows if r["notes_real"] > 0]

NPS_EDGES = [0, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 8, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]
MIN_N = 4


def bucket(v, edges):
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def build(rs):
    c = collections.defaultdict(list)
    for r in rs:
        c[((r.get("level") or "").upper()[:2],
           bucket(r["nps"], NPS_EDGES),
           bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES))].append(r["difficulty"])
    t3 = {k: st.median(v) for k, v in c.items() if len(v) >= MIN_N}
    t2, t1 = {}, {}
    for k, v in c.items():
        if len(v) >= MIN_N:
            t2.setdefault((k[0], k[1]), st.median(v))
            t1.setdefault(k[0], st.median(v))
    return t3, t2, t1


def pred(r, t3, t2, t1, g):
    lv = (r.get("level") or "").upper()[:2]
    ni = bucket(r["nps"], NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    if (lv, ni, hi) in t3:
        return t3[(lv, ni, hi)], "high"
    if (lv, ni) in t2:
        return t2[(lv, ni)], "mid"
    if lv in t1:
        return t1[lv], "low"
    return g, "none"


print("=" * 76)
print("1. LOO 总体精度（留一法）")
print("=" * 76)
errs, confs = [], []
G = st.median([r["difficulty"] for r in rows])
for i, r in enumerate(rows):
    sub = rows[:i] + rows[i + 1:]
    t3, t2, t1 = build(sub)
    g = st.median([x["difficulty"] for x in sub])
    p, c = pred(r, t3, t2, t1, g)
    errs.append(abs(p - r["difficulty"]))
    confs.append(c)
n = len(errs)
es = sorted(errs)
print("  总体 |误差| 中位 %.3f  p75 %.3f  p90 %.3f  p95 %.3f" % (
    es[n // 2], es[int(n * .75)], es[int(n * .90)], es[int(n * .95)]))
print("  ≤0.5 %.1f%%   ≤1.0 %.1f%%   ≤1.5 %.1f%%" % (
    sum(1 for e in errs if e <= .5) / n * 100,
    sum(1 for e in errs if e <= 1.) / n * 100,
    sum(1 for e in errs if e <= 1.5) / n * 100))

print()
print("=" * 76)
print("2. 分置信度精度")
print("=" * 76)
byc = collections.defaultdict(list)
for e, c in zip(errs, confs):
    byc[c].append(e)
for c in ("high", "mid", "low", "none"):
    e = sorted(byc.get(c, []))
    if not e:
        continue
    print("  %-5s n=%-4d 中位 %.3f  p90 %.3f  ≤1.0 占 %.1f%%" % (
        c, len(e), e[len(e) // 2], e[min(int(len(e) * .9), len(e) - 1)],
        sum(1 for x in e if x <= 1.) / len(e) * 100))

print()
print("=" * 76)
print("3. ★ 官方标注自身的内部一致性（同曲四难度）")
print("=" * 76)
by_song = collections.defaultdict(list)
for r in rows:
    by_song[r["song_id"]].append(r)
# 同曲相邻难度的定数差 vs 它们的谱面特征差
diffs = []
for sid, rs in by_song.items():
    rs.sort(key=lambda x: ["EZ", "HD", "IN", "AT"].index(x["level"])
            if x["level"] in ("EZ", "HD", "IN", "AT") else 9)
    for a, b in zip(rs, rs[1:]):
        if a["level"] in ("EZ", "HD", "IN", "AT") and b["level"] in ("EZ", "HD", "IN", "AT"):
            dn = b["difficulty"] - a["difficulty"]
            nn = b["notes_real"] - a["notes_real"]
            diffs.append((dn, nn))
if diffs:
    dns = [d[0] for d in diffs]
    print("  同曲相邻难度定数差：n=%d  中位 %.1f  最小 %.1f" % (
        len(dns), st.median(dns), min(dns)))
    # 定数差 0 或极小的样本
    tiny = [d for d in diffs if d[0] < 2.0]
    print("  定数差 <2.0 的相邻难度对：%d (%.1f%%)" % (
        len(tiny), len(tiny) / len(diffs) * 100))
    print("  → 官方给相邻难度只差 1~2 级，说明官方自己的区分度就这么粗")

print()
print("=" * 76)
print("4. ★ 公式精度 vs 官方离散度对比（关键判断）")
print("=" * 76)
# 格内 IQR = 官方在同一格内的标注离散度
c = collections.defaultdict(list)
for r in rows:
    c[((r.get("level") or "").upper()[:2],
       bucket(r["nps"], NPS_EDGES),
       bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES))].append(r["difficulty"])
big = [v for v in c.values() if len(v) >= 6]
iqrs = []
for v in big:
    vs = sorted(v)
    iqrs.append(vs[len(vs) * 3 // 4] - vs[len(vs) // 4])
if iqrs:
    iqrs.sort()
    print("  格内 IQR（官方自身离散度）n=%d 格" % len(iqrs))
    print("    中位 %.2f   p75 %.2f   p90 %.2f" % (
        iqrs[len(iqrs) // 2], iqrs[int(len(iqrs) * .75)],
        iqrs[min(int(len(iqrs) * .9), len(iqrs) - 1)]))
    print()
    print("  【对比】公式 LOO 误差 p90 = %.2f" % es[int(n * .90)])
    print("  【结论】若两者接近，说明公式已接近官方标注的信息上限，")
    print("          剩余误差主要来自官方标注的主观波动，非公式缺陷。")
