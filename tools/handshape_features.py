#!/usr/bin/env python3
"""片段级「手型」特征：把连续的几个音符当成一段，描述这一段整体怎么摆。

━━━ 为什么需要它 ━━━
`docs/结果/短谱残差诊断.md` 的结论：短谱 ρ 0.716 vs 长谱 0.876，差距全在残差方差
（短 0.677 / 长 0.476），而且不是标注脏、不是模型容量，是**稀疏谱缺信息**：
现有 20 维里跟"排布"有关的只有 Δx / 跳跃距离 / 三连音夹角，全是**相邻两个音符**
的局部量，看不到"这一小段整体是绕圈、是折返、还是双手交替"。

━━━ 口径 ━━━
两种切法、四种片段尺度，互为补充：
  · 固定音符数：连续 8 个事件 / 连续 16 个事件（不重叠）
  · 固定时间窗：0.5 秒 / 1.0 秒（从谱面首音符起算，不重叠；含 ≥4 个音符才计）

每个片段算 46 个**标量**（A–F 六组，见 `METRICS`），再按谱聚合：
对片段序列取 mean / std / min / max / p10 / p50 / p90 / skew 共 8 个统计量。
总维度 = 4 种切法 × 8 统计量 × 46 指标 = **1,472 维**（全部追加在现有 20 维之后）。

━━━ 移植性（给浏览器 JS 重算用）━━━
只用算术、sqrt、atan2、排序、比较：
  · 分位数用线性插值（与 numpy 默认 / 现有 pool142 同口径）
  · std 用总体标准差（ddof=0，与 `np.std` / `pool142` 一致）
  · skew 用 m3 / m2^1.5（总体矩），|skew| 截断 20 防单点爆炸
本文件里用 numpy 只是向量化，**算法本身不含任何 numpy 特有语义**。
复杂度（单张谱，n 个事件、S 个片段）：
  · 片段生成 O(n)（时间分箱用一次 unique，O(n)）
  · 片段内指标：A/B 组 O(k)（k = 片段长度，k≤16 或 时间窗内的音符数）；
    D 组的和弦跨度用 min/max 散射，O(k)；F 组 O(k)
  · 谱级聚合：对每个指标排序取分位数 → **O(S log S)**（S ≈ n/8 ~ n）
  · 没有 O(n²) 路径。

━━━ 用法 ━━━
  python tools/handshape_features.py --dump 1000            # 打一张谱的可读特征
  python tools/handshape_features.py --dump 1000 --all      # 连 1472 维全打
  python tools/handshape_features.py --selftest             # 一致性自检（不读谱）
"""
import argparse
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

CHARTS = os.path.join(ROOT, "data", "charts")
MAX_EVENTS = 8000          # 与 build_seq_dataset.MAX_EVENTS 一致
EPS = 1e-9

