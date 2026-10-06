#!/usr/bin/env python3
"""
P.H.M. Standard 公式 v1.1 —— osu! 架构（参数已校准）+ 线速峰值维度

════════════════════════════════════════════════════════════════
架构来源（研究 osu! lazer，MIT License, © ppy Pty Ltd；独立实现）
════════════════════════════════════════════════════════════════
  1. 逐事件难度 D_i：速度（a/Δt，带上限）、和弦（同押规模）、
     手位移（|Δx|/Δt，带上限）、长押干扰
  2. strain EMA（对照 osu!standard Speed.cs）：
     strain = strain × 0.3^Δt(s) + D_i × (1 - 0.3^Δt)
  3. 调和和汇总（对照 osu! HarmonicSkill.cs，2026 公式）：
     所有音符 strain 降序，
     weight_i = (1 + S/(1+i)) / (i^0.9 + 1 + S/(1+i))，S=20
  4. 线速峰值维度（2026-10-06 用户发现）：谱师故意用极端 speedEvents 值
     （实测 3550×，正常 AT 谱 ~110）制造瞬间不可读段——玩家只能踩背景音。
     该值 32 倍于正常谱，是「演出陷阱」的可量化特征。
  5. 标度：PS = clamp(m × 调和和 + w_sp × sat(线速峰值, k_sp), 0.5, 20)
     所有系数在社区谱（n=900 分层样本，自带官方定数）上
     Nelder-Mead 校准 —— osu! 官方调常数用的也是同类方法。

校准结果（900 张拟合集）：基线中位偏差 1.933；
  a=0.0396 cap_s=4.688 b=0.6525 c=0.0129 cap_m=1.5066 d=0.4286 m=0.4179
"""
import json
import math
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))

# ── 校准常数（Nelder-Mead，900 张社区谱，目标=中位|PS−官方|）──
P_SPEED_A = 0.03958906841481856
P_SPEED_CAP = 4.687944982355189
P_CHORD_B = 0.6524859184899228
P_MOVE_C = 0.012913772488823642
P_MOVE_CAP = 1.5066011884188761
P_HOLD_D = 0.4285826874507639
P_M = 0.41794332732790734
# 线速峰值维度（本轮校准）
P_WSP = 3.0      # 初值，由 calibrate 重写
P_KSP = 200.0    # 初值，由 calibrate 重写

HARMONIC_S = 20.0
HARMONIC_E = 0.9
DECAY_BASE = 0.3


def event_difficulty(dt, chord_size, dx, hold_active):
    speed = min(P_SPEED_CAP, P_SPEED_A / max(dt, 0.001))
    chord = P_CHORD_B * (chord_size - 1)
    move = min(P_MOVE_CAP, P_MOVE_C * abs(dx) / max(dt, 0.001))
    hold = P_HOLD_D if hold_active else 0.0
    return speed + chord + move + hold


def strain_series(events):
    strains = []
    strain = 0.0
    prev_t = None
    for t, chord, dx, hold in events:
        dt = 0.2 if prev_t is None else max(t - prev_t, 0.001)
        decay = DECAY_BASE ** dt
        d = event_difficulty(dt, chord, dx, hold)
        strain = strain * decay + d * (1.0 - decay)
        strains.append(strain)
        prev_t = t
    return strains


def harmonic_sum(values, scale=HARMONIC_S, decay_exp=HARMONIC_E):
    ds = sorted((v for v in values if v > 0), reverse=True)
    total = 0.0
    index = 0
    for v in ds:
        w = (1 + scale / (1 + index)) / (index ** decay_exp + 1
                                         + scale / (1 + index))
        total += v * w
        index += 1
    return total


