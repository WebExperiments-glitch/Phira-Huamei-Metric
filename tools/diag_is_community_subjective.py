#!/usr/bin/env python3
"""
检验：Phira 谱师的定数是「纯主观」还是「有内部共识标准」？

判据：
  若定数与谱面客观特征**强相关** → 谱师心里有标准（只是不公开）
  若定数与特征**几乎无关**   → 真的是纯主观

方法：
  1. 社区谱：定数 vs 各特征的相关性
  2. 官谱对照：官方定数 vs 同样特征的相关性
  3. 若社区谱的相关性接近官谱 → 说明谱师遵循了与官方类似的逻辑
  4. 关键检验：社区谱定数能否被「官谱公式」预测
     —— 能预测 = 谱师不是乱填的
"""
import json
import math
import os
import statistics as st
import sys
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
OFF = os.path.join(BASE, "..", "data", "official", "manifest_v3.jsonl")
COM = os.path.join(BASE, "..", "data", "community", "manifest_features.jsonl")


def pear(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** .5
    dy = sum((y - my) ** 2 for y in ys) ** .5
    return num / (dx * dy) if dx and dy else 0


def partial(xs, ys, zs):
    rxy, rxz, ryz = pear(xs, ys), pear(xs, zs), pear(ys, zs)
    den = ((1 - rxz ** 2) * (1 - ryz ** 2)) ** .5
    return (rxy - rxz * ryz) / den if den else 0


off = [json.loads(l) for l in open(OFF, encoding="utf-8")]
off = [r for r in off if r["notes_real"] > 0]
com = [json.loads(l) for l in open(COM, encoding="utf-8")]
com = [r for r in com if r.get("notes_real", 0) >= 200
       and 0 < (r.get("difficulty") or 0) <= 20]
print(f"[data] 官谱 {len(off)}  社区谱 {len(com)}")

FEATS = [
    ("nps", "NPS(每秒手数)"),
    ("notes_real", "物量"),
    ("strain_peak", "峰值strain"),
    ("fast_ratio", "快速音符%"),
    ("chord_ratio", "同押%"),
    ("stair_speed_avg", "纵连速度"),
    ("above_avg_duration_sec", "高潮段秒数"),
    ("hold_interference_index", "长押干扰"),
    ("weighted_mf_score_per_sec", "多押强度"),
    ("chord_size_entropy", "和弦熵"),
    ("cross_hand_density", "交叉手"),
    ("eff_peak_tps_1s", "有效单指密度"),
]

print()
print("=" * 74)
print("1. 各特征与定数的相关性：官谱 vs 社区谱")
print("=" * 74)
print(f"  {'特征':<20}{'官谱r':>9}{'社区r':>9}"
      f"{'官谱偏r':>10}{'社区偏r':>10}  判定")
print("  " + "-" * 70)
res = []
for k, lab in FEATS:
    a = [float(r.get(k, 0) or 0) for r in off]
    b = [float(r.get(k, 0) or 0) for r in com]
    if not any(a) or not any(b):
        continue
    ra, rb = pear(a, [r["difficulty"] for r in off]), \
             pear(b, [r["difficulty"] for r in com])
    na = [r["nps"] for r in off]
    nb = [r.get("nps", 0) for r in com]
    pa = partial(a, [r["difficulty"] for r in off], na)
    pb = partial(b, [r["difficulty"] for r in com], nb)
    same = "相似" if abs(ra - rb) < 0.12 else ("社区更高" if abs(rb) > abs(ra) else "官谱更高")
    res.append((abs(ra), lab, ra, rb, pa, pb, same))
for a, lab, ra, rb, pa, pb, same in sorted(res, reverse=True):
    print(f"  {lab:<20}{ra:>+9.4f}{rb:>+9.4f}{pa:>+10.4f}{pb:>+10.4f}  {same}")

print()
print("=" * 74)
print("2. ★ 关键检验：官谱公式能否预测社区谱定数？")
print("=" * 74)
NPS_EDGES = [0, 2.5, 4.5, 6.5, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]


def bucket(v, edges):
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def kf(r):
    lv = (r.get("level") or "").upper()[:2]
    ni = bucket(r.get("nps"), NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    return (lv, ni, hi) if (ni is not None and hi is not None) else None


# 用官谱建表
tab = defaultdict(list)
for r in off:
    k = kf(r)
    if k:
        tab[k].append(r["difficulty"])
tbl = {k: st.median(v) for k, v in tab.items() if len(v) >= 4}
by_lv = defaultdict(list)
for r in off:
    by_lv[(r.get("level") or "").upper()[:2]].append(r["difficulty"])
lv_med = {k: st.median(v) for k, v in by_lv.items()}
glob = st.median([r["difficulty"] for r in off])

hit = miss = 0
errs = []
for r in com:
    k = kf(r)
    if k in tbl:
        p = tbl[k]
    else:
        lv = k[0] if k else ""
        p = lv_med.get(lv, glob)
    errs.append(abs(r["difficulty"] - p))
es = sorted(errs)
n = len(es)
print(f"  用官谱公式预测社区谱（n={n}）：")
print(f"    |误差| 中位 {es[n//2]:.2f}   p75 {es[int(n*.75)]:.2f}"
      f"   p90 {es[int(n*.90)]:.2f}")
print(f"    ≤1.0 占 {sum(1 for e in es if e<=1)/n*100:.1f}%"
      f"   ≤2.0 占 {sum(1 for e in es if e<=2)/n*100:.1f}%")
print()
print("  对照：社区谱定数的标准差 = %.2f" % st.pstdev(
    [r["difficulty"] for r in com]))
print("  → 若误差远小于标准差，说明社区谱定数【有规律】，不是乱填")
print("  → 若误差接近标准差，说明定数与谱面无关，纯主观")

print()
print("=" * 74)
print("3. 社区谱内部一致性：同一首歌不同难度是否遵循难度序？")
print("=" * 74)
by_song = defaultdict(list)
for r in com:
    by_song[r.get("name")].append(r)
ORD = ["EZ", "HD", "IN", "AT"]
mono = bad = 0
pairs = []
for nm, rs in by_song.items():
    rs.sort(key=lambda x: ORD.index(x["level"]) if x.get("level") in ORD else 9)
    for a, b in zip(rs, rs[1:]):
        if a.get("level") in ORD and b.get("level") in ORD:
            pairs.append(b["difficulty"] - a["difficulty"])
            if b["difficulty"] >= a["difficulty"]:
                mono += 1
            else:
                bad += 1
if pairs:
    print(f"  同曲相邻难度对：{mono+bad} 组")
    print(f"    递增 {mono} ({mono/(mono+bad)*100:.1f}%)"
          f"   递减 {bad} ({bad/(mono+bad)*100:.1f}%)")
    print(f"    定数差中位 {st.median(pairs):.2f}")
    print()
    if mono / (mono + bad) > 0.9:
        print("  → 【谱师普遍遵循「难度递增」原则】")
        print("  → 这说明定数不是随手填的，有内在顺序约束")
    else:
        print("  → 顺序约束弱，定数较随机")

print()
print("=" * 74)
print("4. 抽象谱/假键流谱是否被系统性区别对待？")
print("=" * 74)
flow = [r for r in com if r.get("fake", 0) > r["notes_real"]]
norm = [r for r in com if r.get("fake", 0) == 0]
if flow:
    print(f"  假键流谱 n={len(flow)}  定数中位 "
          f"{st.median([r['difficulty'] for r in flow]):.2f}")
    print(f"  无假键谱 n={len(norm)}  定数中位 "
          f"{st.median([r['difficulty'] for r in norm]):.2f}")
    # 控制 NPS
    fa = [r["difficulty"] for r in flow]
    na = [r.get("nps", 0) for r in flow]
    print(f"  假键流谱 NPS 中位 {st.median(na):.2f}")
    lo = st.median([r["difficulty"] for r in norm
                    if 3 < r.get("nps", 0) < 7])
    print(f"  同 NPS 区间(3~7)的无假键谱 定数中位 {lo:.2f}")
