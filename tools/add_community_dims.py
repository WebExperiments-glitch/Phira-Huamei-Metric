#!/usr/bin/env python3
"""
社区谱 18 维要素补算

问题：extract_community_features.py 只算了基础特征 + strain + 节奏，
      缺 stair_speed_avg / hold_interference_index 等 18 维。
      结果：报告里「纵连速度」永远显示 0，对照失真。

解决：把 dims14.extract_dims 接到社区谱特征提取流程上。
      三种格式（RPE/PEC/PECTX）的时间轴已各自校准，
      dims14 内部统一用「秒 + tick」表示，可直接复用。
"""
import argparse
import collections
import json
import os
import statistics as st
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from dims14 import extract_dims                          # noqa: E402

COST = {1: 1.00, 2: 1.00, 3: 0.35, 4: 0.55}


# ============================================================
# 三格式的音符读取（返回 (sec, tick, type, above, x, line_idx)）
# ============================================================
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


def tb_triple(t):
    a, b, c = t[0], t[1], t[2]
    return a + b / c if c else float(a)


def read_rpe(j, ev):
    br = []
    for b in (j.get("BPMList") or []):
        stt, bpm = b.get("startTime"), b.get("bpm")
        if stt and bpm and bpm > 0:
            br.append((tb_triple(stt), float(bpm)))
    br.sort()
    bl = BpmList(br) if br else BpmList([(0.0, 120.0)])
    notes = []
    move_disp = 0.0
    rotate_cnt = 0
    disappear_cnt = 0
    for li, ln in enumerate(j.get("judgeLineList") or []):
        # ★ RPE 的演出事件在 eventLayers 里，不是顶层
        for layer in (ln.get("eventLayers") or []):
            if not isinstance(layer, dict):
                continue
            for e in (layer.get("speedEvents") or []):
                stt = e.get("startTime")
                if stt and len(stt) == 3:
                    ev["_tempo_changes"].append(stt[0])
            rotate_cnt += len(layer.get("rotateEvents") or [])
            # 判定线位移：posX/posY 的事件数
            for e in (layer.get("posXEvents") or []):
                move_disp += 1
        # 顶层兼容（部分编辑器把演出直接放判定线上）
        rotate_cnt += len(ln.get("rotateEvents") or [])
        for e in (ln.get("judgeLineRotateEvents") or []):
            pass
        for n in (ln.get("notes") or []):
            if n.get("isFake") == 1:
                continue
            stt = n.get("startTime")
            if not stt or len(stt) != 3:
                continue
            bk = tb_triple(stt)
            notes.append((bl.tb(bk), stt[0] * 32.0, n.get("type"),
                          n.get("above", 1), n.get("positionX", 0.0), li))
    ev["move"] = move_disp
    ev["_rotate_count"] = rotate_cnt
    ev["_disappear_count"] = disappear_cnt
    bpm0 = br[0][1] if br else 120.0
    return notes, bpm0


def read_pec(j, ev):
    notes = []
    for li, ln in enumerate(j.get("judgeLineList") or []):
        for key, below in (("notesAbove", False), ("notesBelow", True)):
            for n in (ln.get(key) or []):
                t = n.get("time")
                if t is None:
                    continue
                ht = n.get("holdTime") or 0
                notes.append((t / 1000.0, t * 32.0, n.get("type"),
                              0 if below else 1, n.get("positionX", 0.0), li))
    bpm = None
    for ln in (j.get("judgeLineList") or []):
        if ln.get("bpm"):
            bpm = float(ln["bpm"])
            break
    return notes, bpm or 120.0


def read_pgr(j, ev):
    lines = j.get("judgeLineList") or []
    bpm0 = 120.0
    for ln in lines:
        if ln.get("bpm"):
            bpm0 = float(ln["bpm"])
            break
    r = 60.0 / 32.0 / bpm0
    notes = []
    for li, ln in enumerate(lines):
        for e in (ln.get("speedEvents") or [])[1:]:
            st_ = e.get("startTime")
            if st_ is not None:
                ev["_tempo_changes"].append(st_ * r)
        for e in (ln.get("judgeLineRotateEvents") or []):
            pass
        for key, below in (("notesAbove", False), ("notesBelow", True)):
            for n in (ln.get(key) or []):
                t = n.get("time")
                if t is None:
                    continue
                notes.append((t * r, t * 32.0, n.get("type"),
                              0 if below else 1, n.get("positionX", 0.0), li))
    return notes, bpm0