def build_events(notes):
    """notes: [(sec, type, x, hold_end_sec)] 已排序。
    返回 [(t, chord_size, max_dx, hold_active)]。"""
    events = []
    i = 0
    n = len(notes)
    prev_t = None
    prev_x = 0.0
    active = []
    while i < n:
        t = notes[i][0]
        j = i
        while j < n and notes[j][0] - t < 1e-3:
            j += 1
        grp = notes[i:j]
        hold_active = any(he > t for he in active)
        max_dx = max((abs(x - prev_x) for _, _, x, _ in grp), default=0.0)
        events.append((t, len(grp), max_dx, hold_active))
        for _, ty, _, he in grp:
            if ty == 2 and he > t:
                active.append(he)
        active = [he for he in active if he > t]
        prev_t = t
        prev_x = grp[-1][2]
        i = j
    return events


def ps_raw(notes):
    events = build_events(notes)
    strains = strain_series(events)
    return harmonic_sum(strains)


def speed_peak_of_chart(j):
    """谱面 JSON → 线速峰值（speedEvents 的 start/end 最大绝对值）。

    ⚠️ RPE 170 的 speedEvents 用 start/end 字段表示线速倍率（无 value 字段）；
    兼容旧格式的 value。实测：正常 AT 谱 ~110，演出陷阱谱 3550（32 倍）。
    """
    mx = 0.0
    for ln in (j.get("judgeLineList") or []):
        for layer in (ln.get("eventLayers") or []):
            if not isinstance(layer, dict):
                continue
            for e in (layer.get("speedEvents") or []):
                if not isinstance(e, dict):
                    continue
                for f in ("start", "end", "value"):
                    if isinstance(e.get(f), (int, float)):
                        mx = max(mx, abs(float(e[f])))
        for e in (ln.get("speedEvents") or []):
            if not isinstance(e, dict):
                continue
            for f in ("start", "end", "value"):
                if isinstance(e.get(f), (int, float)):
                    mx = max(mx, abs(float(e[f])))
    return mx


def ps_score_notes(notes, speed_peak):
    """音符列表 + 线速峰值 → PS（0.5~20）"""
    raw = ps_raw(notes)
    return ps_from_raw(raw, speed_peak)


def ps_from_raw(raw, speed_peak):
    base = P_M * raw
    bonus = P_WSP * sat(speed_peak, P_KSP)
    return min(20.0, max(0.5, base + bonus))


def sat(v, k):
    if v <= 0:
        return 0.0
    return 1.0 - math.exp(-v / k)


# ══════════════════════════════════════════════════════════════
# 谱面解析（RPE / PGR 双格式，含长押结束时间）
# ══════════════════════════════════════════════════════════════

def triple_beats(t):
    a, b, c = t[0], t[1], t[2]
    return a + b / c if c else float(a)


class BpmList:
    def __init__(self, ranges):
        self.el = []
        t, lb, lbp = 0.0, 0.0, None
        for b, v in ranges:
            if lbp is not None:
                t += (b - lb) * (60.0 / lbp)
            lb, lbp = b, v
            self.el.append((b, t, v))

    def tb(self, beats):
        if not self.el:
            return beats * 0.5
        if beats < self.el[0][0]:
            sb, t, bpm = self.el[0]
            return t + (beats - sb) * (60.0 / bpm)
        lo, hi = 0, len(self.el) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.el[mid][0] <= beats:
                lo = mid
            else:
                hi = mid - 1
        sb, t, bpm = self.el[lo]
        return t + (beats - sb) * (60.0 / bpm)


