#!/usr/bin/env python3
"""
社区谱特征提取（三种格式统一口径）

目标：为 9,685 张社区谱计算与官谱**完全一致口径**的特征，
使官方模型能直接套用。

三种格式的时间语义（全部从 Phira 源码 prpr/src/ 逐字确认）：

| 格式 | 原始字段 | 官方换算 | 依据 |
|---|---|---|---|
| **RPE** | `startTime:[a,b,c]` | `beats = a + b/c`，再 `BpmList::time_beats(beats)` | core.rs:100 `self.1/self.2` |
| **PECTX** | `n1 <beat> ...` | `BpmList::time_beats(beat)` | pec.rs:49 `r.time_beats(it as f64)` |
| **PEC** | `time` (ms) | `time / 1000` | 绝对毫秒 |
| **PGR** | `time` | `time * 60/32/bpm` | pgr.rs:232 `let r = 60./32./pgr.bpm` |

BpmList::time_beats 语义（core.rs:134）：
    time + (beats - start_beats) * (60 / bpm)
  即**逐段累计**，BPMList 每段的 startTime 也用同一换算。

本脚本不引入第三方库，纯 stdlib，保证结果可复现。
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

# 音符类型的物理操作成本（依据官方判定区间）
# Tap/Hold ±80ms（精确）  Flick/Drag ±140ms（宽松）
COST = {1: 1.00, 2: 1.00, 3: 0.35, 4: 0.55}


# ============================================================
# BpmList —— 对齐 core.rs:106-145
# ============================================================
class BpmList:
    def __init__(self, ranges):
        """ranges: [(beats, bpm), ...]"""
        self.elements = []
        t = 0.0
        last_beats = 0.0
        last_bpm = None
        for beats, bpm in ranges:
            if last_bpm is not None:
                t += (beats - last_beats) * (60.0 / last_bpm)
            last_beats = beats
            last_bpm = bpm
            self.elements.append((beats, t, bpm))

    def time_beats(self, beats):
        if not self.elements:
            return beats * (60.0 / 120.0)
        # 找最后一个 start_beats <= beats 的段
        lo, hi = 0, len(self.elements) - 1
        if beats < self.elements[0][0]:
            sb, t, bpm = self.elements[0]
            return t + (beats - sb) * (60.0 / bpm)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.elements[mid][0] <= beats:
                lo = mid
            else:
                hi = mid - 1
        sb, t, bpm = self.elements[lo]
        return t + (beats - sb) * (60.0 / bpm)


# ============================================================
# 各格式的音符时间提取
# ============================================================
def triple_beats(t):
    """RPE: [a,b,c] → a + b/c  （core.rs:100）"""
    a, b, c = t[0], t[1], t[2]
    if c == 0:
        return float(a)
    return a + b / c


def from_rpe(j):
    """RPE 格式：beat 三元组 + BPMList"""
    bpm_ranges = []
    for b in (j.get("BPMList") or []):
        stt = b.get("startTime")
        bpm = b.get("bpm")
        if stt is None or not bpm or bpm <= 0:
            continue
        bpm_ranges.append((triple_beats(stt), float(bpm)))
    if not bpm_ranges:
        bpm_ranges = [(0.0, 120.0)]
    bpm_ranges.sort(key=lambda x: x[0])
    bl = BpmList(bpm_ranges)

    ts, ty = [], []
    for ln in (j.get("judgeLineList") or []):
        for n in (ln.get("notes") or []):
            if n.get("isFake") == 1:
                continue
            stt = n.get("startTime")
            if not stt or len(stt) != 3:
                continue
            ts.append(bl.time_beats(triple_beats(stt)))
            ty.append(n.get("type"))
    return ts, ty, len(j.get("judgeLineList") or []), bpm_ranges[0][1]


def from_pec_json(j):
    """PEC(JSON) 格式：time 是绝对毫秒"""
    ts, ty = [], []
    for ln in (j.get("judgeLineList") or []):
        for key in ("notesAbove", "notesBelow"):
            for n in (ln.get(key) or []):
                t = n.get("time")
                if t is None:
                    continue
                ts.append(t / 1000.0)
                ty.append(n.get("type"))
    bpm = None
    for ln in (j.get("judgeLineList") or []):
        if ln.get("bpm"):
            bpm = float(ln["bpm"])
            break
    return ts, ty, len(j.get("judgeLineList") or []), bpm


def from_pgr(j):
    """PGR 格式：time * 60/32/bpm  （pgr.rs:232）"""
    lines = j.get("judgeLineList") or []
    bpm = None
    for ln in lines:
        if ln.get("bpm"):
            bpm = float(ln["bpm"])
            break
    if not bpm or bpm <= 0:
        bpm = 120.0
    r = 60.0 / 32.0 / bpm
    ts, ty = [], []
    for ln in lines:
        for key in ("notesAbove", "notesBelow"):
            for n in (ln.get(key) or []):
                t = n.get("time")
                if t is None:
                    continue
                ts.append(t * r)
                ty.append(n.get("type"))
    return ts, ty, len(lines), bpm


def from_pectx(text):
    """PECTX 文本格式：beat + BpmList（pec.rs:49）"""
    bpm_ranges = []
    notes = []
    offset = None
    lines_seen = set()
    for raw in text.splitlines():
        it = raw.split()
        if not it:
            continue
        if offset is None:
            try:
                offset = float(it[0]) / 1000.0 - 0.15
            except ValueError:
                pass
            continue
        cmd = it[0]
        p = 1
        try:
            if cmd == "bp":
                beat = float(it[p]); p += 1
                bpm = float(it[p]); p += 1
                if bpm > 0:
                    bpm_ranges.append((beat, bpm))
            elif len(cmd) == 2 and cmd[0] == "n" and cmd[1] in "1234":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                beat = float(it[p]); p += 1
                if cmd[1] == "2":
                    p += 1          # Hold 的 end_time
                p += 1             # position_x
                above = int(it[p]) == 1; p += 1
                fake = int(it[p]) != 0; p += 1
                if not fake:
                    notes.append((beat, int(cmd[1])))
                while p < len(it) and it[p] in ("#", "&"):
                    p += 2
            elif len(cmd) == 2 and cmd[0] == "c":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                p += 1              # beat
                sub = cmd[1]
                p += {"v": 1, "p": 2, "d": 1, "a": 1, "m": 4, "r": 2, "f": 2}.get(sub, 0)
        except (ValueError, IndexError):
            continue
    if not bpm_ranges:
        bpm_ranges = [(0.0, 120.0)]
    bpm_ranges.sort(key=lambda x: x[0])
    bl = BpmList(bpm_ranges)
    ts = [bl.time_beats(b) for b, _ in notes]
    ty = [t for _, t in notes]
    return ts, ty, len(lines_seen), bpm_ranges[0][1]


# ============================================================
# 特征计算（口径与官谱 enhance_features.py 一致）
# ============================================================
def strain_features(ts, ty, window=1.0):
    n = len(ts)
    if n == 0:
        return {}
    order = sorted(range(n), key=lambda i: ts[i])
    ts2 = [ts[i] for i in order]
    ty2 = [ty[i] for i in order]
    total = ts2[-1] - ts2[0]
    if total <= 0:
        total = 1e-6

    pre = [0.0] * (n + 1)
    for i in range(n):
        pre[i + 1] = pre[i] + COST.get(ty2[i], 1.0)

    step = window / 20.0
    vals = []
    t = ts2[0]
    last = ts2[-1]
    MIN_NOTES = 5
    while t <= last + 1e-9:
        i0 = bisect.bisect_left(ts2, t)
        i1 = bisect.bisect_left(ts2, t + window)
        span = min(t + window, last + 1e-9) - t
        if span <= 1e-6:
            span = window
        if i1 - i0 >= MIN_NOTES:
            vals.append((pre[i1] - pre[i0]) / span)
        t += step
    if not vals:
        r = pre[n] / total
        return {"strain_peak": round(r, 4), "strain_peak_ratio": 0.0,
                "strain_p50": round(r, 4), "strain_p90": round(r, 4),
                "strain_p99": round(r, 4), "strain_raw_max": round(r, 4)}

    vs = sorted(vals)
    med = vs[len(vs) // 2]
    peak = vs[min(int(len(vs) * 0.99), len(vs) - 1)]
    thr = max(med * 1.5, 1e-6)
    ratio = sum(1 for v in vals if v > thr) / len(vals)
    return {
        "strain_peak": round(peak, 4),
        "strain_peak_ratio": round(ratio, 4),
        "strain_p50": round(vs[int(len(vs) * .50)], 4),
        "strain_p90": round(vs[min(int(len(vs) * .90), len(vs) - 1)], 4),
        "strain_p99": round(vs[min(int(len(vs) * .99), len(vs) - 1)], 4),
        "strain_raw_max": round(vs[-1], 4),
    }


def rhythm_features(ts, ty):
    n = len(ts)
    if n < 3:
        return {}
    order = sorted(range(n), key=lambda i: ts[i])
    ts2 = [ts[i] for i in order]
    d = [ts2[i + 1] - ts2[i] for i in range(n - 1) if ts2[i + 1] > ts2[i]]
    if not d:
        return {}
    ds = sorted(d)
    chord = sum(1 for x in d if x < 0.050)
    fast = sum(1 for x in d if x < 0.150)
    return {
        "iv_mean": round(st.mean(d), 4),
        "iv_median": round(ds[len(ds) // 2], 4),
        "chord_ratio": round(chord / len(d) * 100, 3),
        "fast_ratio": round(fast / len(d) * 100, 3),
    }


def detect_and_load(path):
    with open(path, "rb") as f:
        head = f.read(64).lstrip()
    if head[:1] != b"{":
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return "pectx", from_pectx(f.read())
    with open(path, "r", encoding="utf-8") as f:
        j = json.load(f)
    if "BPMList" in j:
        return "rpe", from_rpe(j)
    lines = j.get("judgeLineList") or []
    if lines and "notesAbove" in lines[0]:
        # 区分 PEC(JSON) 与 PGR：PGR 有 speedEvents，PEC 有 formatVersion
        if "speedEvents" in lines[0] or "judgeLineMoveEvents" in lines[0]:
            return "pgr", from_pgr(j)
        return "pec", from_pec_json(j)
    return "unknown", ([], [], 0, None)


def work(r):
    """模块级函数：进程池需要可 pickle 的顶层函数。"""
    cid = r["id"] if "id" in r else r.get("song_id")
    p = os.path.join(WORK_ROOT, str(cid), "chart.json")
    if not os.path.exists(p):
        return (cid, None, "nofile")
    try:
        fmt, (ts, ty, lines, bpm) = detect_and_load(p)
    except Exception as e:
        return (cid, None, f"{type(e).__name__}")
    if not ts or len(ts) < 2:
        return (cid, None, "empty")
    t0, t1 = min(ts), max(ts)
    dur = max(1e-3, t1 - t0)
    n = len(ts)
    out = {
        "fmt": fmt,
        "t_sec": [t0, t1],
        "duration_s": round(dur, 3),
        "nps": round(n / dur, 3),
        "lines": lines,
        "bpm": bpm,
        "tn": n,
        "ty": ty,
    }
    out.update(strain_features(ts, ty))
    out.update(rhythm_features(ts, ty))
    return (cid, out, None)


WORK_ROOT = ""


def _init(root):
    """进程池 initializer：子进程需要显式拿到路径。"""
    global WORK_ROOT
    WORK_ROOT = root


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--root", required=True, help="含 {id}/chart.json 的目录")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    rows = [json.loads(l) for l in open(args.manifest, encoding="utf-8")]
    print(f"[load] {len(rows)} 条  root={root}")
    # 抽查文件是否真的存在
    sample = rows[0]
    cid0 = sample.get("id") if "id" in sample else sample.get("song_id")
    p0 = os.path.join(root, str(cid0), "chart.json")
    print(f"[check] 抽查 {p0} exists={os.path.exists(p0)}")

    from concurrent.futures import ProcessPoolExecutor, as_completed

    results = {}
    errs = collections.Counter()
    with ProcessPoolExecutor(max_workers=args.workers,
                             initializer=_init, initargs=(root,)) as pool:
        futs = [pool.submit(work, r) for r in rows]
        done = 0
        for fut in as_completed(futs):
            cid, data, err = fut.result()
            done += 1
            if err:
                errs[err] += 1
            else:
                results[cid] = data
            if done % 1500 == 0:
                print(f"  [{done}/{len(rows)}] ok={len(results)} err={dict(errs)}")

    print(f"[done] 成功 {len(results)}  失败 {dict(errs)}")

    # 合并
    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    n_written = 0
    fmt_count = collections.Counter()
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            cid = r["id"] if "id" in r else r.get("song_id")
            d = results.get(cid)
            if not d:
                continue
            ty = d.pop("ty")
            tn = d.pop("tn")
            # ⚠️ 必须**覆盖**而非累加：manifest 里已有 t_tap/t_hold/...
            # （来自下载器 / parse_pectx.py），累加会导致占比翻倍。
            cnt = {1: 0, 2: 0, 3: 0, 4: 0}
            for t in ty:
                if t in cnt:
                    cnt[t] += 1
            r["t_tap"] = cnt[1]
            r["t_hold"] = cnt[2]
            r["t_flick"] = cnt[3]
            r["t_drag"] = cnt[4]
            # 物性校验：四类之和必须等于真实音符数
            assert cnt[1] + cnt[2] + cnt[3] + cnt[4] == tn, \
                f"{cid}: {cnt} != {tn}"
            r.update(d)
            fmt_count[d["fmt"]] += 1
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n_written += 1
    print(f"[write] {n_written} 条 → {out_path}")
    print(f"[fmt]   {dict(fmt_count)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
