#!/usr/bin/env python3
"""
官谱特征提取 v3 —— 接入 14 维要素

在原有基线（NPS/strain/节奏）之上，补齐竞品的核心要素维度。
所有维度算法见 tools/dims14.py 的说明，均对照竞品源码逐条核对。
"""
import argparse
import bisect
import collections
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from dims14 import extract_dims, union_len, _eff_count   # noqa: E402

COST = {1: 1.00, 2: 1.00, 3: 0.35, 4: 0.55}


def beat(t):
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
        lo, hi = 0, len(self.el) - 1
        if beats < self.el[0][0]:
            sb, t, bpm = self.el[0]
            return t + (beats - sb) * (60.0 / bpm)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.el[mid][0] <= beats:
                lo = mid
            else:
                hi = mid - 1
        sb, t, bpm = self.el[lo]
        return t + (beats - sb) * (60.0 / bpm)


def load_pgr(path):
    """解析官谱 PGR，返回 (notes, line_events, duration, bpm, nlines)"""
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    lines = j.get("judgeLineList") or []
    bpm0 = 120.0
    for ln in lines:
        if ln.get("bpm"):
            bpm0 = float(ln["bpm"])
            break
    r = 60.0 / 32.0 / bpm0

    notes = []
    ev = {"move": 0.0, "rotate": 0.0, "disappear": 0.0, "_tempo_changes": []}
    tempo_changes = []
    ev_count = {"rotate": 0, "disappear": 0}

    for li, ln in enumerate(lines):
        # 判定线演出
        for e in (ln.get("judgeLineMoveEvents") or []):
            st_, en = e.get("startTime"), e.get("endTime")
            if st_ is None or en is None:
                continue
            dur = (en - st_) * r
            if dur <= 0:
                continue
            x0, x1 = e.get("start", 0), e.get("end", 0)
            y0, y1 = e.get("start2", 0), e.get("end2", 0)
            # 归一化：官方把 -880~880 映射到 -1~1，位移量按像素算
            px = abs((x1 - x0) * 880) + abs((y1 - y0) * 880)
            ev["move"] += px
        # ★ 竞品口径：rotate/disappear 密度 = 事件**计数**/秒（非时长/秒）
        #   见 feature_extractor.py:1445-1446  jline_rotate_total += len(revs)
        ev_count["rotate"] += len(ln.get("judgeLineRotateEvents") or [])
        ev_count["disappear"] += len(ln.get("judgeLineDisappearEvents") or [])
        # 变速
        se = (ln.get("speedEvents") or [])
        for e in se[1:]:
            if e.get("startTime") is not None:
                tempo_changes.append(e["startTime"] * r)

        for key in ("notesAbove", "notesBelow"):
            below = key == "notesBelow"
            for nn in (ln.get(key) or []):
                t = nn.get("time")
                ty = nn.get("type")
                if t is None:
                    continue
                notes.append((t * r, t, ty, below,
                              nn.get("positionX") or 0.0, li))

    ev["_tempo_changes"] = sorted(tempo_changes)
    ev["_rotate_count"] = ev_count["rotate"]
    ev["_disappear_count"] = ev_count["disappear"]
    notes.sort(key=lambda x: (x[0], x[1]))
    dur = max(1e-3, max(x[0] for x in notes) - min(x[0] for x in notes))
    return notes, ev, dur, bpm0, len(lines)


def strain_features(ts, ty, window=1.0):
    n = len(ts)
    if n == 0:
        return {}
    pre = [0.0] * (n + 1)
    for i in range(n):
        pre[i + 1] = pre[i] + COST.get(ty[i], 1.0)
    step = window / 20.0
    vals = []
    t, last = ts[0], ts[-1]
    while t <= last + 1e-9:
        i0 = bisect.bisect_left(ts, t)
        i1 = bisect.bisect_left(ts, t + window)
        span = min(t + window, last + 1e-9) - t
        if span <= 1e-6:
            span = window
        if i1 - i0 >= 5:
            vals.append((pre[i1] - pre[i0]) / span)
        t += step
    if not vals:
        r = pre[n] / max(last - ts[0], 1e-6)
        return {"strain_peak": round(r, 4), "strain_peak_ratio": 0.0,
                "strain_p50": round(r, 4), "strain_p90": round(r, 4),
                "strain_p99": round(r, 4)}
    vs = sorted(vals)
    med = vs[len(vs) // 2]
    return {
        "strain_peak": round(vs[min(int(len(vs) * .99), len(vs) - 1)], 4),
        "strain_peak_ratio": round(
            sum(1 for v in vals if v > max(med * 1.5, 1e-6)) / len(vals), 4),
        "strain_p50": round(vs[int(len(vs) * .50)], 4),
        "strain_p90": round(vs[min(int(len(vs) * .90), len(vs) - 1)], 4),
        "strain_p99": round(vs[min(int(len(vs) * .99), len(vs) - 1)], 4),
    }


def rhythm_features(ts):
    n = len(ts)
    if n < 3:
        return {}
    d = [ts[i + 1] - ts[i] for i in range(n - 1) if ts[i + 1] > ts[i]]
    if not d:
        return {}
    ds = sorted(d)
    return {
        "iv_median": round(ds[len(ds) // 2], 4),
        "chord_ratio": round(sum(1 for x in d if x < 0.050) / len(d) * 100, 3),
        "fast_ratio": round(sum(1 for x in d if x < 0.150) / len(d) * 100, 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgr", required=True)
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
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
            notes, ev, dur, bpm, nlines = load_pgr(p)
            if not notes:
                miss += 1
                continue
            ts = [x[0] for x in notes]
            ty = [x[2] for x in notes]
            r.update(strain_features(ts, ty))
            r.update(rhythm_features(ts))
            r.update(extract_dims(notes, ev, dur, bpm, nlines))
            ok += 1
        except Exception as e:
            print(f"  [err] {r['song_id']}/{r['level']}: {type(e).__name__} {e}")
            miss += 1

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[done] 增强 {ok} 条，缺 {miss} 条 → {out}")

    if ok:
        DIMS = ["real_core_notes_per_second", "eff_peak_tps_1s",
                "eff_avg_tps_1s", "above_avg_density_mean",
                "above_avg_duration_sec", "chord_size_entropy",
                "weighted_mf_score_per_sec", "stair_speed_avg",
                "pattern_switch_rate", "tempo_change_count",
                "hold_interference_index", "jline_move_disp_per_sec",
                "jline_rotate_density", "jline_disappear_density",
                "type_switch_per_sec", "note_clutter_ratio",
                "drag_per_sec", "cross_hand_density"]
        print(f"\n{'维度':<32}{'min':>10}{'中位':>10}{'max':>10}")
        print("-" * 62)
        for k in DIMS:
            v = sorted(x[k] for x in rows if k in x)
            if v:
                print(f"{k:<32}{v[0]:>10.3f}{v[len(v)//2]:>10.3f}{v[-1]:>10.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