# ────────────────────────── 指标清单 ──────────────────────────
# (名称, 组)。顺序即特征顺序，禁止重排（缓存与报告都依赖它）。
METRICS = [
    # A 轨迹几何（在**判定线运动后的屏幕坐标** sx/sy 上算，/675 归一化）
    ("step_mean", "A"),        # 平均步长
    ("step_max", "A"),         # 最大步长
    ("step_cv", "A"),          # 步长变异系数（节奏不匀）
    ("turn_mean", "A"),        # 平均 |转角|（弧度）
    ("turn_p90", "A"),         # 90 分位 |转角|
    ("turn_signed", "A"),      # 平均有符号转角（顺时针/逆时针偏好）
    ("turn_sharp", "A"),       # |转角|>90° 的占比
    ("turn_straight", "A"),    # |转角|<15° 的占比
    ("curv", "A"),             # 平均曲率 |转角|/步长
    ("curv_max", "A"),         # 最大曲率
    ("path", "A"),             # 路径长度
    ("disp", "A"),             # 首尾位移
    ("eff", "A"),              # 路径效率 = 位移/路径（低=绕）
    ("bbox_area", "A"),        # 包围盒面积
    ("diag", "A"),             # 包围盒对角
    ("aspect", "A"),           # 宽/高
    ("span_x", "A"),           # x 极差（手型跨度）
    ("span_y", "A"),           # y 极差
    # B 方向反转
    ("flip_x", "B"),           # dx 符号翻转率
    ("flip_y", "B"),           # dy 符号翻转率
    ("runx_mean", "B"),        # 同向最大游程的均值
    ("runx_max", "B"),         # 同向最大游程占比
    ("reversal", "B"),         # 折返标志：位移<0.2×路径
    ("dx_jerk", "B"),          # |Δdx| 相对量（锯齿度）
    # C 左右手（以屏幕 x=0 为中线）
    ("hand_switch", "C"),      # 换手率
    ("hand_run", "C"),         # 单手最长连续占比
    ("span_L", "C"),           # 左手跨度
    ("span_R", "C"),           # 右手跨度
    ("span_diff", "C"),        # 双手跨度差
    ("hand_ratio", "C"),       # (右-左)/总数
    ("two_hand", "C"),         # 双手都用到的标志
    # D 同押与和弦（20ms 连链分组）
    ("chord2", "D"),           # 2 押占比
    ("chord3", "D"),           # 3 押占比
    ("chord4p", "D"),          # 4+ 押占比
    ("chord_span", "D"),       # 和弦内平均跨度
    ("chord_span_max", "D"),   # 和弦内最大跨度
    ("chord_then_single", "D"),# 和弦后紧跟单点的比例
    # E 节奏形态
    ("ioi_mean", "E"),
    ("ioi_cv", "E"),
    ("ioi_max", "E"),
    ("burst", "E"),            # IOI<60ms 占比
    ("pause", "E"),            # IOI>400ms 占比
    ("ioi_trend", "E"),        # IOI 一阶差分相对均值（加速/减速）
    # F 密度形态
    ("dens_max", "F"),         # 1/8 秒窗最大音符数
    ("dens_std", "F"),         # 1/8 秒窗计数标准差
    ("dens_slope", "F"),       # 后半段 - 前半段平均计数
]
METRIC_NAMES = [m for m, _ in METRICS]
METRIC_GROUPS = [g for _, g in METRICS]
GROUP_NAMES = ["A", "B", "C", "D", "E", "F"]
STATS = ["mean", "std", "min", "max", "p10", "p50", "p90", "skew"]
SEGMENTS = [("n8", "count", 8), ("n16", "count", 16),
            ("t05", "time", 0.5), ("t10", "time", 1.0)]
MIN_SEG_EVENTS = 4          # 片段少于此事件数直接丢弃（指标无意义）


# ────────────────────────── 纯函数统计（JS 可直接照抄）──────────────────────────
def quantile_linear(v, q):
    """线性插值分位数，与 numpy 默认 / pool142 同口径。v 需已排序。"""
    n = len(v)
    if n == 0:
        return 0.0
    if n == 1:
        return float(v[0])
    h = (n - 1) * q
    lo = int(math.floor(h))
    hi = min(lo + 1, n - 1)
    return float(v[lo] + (v[hi] - v[lo]) * (h - lo))


def stats8(v):
    """mean/std(总体)/min/max/p10/p50/p90/skew —— 一个指标的 8 个统计量。"""
    if v.size == 0:
        return [0.0] * 8
    mu = float(v.mean())
    d = v - mu
    m2 = float(np.mean(d * d))
    sd = math.sqrt(m2)
    sk = 0.0
    if m2 > 1e-18:
        sk = float(np.mean(d * d * d) / (m2 ** 1.5))
        sk = max(-20.0, min(20.0, sk))
    s = np.sort(v)
    return [mu, sd, float(s[0]), float(s[-1]),
            quantile_linear(s, 0.10), quantile_linear(s, 0.50),
            quantile_linear(s, 0.90), sk]


# ────────────────────────── 片段生成 ──────────────────────────
def segment_slices(t):
    """返回 {切法名: [(i0, i1), ...]}。全部为左闭右开、互不重叠。"""
    n = len(t)
    out = {}
    for tag, kind, k in SEGMENTS:
        if kind == "count":
            starts = range(0, n - k + 1, k)
            out[tag] = [(i, i + k) for i in starts]
        else:
            # 按 [t0 + j*k, t0 + (j+1)*k) 分箱；b 单调不减，用一次 unique 拿边界
            b = np.floor((t - t[0]) / k).astype(np.int64)
            uniq, first, cnt = np.unique(b, return_index=True, return_counts=True)
            del uniq
            out[tag] = [(int(f), int(f) + int(c)) for f, c in zip(first, cnt)]
    return out


