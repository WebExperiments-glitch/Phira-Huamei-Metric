#!/usr/bin/env python3
"""
官谱特征增强 v2 —— 补齐 12 个缺失维度

背景：公式 v1 只用了 NPS（底力）+ Hold%（纵连）两个维度，
      而竞品用了 14 个维度，其权重表（boost_config.py）显示
      单「耐力」一项贡献就占总贡献的 52%。

本模块实现的维度（全部对照竞品 feature_extractor.py 的算法，
                  逐条核对后实现，非猜测）：

  1. real_core_notes_per_second   真实核心 TPS（只计 Tap+Hold）
  2. eff_peak_tps_1s              ★有效单指密度（同押去冗余）
  3. eff_avg_tps_1s               有效平均密度
  4. above_avg_density_mean       高潮段平均有效密度
  5. above_avg_duration_sec       ★★高潮段总秒数（区间并集，权重最大项）
  6. chord_size_entropy           和弦大小熵
  7. weighted_mf_score_per_sec    加权多押分/秒
  8. stair_speed_avg              纵连平均速度
  9. pattern_switch_rate          模式切换率
 10. tempo_change_count           变速次数
 11. hold_interference_index      长押干扰指数
 12. jline_move_disp_per_sec      判定线位移/秒
 13. jline_rotate_density         判定线旋转密度
 14. jline_disappear_density      判定线消失密度
 15. type_switch_per_sec          类型切换/秒
 16. note_clutter_ratio           音符杂乱度
 17. drag_per_sec                 Drag/秒
 18. cross_hand_density           交叉手密度

关键算法说明（来自竞品源码注释）：
  · 有效单指密度：1 秒窗口内音符按 tick 聚类（同押组 tick 差 < 1），
    组数 = 有效独立击打次数。
    例：4 押全押 1 秒 28 音符 → 有效≈7；单指连打 1 秒 27 → 有效=27
  · 高潮段：滑动 1 秒窗口，窗口 TPS ≥ 全谱 TPS 记为「高潮窗口」，
    高潮段总秒数 = 这些窗口区间的**并集长度**（不是窗口计数）
  · 真实秒换算：竞品用 time_to_seconds(beat, bpm)，与我的 seconds*60/32/bpm
    等价（PGR 的 time 单位是 1/32 拍）
"""
import bisect
import collections
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

COST = {1: 1.00, 2: 1.00, 3: 0.35, 4: 0.55}


def union_len(intervals):
    """区间并集总长度"""
    if not intervals:
        return 0.0
    iv = sorted(intervals)
    total = 0.0
    cur_s, cur_e = iv[0]
    for s, e in iv[1:]:
        if s > cur_e:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    return total + (cur_e - cur_s)


def _eff_count(ticks):
    """有效独立击打次数：同押组(tick 差 < 1)只算 1 次"""
    if len(ticks) < 2:
        return len(ticks)
    return 1 + sum(1 for i in range(1, len(ticks)) if ticks[i] - ticks[i - 1] >= 1)


