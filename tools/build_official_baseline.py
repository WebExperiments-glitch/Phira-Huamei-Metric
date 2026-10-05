#!/usr/bin/env python3
"""
官谱基线提取器（PGR 格式）

目标：为「官方定数 ↔ 谱面特征」映射提供可靠特征。
与社区谱（RPE/PEC/PECTX）口径严格一致，确保可比。

PGR 格式要点（已从 Phira 源码 prpr/src/parse/pgr.rs 逐字确认）：
  顶层: formatVersion, judgeLineList, offset          ← 无 BPMList
  判定线: bpm, notesAbove, notesBelow, speedEvents,
         judgeLineMoveEvents, judgeLineRotateEvents, judgeLineDisappearEvents
  音符:   {"type":N,"time":T,"positionX":f32,"holdTime":T,
           "speed":f32,"floorPosition":f32}
  type 映射与 RPE/PECTX 一致：1=Tap 2=Hold 3=Flick 4=Drag

★ 时间单位（关键，曾在此出错）：
  官方 pgr.rs:232  `let r = 60. / 32. / pgr.bpm;`
  → seconds = time * 60 / 32 / BPM
  即 `time` 的单位是 **1/32 拍**，不是毫秒。

  误判后果：若按毫秒算，華灯爱 IN 会被算成 6.9 秒 / NPS 75（物理不可能）；
  正解是 108.1 秒 / NPS 4.8。

物量口径与社区谱对齐：
  notes_real = 不含假音符（PGR 无假键概念，故等于 notes_all）
  fake 恒为 0
"""
import argparse
import collections
import glob
import json
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))


def load_difficulty(path):
    """读 difficulty.tsv → {song_id: {'EZ':v,'HD':v,'IN':v,'AT':v}}"""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            sid = parts[0]
            d = {}
            for i, lv in enumerate(["EZ", "HD", "IN", "AT"], start=1):
                if i < len(parts) and parts[i]:
                    try:
                        d[lv] = float(parts[i])
                    except ValueError:
                        pass
            out[sid] = d
    return out


def load_info(path):
    """读 info.tsv → {song_id: {name, composer, illustrator, charter:{LV:name}}}"""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) < 4:
                continue
            out[p[0]] = {
                "name": p[1], "composer": p[2], "illustrator": p[3],
                "charter": {lv: p[4 + i] for i, lv in enumerate(["EZ", "HD", "IN", "AT"])
                            if 4 + i < len(p) and p[4 + i]},
            }
    return out


def extract_one(path, diff, meta, song_id, level):
    """提取单张 PGR 谱面特征。diff 为官方定数，meta 为元信息。"""
    with open(path, encoding="utf-8") as f:
        j = json.load(f)

    lines = j.get("judgeLineList") or []
    notes = []
    bpms = []
    for ln in lines:
        b = ln.get("bpm")
        if isinstance(b, (int, float)) and b > 0:
            bpms.append(b)
        for key in ("notesAbove", "notesBelow"):
            for n in (ln.get(key) or []):
                notes.append(n)

    if not notes:
        return None

    types = collections.Counter(n.get("type") for n in notes)

    # ★ 官方 pgr.rs:232  r = 60. / 32. / bpm  —— time 单位是 1/32 拍
    bpm0 = bpms[0] if bpms else 120.0
    r = 60.0 / 32.0 / bpm0

    times = [n.get("time", 0) or 0 for n in notes]
    t0, t1 = min(times), max(times)
    # 末音符时长：Hold 用 holdTime 补足
    end_max = t1
    for n in notes:
        if n.get("type") == 2:
            ht = n.get("holdTime") or 0
            end_max = max(end_max, (n.get("time", 0) or 0) + ht)

    t_start = t0 * r
    t_end = end_max * r
    dur_s = max(1e-3, t_end - t_start)

    n = len(notes)
    row = {
        "song_id": song_id,
        "level": level,
        "difficulty": diff,
        "name": meta.get("name", ""),
        "composer": meta.get("composer", ""),
        "charter": meta.get("charter", {}).get(level, ""),
        "lines": len(lines),
        "notes_all": n,
        "notes_real": n,
        "fake": 0,
        "behind": sum(1 for ln in lines for _m in (ln.get("notesBelow") or [])),
        "t_tap": types.get(1, 0),
        "t_hold": types.get(2, 0),
        "t_flick": types.get(3, 0),
        "t_drag": types.get(4, 0),
        "bpm": bpms[0] if bpms else None,
        "bpm_items": len(bpms),
        "duration_s": round(dur_s, 3),
        "nps": round(n / dur_s, 3),
    }
    tot = n
    for k in ("t_tap", "t_hold", "t_flick", "t_drag"):
        row[k.replace("t_", "pct_")] = round(row[k] / tot * 100, 3)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgr", required=True, help="含 chart/ 与 info/ 的目录")
    ap.add_argument("--out", required=True, help="输出 manifest.jsonl")
    args = ap.parse_args()

    pgr = os.path.abspath(args.pgr)
    diff = load_difficulty(os.path.join(pgr, "info", "difficulty.tsv"))
    meta = load_info(os.path.join(pgr, "info", "info.tsv"))
    print(f"[load] 定数 {len(diff)} 首 / 元信息 {len(meta)} 首")

    # chart 目录名是 "<song_id>.0"，tsv 里的 song_id 已去掉末尾2字符
    song_dirs = {}
    for d in os.listdir(os.path.join(pgr, "chart")):
        if not os.path.isdir(os.path.join(pgr, "chart", d)):
            continue
        song_dirs[d] = d

    rows, miss_diff, miss_meta, miss_file = [], 0, 0, 0
    for dname in sorted(song_dirs):
        # 目录形如 "Igallta.SeURa.0"，tsv 键为 "Igallta.SeURa"
        sid = dname[:-2] if dname.endswith(".0") else dname
        if sid not in diff:
            miss_diff += 1
            continue
        if sid not in meta:
            miss_meta += 1
        for lv in ("EZ", "HD", "IN", "AT"):
            p = os.path.join(pgr, "chart", dname, f"{lv}.json")
            if not os.path.exists(p):
                continue
            if lv not in diff[sid]:
                continue
            r = extract_one(p, diff[sid][lv], meta.get(sid, {}), sid, lv)
            if r:
                rows.append(r)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"[done] 提取 {len(rows)} 条")
    print(f"  定数表未收录: {miss_diff}  元信息缺: {miss_meta}")
    print(f"  输出 {args.out}")

    # 快速体检
    if rows:
        ds = [r["difficulty"] for r in rows]
        ns = [r["notes_real"] for r in rows]
        du = [r["duration_s"] for r in rows]
        print(f"\n  定数   {min(ds):.1f}~{max(ds):.1f} 中位 {st.median(ds):.1f}")
        print(f"  物量   {min(ns)}~{max(ns)} 中位 {st.median(ns):.0f}")
        print(f"  时长   {min(du):.1f}~{max(du):.1f}s 中位 {st.median(du):.1f}s")
        bad = [r for r in rows if r["duration_s"] < 5]
        print(f"  可疑短谱(<5s): {len(bad)}")
        c = collections.Counter(r["level"] for r in rows)
        print(f"  难度分布: {dict(c)}")
        # 物性校验
        bad_sum = [r["song_id"] for r in rows
                   if r["t_tap"] + r["t_hold"] + r["t_flick"] + r["t_drag"] != r["notes_real"]]
        print(f"  音符类型和不守恒: {len(bad_sum)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
