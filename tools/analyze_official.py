#!/usr/bin/env python3
"""Identify official Phigros charts ported into Phira, compare their difficulty vs community charts."""
import json, os, re, statistics as st
from collections import Counter, defaultdict

BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
R = json.load(open(os.path.join(BASE, "regular.json"), encoding="utf-8"))["results"]

# Phigros official charts: level prefix in {Easy, Hard, Extreme, IN, AT, FM} AND
# difficulty is an integer, and often tagged. Search by known official song names too.
OFFICIAL_PREFIX = {"EASY", "HARD", "EXTREME", "IN", "AT", "FM", "E", "H"}

print("=" * 72)
print("A. tags 中含'移植'/'官方'/'phigros'/'PGR' 的谱")
print("=" * 72)
keys = ["移植", "官方", "phigros", "PGR", "pgr", "官谱", "移植谱", "黄谱", "绿谱"]
hit = defaultdict(list)
for r in R:
    for t in r.get("tags") or []:
        for k in keys:
            if k.lower() in t.lower():
                hit[t].append(r)
for t, rows in hit.items():
    ds = [x["difficulty"] for x in rows]
    ints = [d for d in ds if abs(d - round(d)) < 1e-3]
    print(f"  tag={t!r}: n={len(rows)}  定数中位数={st.median(ds):.2f} 平均={st.mean(ds):.2f} 整数定数占比={len(ints)/len(ds)*100:.1f}%")

print("\n" + "=" * 72)
print("B. 用'纯整数定数 + level前缀为官方难度名'筛候选官方谱")
print("=" * 72)
cand = []
for r in R:
    d = r["difficulty"]
    if abs(d - round(d)) > 1e-3:
        continue
    if not (1 <= d <= 20):
        continue
    lv = (r.get("level") or "").strip().upper()
    m = re.match(r"^(EASY|HARD|EXTREME|IN|AT|FM|E|H)\b", lv)
    if not m:
        continue
    cand.append(r)
print(f"  候选数: {len(cand)}")
ds = [r["difficulty"] for r in cand]
print(f"  定数分布: {sorted(Counter(int(d) for d in ds).items())}")
print(f"  中位数={st.median(ds):.1f} 平均={st.mean(ds):.2f}")
print("  样例:")
for r in cand[:20]:
    print(f"    id={r['id']:<6} diff={r['difficulty']:<5.0f} level={r['level']!r:<20} name={r['name'][:24]!r} charter={r['charter'][:16]!r} stable={r['stable']}")

print("\n" + "=" * 72)
print("C. 官方谱 vs 社区谱：定数分布对比")
print("=" * 72)
# compare: charts whose difficulty is integer AND level has no 'Lv' marker (official style "IN 15")
off_style = [r for r in R if abs(r["difficulty"] - round(r["difficulty"])) < 1e-3
             and not re.search(r"Lv", r.get("level") or "", re.I)
             and 1 <= r["difficulty"] <= 20]
comm = [r for r in R if 0 < r["difficulty"] <= 20]
def desc(rows, name):
    d = [r["difficulty"] for r in rows]
    intd = [x for x in d if abs(x - round(x)) < 1e-3]
    print(f"  {name}: n={len(d)} 中位数={st.median(d):.2f} 平均={st.mean(d):.2f} 整数占比={len(intd)/len(d)*100:.1f}%")
    c = Counter(int(x) for x in d)
    print(f"     整数等级: {sorted(c.items())}")
    return d
if off_style:
    desc(off_style, "'官方风格'(整数定数 + level无Lv)")
desc(comm, "社区谱(0<diff<=20 全部)")

print("\n" + "=" * 72)
print("D. stable(ranked) 谱的定数分布 —— 官方最看重的一类")
print("=" * 72)
st_rows = [r for r in R if r["stable"]]
d = [r["difficulty"] for r in st_rows]
print(f"  n={len(d)} 中位数={st.median(d):.2f} 平均={st.mean(d):.2f} min={min(d)} max={max(d)}")
print(f"  整数等级分布: {sorted(Counter(int(x) for x in d).items())}")
frac = Counter(round(x - int(x), 2) for x in d)
print(f"  小数部分: {frac.most_common(11)}")
nolv = [r for r in st_rows if not re.search(r"Lv", r.get('level') or '', re.I)]
print(f"  level 不含 'Lv' 的 stable 谱: {len(nolv)}/{len(st_rows)} ({len(nolv)/len(st_rows)*100:.1f}%)")

print("\n" + "=" * 72)
print("E. 定数与 '整数等级' 的关系：是否存在'压线'惯例 (x.9)")
print("=" * 72)
sub = [r for r in R if 10 <= r["difficulty"] < 20]
f09 = [r for r in sub if abs((r["difficulty"] - int(r["difficulty"])) - 0.9) < 1e-3]
f00 = [r for r in sub if abs(r["difficulty"] - int(r["difficulty"])) < 1e-3]
f05 = [r for r in sub if abs((r["difficulty"] - int(r["difficulty"])) - 0.5) < 1e-3]
print(f"  Lv.10-19 区间 n={len(sub)}")
print(f"    小数=0.0: {len(f00)} ({len(f00)/len(sub)*100:.1f}%)")
print(f"    小数=0.5: {len(f05)} ({len(f05)/len(sub)*100:.1f}%)")
print(f"    小数=0.9: {len(f09)} ({len(f09)/len(sub)*100:.1f}%)")
oth = len(sub) - len(f00) - len(f05) - len(f09)
print(f"    其他小数: {oth} ({oth/len(sub)*100:.1f}%)")