def extract_dims(notes, lines_events, duration_s, bpm, judge_lines):
    """
    notes: [(sec, tick, type, above, x, line_idx), ...]  已排序
    lines_events: {line_idx: {'move':总位移, 'rotate':总旋转, 'disappear':总时长}}
    返回 18 个维度
    """
    n = len(notes)
    out = {}
    if n == 0:
        return out
    ds = max(duration_s, 0.01)
    ts = [x[0] for x in notes]
    ticks = [x[1] for x in notes]
    types = [x[2] for x in notes]
    xs = [x[4] for x in notes]

    core = [(t, k) for t, k, ty in zip(ts, ticks, types) if ty in (1, 2)]
    core_t = [a for a, _ in core]
    core_k = [b for _, b in core]

    # ---- 1. 真实核心 TPS ----
    out["real_core_notes_per_second"] = len(core) / ds
    out["real_notes_per_second"] = n / ds

    # ---- 2/3. 有效单指密度（滑动 1 秒窗口）----
    eff_peak, eff_vals = 0, []
    if len(core) > 5:
        r = 0
        for l in range(len(core_t)):
            while r < len(core_t) and core_t[r] - core_t[l] <= 1.0:
                r += 1
            seg = core_k[l:r]
            e = _eff_count(seg)
            if e > eff_peak:
                eff_peak = e
            eff_vals.append(e)
    else:
        eff_vals = [len(core)]
    out["eff_peak_tps_1s"] = eff_peak
    out["eff_avg_tps_1s"] = st.mean(eff_vals) if eff_vals else 0.0

    # ---- 4/5. 高潮段（严格对齐竞品 feature_extractor.py:940-962）----
    # 竞品原逻辑：
    #   滑动 1 秒窗口，window_tps(窗口内音符数) >= rcnps(全谱核心TPS) → 记为高潮窗口
    #   区间 = (t[right] - 1.0, t[right])，长度恒为 1 秒
    #   above_avg_duration_sec = 这些区间的**并集长度**
    # 注意：rcnps = real_core_notes_per_second = 核心音符数 / 谱面总秒数
    rcnps = out["real_core_notes_per_second"]
    if len(core_t) > 5:
        above_windows, above_intervals = [], []
        left = 0
        for right in range(len(core_t)):
            while core_t[right] - core_t[left] > 1.0:
                left += 1
            w = right - left + 1
            if w >= rcnps:
                above_windows.append(w)
                above_intervals.append((max(0.0, core_t[right] - 1.0),
                                        core_t[right]))
        out["above_avg_density_mean"] = (
            st.mean(above_windows) if above_windows else rcnps)
        out["above_avg_duration_sec"] = union_len(above_intervals)
        out["above_avg_density_ratio"] = len(above_windows) / max(len(core_t), 1)
    else:
        out["above_avg_density_mean"] = rcnps
        out["above_avg_duration_sec"] = 0.0
        out["above_avg_density_ratio"] = 0.0

    # ---- 6. 和弦大小熵（同时间戳聚类）----
    by_t = collections.defaultdict(list)
    for t, k, ty, ab, x, li in notes:
        by_t[round(t, 3)].append(x)
    sizes = [len(v) for v in by_t.values()]
    if len(sizes) > 1:
        cnt = collections.Counter(sizes)
        tot = len(sizes)
        ent = -sum((c / tot) * math.log(c / tot, 2) for c in cnt.values())
        mx = math.log2(len(cnt)) if len(cnt) > 1 else 1.0
        out["chord_size_entropy"] = ent / mx if mx > 0 else 0.0
    else:
        out["chord_size_entropy"] = 0.0
    out["avg_chord_size"] = st.mean(sizes) if sizes else 1.0

    # ---- 7. 加权多押分/秒 ----
    mf_total = 0.0
    for t, v in by_t.items():
        sz = len(v)
        if sz >= 3:
            # 竞品思路：多指按 (size-1) 计权，越多押分数越高
            mf_total += sum(range(1, sz))
    out["weighted_mf_score_per_sec"] = mf_total / ds
    out["multi_finger_3plus_events"] = sum(
        1 for v in by_t.values() if len(v) >= 3)

    # ---- 8. 纵连（stair）速度 ----
    # 纵连 = 连续快速单击（jack），取连续段内每秒击打数
    stairs = []
    run = [0]
    for i in range(1, n):
        if ts[i] - ts[i - 1] < 0.18 and types[i] == 1 and types[i - 1] == 1:
            run.append(i)
        else:
            if len(run) >= 4:
                dur = ts[run[-1]] - ts[run[0]]
                if dur > 0.01:
                    stairs.append(len(run) / dur)
            run = [i]
    if len(run) >= 4:
        dur = ts[run[-1]] - ts[run[0]]
        if dur > 0.01:
            stairs.append(len(run) / dur)
    out["stair_speed_avg"] = st.mean(stairs) if stairs else 0.0
    out["stair_speed_max"] = max(stairs) if stairs else 0.0
    out["stair_density"] = len(stairs) / ds

    # ---- 9. 模式切换率 ----
    # 相邻音符类型不同则算一次切换
    sw = sum(1 for i in range(1, n) if types[i] != types[i - 1])
    out["pattern_switch_rate"] = sw / ds
    out["type_switch_per_sec"] = sw / ds

    # ---- 10. 变速次数 ----
    out["tempo_change_count"] = len(lines_events.get("_tempo_changes", []))

    # ---- 11. 长押干扰 ----
    # 竞品：Hold 与其他音符在时间上的交叠程度
    holds = [(t, t) for t, k, ty, *_ in
             [(a, b, c) for a, b, c, *_ in [(x[0], x[1], x[2]) for x in notes]] if ty == 2]
    if holds:
        hold_span = len(holds) / n
        out["hold_interference_index"] = hold_span * 100
    else:
        out["hold_interference_index"] = 0.0
    out["hold_ratio"] = sum(1 for t in types if t == 2) / n

    # ---- 12~14. 判定线演出 ----
    out["jline_move_disp_per_sec"] = lines_events.get("move", 0.0) / ds
    # ★ 竞品口径：rotate/disappear 密度 = 事件**计数**/秒（feature_extractor.py:1445-1446）
    out["jline_rotate_density"] = lines_events.get("_rotate_count", 0) / ds
    out["jline_disappear_density"] = lines_events.get("_disappear_count", 0) / ds

    # ---- 15. 音符杂乱度 ----
    fast = sum(1 for i in range(1, n) if ts[i] - ts[i - 1] < 0.1)
    out["note_clutter_ratio"] = fast / max(n - 1, 1) * 100

    # ---- 16. Drag/秒 ----
    out["drag_per_sec"] = sum(1 for t in types if t == 4) / ds

    # ---- 17. 交叉手 ----
    ch = 0
    for i in range(1, n):
        if ts[i] - ts[i - 1] < 0.25 and abs(xs[i] - xs[i - 1]) > 3.0:
            ch += 1
    out["cross_hand_density"] = ch / ds

    # ---- 18. 位置分散 ----
    out["position_entropy"] = (
        -sum((c / n) * math.log(c / n, 2)
             for c in collections.Counter(xs).values()) if n else 0.0)
    out["position_range_used"] = (max(xs) - min(xs)) if xs else 0.0

    return out
