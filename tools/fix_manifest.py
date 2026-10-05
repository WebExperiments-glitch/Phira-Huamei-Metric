#!/usr/bin/env python3
"""
离线修复 manifest —— 无需重新下载

背景：早期版本的 fetch_charts.py 假设所有谱面都是 RPE 格式，
        导致 14 张 PEC 格式谱面被误判为「空谱」，
        1.4 万个音符被当成无效数据丢弃。

本脚本直接重扫已落盘的 chart.json，重建 manifest。
"""
import json
import os
from collections import Counter

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
CHARTS = os.path.join(ROOT, "data", "charts")
META = os.path.join(ROOT, "_research", "meta", "regular.json")
MANIFEST = os.path.join(CHARTS, "manifest.jsonl")


def note_type_of(lines, is_rpe):
    """返回 (音符列表, Counter(type), 假键数, 背面数)"""
    if is_rpe:
        allnotes = [n for l in lines for n in (l.get("notes") or [])]
        real = [n for n in allnotes if n.get("isFake") != 1]
        return real, Counter(n.get("type") for n in real), len(allnotes) - len(real), \
               sum(1 for n in real if n.get("above") != 1)
    # PEC: notesAbove(正面) / notesBelow(背面)，无 isFake 概念
    above, below = [], []
    for l in lines:
        above += (l.get("notesAbove") or [])
        below += (l.get("notesBelow") or [])
    real = above + below
    return real, Counter(n.get("type") for n in real), 0, len(below)


def main():
    recs = json.load(open(META, encoding="utf-8"))["results"]
    old = {}
    if os.path.exists(MANIFEST):
        for line in open(MANIFEST, encoding="utf-8"):
            try:
                r = json.loads(line)
                old[r["id"]] = r
            except Exception:
                pass

    out, pec_found, fixed_fmt, unreadable = [], 0, 0, 0
    for rec in recs:
        cid = rec["id"]
        p = os.path.join(CHARTS, str(cid), "chart.json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
            unreadable += 1
            continue

        lines = j.get("judgeLineList") or []
        is_rpe = "BPMList" in j
        is_pec = bool(lines) and "notesAbove" in lines[0]
        fmt = "rpe" if is_rpe else ("pec" if is_pec else "unknown")

        real, types, fake, behind = note_type_of(lines, is_rpe)
        bpm_list = (j.get("BPMList") or []) if is_rpe else []

        prev = old.get(cid, {})
        row = {
            "id": cid,
            "name": rec.get("name"),
            "level": rec.get("level"),
            "difficulty": rec.get("difficulty"),
            "rating": rec.get("rating"),
            "ratingCount": rec.get("ratingCount"),
            "stable": rec.get("stable"),
            "ranked": rec.get("ranked"),
            "charter": rec.get("charter"),
            "tags": rec.get("tags"),
            "file_size": prev.get("file_size", 0),
            "chart_file": prev.get("chart_file", ""),
            "format": fmt,
            "bpm": bpm_list[0].get("bpm") if bpm_list else None,
            "bpm_items": len(bpm_list),
            "rpe_version": (j.get("META") or {}).get("RPEVersion") if is_rpe else None,
            "lines": len(lines),
            "notes_all": len(real),
            "notes_real": len(real),
            "fake": fake,
            "behind": behind,
            "t_tap": types.get(1, 0),
            "t_hold": types.get(2, 0),
            "t_drag": types.get(3, 0),
            "t_flick": types.get(4, 0),
            "with_father": sum(1 for l in lines if l.get("father") is not None),
            "bpmfactor_non1": sum(1 for l in lines
                                  if (l.get("bpmfactor") or 1.0) != 1.0),
            "fetched_at": prev.get("fetched_at", ""),
        }
        if is_pec:
            pec_found += 1
        if prev.get("format") != fmt:
            fixed_fmt += 1
        out.append(row)

    seen = {}
    for r in out:
        seen[r["id"]] = r
    out = list(seen.values())

    with open(MANIFEST, "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    fmts = Counter(r["format"] for r in out)
    print(f"扫描 {len(out)} 张 | 不可读 {unreadable}")
    print(f"格式分布：{dict(fmts)}")
    print(f"修正 format 字段：{fixed_fmt} 条 | 新识别 PEC：{pec_found} 张")
    print(f"物量=0 的谱：{sum(1 for r in out if r['notes_real'] == 0)}")
    print(f"音符总计：{sum(r['notes_real'] for r in out):,}")
    print(f"已重写 {MANIFEST}")


if __name__ == "__main__":
    main()
