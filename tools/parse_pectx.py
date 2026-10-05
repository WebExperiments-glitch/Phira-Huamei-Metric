#!/usr/bin/env python3
"""
PECTX 解析器 —— 严格按 Phira 源码 prpr/src/parse/pec.rs 实现

官方源码逐字对照：
  fn take_time(&mut self, r: &mut BpmList) -> Result<f64> {
      self.take_f32().map(|it| r.time_beats(it as f64))     // ← beat 直接转秒
  }
  'b' if cmd == "bp" => bpm_list.push((beat, bpm));
  'n' if cs.len()==2 && ('1'..='4').contains(&cs[1]) => {
      let line   = it.take_usize()?;
      let time   = it.take_time(r)?;                        // ← 音符时间
      let kind   = match cs[1] { '1'=>Click, '2'=>Hold{end_time}, '3'=>Flick, '4'=>Drag }
      let pos_x  = it.take_f32()? / 1024.;
      let above  = it.take_usize()? == 1;
      let fake   = it.take_usize()? != 0;
      if it.next() == Some("#") { speed }
      if it.next() == Some("&") { size }
  }
  'c' if cs.len()==2 => { 'v'|'p'|'d'|'a'|'m'|'r'|'f' }
  '#' | '&' 单独成行时作用于 last_note

注意：首行是 offset（毫秒），不是音符数。
"""
import argparse
import json
import os
import re
import statistics as st
import sys
from collections import Counter

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
CHARTS = os.path.join(ROOT, "data", "charts")

CMD_LEN = {}


class BpmList:
    """官方 BpmList 语义：逐段累计，time_beats(beats) → 秒"""

    def __init__(self, ranges):
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
            return beats * (60.0 / 120.0)   # 无 BPM 时的兜底
        for start_beats, t, bpm in self.elements:
            if start_beats <= beats:
                return t + (beats - start_beats) * (60.0 / bpm)
        sb, t, bpm = self.elements[0]
        return t + (beats - sb) * (60.0 / bpm)


