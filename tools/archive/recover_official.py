#!/usr/bin/env python3
"""
恢复官谱真源（修复复合键 bug 导致的行合并）

事故：consolidate_data.py 用 song_id 单键去重官谱，
     而官谱每首歌有 EZ/HD/IN/AT 四行，被合并成 1 行 → 1037 行变 327 行。

恢复依据（两份文件互补）：
  · data/_backup_before_consolidate/official_manifest_v3.jsonl
      1037 行（完整），但缺 iv_mean / iv_p10 / strain_raw_max
  · data/official.jsonl
      327 行（错误合并），但含上述 3 个字段

做法：以备份的 1037 行为基底，按 (song_id, level) 回填那 3 个字段。
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data")

SRC = os.path.join(DATA, "_backup_before_consolidate", "official_manifest_v3.jsonl")
CUR = os.path.join(DATA, "official.jsonl")
OUT = os.path.join(DATA, "official.jsonl")

EXTRA = ["iv_mean", "iv_p10", "strain_raw_max"]


def main():
    if not os.path.exists(SRC):
        print(f"[abort] 未找到备份 {SRC}", file=sys.stderr)
        return 1

    rows = [json.loads(l) for l in open(SRC, encoding="utf-8") if l.strip()]
    print(f"[load] 备份 {len(rows)} 行")

    # 当前文件里的 3 个字段
    extra_map = {}
    if os.path.exists(CUR):
        for l in open(CUR, encoding="utf-8"):
            if not l.strip():
                continue
            r = json.loads(l)
            k = (r.get("song_id"), r.get("level"))
            extra_map[k] = {f: r.get(f) for f in EXTRA if r.get(f) is not None}
        print(f"[load] 当前文件 {len(extra_map)} 行（含 {EXTRA}）")

    filled = 0
    for r in rows:
        k = (r.get("song_id"), r.get("level"))
        for f, v in extra_map.get(k, {}).items():
            if r.get(f) is None:
                r[f] = v
                filled += 1
    print(f"[merge] 回填 {filled} 个字段值")

    # 校验
    keys = [(r.get("song_id"), r.get("level")) for r in rows]
    dup = len(keys) - len(set(keys))
    lv = {}
    for r in rows:
        lv[r.get("level")] = lv.get(r.get("level"), 0) + 1
    print(f"[check] 行数 {len(rows)}  重复键 {dup}  难度分布 {lv}")

    if dup:
        print("[abort] 仍有重复键，不覆盖", file=sys.stderr)
        return 1
    if len(rows) != 1037:
        print(f"[warn] 行数 {len(rows)} != 1037")

    with open(OUT, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[done] 已写回 {os.path.relpath(OUT, ROOT)}  {len(rows)} 行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