# ────────────────────────── 单个片段的 46 个标量 ──────────────────────────
def seg_metrics(t, xs, ys, grp):
    """t/xs/ys/grp 是该片段的切片。返回长度 46 的 float64 数组。"""
    m = t.size
    out = np.zeros(len(METRICS), dtype=np.float64)
    if m < MIN_SEG_EVENTS:
        return None

    dx = np.diff(xs)
    dy = np.diff(ys)
    L = np.hypot(dx, dy)
    steps = dx.size                      # 步数 = m-1

    # ── A 轨迹几何 ──
    step = L / 675.0
    sm = float(step.mean())
    sstd = float(step.std())
    out[0] = sm
    out[1] = float(step.max())
    out[2] = sstd / (sm + EPS)

    th = np.arctan2(dy, dx)
    dth = np.diff(th)
    dth = (dth + math.pi) % (2.0 * math.pi) - math.pi   # 折到 (-π, π]
    at = np.abs(dth)
    out[3] = float(at.mean()) if at.size else 0.0
    out[4] = quantile_linear(np.sort(at), 0.90) if at.size else 0.0
    out[5] = float(dth.mean()) if dth.size else 0.0
    out[6] = float((at > math.pi / 2).mean()) if at.size else 0.0
    out[7] = float((at < math.pi / 12).mean()) if at.size else 0.0
    # 曲率：转角 / 步长（乘 675 换成「每半屏」量纲；步长低于 1 单位按 1 计，防爆炸）
    if dth.size:
        c = at * 675.0 / np.maximum(L[1:], 1.0)
        out[8] = float(c.mean())
        out[9] = float(c.max())
    out[10] = float(L.sum()) / 675.0
    out[11] = math.hypot(float(xs[-1] - xs[0]), float(ys[-1] - ys[0])) / 675.0
    out[12] = out[11] / (out[10] + EPS)

    rx = float(xs.max() - xs.min())
    ry = float(ys.max() - ys.min())
    out[13] = (rx * ry) / (675.0 * 675.0)
    out[14] = math.hypot(rx, ry) / 675.0
    out[15] = rx / (ry + 1.0)
    out[16] = rx / 675.0
    out[17] = ry / 675.0

    # ── B 方向反转 ──
    sx_sign = np.sign(dx)
    sy_sign = np.sign(dy)
    out[18] = _flip_rate(sx_sign)
    out[19] = _flip_rate(sy_sign)
    runs = _run_lengths(sx_sign)
    out[20] = float(runs.mean()) / max(steps, 1) if runs.size else 0.0
    out[21] = float(runs.max()) / max(steps, 1) if runs.size else 0.0
    out[22] = 1.0 if out[11] < 0.2 * out[10] else 0.0
    if dx.size >= 2:
        out[23] = float(np.abs(np.diff(dx)).mean()) / (float(np.abs(dx).mean()) + EPS)

    # ── C 左右手（屏幕 x=0 为中线）──
    side = xs >= 0.0
    out[24] = float((side[1:] != side[:-1]).mean()) if m > 1 else 0.0
    rr = _run_lengths_bool(side)
    out[25] = (float(rr.max()) / m) if rr.size else 0.0
    left, right = xs[~side], xs[side]
    out[26] = (float(left.max() - left.min()) / 675.0) if left.size else 0.0
    out[27] = (float(right.max() - right.min()) / 675.0) if right.size else 0.0
    out[28] = abs(out[26] - out[27])
    out[29] = (float(right.size) - float(left.size)) / m
    out[30] = 1.0 if (left.size and right.size) else 0.0

    # ── D 同押与和弦（grp 已按 20ms 连链分好组）──
    g = grp - grp[0]
    sizes = np.bincount(g).astype(np.float64)          # 按时间顺序
    out[31] = float((sizes == 2).sum()) * 2.0 / m
    out[32] = float((sizes == 3).sum()) * 3.0 / m
    out[33] = float((sizes >= 4).sum() * sizes[sizes >= 4].sum()) / m if (sizes >= 4).any() else 0.0
    ch = sizes >= 2
    if ch.any():
        mn = np.full(sizes.size, np.inf)
        mx = np.full(sizes.size, -np.inf)
        np.minimum.at(mn, g, xs)
        np.maximum.at(mx, g, xs)
        sp = (mx - mn)[ch] / 675.0
        out[34] = float(sp.mean())
        out[35] = float(sp.max())
    if sizes.size >= 2:
        prev_ch = sizes[:-1] >= 2
        denom = int(prev_ch.sum())
        if denom:
            out[36] = float((prev_ch & (sizes[1:] == 1)).sum()) / denom

    # ── E 节奏形态 ──
    dt = np.diff(t)
    dm = float(dt.mean()) if dt.size else 0.0
    out[37] = dm
    out[38] = float(dt.std()) / (dm + EPS) if dt.size else 0.0
    out[39] = float(dt.max()) if dt.size else 0.0
    out[40] = float((dt < 0.060).mean()) if dt.size else 0.0
    out[41] = float((dt > 0.400).mean()) if dt.size else 0.0
    if dt.size >= 2:
        out[42] = float(np.diff(dt).mean()) / (dm + EPS)

    # ── F 密度形态（1/8 秒窗）──
    b = np.floor((t - t[0]) / 0.125).astype(np.int64)
    cnt = np.bincount(b).astype(np.float64)
    out[43] = float(cnt.max())
    out[44] = float(cnt.std())
    if cnt.size >= 2:
        h = cnt.size // 2
        out[45] = float(cnt[h:].mean()) - float(cnt[:h].mean())
    return out


