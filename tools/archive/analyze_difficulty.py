#!/usr/bin/env python3
"""Analyze Phira difficulty vs level field across all divisions."""
import json, os, re, statistics as st
from collections import Counter, defaultdict

BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
data = {}
for tag in ["regular", "plain", "troll", "visual"]:
    p = os.path.join(BASE, f"{tag}.json")
    if os.path.exists(p):
        data[tag] = json.load(open(p, encoding="utf-8"))["results"]

print("=" * 70)
print("1. 全量 difficulty 分布（原始值，含离群）")
print("=" * 70)
for tag, rows in data.items():
    d = [r["difficulty"] for r in rows]
    print(f"\n[{tag}] n={len(d)}")
    print(f"  min={min(d):.3f} max={max(d):.3f} mean={st.mean(d):.2f} median={st.median(d):.2f}")
    qs = st.quantiles(d, n=100)
    print(f"  p1={qs[0]:.2f} p5={qs[4]:.2f} p25={qs[24]:.2f} p75={qs[74]:.2f} p95={qs[94]:.2f} p99={qs[98]:.2f}")
    # how many outside 0-20 (the editor slider range)
    oob = [x for x in d if x < 0 or x > 20]
    print(f"  超出编辑器滑块范围[0,20]: {len(oob)} ({len(oob)/len(d)*100:.2f}%)")
    neg = [x for x in d if x < 0]
    print(f"  负定数: {len(neg)}")

print("\n" + "=" * 70)
print("2. f32 精度伪影：difficulty 是否为 x.0 / x.5 等一位小数")
print("=" * 70)
for tag, rows in data.items():
    d = [r["difficulty"] for r in rows]
    # artifact = not representable in ~6 significant decimal digits of f32
    art = [x for x in d if abs(x * 10 - round(x * 10)) > 1e-4]
    clean = [x for x in d if abs(x * 10 - round(x * 10)) <= 1e-4]
    print(f"[{tag}] 干净一位小数 {len(clean)}/{len(d)} ({len(clean)/len(d)*100:.1f}%) | 伪影值 {len(art)} ({len(art)/len(d)*100:.1f}%)")
    if art[:5]:
        print(f"   伪影样例: {art[:5]}")

print("\n" + "=" * 70)
print("3. level 字符串 vs difficulty 的关系（核心）")
print("=" * 70)
pat_lv = re.compile(r"Lv\.?\s*(\d+(?:\.\d+)?)", re.I)
for tag, rows in data.items():
    print(f"\n[{tag}] n={len(rows)}")
    has_lv = 0
    match = 0
    floor_match = 0
    diffs = []
    no_lv = []
    for r in rows:
        lv = r.get("level") or ""
        m = pat_lv.search(lv)
        if not m:
            no_lv.append(lv)
            continue
        has_lv += 1
        try:
            lvn = float(m.group(1))
        except ValueError:
            continue
        dv = r["difficulty"]
        diffs.append(lvn - dv)
        if abs(lvn - dv) < 0.01:
            match += 1
        # does floor(difficulty) equal the Lv number?
        if int(dv) == int(lvn):
            floor_match += 1
    print(f"  含 'Lv' 的 level: {has_lv}/{len(rows)} ({has_lv/len(rows)*100:.1f}%)")
    if has_lv:
        print(f"  Lv 数值 == difficulty(±0.01): {match}/{has_lv} ({match/has_lv*100:.1f}%)")
        print(f"  int(difficulty) == Lv 整数部分: {floor_match}/{has_lv} ({floor_match/has_lv*100:.1f}%)")
        print(f"  Lv - difficulty: mean={st.mean(diffs):+.3f} median={st.median(diffs):+.3f}")
    if no_lv:
        c = Counter(no_lv)
        print(f"  不含 Lv 的 level ({len(no_lv)} 个), 前 8: {c.most_common(8)}")

print("\n" + "=" * 70)
print("4. level 前缀（难度标签）分布  [? = IN / ? = AT / ? = FM 等]")
print("=" * 70)
for tag, rows in data.items():
    pref = Counter()
    for r in rows:
        lv = (r.get("level") or "").strip()
        m = re.match(r"^([A-Za-z\u4e00-\u9fff]+)", lv)
        pref[m.group(1).upper() if m else "(空)"] += 1
    print(f"\n[{tag}] top12: {pref.most_common(12)}")

print("\n" + "=" * 70)
print("5. 整数部分（等级）分布 vs 小数部分")
print("=" * 70)
for tag, rows in data.items():
    d = [r["difficulty"] for r in rows if 0 <= r["difficulty"] <= 20]
    if not d:
        continue
    print(f"\n[{tag}] n={len(d)} (仅取 0-20 区间)")
    intc = Counter(int(x) for x in d)
    print(f"  整数等级分布: {sorted(intc.items())}")
    frac = Counter(round(x - int(x), 2) for x in d)
    print(f"  小数部分 top10: {frac.most_common(10)}")
