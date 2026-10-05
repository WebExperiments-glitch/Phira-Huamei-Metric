#!/usr/bin/env python3
"""
交叉验证：我的 APK 提取 vs 竞品的 difficulty.tsv

目的：
  1. 验证我从 APK 提取的定数是否可信（两套独立方法应高度一致）
  2. 找出差异条目，判断是版本更新还是提取错误
  3. 顺便验证「7级及以上无 x.0」规则的违反率

数据源：
  我的：APK → data.unity3d → GameInformation（1037 条定数）
  竞品：仓库 data/info/difficulty.tsv（312 首 = 312×4 = 1248 个值）
"""
import json
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))

LEVELS = ["EZ", "HD", "IN", "AT"]


def load_mine():
    p = os.path.join(ROOT, "data", "official", "manifest_enhanced.jsonl")
    out = {}
    for line in open(p, encoding="utf-8"):
        r = json.loads(line)
        out.setdefault(r["song_id"], {})[r["level"]] = r["difficulty"]
    return out


def load_theirs(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) < 2:
                continue
            d = {}
            for i, lv in enumerate(LEVELS, start=1):
                if i < len(p) and p[i]:
                    try:
                        d[lv] = float(p[i])
                    except ValueError:
                        pass
            out[p[0]] = d
    return out


def main():
    tp = os.path.join(ROOT, "_research", "est_difficulty.tsv")
    if not os.path.exists(tp):
        print("[abort] 未找到 est_difficulty.tsv")
        return 1
    mine = load_mine()
    theirs = load_theirs(tp)
    print(f"[load] 我的 {len(mine)} 首 / 竞品 {len(theirs)} 首")

    common = set(mine) & set(theirs)
    only_mine = set(mine) - set(theirs)
    only_theirs = set(theirs) - set(mine)
    print(f"[交集] {len(common)} 首")
    print(f"[仅我有] {len(only_mine)} 首  例: {list(only_mine)[:3]}")
    print(f"[仅它有] {len(only_theirs)} 首  例: {list(only_theirs)[:3]}")

    # ---- 逐条比对 ----
    same = 0
    diff = []
    for sid in common:
        for lv in LEVELS:
            if lv in mine[sid] and lv in theirs[sid]:
                a, b = mine[sid][lv], theirs[sid][lv]
                if abs(a - b) < 1e-6:
                    same += 1
                else:
                    diff.append((sid, lv, a, b))
    tot = same + len(diff)
    print(f"\n[比对] 共 {tot} 个定数值")
    print(f"  一致 {same} ({same/tot*100:.2f}%)")
    print(f"  不一致 {len(diff)} ({len(diff)/tot*100:.2f}%)")
    if diff:
        print(f"\n  不一致明细（前 20）:")
        for sid, lv, a, b in diff[:20]:
            print(f"    {sid[:36]:<38} {lv:<3} 我={a:5.1f}  竞品={b:5.1f}  Δ={a-b:+.1f}")
        deltas = [abs(a - b) for _, _, a, b in diff]
        print(f"\n  差异幅度: 中位 {st.median(deltas):.1f}  最大 {max(deltas):.1f}")

    # ---- 验证「7+ 无 x.0」规则 ----
    print("\n" + "=" * 70)
    print("验证社区规则「2.5.0 起 7 级及以上无 x.0」")
    print("=" * 70)
    for lab, data in (("我的(APK)", mine), ("竞品(tsv)", theirs)):
        viol = 0
        allv = 0
        examples = []
        for sid, d in data.items():
            for lv, v in d.items():
                allv += 1
                lvl = int(v)
                frac = round(v - lvl, 1)
                if lvl >= 8 and abs(frac) < 1e-6:
                    viol += 1
                    if len(examples) < 5:
                        examples.append((sid, lv, v))
        print(f"  {lab:<12} 定数 {allv} 个，8+ 级出现 x.0 的 {viol} 个"
              f"（{viol/allv*100:.2f}%）")
        for s, lv, v in examples:
            print(f"      例: {s[:30]:<32} {lv} = {v}")

    # ---- 分布对比 ----
    print("\n" + "=" * 70)
    print("定数分布对比")
    print("=" * 70)
    for lab, data in (("我的", mine), ("竞品", theirs)):
        vs = [v for d in data.values() for v in d.values()]
        vs.sort()
        print(f"  {lab:<6} n={len(vs):<5} {min(vs):.1f}~{max(vs):.1f} "
              f"中位 {st.median(vs):.1f} 均值 {st.mean(vs):.2f}")

    # ---- 同曲定数递增性 ----
    print("\n" + "=" * 70)
    print("同曲四难度递增性（官谱应有此性质）")
    print("=" * 70)
    for lab, data in (("我的", mine), ("竞品", theirs)):
        bad = []
        for sid, d in data.items():
            seq = [d.get(lv) for lv in LEVELS]
            seq = [x for x in seq if x is not None]
            if len(seq) >= 2 and any(seq[i] > seq[i + 1]
                                    for i in range(len(seq) - 1)):
                bad.append(sid)
        print(f"  {lab:<6} 非递增 {len(bad)} 首  例: {bad[:3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
