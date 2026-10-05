#!/usr/bin/env python3
"""
谱面特征与定数的相关性分析

用途：为难度模型提供可证伪的权重依据，而不是拍脑袋。

关键设计：
  1. 分层过滤 —— 排除小样本与异常值，避免噪声主导
  2. 偏相关 —— 控制物量后重算，区分「真实效应」与「谱型混淆」
  3. 分档交叉表 —— 观察非线性关系（相关系数只能给方向）
  4. 物性校验 —— 音符类型占比之和必须为 100%

用法：
  python analyze_chart_correlation.py            # 默认 manifest
  python analyze_chart_correlation.py --min-notes 200
"""
import argparse
import json
import os
import statistics as st

BASE = os.path.dirname(os.path.abspath(__file__))


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return num / (dx * dy) if dx * dy else 0.0


def partial_pearson(xs, ys, zs):
    """控制 z 后 xs 与 ys 的偏相关。"""
    rxy = pearson(xs, ys)
    rxz = pearson(xs, zs)
    ryz = pearson(ys, zs)
    den = ((1 - rxz ** 2) * (1 - ryz ** 2)) ** 0.5
    return (rxy - rxz * ryz) / den if den else 0.0


def bar(v, lo, hi):
    if hi <= lo:
        return ""
    n = int(round((v - lo) / (hi - lo) * 40))
    return "#" * max(0, n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest",
                    default=os.path.join(BASE, "..", "data", "charts", "manifest.jsonl"))
    ap.add_argument("--min-notes", type=int, default=200)
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.manifest, encoding="utf-8")]
    print(f"[load] manifest 共 {len(rows)} 条")

    # ---- 物性校验 ----
    bad = [r for r in rows
           if r["notes_real"] > 0 and
           abs(r["t_tap"] + r["t_hold"] + r["t_drag"] + r["t_flick"] - r["notes_real"]) > 0]
    print(f"[check] 音符类型和不守恒: {len(bad)} 条（应接近 0）")

    # ---- 分层过滤 ----
    v = [r for r in rows
         if r["notes_real"] >= args.min_notes
         and 0 < r["difficulty"] <= 20
         and r["notes_real"] > 0]
    print(f"[filter] 有效样本 n={len(v)}（notes>={args.min_notes}, 0<diff<=20）")
    if len(v) < 30:
        print("[abort] 样本不足")
        return

    def pct(r, k):
        return r[k] / r["notes_real"] * 100.0

    def num(r, k):
        """取数值字段，None/缺失返回 None。"""
        v = r.get(k)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    d = [r["difficulty"] for r in v]

    # ---- 1. 音符类型占比 ----
    print("\n" + "=" * 72)
    print("1. 音符类型占比 vs 定数")
    print("=" * 72)
    feats = [("t_tap", "Tap%", True, "判定±80ms 需精准"),
             ("t_hold", "Hold%", True, "需按住至结束"),
             ("t_drag", "Drag%", True, "判定±140ms 只需接住"),
             ("t_flick", "Flick%", True, "判定±140ms 只需划到")]
    for k, lab, _ispct, note in feats:
        p = [pct(r, k) for r in v]
        r = pearson(p, d)
        print(f"  {lab:<9} r = {r:+.4f}   {note}")

    # ---- 2. 结构特征 ----
    print("\n" + "=" * 72)
    print("2. 结构特征 vs 定数")
    print("=" * 72)
    struct = [("notes_real", "物量", False, "音符总数", True),
              ("lines", "判定线数", False, "", True),
              ("bpm", "BPM", False, "", False),
              ("bpm_items", "BPM段数", False, "变速复杂度", True),
              ("behind", "背面%", True, "above!=1", True),
              ("fake", "假键率%", True, "装饰性音符", True)]
    for k, lab, ispct, note, always in struct:
        if ispct:
            x = [pct(r, k) for r in v]
        elif always:
            x = [num(r, k) for r in v]
        else:
            # BPM 等可能为 None（PECTX 无 BPM 定义），需剔除配对
            pairs = [(num(r, k), r["difficulty"]) for r in v if num(r, k) is not None]
            if len(pairs) < 10:
                print(f"  {lab:<10} 有效样本不足（{len(pairs)}），跳过")
                continue
            x = [a for a, _ in pairs]
            print(f"  {lab:<10} r = {pearson(x, [b for _, b in pairs]):+.4f}   "
                  f"{note}  [n={len(pairs)}，其余为 PECTX 无BPM]")
            continue
        r = pearson(x, d)
        print(f"  {lab:<10} r = {r:+.4f}   {note}")

    # ---- 3. 偏相关：控制物量 ----
    print("\n" + "=" * 72)
    print("3. 控制「物量」后的偏相关（区分真实效应 vs 谱型混淆）")
    print("=" * 72)
    print(f"  {'特征':<10} {'r(原始)':>10} {'r(控制物量)':>14}   结论")
    print("  " + "-" * 58)
    notes = [r["notes_real"] for r in v]
    for item in feats + struct:
        k, lab, ispct = item[0], item[1], item[2]
        always = item[4] if len(item) > 4 else True
        if k == "notes_real":
            continue
        if ispct or always:
            x = [pct(r, k) if ispct else num(r, k) for r in v]
        else:
            continue        # BPM 已在第2节单独处理
        r0 = pearson(x, d)
        rp = partial_pearson(x, d, notes)
        note = "真实效应" if abs(rp) > 0.10 else ("谱型混淆" if abs(r0) > 0.10 else "无判别力")
        print(f"  {lab:<10} {r0:>+10.4f} {rp:>+14.4f}   {note}")

    # ---- 4. 非线性：分档交叉表 ----
    print("\n" + "=" * 72)
    print("4. 分档交叉表（相关系数只给方向，看非线性必须分档）")
    print("=" * 72)
    for item in feats + struct:
        k, lab, ispct = item[0], item[1], item[2]
        if not ispct and k == "bpm":
            continue                       # BPM 已单独处理
        x = [pct(r, k) if ispct else num(r, k) for r in v]
        if any(xx is None for xx in x):
            continue
        lo, hi = min(x), max(x)
        print(f"\n  【{lab}】 五分位均值：")
        rows5 = []
        for i in range(5):
            a = lo + (hi - lo) * i / 5
            b = lo + (hi - lo) * (i + 1) / 5
            sub = [d[j] for j in range(len(x)) if a <= x[j] < b] if i < 4 else \
                   [d[j] for j in range(len(x)) if a <= x[j] <= b]
            if sub:
                rows5.append((a, b, len(sub), st.mean(sub)))
        mn = min(r[3] for r in rows5)
        mx = max(r[3] for r in rows5)
        for a, b, n, m in rows5:
            tag = f"{a:.1f}~{b:.1f}" if ispct else f"{a:.0f}~{b:.0f}"
            print(f"    {tag:>14}  n={n:<5} 定数均值 {m:6.2f}  {bar(m, mn, mx)}")

    # ---- 5. 定数分档画像 ----
    print("\n" + "=" * 72)
    print("5. 定数分档的谱型画像（看高定数谱到底有什么特征）")
    print("=" * 72)
    bands = [(0, 10), (10, 12), (12, 13), (13, 14), (14, 15), (15, 16), (16, 20)]
    print(f"  {'定数区间':<12} {'n':>5} {'物量中位':>9} {'Tap%':>7} {'Drag%':>7} "
          f"{'Flick%':>7} {'Hold%':>7} {'线数中位':>9}")
    print("  " + "-" * 72)
    for lo, hi in bands:
        sub = [r for r in v if lo <= r["difficulty"] < hi]
        if len(sub) < 5:
            continue
        print(f"  {lo}-{hi:<10} {len(sub):>5} "
              f"{st.median(r['notes_real'] for r in sub):>9.0f} "
              f"{st.median(pct(r,'t_tap') for r in sub):>7.1f} "
              f"{st.median(pct(r,'t_drag') for r in sub):>7.1f} "
              f"{st.median(pct(r,'t_flick') for r in sub):>7.1f} "
              f"{st.median(pct(r,'t_hold') for r in sub):>7.1f} "
              f"{st.median(r['lines'] for r in sub):>9.0f}")

    # ---- 6. 离群谱 ----
    print("\n" + "=" * 72)
    print("6. 离群谱（同物量下定数明显偏离）")
    print("=" * 72)
    ln = [r["notes_real"] for r in v]
    md = st.median(ln)
    near = [r for r in v if md * 0.7 <= r["notes_real"] <= md * 1.4]
    print(f"  物量中位 {md:.0f} 附近共 {len(near)} 张，列出定数两端各 8 张：\n")
    srt = sorted(near, key=lambda x: x["difficulty"])
    for r in srt[:8]:
        print(f"    [低] {r['name'][:20]:<22} {r['level'] or '(无)':<12} "
              f"定数{r['difficulty']:5.1f} 物量{r['notes_real']:>5} "
              f"Drag{pct(r,'t_drag'):5.1f}% Tap{pct(r,'t_tap'):5.1f}%")
    print()
    for r in srt[-8:]:
        print(f"    [高] {r['name'][:20]:<22} {r['level'] or '(无)':<12} "
              f"定数{r['difficulty']:5.1f} 物量{r['notes_real']:>5} "
              f"Drag{pct(r,'t_drag'):5.1f}% Tap{pct(r,'t_tap'):5.1f}%")

    # ---- 7. 抽象谱识别 ----
    print("\n" + "=" * 72)
    print("7. 抽象谱候选（Drag占比>20% 或 极端离群）")
    print("=" * 72)
    abs_charts = [r for r in v if pct(r, "t_drag") > 20]
    print(f"  Drag>20%: {len(abs_charts)} 张（占 {len(abs_charts)/len(v)*100:.2f}%）")
    if abs_charts:
        print(f"  {'谱名':<24} {'level':<14} {'定数':>6} {'Drag%':>7} {'物量':>6}")
        for r in sorted(abs_charts, key=lambda x: -pct(x, "t_drag"))[:15]:
            print(f"  {r['name'][:22]:<24} {(r['level'] or '(无)')[:12]:<14} "
                  f"{r['difficulty']:>6.1f} {pct(r,'t_drag'):>7.1f} {r['notes_real']:>6}")
        dd = [r["difficulty"] for r in abs_charts]
        print(f"\n  抽象谱定数：中位 {st.median(dd):.2f} / 均值 {st.mean(dd):.2f}")
        print(f"  全体定数：中位 {st.median(d):.2f} / 均值 {st.mean(d):.2f}")
        print(f"  → 抽象谱定数{'显著偏低' if st.median(dd)<st.median(d)-0.3 else '未见明显偏低'}")

    print("\n" + "=" * 72)
    print("提醒：以上为观测统计，不等于因果。特征权重须经全量回归验证后使用。")
    print("=" * 72)


if __name__ == "__main__":
    main()
