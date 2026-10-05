#!/usr/bin/env python3
"""
官谱基线验证 —— 「100% 对齐官方」的硬校验

原则：任何拟合之前，必须先证明特征提取与官方定数完全对齐。
本脚本只做验证，不做拟合。

检查项：
  A. 物性校验（内部自洽）
  B. 时间轴物理合理性（NPS 必须在音游可行区间内）
  C. 官谱 vs 社区谱分布对比（口径一致性）
  D. 定数 ↔ 特征的映射可辨识性（能否区分不同定数档）
  E. 异常检测（离群、矛盾、疑似虚标）
"""
import collections
import json
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
OFFICIAL = os.path.abspath(os.path.join(BASE, "..", "data", "official", "manifest.jsonl"))
COMMUNITY = os.path.abspath(os.path.join(BASE, "..", "data", "charts", "manifest.jsonl"))

FAIL, WARN, OK = [], [], []


def ok(m):
    OK.append(m); print(f"  [PASS] {m}")


def fail(m):
    FAIL.append(m); print(f"  [FAIL] {m}")


def warn(m):
    WARN.append(m); print(f"  [WARN] {m}")


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return num / (dx * dy) if dx and dy else 0.0


def load(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        out[r["id"] if "id" in r else r.get("song_id", 0)] = r
    return list(out.values())


def main():
    off = load(OFFICIAL)
    print(f"[load] 官谱 {len(off)} 条")

    # ---------- A. 物性校验 ----------
    print("\n" + "=" * 72)
    print("A. 物性校验")
    print("=" * 72)

    bad = [r for r in off
           if r["t_tap"] + r["t_hold"] + r["t_flick"] + r["t_drag"] != r["notes_real"]]
    (ok if not bad else fail)(
        f"音符类型和不守恒：{len(bad)} 处"
        + (f"，例：{[b['song_id'] for b in bad[:3]]}" if bad else ""))

    bad = [r for r in off if r["notes_real"] <= 0]
    (ok if not bad else fail)(f"空谱：{len(bad)} 张")

    bad = [r for r in off if not (r.get("bpm") or 0) > 0]
    (ok if not bad else fail)(f"BPM 非法：{len(bad)} 张")

    dup = [k for k, v in collections.Counter(
        (r["song_id"], r["level"]) for r in off).items() if v > 1]
    (ok if not dup else fail)(f"重复条目：{len(dup)}")

    # ---------- B. 时间轴物理合理性 ----------
    print("\n" + "=" * 72)
    print("B. 时间轴物理合理性")
    print("=" * 72)

    nps = sorted(r["nps"] for r in off)
    dur = sorted(r["duration_s"] for r in off)
    print(f"  NPS    {nps[0]:.1f} ~ {nps[-1]:.1f}  中位 {nps[len(nps)//2]:.1f}")
    print(f"  时长   {dur[0]:.1f}s ~ {dur[-1]:.1f}s  中位 {dur[len(dur)//2]:.1f}s")

    # 音游物理上限：单人同时最多 10 指，纵连可超但极罕见
    # 取 99 分位做硬判据
    p99 = nps[int(len(nps) * 0.99)]
    (ok if nps[-1] < 60 else warn)(
        f"最大 NPS {nps[-1]:.1f}（p99={p99:.1f}）—— 若 >60 说明换算仍有问题")

    unrealistic = [r for r in off if r["nps"] > 40]
    (ok if not unrealistic else warn)(
        f"NPS>40 的谱：{len(unrealistic)} 张"
        + (f"，例：{[(r['name'][:12], round(r['nps'],1)) for r in unrealistic[:3]]}"
           if unrealistic else ""))

    short = [r for r in off if r["duration_s"] < 30]
    (ok if not short else warn)(
        f"时长 <30s 的谱：{len(short)} 张（官谱正常曲目应 >60s）")

    zero_notes = [r for r in off if r["nps"] <= 0]
    (ok if not zero_notes else fail)(f"NPS<=0：{len(zero_notes)} 张")

    # 物量 / 时长 一致性
    bad = [r for r in off
           if abs(r["notes_real"] / max(r["duration_s"], 1e-9) - r["nps"]) > 0.01]
    (ok if not bad else fail)(f"NPS 与 物量/时长 不一致：{len(bad)} 张")

    # ---------- C. 官谱 vs 社区谱 ----------
    print("\n" + "=" * 72)
    print("C. 官谱 vs 社区谱（口径一致性检查）")
    print("=" * 72)

    com = load(COMMUNITY)
    com = [r for r in com if r.get("notes_real", 0) >= 100
           and 0 < (r.get("difficulty") or 0) <= 20]
    print(f"  社区谱有效样本 {len(com)}")

    for lab, rows in (("官谱", off), ("社区谱", com)):
        tp = st.median([r["t_tap"] / r["notes_real"] * 100 for r in rows])
        dr = st.median([r["t_drag"] / r["notes_real"] * 100 for r in rows])
        fl = st.median([r["t_flick"] / r["notes_real"] * 100 for r in rows])
        ho = st.median([r["t_hold"] / r["notes_real"] * 100 for r in rows])
        nm = st.median([r["notes_real"] for r in rows])
        ln = st.median([r["lines"] for r in rows])
        print(f"  {lab:<7} n={len(rows):<5} 物量中位={nm:>6.0f} 线数中位={ln:>4.0f} "
              f"Tap={tp:5.1f}% Flick={fl:5.1f}% Hold={ho:5.1f}% Drag={dr:5.1f}%")

    offtp = st.median([r["t_tap"] / r["notes_real"] * 100 for r in off])
    comtp = st.median([r["t_tap"] / r["notes_real"] * 100 for r in com])
    diff = abs(offtp - comtp)
    (ok if diff < 8 else warn)(
        f"Tap 占比差异 {offtp:.1f}% vs {comtp:.1f}% = {diff:.1f}pp（<8pp 视为口径一致）")

    # ---------- D. 定数 ↔ 特征可辨识性 ----------
    print("\n" + "=" * 72)
    print("D. 定数 ↔ 特征映射的可辨识性")
    print("=" * 72)

    print("  与定数的 Pearson 相关（官谱 n=%d）:" % len(off))
    feats = [("notes_real", "物量", False),
             ("lines", "判定线数", False),
             ("bpm", "BPM", False),
             ("nps", "NPS", False),
             ("duration_s", "时长", False)]
    d = [r["difficulty"] for r in off]
    for k, lab, ispct in feats:
        x = [r[k] for r in off]
        print(f"    {lab:<10} r = {pearson(x, d):+.4f}")
    for k, lab in (("t_tap", "Tap%"), ("t_hold", "Hold%"),
                   ("t_flick", "Flick%"), ("t_drag", "Drag%")):
        x = [r[k] / r["notes_real"] * 100 for r in off]
        print(f"    {lab:<10} r = {pearson(x, d):+.4f}")

    # 分档验证：不同定数档的特征是否可区分
    print("\n  按定数分档的特征画像（可辨识性检验）:")
    print(f"  {'定数区间':<12}{'n':>5}{'物量中位':>9}{'NPS中位':>9}"
          f"{'Tap%':>7}{'时长中位':>9}")
    print("  " + "-" * 60)
    for lo, hi in [(0, 6), (6, 9), (9, 11), (11, 13), (13, 14),
                   (14, 15), (15, 16), (16, 19)]:
        sub = [r for r in off if lo <= r["difficulty"] < hi]
        if len(sub) < 5:
            continue
        print(f"  {lo}-{hi:<10}{len(sub):>5}"
              f"{st.median([r['notes_real'] for r in sub]):>9.0f}"
              f"{st.median([r['nps'] for r in sub]):>9.2f}"
              f"{st.median([r['t_tap']/r['notes_real']*100 for r in sub]):>7.1f}"
              f"{st.median([r['duration_s'] for r in sub]):>9.1f}")

    # 关键检验：单调性
    bands = [(0, 6), (6, 9), (9, 11), (11, 13), (13, 14), (14, 15), (15, 16), (16, 19)]
    seq = []
    for lo, hi in bands:
        sub = [r for r in off if lo <= r["difficulty"] < hi]
        if len(sub) >= 5:
            seq.append((lo, hi, st.median([r["notes_real"] for r in sub])))
    mono = all(seq[i][2] < seq[i + 1][2] for i in range(len(seq) - 1))
    (ok if mono else warn)(
        f"物量随定数单调递增：{'是' if mono else '否（存在反常档）'}")
    print("    " + " → ".join(f"{lo}-{hi}:{int(n)}" for lo, hi, n in seq))

    # ---------- E. 异常检测 ----------
    print("\n" + "=" * 72)
    print("E. 异常检测")
    print("=" * 72)

    over = [r for r in off if r["difficulty"] > 18.0]
    (ok if not over else warn)(
        f"定数 > 18.0（官方历史上限）：{len(over)} 张")

    # 同曲四难度定数应递增
    by_song = collections.defaultdict(dict)
    for r in off:
        by_song[r["song_id"]][r["level"]] = r["difficulty"]
    non_mono = []
    for sid, d2 in by_song.items():
        seq2 = [d2.get(l) for l in ("EZ", "HD", "IN", "AT")]
        seq2 = [x for x in seq2 if x is not None]
        if len(seq2) >= 2 and any(seq2[i] > seq2[i + 1] for i in range(len(seq2) - 1)):
            non_mono.append((sid, d2))
    (ok if not non_mono else warn)(
        f"同曲难度定数非递增：{len(non_mono)} 首"
        + (f"，例：{[(s, v) for s, v in non_mono[:2]]}" if non_mono else ""))

    # 同物量下定数应无极端离群（官方数据应自洽）
    med_n = st.median([r["notes_real"] for r in off])
    band = [r for r in off if med_n * 0.7 <= r["notes_real"] <= med_n * 1.4]
    if band:
        dv = sorted(r["difficulty"] for r in band)
        iqr = dv[int(len(dv) * .75)] - dv[int(len(dv) * .25)]
        lo = dv[int(len(dv) * .25)] - 1.5 * iqr
        hi2 = dv[int(len(dv) * .75)] + 1.5 * iqr
        outl = [r for r in band if r["difficulty"] < lo or r["difficulty"] > hi2]
        (ok if not outl else warn)(
            f"同物量区间内定数离群（1.5×IQR）：{len(outl)} 张"
            + (f"，例：{[(r['name'][:14], r['difficulty']) for r in outl[:3]]}"
               if outl else ""))

    print(f"\n  官谱定数分布: {dict(sorted(collections.Counter(int(r['difficulty']) for r in off).items()))}")

    # ---------- 结论 ----------
    print("\n" + "=" * 72)
    print(f"基线验证：PASS={len(OK)}  WARN={len(WARN)}  FAIL={len(FAIL)}")
    print("=" * 72)
    for m in FAIL:
        print(f"  [FAIL] {m}")
    for m in WARN:
        print(f"  [WARN] {m}")
    if FAIL:
        print("\n❌ 基线不可用，禁止进入拟合阶段。")
        return 2
    print("\n✅ 基线可用。官谱定数 ↔ 谱面特征映射可辨识，可进入拟合。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
