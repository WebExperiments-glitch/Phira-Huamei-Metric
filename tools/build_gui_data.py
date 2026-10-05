#!/usr/bin/env python3
"""
前端数据构建：从真源裁剪出 GUI 需要的字段

为什么要裁剪：真源 69 字段/17.6MB，前端只用 18 个字段。
             裁剪后 3.4MB，浏览器解析更快。

输入：data/official.jsonl + data/community.jsonl（真源）
输出：phm/gui/data/official.jsonl + phm/gui/data/community.jsonl
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "phm", "gui", "data")

# 归一化唯一真源在 phm/core.py，前端不再自己 slice 自由文本
sys.path.insert(0, os.path.join(ROOT, "phm"))
from core import norm_level  # noqa: E402

# GUI 实际读取的字段（与 index.html 的 show() 一一对应）
COM_KEEP = [
    "id", "name", "level", "difficulty", "charter", "notes_real", "lines",
    "nps", "duration_s", "t_tap", "t_hold", "t_flick", "t_drag", "fake",
    "stair_speed_avg", "hold_interference_index", "stable", "ranked",
]
OFF_KEEP = [
    "name", "level", "difficulty", "notes_real", "nps",
    "t_tap", "t_hold", "t_flick", "t_drag",
    "stair_speed_avg", "hold_interference_index", "charter",
]


def build(src, dst, keep, key, alias=None):
    if not os.path.exists(src):
        print(f"[abort] 未找到 {src}", file=sys.stderr)
        return 1
    n = 0
    with open(src, encoding="utf-8") as fi, \
            open(dst, "w", encoding="utf-8") as fo:
        for line in fi:
            if not line.strip():
                continue
            r = json.loads(line)
            o = {k: r.get(k) for k in keep}
            # 预计算标准难度标签（EZ/HD/IN/AT/SP，无法识别为 null），
            # 前端按 tag 分组/筛选，不再对自由文本 level 做切片
            o["tag"] = norm_level(r.get("level"))
            # 前端用 `id` 字段作索引；官谱真源里叫 song_id
            if alias:
                o["id"] = r.get(alias)
            elif key and "id" not in o:
                o["id"] = r.get(key)
            fo.write(json.dumps(o, ensure_ascii=False) + "\n")
            n += 1
    print(f"  {os.path.relpath(dst, ROOT):<38} {n:>6} 条  "
          f"{os.path.getsize(dst)/1048576:>6.2f} MB")
    return 0


def main():
    os.makedirs(OUT, exist_ok=True)
    print("[build] 前端数据（从真源裁剪）")
    rc = build(os.path.join(DATA, "community.jsonl"),
               os.path.join(OUT, "community.jsonl"),
               COM_KEEP, "id")
    if rc:
        return rc
    rc = build(os.path.join(DATA, "official.jsonl"),
               os.path.join(OUT, "official.jsonl"),
               OFF_KEEP, "id", alias="song_id")
    if rc:
        return rc

    # 完整性校验：前端能否只靠这些字段做判断
    c = os.path.join(OUT, "community.jsonl")
    rows = [json.loads(l) for l in open(c, encoding="utf-8")]
    need = ["nps", "notes_real", "t_hold", "difficulty", "level"]
    miss = {k: sum(1 for r in rows if r.get(k) is None) for k in need}
    bad = {k: v for k, v in miss.items() if v}
    if bad:
        print(f"[warn] 存在空字段：{bad}", file=sys.stderr)
    else:
        print("  [check] 前端必需字段无缺失 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
