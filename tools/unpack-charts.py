#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 data/charts-archive.tar.gz 里取回单个谱面的原始文件。

【为什么会有这个脚本】
  2026-11-14：D 盘只剩 43 GB，而 data/charts 下 11,770 个原始谱面占了 36.61 GB。
  这些是纯文本的结构（判定线 + 音符），压缩率 0.12%（100 张 291 MB → 0.4 MB），
  整个目录压完约 44 MB。于是全部归档，原目录删除。

【代价，说清楚】
  归档后【不能】再对全部谱面做遍历式分析（如「重算所有谱面的 20 维特征」）——
  那种任务要先把 36 GB 解压回来。日常的单张查询、抽查、补算几张，用这个脚本取回即可。

【用法】
  python tools/unpack-charts.py --list                列出归档里前 20 个谱面 id
  python tools/unpack-charts.py --cid 14597           取回单张 → data/charts/14597/
  python tools/unpack-charts.py --cid 14597 --dry     只看会不会命中，不写盘
  python tools/unpack-charts.py --all                 全解压（慢，36 GB）

【为什么单张要扫整个归档】
  .tar.gz 是流式压缩，没法跳到中间某个成员，只能从头读到尾再匹配。
  44 MB 的归档扫一遍是秒级，可以接受。
"""
import argparse
import os
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.path.join(ROOT, "data", "charts-archive.tar.gz")
DEST = os.path.join(ROOT, "data", "charts")


def _cid_of(name):
    """从归档成员名里取谱面 id。
    归档是 `tar -C data/charts .` 生成的，成员名形如 `./1000/chart.json`，
    直接 split('/')[0] 会得到 "." —— 必须先把前导 ./ 去掉。"""
    parts = [x for x in name.split("/") if x not in ("", ".")]
    return parts[0] if parts else ""


def open_archive():
    if not os.path.exists(ARCHIVE):
        sys.exit("归档不存在：%s\n（如果你是第一次用，可能它已经被删了）" % ARCHIVE)
    return tarfile.open(ARCHIVE, "r:gz")


def do_list(limit=20):
    with open_archive() as tf:
        shown = set()
        total = 0
        for m in tf:
            if not m.isfile():
                continue
            total += 1
            cid = _cid_of(m.name)
            if cid not in shown and len(shown) < limit:
                shown.add(cid)
                print("  " + cid)
        print("  归档内文件数：%d" % total)


def do_extract(cid, dry=False):
    cid = str(cid).strip()
    if not cid:
        sys.exit("--cid 不能为空")
    hit = []
    with open_archive() as tf:
        for m in tf:
            if not m.isfile():
                continue
            if _cid_of(m.name) != cid:
                continue
            hit.append(m)
            if dry:
                continue
            target = os.path.join(DEST, m.name.lstrip("./"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tf.extractfile(m) as src, open(target, "wb") as out:
                out.write(src.read())
            print("  ✓ %s（%.1f MB）" % (m.name.lstrip("./"), m.size / 1024 ** 2))
    if not hit:
        print("  ✗ 归档里没有 %s" % cid)
        return 1
    if dry:
        print("  会命中 %d 个文件：%s" % (len(hit), ", ".join(x.name.lstrip("./") for x in hit)))
    else:
        print("  已放到 %s" % os.path.join(DEST, cid))
    return 0


def do_all():
    os.makedirs(DEST, exist_ok=True)
    n = 0
    with open_archive() as tf:
        for m in tf:
            if not m.isfile():
                continue
            target = os.path.join(DEST, m.name.lstrip("./"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tf.extractfile(m) as src, open(target, "wb") as out:
                out.write(src.read())
            n += 1
            if n % 2000 == 0:
                print("  ... %d 个" % n)
    print("  全解压完成：%d 个文件 → %s" % (n, DEST))


def main():
    ap = argparse.ArgumentParser(description="从归档里取回谱面原始文件")
    ap.add_argument("--list", action="store_true", help="列出归档里的谱面 id")
    ap.add_argument("--cid", help="要取回的谱面 id")
    ap.add_argument("--all", action="store_true", help="全量解压（慢）")
    ap.add_argument("--dry", action="store_true", help="只检查，不写盘")
    a = ap.parse_args()

    if a.list:
        return do_list()
    if a.all:
        return do_all()
    if a.cid:
        return do_extract(a.cid, a.dry)
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
