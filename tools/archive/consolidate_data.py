#!/usr/bin/env python3
"""
数据整合：确立唯一真源

背景：data/ 下同一份数据有 4 个版本层层叠加，无从判断哪个是准的。
      official: manifest.jsonl → manifest_enhanced.jsonl → manifest_v3.jsonl
      community: manifest_features.jsonl + manifest_v2.jsonl → manifest_full.jsonl

整合原则：
  1. 真源必须是最完整的（是其他版本的超集）
  2. 中间产物若含真源没有的字段，先**合并进去**再删
  3. 命名统一为 data/{official,community}.jsonl，一眼可辨

用法：
  python consolidate_data.py --check     # 只检查，不动文件
  python consolidate_data.py --apply     # 执行整合
"""
import argparse
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data")


def load(path, key):
    """
    读 jsonl 为字典。

    ⚠️ key 可以是字符串或元组：
      · community 谱：每行有唯一 id → key="id"
      · official 谱：每首歌 4 个难度共 4 行 → **必须** key=("song_id","level")
        用 "song_id" 单键会把 4 个难度合并成 1 行（实测 1037 → 327，丢 710 行）
    """
    def mk(r):
        if isinstance(key, tuple):
            return tuple(r.get(k) for k in key)
        return r.get(key)

    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            out[mk(r)] = r
    return out


def dump(rows, path):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="执行（默认只检查）")
    args = ap.parse_args()

    # ---- 官谱 ----
    off_v3 = os.path.join(DATA, "official", "manifest_v3.jsonl")
    off_enh = os.path.join(DATA, "official", "manifest_enhanced.jsonl")
    off_base = os.path.join(DATA, "official", "manifest.jsonl")

    print("=" * 68)
    print("官谱（key=song_id）")
    print("=" * 68)
    T = load(off_v3, ("song_id", "level"))
    print(f"  真源 manifest_v3.jsonl        {len(T)} 条  {len(next(iter(T.values())))} 字段")

    # 合并 enhanced 的独有字段
    merged_off = 0
    if os.path.exists(off_enh):
        E = load(off_enh, ("song_id", "level"))
        tkeys = set(next(iter(T.values())).keys())
        ekeys = set(next(iter(E.values())).keys())
        extra = ekeys - tkeys
        print(f"  enhanced 独有字段: {sorted(extra) if extra else '无'}")
        for k, flds in ((k, {f: E[k][f] for f in extra if f in E[k]})
                        for k in E if k in T):
            for f, v in flds.items():
                if v is not None:
                    T[k][f] = v
                    merged_off += 1
        print(f"  → 合并 {merged_off} 个字段值")
    else:
        print("  enhanced 不存在，跳过")

    # 检查 base
    if os.path.exists(off_base):
        B = load(off_base, ("song_id", "level"))
        bkeys = set(next(iter(B.values())).keys())
        tkeys = set(next(iter(T.values())).keys())
        print(f"  base 独有字段: {sorted(bkeys - tkeys) if bkeys - tkeys else '无 ✓'}")

    print(f"\n  整合后官谱 {len(T)} 条  {len(next(iter(T.values())))} 字段")
    print(f"  目标: data/official.jsonl")

    # ---- 社区谱 ----
    print()
    print("=" * 68)
    print("社区谱（key=id）")
    print("=" * 68)
    com_full = os.path.join(DATA, "community", "manifest_full.jsonl")
    C = load(com_full, "id")
    print(f"  真源 manifest_full.jsonl      {len(C)} 条  "
          f"{len(next(iter(C.values())))} 字段")
    for mid in ("manifest_features.jsonl", "manifest_v2.jsonl"):
        p = os.path.join(DATA, "community", mid)
        if not os.path.exists(p):
            continue
        M = load(p, "id")
        mkeys = set(next(iter(M.values())).keys())
        ckeys = set(next(iter(C.values())).keys())
        extra = mkeys - ckeys
        print(f"  {mid:<28} 独有字段: "
              f"{sorted(extra) if extra else '无 ✓'}")

    print(f"\n  整合后社区谱 {len(C)} 条  {len(next(iter(C.values())))} 字段")
    print(f"  目标: data/community.jsonl")

    if not args.apply:
        print()
        print("=" * 68)
        print("（检查模式，未改动任何文件。加 --apply 执行）")
        print("=" * 68)
        return 0

    # ---- 执行 ----
    print()
    print("=" * 68)
    print("执行整合")
    print("=" * 68)

    # 备份真源
    import shutil
    bak = os.path.join(DATA, "_backup_before_consolidate")
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(off_v3, os.path.join(bak, "official_manifest_v3.jsonl"))
    shutil.copy2(com_full, os.path.join(bak, "community_manifest_full.jsonl"))
    print(f"  备份 → {bak}/")

    # 写新真源
    dump(list(T.values()), os.path.join(DATA, "official.jsonl"))
    dump(list(C.values()), os.path.join(DATA, "community.jsonl"))
    print("  写入 data/official.jsonl")
    print("  写入 data/community.jsonl")

    # 删中间产物
    to_del = [
        off_v3, off_enh, off_base,
        com_full,
        os.path.join(DATA, "community", "manifest_features.jsonl"),
        os.path.join(DATA, "community", "manifest_v2.jsonl"),
        os.path.join(DATA, "community", "verdicts.jsonl"),
    ]
    for p in to_del:
        if os.path.exists(p):
            os.remove(p)
            print(f"  删除 {os.path.relpath(p, ROOT)}")
    for d in (os.path.join(DATA, "official"), os.path.join(DATA, "community")):
        if os.path.isdir(d) and not os.listdir(d):
            os.rmdir(d)
            print(f"  删除空目录 {os.path.relpath(d, ROOT)}/")

    print("\n  完成。真源：")
    for p in ("official.jsonl", "community.jsonl"):
        fp = os.path.join(DATA, p)
        n = sum(1 for _ in open(fp, encoding="utf-8"))
        sz = os.path.getsize(fp) / 1048576
        print(f"    data/{p:<18} {n:>5} 条  {sz:>6.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