def _flip_rate(s):
    """去掉 0 后相邻符号变化的占比。"""
    nz = s[s != 0]
    if nz.size < 2:
        return 0.0
    return float((nz[1:] != nz[:-1]).mean())


def _run_lengths(s):
    """同值游程长度数组（跳过 0 会把游程切断，这里 0 当作独立取值）。"""
    if s.size == 0:
        return np.zeros(0, dtype=np.int64)
    chg = np.flatnonzero(s[1:] != s[:-1])
    starts = np.r_[0, chg + 1]
    ends = np.r_[chg + 1, s.size]
    return (ends - starts).astype(np.int64)


def _run_lengths_bool(s):
    return _run_lengths(s.astype(np.int8))


# ────────────────────────── 整谱 → 特征向量 ──────────────────────────
def feature_names():
    names = []
    for tag, _, _ in SEGMENTS:
        for st in STATS:
            for mt in METRIC_NAMES:
                names.append(f"{tag}|{st}|{mt}")
    return names


def chart_features(ev):
    """事件列表 → (names, vec)。vec 为 float32，长度 = 4*8*46 = 1472。"""
    n = len(ev)
    if n < MIN_SEG_EVENTS:
        return feature_names(), np.zeros(4 * 8 * len(METRICS), dtype=np.float32)

    t = np.fromiter((e[0] for e in ev), dtype=np.float64, count=n)
    xs = np.fromiter((e[2] if len(e) >= 8 else e[1] for e in ev), dtype=np.float64, count=n)
    ys = np.fromiter((e[3] if len(e) >= 8 else 0.0 for e in ev), dtype=np.float64, count=n)
    # 同刻（含 20ms 内）音符在文件里的先后是任意的，直接连成轨迹会引入随机的
    # "折返"噪声。这里只在**同刻组内部**按屏幕 x 排序（左→右），组间顺序不动：
    #   · 结果与谱面文件的音符书写顺序无关（跨客户端/跨解析器可复现）
    #   · 与物理直觉一致：同一时刻的和弦，手是从左扫到右
    order = np.lexsort((xs, t))
    if n > 1 and not np.array_equal(order, np.arange(n)):
        t, xs, ys = t[order], xs[order], ys[order]
    grp = np.cumsum(np.r_[True, np.diff(t) > 0.02]) - 1

    pieces = []
    for tag, _, _ in SEGMENTS:
        segs = segment_slices_for(tag, t)
        rows = []
        for i0, i1 in segs:
            r = seg_metrics(t[i0:i1], xs[i0:i1], ys[i0:i1], grp[i0:i1])
            if r is not None:
                rows.append(r)
        if rows:
            S = np.asarray(rows, dtype=np.float64)       # (S, 46)
        else:
            S = np.zeros((0, len(METRICS)), dtype=np.float64)
        block = np.zeros((len(METRICS), 8), dtype=np.float64)
        for j in range(len(METRICS)):
            block[j] = stats8(S[:, j])
        # 布局：stat 外层 / metric 内层（与 feature_names 一致）
        pieces.append(block.T.reshape(-1))
    return feature_names(), np.concatenate(pieces).astype(np.float32)


def segment_slices_for(tag, t):
    for name, kind, k in SEGMENTS:
        if name != tag:
            continue
        if kind == "count":
            return [(i, i + k) for i in range(0, len(t) - k + 1, k)]
        b = np.floor((t - t[0]) / k).astype(np.int64)
        _u, first, cnt = np.unique(b, return_index=True, return_counts=True)
        return [(int(f), int(f) + int(c)) for f, c in zip(first, cnt)]
    raise KeyError(tag)


