#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab_press_sample.py —— 为「press 口径节奏特征」A/B 抽样本并解包

背景
----
`engine.js` 的节奏特征（iv_mean / chord_ratio / fast_ratio）用的是**全部音符**
时间轴，而密度类特征用的是 Tap+Hold（press）口径。
`pde-src/rating/features.py` 明确要求密度/多押/手部/位移/节奏都建立在同一条
press 时间线上 —— 所以现有实现有一处口径不一致。

工程上不能直接改（AGENTS.md 硬约束 3：特征语义冻结）。
2026-11-24 已在 engine.js 里**追加** press_iv_mean / press_iv_median /
press_chord_ratio / press_fast_ratio 四个字段，现役权重按名字取特征，不受影响。

本脚本负责把 A/B 需要的谱面从 data/charts-archive.tar.gz 里取出来。

标签清洗（必须做）
------------------
community.jsonl 里 difficulty 的范围是 0.0 ~ **2024.0** —— 后者明显是年份
被当成了定数。只保留 (1, 20) 的谱，否则回归会被单个离群点带飞。

抽样策略
--------
按 charter 分层：谱师有 6937 个、多数只有 1 张谱，纯随机抽会漏掉长尾。
做法是先按 charter 分组，组内最多取 3 张，再在候选里随机补齐到目标张数。

用法
----
  python tools/ab_press_sample.py                 # 1500 张，seed 固定
  python tools/ab_press_sample.py --n 800
  python tools/ab_press_sample.py --out tmp/pde-sample
"""
import argparse
import io
import json
import os
import random
import sys
import tarfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMUNITY = os.path.join(ROOT, 'data', 'community.jsonl')
ARCHIVE = os.path.join(ROOT, 'data', 'charts-archive.tar.gz')


def load_labels():
    """chart_id -> {difficulty, charter}；只保留定数在 (1, 20) 的。"""
    out = {}
    dropped = 0
    with io.open(COMMUNITY, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            cid = d.get('id') or d.get('chart_id')
            diff = d.get('difficulty')
            if cid is None or diff is None:
                continue
            try:
                diff = float(diff)
            except (TypeError, ValueError):
                continue
            if not (1.0 < diff < 20.0):
                dropped += 1
                continue
            out[str(cid)] = {'difficulty': diff, 'charter': d.get('charter') or ''}
    return out, dropped


def stratified_pick(labels, n, seed):
    """按 charter 分层，组内最多 3 张，再随机补齐。"""
    rnd = random.Random(seed)
    by_charter = defaultdict(list)
    for cid, meta in labels.items():
        by_charter[meta['charter']].append(cid)

    picked = []
    for _ch, ids in by_charter.items():
        rnd.shuffle(ids)
        picked.extend(ids[:3])
    if len(picked) < n:
        rest = [c for c in labels if c not in set(picked)]
        rnd.shuffle(rest)
        picked.extend(rest[:n - len(picked)])
    picked = list(dict.fromkeys(picked))
    rnd.shuffle(picked)
    return picked[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=1500)
    ap.add_argument('--seed', type=int, default=20261124)
    ap.add_argument('--out', default=os.path.join(ROOT, 'tmp', 'pde-sample'))
    args = ap.parse_args()

    labels, dropped = load_labels()
    print('可用谱面 %d（剔除定数越界 %d 条）' % (len(labels), dropped))

    want = set(stratified_pick(labels, args.n, args.seed))
    print('目标样本 %d 张' % len(want))

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    got = 0
    kept = {}
    tar = tarfile.open(ARCHIVE)
    for member in tar:
        if not member.name.endswith('/chart.json'):
            continue
        cid = os.path.basename(os.path.dirname(member.name))
        if cid not in want:
            continue
        try:
            data = tar.extractfile(member).read()
        except Exception as e:                       # noqa: BLE001
            print('  跳过 %s：%s' % (cid, e), file=sys.stderr)
            continue
        d = os.path.join(out_dir, cid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'chart.json'), 'wb') as f:
            f.write(data)
        kept[cid] = labels[cid]
        got += 1
        if got % 200 == 0:
            print('  已解出 %d …' % got)

    meta_path = os.path.join(out_dir, 'labels.json')
    with io.open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(kept, f, ensure_ascii=False)
    print('完成：%d 张 → %s' % (got, out_dir))
    print('标签写入 %s' % meta_path)


if __name__ == '__main__':
    main()