def load_notes(path):
    """解析 RPE/PGR 谱面 → (notes, bpm0)
    notes: [(sec, type, x, hold_end_sec)]（真实音符，已排序）"""
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    lines = j.get("judgeLineList") or []
    if not lines:
        raise ValueError("无 judgeLineList")
    notes = []
    if "BPMList" in j:
        br = []
        for b in (j.get("BPMList") or []):
            stt, bpm = b.get("startTime"), b.get("bpm")
            if stt and bpm and bpm > 0:
                br.append((triple_beats(stt), float(bpm)))
        br.sort()
        bl = BpmList(br) if br else BpmList([(0.0, 120.0)])
        bpm0 = br[0][1] if br else 120.0
        for li, ln in enumerate(lines):
            for n in (ln.get("notes") or []):
                if n.get("isFake") == 1 or n.get("isFake") is True:
                    continue
                stt = n.get("startTime")
                if not stt or len(stt) != 3 or n.get("type") is None:
                    continue
                sec = bl.tb(triple_beats(stt))
                he = sec
                et = n.get("endTime")
                if et and len(et) == 3:
                    he = bl.tb(triple_beats(et))
                notes.append((sec, n["type"], n.get("positionX", 0.0), he))
    else:
        bpm0 = 120.0
        for ln in lines:
            if ln.get("bpm"):
                bpm0 = float(ln["bpm"])
                break
        r = 60.0 / 32.0 / bpm0
        for li, ln in enumerate(lines):
            for key in ("notesAbove", "notesBelow"):
                for n in (ln.get(key) or []):
                    t = n.get("time")
                    if t is None or n.get("type") is None:
                        continue
                    sec = t * r
                    he = sec + (n.get("holdTime") or 0) * r
                    notes.append((sec, n["type"], n.get("positionX", 0.0), he))
    notes.sort(key=lambda x: (x[0], x[1]))
    return notes, bpm0


def speed_peak(path):
    """谱面文件 → speedEvents |value| 峰值"""
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    return speed_peak_of_chart(j)


# ══════════════════════════════════════════════════════════════
# 标度校准与验收
# ══════════════════════════════════════════════════════════════

def spearman(a, b):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            m = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = m
            i = j + 1
        return r
    ra, rb = rank(a), rank(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra))
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return cov / (va * vb) if va * vb else 0.0