def read_pectx(text, ev):
    br = []
    notes = []
    lines_seen = set()
    offset = None
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
                    br.append((beat, bpm))
            elif len(cmd) == 2 and cmd[0] == "n" and cmd[1] in "1234":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                beat = float(it[p]); p += 1
                if cmd[1] == "2":
                    p += 1
                p += 1
                above = int(it[p]) == 1; p += 1
                fake = int(it[p]) != 0; p += 1
                if not fake:
                    notes.append((beat, beat * 32.0, int(cmd[1]),
                                  1 if above else 0, 0.0, line))
                while p < len(it) and it[p] in ("#", "&"):
                    p += 2
            elif len(cmd) == 2 and cmd[0] == "c":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                p += 1
                p += {"v": 1, "p": 2, "d": 1, "a": 1,
                      "m": 4, "r": 2, "f": 2}.get(cmd[1], 0)
        except (ValueError, IndexError):
            continue
    br.sort()
    bl = BpmList(br) if br else BpmList([(0.0, 120.0)])
    out = [(bl.tb(b), tk, t, ab, x, li) for b, tk, t, ab, x, li in notes]
    return out, (br[0][1] if br else 120.0)


def load_chart(path):
    with open(path, "rb") as f:
        head = f.read(64).lstrip()
    ev = {"move": 0.0, "_tempo_changes": [], "_rotate_count": 0,
          "_disappear_count": 0}
    if head[:1] != b"{":
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            notes, bpm = read_pectx(f.read(), ev)
    else:
        with open(path, "r", encoding="utf-8") as f:
            j = json.load(f)
        if "BPMList" in j:
            notes, bpm = read_rpe(j, ev)
        else:
            lines = j.get("judgeLineList") or []
            if lines and "notesAbove" in lines[0]:
                if "speedEvents" in lines[0] or "judgeLineMoveEvents" in lines[0]:
                    notes, bpm = read_pgr(j, ev)
                else:
                    notes, bpm = read_pec(j, ev)
            else:
                notes, bpm = [], 120.0
    return notes, ev, bpm


ROOT = ""


def _init(root):
    global ROOT
    ROOT = root


def work(rec):
    cid = rec["id"] if "id" in rec else rec.get("song_id")
    p = os.path.join(ROOT, str(cid), "chart.json")
    if not os.path.exists(p):
        return (cid, None, "nofile")
    try:
        notes, ev, bpm = load_chart(p)
        if len(notes) < 2:
            return (cid, None, "empty")
        notes.sort(key=lambda x: (x[0], x[1]))
        ts = [x[0] for x in notes]
        ty = [x[2] for x in notes]
        dur = max(1e-3, ts[-1] - ts[0])
        out = extract_dims(notes, ev, dur, bpm, len({x[5] for x in notes}))
        out["_tn"] = len(notes)
        out["_ty"] = ty
        return (cid, out, None)
    except Exception as e:
        return (cid, None, f"{type(e).__name__}: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    rows = [json.loads(l) for l in open(args.manifest, encoding="utf-8")]
    print(f"[load] {len(rows)} 条")

    results, errs = {}, collections.Counter()
    with ProcessPoolExecutor(max_workers=args.workers,
                             initializer=_init, initargs=(root,)) as pool:
        done = 0
        for fut in as_completed([pool.submit(work, r) for r in rows]):
            cid, d, err = fut.result()
            done += 1
            if err:
                errs[err] += 1
            else:
                results[cid] = d
            if done % 2000 == 0:
                print(f"  [{done}/{len(rows)}] ok={len(results)} err={dict(errs)}")

    print(f"[done] 成功 {len(results)}  失败 {dict(errs)}")

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            cid = r["id"] if "id" in r else r.get("song_id")
            d = results.get(cid)
            if not d:
                continue
            tn, ty = d.pop("_tn"), d.pop("_ty")
            cnt = {1: 0, 2: 0, 3: 0, 4: 0}
            for t in ty:
                if t in cnt:
                    cnt[t] += 1
            r["t_tap"], r["t_hold"] = cnt[1], cnt[2]
            r["t_flick"], r["t_drag"] = cnt[3], cnt[4]
            assert sum(cnt.values()) == tn
            r.update(d)
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    print(f"[write] {n} 条 → {out}")

    DIMS = ["stair_speed_avg", "hold_interference_index",
            "eff_peak_tps_1s", "above_avg_duration_sec", "chord_size_entropy"]
    print(f"\n{'维度':<30}{'非零比例':>10}{'中位':>12}{'max':>12}")
    print("-" * 64)
    rs = [json.loads(l) for l in open(out, encoding="utf-8")]
    for k in DIMS:
        v = [x.get(k, 0) for x in rs]
        nz = sum(1 for x in v if x > 0)
        print(f"{k:<30}{nz/len(v)*100:>9.1f}%{st.median(v):>12.3f}{max(v):>12.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
