#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab_multi_expert.py —— 链式多段专家（双模型的自然扩展）

思路
----
双模型（2026-11-26）的机制是「顶端由专门的模型负责」，17+ 段 MAE 降了 0.10。
那自然的追问是：**段数越多越好吗？**

这里实现「链式多段」：
    p0 = 全量主模型
    p1 = p0 与 高段专家（>= A1）按预测值软混合
    p2 = p1 与 中段专家（>= A2 且 < A1）按预测值软混合
    ...

每一层只在自己那一段训练、只在那一段附近生效，层与层之间靠预测值平滑接入。
好处是**不需要重构模型**：每加一层就是一个新的 Ridge，可逐层验证收益。

为什么不做「门控 MoE」
---------------------
真正的 MoE 要让网络自己学 gating，需要联合训练、且我们只有 9,504 张样本。
先用「人定的分段 + 软混合」验证「多专家是否单调变好」这个问题本身；
如果链式到 3 段就饱和，门控也不会更优（它只是把分段也学出来）。

用法
----
  python tools/ab_multi_expert.py                    # 2 段（复现双模型）
  python tools/ab_multi_expert.py --chain 14 17      # 3 段
  python tools/ab_multi_expert.py --chain 12 14 17   # 4 段
"""
import argparse
import io
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMUNITY = os.path.join(ROOT, 'data', 'community.jsonl')

META = {'id', 'chart_id', 'charter', 'difficulty', 'chart_file', 'name', 'song',
        'level', 'fake', 'behind'}
BAND = 1.0        # 混合带宽度（以分界点为中心，上下各 0.5）


def load():
    rows, y = [], []
    with io.open(COMMUNITY, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            v = d.get('difficulty')
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if not (1.0 < v < 20.0):      # 0 与 2024 都是脏值
                continue
            rows.append(d)
            y.append(v)
    return rows, np.asarray(y, dtype=float)


def matrix(rows):
    cols = sorted({k for d in rows for k, v in d.items()
                   if isinstance(v, (int, float)) and k not in META})
    X = np.zeros((len(rows), len(cols)), dtype=float)
    for i, d in enumerate(rows):
        for j, c in enumerate(cols):
            v = d.get(c)
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = 0.0
            if not np.isfinite(v) or v < 0:
                v = 0.0
            X[i, j] = np.log1p(v)
    return X, cols


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chain', nargs='+', type=float, default=[17.0],
                    help='向上分界点（递增）。默认 [17.0] = 双模型')
    ap.add_argument('--down', type=float, default=None,
                    help='向下分界点：标签 < 该值的样本训一个低段专家。'
                         '2026-11-26 残差诊断发现 1-12 段 MAE 3.3~5.9、'
                         '占总误差 31%，而原实现只做「向上」专家，低段无人负责。')
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--boot', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=20261126)
    ap.add_argument('--min-expert', type=int, default=120,
                    help='某段训练样本少于该值则跳过该专家')
    args = ap.parse_args()

    try:
        from sklearn.linear_model import Ridge
        from sklearn.model_selection import GroupKFold
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        print('需要 sklearn', file=sys.stderr)
        return 2

    rows, y = load()
    X, cols = matrix(rows)
    groups = np.array([d.get('charter') or ('__solo_%d' % i) for i, d in enumerate(rows)])
    cuts = sorted(args.chain)
    print('样本 %d · 特征 %d 维 · 分界 %s · 混合带 ±%.2f'
          % (len(y), len(cols), cuts, BAND / 2))

    def soft(pred, new_pred, center):
        """在 center±BAND/2 内线性切换；只影响附近样本。"""
        w = np.clip((pred - (center - BAND / 2)) / BAND, 0.0, 1.0)
        return (1.0 - w) * pred + w * new_pred

    def soft_down(pred, new_pred, center):
        """向下切换：预测值低于 center 时用低段专家，向上平滑退出。"""
        w = 1.0 - np.clip((pred - (center - BAND / 2)) / BAND, 0.0, 1.0)
        return (1.0 - w) * pred + w * new_pred

    n = len(y)
    p_single = np.full(n, np.nan)
    p_chain = np.full(n, np.nan)
    used = []

    gkf = GroupKFold(n_splits=args.folds)
    for tr, te in gkf.split(X, y, groups):
        sc = StandardScaler().fit(X[tr])
        Xtr, Xte = sc.transform(X[tr]), sc.transform(X[te])
        m0 = Ridge(alpha=3.0).fit(Xtr, y[tr])
        p0 = m0.predict(Xte)
        p_single[te] = p0

        cur = p0.copy()
        # 向下专家：标签 < down 的样本单独训，预测值低时接管
        if args.down is not None:
            mask_low = y[tr] < args.down
            if mask_low.sum() >= args.min_expert:
                mk = Ridge(alpha=3.0).fit(Xtr[mask_low], y[tr][mask_low])
                cur = soft_down(cur, mk.predict(Xte), args.down)
        for c in cuts:
            lo = c if c is not cuts[-1] else c
            mask = y[tr] >= lo
            if mask.sum() < args.min_expert:
                continue
            mk = Ridge(alpha=3.0).fit(Xtr[mask], y[tr][mask])
            cur = soft(cur, mk.predict(Xte), c)
        p_chain[te] = cur

    ok = ~np.isnan(p_single)
    e1, e2 = np.abs(p_single - y), np.abs(p_chain - y)

    def show(tag, e, mask):
        m = ok & mask
        print('  %-8s n=%-5d MAE %.4f  中位 %.4f  p90 %.4f'
              % (tag, int(m.sum()), e[m].mean(), np.median(e[m]),
                 np.quantile(e[m], 0.90)))

    print('\n全区间：')
    show('单模型', e1, np.ones(n, dtype=bool))
    show('多专家', e2, np.ones(n, dtype=bool))

    print('\n17+ 子集：')
    m17 = y >= 17.0
    show('单模型', e1, m17)
    show('多专家', e2, m17)

    def boot(mask, label):
        d = (e2 - e1)[ok & mask]
        if d.size < 20:
            print('  %-8s 样本不足' % label)
            return
        rng = np.random.default_rng(args.seed)
        idx = rng.integers(0, d.size, size=(args.boot, d.size))
        b = d[idx].mean(axis=1)
        lo, hi = np.quantile(b, [0.025, 0.975])
        flag = ('显著更好' if hi < 0 else ('显著更差' if lo > 0 else '无显著差异'))
        print('  %-8s ΔMAE %+.4f  CI [%+.4f, %+.4f]  %s'
              % (label, d.mean(), lo, hi, flag))

    print('\nbootstrap（多专家 − 单模型，负=更好）：')
    boot(np.ones(n, dtype=bool), '全区间')
    boot(m17, '17+')

    print('\n分档 ΔMAE：')
    for lo_d, hi_d in [(1, 12), (12, 14), (14, 15.5), (15.5, 17), (17, 18), (18, 21)]:
        m = ok & (y >= lo_d) & (y < hi_d)
        if m.sum() >= 30:
            print('  %5.1f-%-4.1f n=%-4d %+.4f'
                  % (lo_d, hi_d, int(m.sum()), (e2 - e1)[m].mean()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