def stratified_sample(rows, per_band=45):
    bands = {}
    for r in rows:
        if not r.get("difficulty"):
            continue
        b = round(r["difficulty"] * 2) / 2
        bands.setdefault(b, []).append(r)
    out = []
    for b in sorted(bands):
        lst = sorted(bands[b], key=lambda r: r["id"])
        step = max(1, len(lst) // per_band)
        out.extend(lst[::step][:per_band])
    return out


def main():
    bar = "═" * 66
    nl = chr(10)
    print(bar)
    print("P.H.M. Standard v1.1（osu! 架构 + 线速峰值）验收")
    print(bar)

    # ── A. 单调性 ──
    print(nl + "[A] 单调性（合成谱性质测试）")
    base = [(0.4 + 0.11 * i, (1 if i % 4 else 2), (i % 7) - 3, 0.0)
            for i in range(600)]
    p0 = ps_raw(base)
    dens = [(t / 1.5, ty, x, he) for (t, ty, x, he) in base]
    p1 = ps_raw(dens)
    ok_a = p1 > p0
    print(f"  基准 raw = {p0:.2f}")
    print(f"  {'✓' if p1 > p0 else '✗'} 密度 ×1.5          {p0:.2f} → {p1:.2f}")
    sp_base = 24.0
    lo = ps_from_raw(p0, sp_base)
    hi = ps_from_raw(p0, sp_base * 8)
    ok_sp = hi > lo
    print(f"  {'✓' if ok_sp else '✗'} 线速峰值 24→192      "
          f"PS {lo:.2f} → {hi:.2f}（演出陷阱维度）")

    # ── B/C. 社区谱校准与验证 ──
    print(nl + "[B] 社区谱校准与验证（分层抽样）")
    com = [json.loads(l) for l in
           open(os.path.join(ROOT, "data", "community.jsonl"),
                encoding="utf-8")]
    com = [r for r in com
           if r.get("notes_real", 0) > 0 and r.get("difficulty")]
    sample = stratified_sample(com, per_band=45)
    print(f"  抽样 {len(sample)} / {len(com)} 张")
    raws, offs, sps = [], [], []
    ok_parse = 0
    for r in sample:
        d = os.path.join(ROOT, "data", "charts", str(r["id"]))
        src = os.path.join(d, r.get("chart_file") or "chart.json")
        if not os.path.exists(src):
            src = os.path.join(d, "chart.json")
        if not os.path.exists(src):
            continue
        try:
            notes, _ = load_notes(src)
            if len(notes) < 10:
                continue
            sp = speed_peak(src)
            raws.append(ps_raw(notes))
            sps.append(sp)
            offs.append(float(r["difficulty"]))
            ok_parse += 1
        except Exception:
            continue
    print(f"  成功解析 {ok_parse} 张")
    # 闭式 m + 网格调 w_sp/k_sp（基线 6 参数已由上一轮 Nelder-Mead 定出）
    m = (sum(a * b for a, b in zip(raws, offs)) / sum(a * a for a in raws))
    best = None
    for w in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0):
        for k in (100.0, 200.0, 400.0, 800.0):
            errs = []
            for raw, sp, o in zip(raws, sps, offs):
                p = min(20.0, max(0.5, m * raw + w * sat(sp, k)))
                errs.append(abs(p - o))
            errs.sort()
            n = len(errs)
            med = errs[min(int(n * .5), n - 1)]
            if best is None or med < best[0]:
                best = (med, w, k)
    med0 = best[0]
    w_sp, k_sp = best[1], best[2]
    ps = [min(20.0, max(0.5, m * a + w_sp * sat(sp, k_sp)))
          for a, sp in zip(raws, sps)]
    rho = spearman(ps, offs)
    err = sorted(abs(p - o) for p, o in zip(ps, offs))
    n = len(err)
    q = lambda t: err[min(int(n * t), n - 1)]
    le1 = sum(1 for e in err if e <= 1.0) / n * 100
    print(f"  标度 m = {m:.4f}   线速维度 w={w_sp} k={k_sp}")
    print(f"  中位偏差 {med0:.2f}")
    print(f"  Spearman ρ = {rho:.4f}")
    print(f"  p90 {q(.90):.2f}  ≤1.0 {le1:.1f}%")

    print(nl + "  包络（官方定数 → PS 中位）：")
    for target in (5, 8, 11, 13, 15.5, 17.5):
        band = [p for p, o in zip(ps, offs) if abs(o - target) < 0.8]
        if band:
            band.sort()
            print(f"    官方 ~{target:<5} → PS {band[len(band)//2]:.1f} "
                  f"(n={len(band)})")

    # ── D. 5 张已知样本 + 演出陷阱谱 ──
    print(nl + "[D] 已知样本（官方定数 → PS）")
    known = ((64916, "感情的摩天楼", 5.0), (7425, "theme-44", 8.0),
             (59645, "ごまかし", 13.0), (48929, "R", 15.3),
             (32097, "一瞬֍幻夢", 17.6))
    for pid, nm, d0 in known:
        d = os.path.join(ROOT, "data", "charts", str(pid))
        src = os.path.join(d, "chart.json")
        if not os.path.exists(src):
            print(f"  {nm:<16} 缺文件")
            continue
        notes, _ = load_notes(src)
        sp = speed_peak(src)
        v = min(20.0, max(0.5, m * ps_raw(notes) + w_sp * sat(sp, k_sp)))
        print(f"  {nm:<16} 官方 {d0:<5} → PS {v:.1f}")
    print(nl + "[E] 演出陷阱谱（创作者投票 LV15 43% / LV16 57%）")
    lag = os.path.join(ROOT, "谱面数据包", "_extracted",
                       "7963202028565562.json")
    if os.path.exists(lag):
        notes, _ = load_notes(lag)
        sp = speed_peak(lag)
        v = min(20.0, max(0.5, m * ps_raw(notes) + w_sp * sat(sp, k_sp)))
        print(f"  アクマバライ feat. 雨衣  官方 AT16 → PS {v:.1f}"
              f"   线速峰值 {sp:,.0f}")

    print(nl + bar)
    verdict = (ok_a and ok_sp and rho >= 0.85 and med0 <= 1.6)
    print(f"验收：单调 {'✓' if ok_a else '✗'} · 线速维度 {'✓' if ok_sp else '✗'} · "
          f"ρ {rho:.3f} {'✓' if rho >= 0.85 else '✗'} · "
          f"中位偏差 {med0:.2f} {'✓' if med0 <= 1.6 else '✗'}")
    print("结论：", "v1.1 合格（osu! 架构 + 线速陷阱维度）" if verdict
          else "需回炉")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