def chart_features_from_path(path):
    from chart_io import load_notes_ex
    ev = load_notes_ex(path, max_events=MAX_EVENTS)
    return chart_features(ev)


# ────────────────────────── dump ──────────────────────────
def dump(cid, show_all=False):
    d = os.path.join(CHARTS, cid)
    if not os.path.isdir(d):
        raise SystemExit(f"没有这张谱：{d}")
    p = None
    for f in os.listdir(d):
        if f.lower().endswith((".json", ".pgr", ".pec")):
            p = os.path.join(d, f)
            break
    if not p:
        raise SystemExit(f"{d} 里没有谱面文件")
    from chart_io import load_notes_ex
    ev = load_notes_ex(p, max_events=MAX_EVENTS)
    names, v = chart_features(ev)
    dur = ev[-1][0] - ev[0][0] if ev else 0.0
    print(f"谱面 {cid} · {os.path.basename(p)} · 事件 {len(ev)} · 时长 {dur:.1f}s "
          f"· 特征 {len(v)} 维")
    segs = segment_slices(ev and np.array([e[0] for e in ev]))
    print("片段数：" + " · ".join(f"{k} {len(s)}" for k, s in segs.items()))
    if show_all:
        for nm, val in zip(names, v):
            print(f"  {nm:<28s} {val: .6g}")
        return
    # 默认视图：每种切法只打该切法的 mean 统计（46 行 × 4 列），便于肉眼比对
    cols = {tag: {st: {} for st in STATS} for tag, _, _ in SEGMENTS}
    for nm, val in zip(names, v):
        tag, st, mt = nm.split("|")
        cols[tag][st][mt] = float(val)
    print("\n" + "指标".ljust(20) + "".join(f"{t + '.mean':>13s}" for t, _, _ in SEGMENTS))
    print("-" * 72)
    grp = None
    for mt, g in zip(METRIC_NAMES, METRIC_GROUPS):
        if g != grp:
            print(f"[{g}]")
            grp = g
        row = f"  {mt:<18s}"
        for tag, _, _ in SEGMENTS:
            row += f"{cols[tag]['mean'].get(mt, 0.0):13.4f}"
        print(row)
    print("\n（--all 可打印全部 1,472 维；每种切法还有 std/min/max/p10/p50/p90/skew）")


# ────────────────────────── 自检 ──────────────────────────
def selftest():
    rng = np.random.default_rng(7)
    n = 40
    t = np.cumsum(rng.uniform(0.02, 0.35, n))
    xs = np.cumsum(rng.normal(0, 120, n))
    ys = np.zeros(n)
    grp = np.cumsum(np.r_[True, np.diff(t) > 0.02]) - 1
    S = []
    for tag, _, _ in SEGMENTS:
        for i0, i1 in segment_slices_for(tag, t):
            r = seg_metrics(t[i0:i1], xs[i0:i1], ys[i0:i1], grp[i0:i1])
            if r is not None:
                S.append(r)
    S = np.asarray(S)
    print(f"片段 {S.shape[0]} 个 · 指标 {S.shape[1]} 个")
    assert S.shape[1] == len(METRICS), "指标数与 METRICS 不一致"
    assert np.isfinite(S).all(), "出现 NaN/Inf"
    # 手搓一段直线，验证 A 组口径
    tt = np.array([0, .1, .2, .3, .4])
    xx = np.array([0., 100, 200, 300, 400])
    yy = np.zeros(5)
    r = seg_metrics(tt, xx, yy, np.zeros(5, dtype=np.int64))
    assert abs(r[10] - 400 / 675) < 1e-9, r[10]          # path
    assert abs(r[11] - 400 / 675) < 1e-9, r[11]          # disp
    assert abs(r[12] - 1.0) < 1e-6, r[12]                # eff = 1（EPS 造成的 1e-9 相对偏差）
    assert abs(r[5]) < 1e-9 and abs(r[3]) < 1e-9         # 无转角
    assert abs(r[7] - 1.0) < 1e-9, r[7]                  # 全部是"直"
    assert abs(r[26]) < 1e-9                              # 全在右侧，左手跨度 0
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=None, help="打印该谱面 id 的特征")
    ap.add_argument("--all", action="store_true", help="dump 时打印全部维度")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    elif a.dump:
        dump(a.dump, a.all)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