def parse_pectx(text):
    """返回 (stats, error) —— stats 为 None 表示失败"""
    lines = text.splitlines()
    bpm_ranges = []
    notes = []            # (line, type, time_sec, fake, above, pos_x)
    lines_seen = set()
    offset = None
    cur_bpm = None
    errors = []

    def toks(s):
        return s.split()

    for ln_no, raw in enumerate(lines, 1):
        it = toks(raw)
        if not it:
            continue
        if offset is None:
            try:
                offset = float(it[0]) / 1000.0 - 0.15   # 官方：/1000 - 0.15
            except ValueError:
                errors.append(f"L{ln_no} offset 解析失败")
            continue

        cmd = it[0]
        CMD_LEN[cmd] = CMD_LEN.get(cmd, 0) + 1
        p = 1

        try:
            if cmd == "bp":
                beat = float(it[p]); p += 1
                bpm = float(it[p]); p += 1
                if bpm <= 0:
                    errors.append(f"L{ln_no} bpm<=0")
                    continue
                bpm_ranges.append((beat, bpm))
                cur_bpm = BpmList(bpm_ranges)

            elif len(cmd) == 2 and cmd[0] == "n" and cmd[1] in "1234":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                beat = float(it[p]); p += 1
                nt = cmd[1]
                if nt == "2":                      # Hold 需要 end_time
                    end_beat = float(it[p]); p += 1
                time_sec = (cur_bpm.time_beats(beat) if cur_bpm else beat * 0.5)
                pos_x = float(it[p]) / 1024.0; p += 1
                above = int(it[p]) == 1; p += 1
                fake = int(it[p]) != 0; p += 1
                notes.append((line, int(nt), time_sec, fake, above, pos_x))
                # 可选的 "#speed" / "&size" 后缀
                while p < len(it):
                    if it[p] == "#":
                        p += 2
                    elif it[p] == "&":
                        p += 2
                    else:
                        break

            elif len(cmd) == 2 and cmd[0] == "c":
                line = int(it[p]); p += 1
                lines_seen.add(line)
                beat = float(it[p]); p += 1
                sub = cmd[1]
                if sub == "v":
                    p += 1
                elif sub == "p":
                    p += 2
                elif sub in ("d", "a"):
                    p += 1
                elif sub == "m":
                    p += 4        # end_time x y tween
                elif sub in ("r", "f"):
                    p += 2        # end_time value [tween]
                # else: 未知子命令，跳过
            elif cmd in ("#", "&"):
                pass             # 作用于上一音符，已在 n 分支处理
            else:
                errors.append(f"L{ln_no} 未知指令 {cmd!r}")
        except (ValueError, IndexError) as e:
            errors.append(f"L{ln_no} {cmd}: {type(e).__name__}")

    real = [n for n in notes if not n[3]]
    types = Counter(n[1] for n in real)
    return {
        "offset": offset,
        "n_lines": len(lines_seen),
        "bpm_items": len(bpm_ranges),
        "notes_all": len(notes),
        "notes_real": len(real),
        "fake": len(notes) - len(real),
        "behind": sum(1 for n in real if not n[4]),
        "t_tap": types.get(1, 0), "t_hold": types.get(2, 0),
        "t_drag": types.get(3, 0), "t_flick": types.get(4, 0),
        "errors": errors,
        "duration": (max((n[2] for n in real), default=0.0)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--write", action="store_true", help="把结果并入 manifest.jsonl")
    args = ap.parse_args()

    targets = []
    for d in sorted(os.listdir(CHARTS)):
        if not d.isdigit():
            continue
        p = os.path.join(CHARTS, d, "chart.json")
        if not os.path.exists(p):
            continue
        with open(p, "rb") as f:
            if f.read(1).lstrip() == b"{":
                continue
        targets.append((int(d), p))
    if args.limit:
        targets = targets[:args.limit]

    print(f"[scan] PECTX 谱面 {len(targets)} 张")
    rows, failed, has_err = [], [], 0
    for cid, p in targets:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        try:
            r = parse_pectx(text)
        except Exception as e:
            failed.append((cid, f"{type(e).__name__}: {e}"))
            continue
        if r["errors"]:
            has_err += 1
        rows.append((cid, r))

    print(f"[parse] 成功 {len(rows)}  失败 {len(failed)}  有告警 {has_err}")
    if failed:
        print(f"[fail] 例：{failed[:5]}")

    if not rows:
        return 1

    tot = sum(r["notes_real"] for _, r in rows)
    print(f"\n[统计] PECTX 音符总计 {tot:,}")
    # 官方 prpr/src/parse/pec.rs 与 parse/rpe.rs 的 type 映射完全一致：
    #   1=Click(Tap) 2=Hold 3=Flick 4=Drag
    for k, lab in [("t_tap", "Click/Tap(1)"), ("t_hold", "Hold(2)"),
                   ("t_flick", "Flick(3)"), ("t_drag", "Drag(4)")]:
        s = sum(r[k] for _, r in rows)
        print(f"  {lab:<14} {s:>8,}  {s/max(tot,1)*100:5.2f}%")
    print(f"  假音符      {sum(r['fake'] for _, r in rows):>8,}")
    print(f"  背面音符    {sum(r['behind'] for _, r in rows):>8,}")
    nl = sorted(r["n_lines"] for _, r in rows)
    nt = sorted(r["notes_real"] for _, r in rows)
    du = sorted(r["duration"] for _, r in rows)
    print(f"\n  判定线数  min={nl[0]} 中位={nl[len(nl)//2]} max={nl[-1]}")
    print(f"  音符数    min={nt[0]} 中位={nt[len(nt)//2]} max={nt[-1]}")
    print(f"  时长(s)   min={du[0]:.1f} 中位={du[len(du)//2]:.1f} max={du[-1]:.1f}")
    print(f"  多BPM段   {sum(1 for _,r in rows if r['bpm_items']>1)} 张")

    print(f"\n[指令频次 TOP12]")
    for k, v in sorted(CMD_LEN.items(), key=lambda x: -x[1])[:12]:
        print(f"  {k:<6} {v}")

    if args.write:
        recs = {}
        for l in open(os.path.join(CHARTS, "manifest.jsonl"), encoding="utf-8"):
            r = json.loads(l)
            recs[r["id"]] = r
        meta = json.load(open(os.path.join(ROOT, "_research", "meta", "regular.json"),
                              encoding="utf-8"))["results"]
        by_id = {m["id"]: m for m in meta}
        added = 0
        for cid, r in rows:
            if cid in recs:
                continue
            m = by_id.get(cid, {})
            recs[cid] = {
                "id": cid, "name": m.get("name"), "level": m.get("level"),
                "difficulty": m.get("difficulty"), "rating": m.get("rating"),
                "ratingCount": m.get("ratingCount"), "stable": m.get("stable"),
                "ranked": m.get("ranked"), "charter": m.get("charter"),
                "tags": m.get("tags"), "file_size": 0, "chart_file": "chart.json",
                "format": "pectx", "bpm": None, "bpm_items": r["bpm_items"],
                "rpe_version": None, "lines": r["n_lines"],
                "notes_all": r["notes_all"], "notes_real": r["notes_real"],
                "fake": r["fake"], "behind": r["behind"],
                "t_tap": r["t_tap"], "t_hold": r["t_hold"],
                "t_drag": r["t_drag"], "t_flick": r["t_flick"],
                "with_father": 0, "bpmfactor_non1": 0,
                "duration": round(r["duration"], 3),
                "fetched_at": "",
            }
            added += 1
        with open(os.path.join(CHARTS, "manifest.jsonl"), "w", encoding="utf-8") as f:
            for r in recs.values():
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"\n[write] 新增 {added} 条，manifest 现共 {len(recs)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
