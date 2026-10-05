#!/usr/bin/env python3
"""
批量修正脚本里的旧数据路径

数据整合后路径变了，把 tools/*.py 里的引用统一更新。

   旧 → 新
   data/official/manifest_v3.jsonl        → data/official.jsonl
   data/official/manifest_enhanced.jsonl  → data/official.jsonl
   data/official/manifest.jsonl           → data/.stages/official_base.jsonl
   data/community/manifest_full.jsonl     → data/community.jsonl
   data/community/manifest_features.jsonl → data/.stages/community_base.jsonl
   data/community/manifest_v2.jsonl       → data/.stages/community_dims.jsonl

同时处理两种写法：
   a) os.path.join(BASE/ROOT, ..., "data", "official", "manifest_v3.jsonl")
   b) 字符串字面量 "data/official/manifest_v3.jsonl"
"""
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

RULES = [
    # (旧片段, 新片段) —— 按 os.path.join 的参数序列匹配
    (('"data", "official", "manifest_v3.jsonl"',), '"data", "official.jsonl"'),
    (('"data", "official", "manifest_enhanced.jsonl"',), '"data", "official.jsonl"'),
    (('"data", "official", "manifest.jsonl"',),
     '"data", ".stages", "official_base.jsonl"'),
    (('"data", "community", "manifest_full.jsonl"',), '"data", "community.jsonl"'),
    (('"data", "community", "manifest_features.jsonl"',),
     '"data", ".stages", "community_base.jsonl"'),
    (('"data", "community", "manifest_v2.jsonl"',),
     '"data", ".stages", "community_dims.jsonl"'),
    (('"data", "charts", "manifest.jsonl"',), '"data", "charts", "manifest.jsonl"'),
    # 字符串字面量形式
    (('"data/official/manifest_v3.jsonl"',), '"data/official.jsonl"'),
    (('"data/official/manifest_enhanced.jsonl"',), '"data/official.jsonl"'),
    (('"data/official/manifest.jsonl"',), '"data/.stages/official_base.jsonl"'),
    (('"data/community/manifest_full.jsonl"',), '"data/community.jsonl"'),
    (('"data/community/manifest_features.jsonl"',),
     '"data/.stages/community_base.jsonl"'),
    (('"data/community/manifest_v2.jsonl"',),
     '"data/.stages/community_dims.jsonl"'),
]


def main():
    ap_dry = "--apply" not in sys.argv
    files = sorted(f for f in os.listdir(BASE)
                   if f.endswith(".py") and f != os.path.basename(__file__))
    print(f"扫描 {len(files)} 个脚本" + ("（预览，加 --apply 执行）" if ap_dry else ""))
    total = 0
    for fn in files:
        p = os.path.join(BASE, fn)
        s = open(p, encoding="utf-8").read()
        orig = s
        hits = []
        for (old,), new in RULES:
            if old in s and old != new:
                c = s.count(old)
                s = s.replace(old, new)
                hits.append(f"{old} → {new} ×{c}")
        if s != orig:
            total += 1
            print(f"\n  {fn}")
            for h in hits:
                print(f"      {h}")
            if not ap_dry:
                open(p, "w", encoding="utf-8").write(s)
    print(f"\n{'将修改' if ap_dry else '已修改'} {total} 个脚本")


if __name__ == "__main__":
    main()
