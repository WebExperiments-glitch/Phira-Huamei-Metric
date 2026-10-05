#!/usr/bin/env python3
"""
官谱特征增强 —— 补充时序类特征

基线（build_official_baseline.py）只有聚合统计量，缺��键的时序特征。
本脚本补充峰值 strain 与节奏型特征，输出增强版基线。

峰值 strain 的物理依据（osu! 思路）：
  平均密度会被「耐力型谱」稀释 —— 一张 3 分钟 1000 音符的谱，
  平均 NPS 很低，但可能有 10 秒极高密度。
  难度来自**峰值**，不是平均。
  → 竞品自陈的失败点「耐力是乘性难度」正是这个问题

时间轴：PGR，seconds = time * 60/32/BPM（官方 pgr.rs:232）
"""
import argparse
import collections
import json
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# 音符类型的操作成本（依据官方判定区间，±ms）
# Tap/Hold ±80ms 需精准；Flick/Drag ±140ms 宽松
COST = {1: 1.00, 2: 1.00, 3: 0.35, 4: 0.55}


def load_chart_times(path):
    """读 PGR 谱，返回 (秒列表, 类型列表, 判定线数)"""
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    lines = j.get("judgeLineList") or []
    bpm0 = 120.0
    for ln in lines:
        b = ln.get("bpm")
        if isinstance(b, (int, float)) and b > 0:
            bpm0 = b
            break
    r = 60.0 / 32.0 / bpm0
    ts, ty = [], []
    for ln in lines:
        for key in ("notesAbove", "notesBelow"):
            for n in (ln.get(key) or []):
                t = n.get("time")
                if t is None:
                    continue
                ts.append(t * r)
                ty.append(n.get("type"))
    return ts, ty, len(lines)


def strain_peak(ts, ty, window=1.0):
    """
    峰值 strain：滑动 1 秒窗口内的加权音符率（strain/s）。

    权重用物理操作成本 COST，使 Flick/Drag 贡献低于 Tap/Hold。
    窗口按 0.05s 步进，保证短谱也有足够采样点。

    实现要点：所有音符先按时间排序，双指针维护窗口。
    窗口跨度可能小于 1s（谱尾），此时除以实际跨度，避免除零。
    """
    n = len(ts)
    if n == 0:
        return 0.0, 0.0, {}
    order = sorted(range(n), key=lambda i: ts[i])
    ts2 = [ts[i] for i in order]
    ty2 = [ty[i] for i in order]
    dur_total = ts2[-1] - ts2[0]
    if dur_total <= 0:
        return 0.0, 0.0, {}

    step = window / 20.0                      # 0.05s

    # 前缀和：sum_cost[i] = 前 i 个音符的加权成本总和
    pre = [0.0] * (n + 1)
    for i in range(n):
        pre[i + 1] = pre[i] + COST.get(ty2[i], 1.0)

    import bisect
    vals = []
    t = ts2[0]
    last = ts2[-1]
    MIN_NOTES = 5          # 窗口内音符数下限，不足则不计（否则谱尾会虚高）
    while t <= last + 1e-9:
        i0 = bisect.bisect_left(ts2, t)
        i1 = bisect.bisect_left(ts2, t + window)
        cnt = i1 - i0
        span = min(t + window, last + 1e-9) - t
        if span <= 1e-6:
            span = window
        if cnt >= MIN_NOTES:
            vals.append((pre[i1] - pre[i0]) / span)
        t += step
    if not vals:
        # 音符太少，退化为整体 NPS
        return round((pre[n] / max(dur_total, 1e-6)), 4), 0.0, {
            "p50": round(pre[n] / max(dur_total, 1e-6), 4),
            "p90": round(pre[n] / max(dur_total, 1e-6), 4),
            "p99": round(pre[n] / max(dur_total, 1e-6), 4)}
    if not vals:
        return 0.0, 0.0, {}

    vs = sorted(vals)
    med = vs[len(vs) // 2]
    # 峰值定义：取 p99 而非 raw max。
    # 理由：单窗口内大量同刻音符（谱师误操作/幽灵Hold）会让 raw max
    # 偏离物理可达值 1~2 个数量级（实测 p99=55 而 raw max=1772）。
    # p99 已覆盖 99% 的时间窗，足以刻画「最密集段落」且不被离群值污染。
    peak = vs[min(int(len(vs) * 0.99), len(vs) - 1)]
    thr = max(med * 1.5, 1e-6)
    ratio = sum(1 for v in vals if v > thr) / len(vals)
    q = {
        "p50": vs[int(len(vs) * .50)],
        "p90": vs[min(int(len(vs) * .90), len(vs) - 1)],
        "p99": vs[min(int(len(vs) * .99), len(vs) - 1)],
        "raw_max": vs[-1],
    }
    return round(peak, 4), round(ratio, 4), {k: round(v, 4) for k, v in q.items()}


def rhythm_features(ts, ty):
    """节奏型特征：间隔分布"""
    n = len(ts)
    if n < 3:
        return {}
    order = sorted(range(n), key=lambda i: ts[i])
    ts2 = [ts[i] for i in order]
    ty2 = [ty[i] for i in order]
    d = [ts2[i + 1] - ts2[i] for i in range(n - 1) if ts2[i + 1] > ts2[i]]
    if not d:
        return {}
    d.sort()
    mean_d = st.mean(d)
    # 同时押：时间差 <50ms 视为同押
    chord = sum(1 for x in d if x < 0.050)
    # 十六分音符以下（<150ms）
    fast = sum(1 for x in d if x < 0.150)
    return {
        "iv_mean": round(mean_d, 4),
        "iv_p10": round(d[int(len(d) * .10)], 4),
        "iv_median": round(d[len(d) // 2], 4),
        "chord_ratio": round(chord / len(d) * 100, 3),
        "fast_ratio": round(fast / len(d) * 100, 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgr", required=True)
    ap.add_argument("--baseline", required=True, help="输入基线 manifest")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    pgr = os.path.abspath(args.pgr)
    rows = [json.loads(l) for l in open(args.baseline, encoding="utf-8")]
    print(f"[load] 基线 {len(rows)} 条")

    ok = miss = 0
    for r in rows:
        p = os.path.join(pgr, "chart", r["song_id"] + ".0", r["level"] + ".json")
        if not os.path.exists(p):
            miss += 1
            continue
        try:
            ts, ty, _ = load_chart_times(p)
        except Exception:
            miss += 1
            continue
        if not ts:
            miss += 1
            continue
        peak, ratio, q = strain_peak(ts, ty)
        r["strain_peak"] = peak
        r["strain_peak_ratio"] = ratio
        r["strain_p50"] = q.get("p50", 0.0)
        r["strain_p90"] = q.get("p90", 0.0)
        r["strain_p99"] = q.get("p99", 0.0)
        r["strain_raw_max"] = q.get("raw_max", 0.0)
        r.update(rhythm_features(ts, ty))
        ok += 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"[done] 增强 {ok} 条，缺谱 {miss} 条")
    print(f"       输出 {args.out}")

    # 快速体检
    if ok:
        pk = sorted(r["strain_peak"] for r in rows if "strain_peak" in r)
        print(f"\n  strain_peak  {pk[0]:.2f} ~ {pk[-1]:.2f}  中位 {st.median(pk):.2f}")
        for k in ("chord_ratio", "fast_ratio", "iv_median"):
            v = [r[k] for r in rows if k in r]
            if v:
                print(f"  {k:<12} 中位 {st.median(v):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
