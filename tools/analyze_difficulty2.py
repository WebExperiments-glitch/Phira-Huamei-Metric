#!/usr/bin/env python3
"""Deeper analysis: fractional convention, IN/AT tier vs difficulty, official chart detection."""
import json, os, re, statistics as st
from collections import Counter, defaultdict

BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
R = json.load(open(os.path.join(BASE, "regular.json"), encoding="utf-8"))["results"]

print("=" * 72)
print("A. 整数等级 = floor(difficulty) 的验证（含 Lv 的 level 字段）")
print("=" * 72)
pat = re.compile(r"Lv\.?\s*(\d+)", re.I)
ok = bad = 0
badsamples = []
for r in R:
    lv = r.get("level") or ""
    m = pat.search(lv)
    if not m:
        continue
    want = int(m.group(1))
    got = int(r["difficulty"])
    if want == got:
        ok += 1
    else:
        bad += 1
        if len(badsamples) < 10:
            badsamples.append((r["id"], lv, r["difficulty"]))
print(f"  一致: {ok}  不一致: {bad}  ->  一致率 {ok/(ok+bad)*100:.2f}%")
print("  不一致样例 (id, level, difficulty):")
for s in badsamples:
    print("   ", s)

print("\n" + "=" * 72)
print("B. 小数部分 = 0.9 的现象（'压线'惯例：15.9 表示'差一点点 16'）")
print("=" * 72)
sub = [r for r in R if 0 < r["difficulty"] <= 20]
byint = defaultdict(Counter)
for r in sub:
    i = int(r["difficulty"])
    f = round(r["difficulty"] - i, 3)
    byint[i][f] += 1
for i in sorted(byint):
    c = byint[i]
    tot = sum(c.values())
    top = ", ".join(f"{k:.1f}×{v}" for k, v in c.most_common(4))
    print(f"  Lv.{i:<2} n={tot:<5} 小数分布: {top}")

print("\n" + "=" * 72)
print("C. level 前缀（IN/AT/FM/SP/HD...）× 整数等级 交叉表 [regular]")
print("=" * 72)
cross = defaultdict(Counter)
for r in R:
    lv = (r.get("level") or "").strip()
    m = re.match(r"^([A-Za-z\u4e00-\u9fff]+)", lv)
    p = (m.group(1).upper() if m else "(空)")
    if not pat.search(lv):
        continue
    cross[p][int(r["difficulty"])] += 1
for p in ["IN", "AT", "FM", "SP", "HD", "EZ", "EX", "LV"]:
    if p in cross:
        c = cross[p]
        tot = sum(c.values())
        items = sorted(c.items())
        print(f"  {p:<4} n={tot:<5} {items}")

print("\n" + "=" * 72)
print("D. 定数超出编辑器滑块范围 [0,20] 的谱（regular）")
print("=" * 72)
oob = sorted([r for r in R if not (0 <= r["difficulty"] <= 20)], key=lambda r: -r["difficulty"])
print(f"  共 {len(oob)} 张：")
for r in oob[:15]:
    print(f"   id={r['id']:<6} diff={r['difficulty']:<12} level={r['level']!r:<22} charter={r['charter'][:20]!r} stable={r['stable']} rated={r['rating']:.2f} n={r['ratingCount']}")

print("\n" + "=" * 72)
print("E. 定数为 0 的谱（regular）")
print("=" * 72)
zero = [r for r in R if r["difficulty"] == 0]
print(f"  共 {len(zero)} 张，样例：")
for r in zero[:12]:
    print(f"   id={r['id']:<6} level={r['level']!r:<24} charter={r['charter'][:18]!r} stable={r['stable']} n={r['ratingCount']}")

print("\n" + "=" * 72)
print("F. tags 分布（用于识别官方谱 / 移植谱）")
print("=" * 72)
tagc = Counter()
for r in R:
    for t in r.get("tags") or []:
        tagc[t] += 1
print(f"  不同 tag 数: {len(tagc)}")
for t, c in tagc.most_common(40):
    print(f"   {t:<24} {c}")

print("\n" + "=" * 72)
print("G. 定数 vs 玩家评分 rating 的相关性（rated/stable 子集）")
print("=" * 72)
import math
def corr(xs, ys):
    n = len(xs)
    if n < 3: return None
    mx, my = sum(xs)/n, sum(ys)/n
    sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    sxx = sum((x-mx)**2 for x in xs); syy = sum((y-my)**2 for y in ys)
    if sxx <= 0 or syy <= 0: return None
    return sxy/math.sqrt(sxx*syy)

for label, sel in [
    ("regular 全部", lambda r: 0 <= r["difficulty"] <= 20 and r["ratingCount"] >= 20),
    ("stable(ranked)", lambda r: 0 <= r["difficulty"] <= 20 and r["stable"] and r["ratingCount"] >= 20),
]:
    rows = [r for r in R if sel(r)]
    xs = [r["difficulty"] for r in rows]; ys = [r["rating"] for r in rows]
    c = corr(xs, ys)
    print(f"  {label}: n={len(rows)} Pearson r(difficulty, rating) = {c:.4f}" if c else f"  {label}: n={len(rows)} 无法计算")
    # difficulty band vs mean rating
    band = defaultdict(list)
    for r in rows:
        band[int(r["difficulty"])].append(r["rating"])
    print("     难度带平均评分:", {k: round(st.mean(v), 3) for k, v in sorted(band.items()) if len(v) >= 15})
