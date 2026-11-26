#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab_two_model.py —— 双模型混合 vs 单模型（结构级 A/B）

为什么做这个
------------
拆 `pde-src`（phigros_difficulty_estimator_re）时发现它真正的优势不是模型，
而是**把任务切窄**：用 1,037 张官谱训主模型稳住中低段，再用 222 张 17+ 高手表
训一个专精模型，两者在 17.1–17.9 之间线性混合。

它报的 17+ MAE 0.39 来自「专精模型考专精题」（47 张留出全在 17+），
不能直接和我们的全区间指标比。但**这个结构本身值得独立验证**。

我们的条件其实更好：17+ 有 916 张，是它高手表（269）的 3.4 倍。

对照组
------
基线 = 单模型（全区间一个 Ridge）
实验 = 双模型（主模型 + 17+ 专精模型 + 平滑混合带）

关键设计
--------
* 混合权重按**预测值**算，不按标签 —— 推理时没有标签，按标签算等于作弊
* 专精模型的训练集在每一折内部取，防泄漏
* 预设一个混合带（16.5–17.5），**不做带宽搜索** ——
  在同一批 OOF 上搜参数再报结果，等于拿验证集调参
* 判据：全区间与 17+ 子集分别做配对 bootstrap 10,000 次

用法
----
  python tools/ab_two_model.py
  python tools/ab_two_model.py --band 16.5 17.5
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
            # 标签清洗：0 与 2024 都是脏值（后者是年份被当成定数）
            if not (1.0 < v < 20.0):
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
            X[i, j] = np.log1p(v)          # 与 engine.js ridgeBeta 一致
    return X, cols


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--boot', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=20261126)
    ap.add_argument('--band', nargs=2, type=float, default=[16.5, 17.5])
    ap.add_argument('--top-floor', type=float, default=17.0,
                    help='专精模型只取标签 >= 该值的样本')
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
    print('样本 %d · 特征 %d 维 · 谱师 %d 个' % (len(y), len(cols), len(set(groups))))
    print('17+ 样本 %d 张' % int((y >= args.top_floor).sum()))

    LOW, HIGH = args.band

    def fit_pred(tr, te):
        sc = StandardScaler().fit(X[tr])
        m_main = Ridge(alpha=3.0).fit(sc.transform(X[tr]), y[tr])
        p_main = m_main.predict(sc.transform(X[te]))

        mask = y[tr] >= args.top_floor
        if mask.sum() < 40:                 # 折内样本不足就不启用专精模型
            return p_main, p_main
        m_top = Ridge(alpha=3.0).fit(sc.transform(X[tr][mask]), y[tr][mask])
        p_top = m_top.predict(sc.transform(X[te]))
        return p_main, p_top

    n = len(y)
    p_single = np.full(n, np.nan)
    p_blend = np.full(n, np.nan)
    gkf = GroupKFold(n_splits=args.folds)
    for tr, te in gkf.split(X, y, groups):
        pm, pt = fit_pred(tr, te)
        p_single[te] = pm
        w = np.clip((pm - LOW) / max(HIGH - LOW, 1e-9), 0.0, 1.0)
        p_blend[te] = (1.0 - w) * pm + w * pt

    ok = ~np.isnan(p_single)
    e1 = np.abs(p_single - y)
    e2 = np.abs(p_blend - y)

    def show(tag, e, mask=None):
        m = ok if mask is None else (ok & mask)
        print('  %-10s n=%-5d MAE %.4f  中位 %.4f  p90 %.4f'
              % (tag, int(m.sum()), e[m].mean(), np.median(e[m]),
                 np.quantile(e[m], 0.90)))

    print('\n全区间：')
    show('单模型', e1)
    show('双模型', e2)

    print('\n17+ 子集（重点）：')
    m17 = y >= args.top_floor
    show('单模型', e1, m17)
    show('双模型', e2, m17)

    def boot(mask, label):
        d = (e2 - e1)[ok & mask]
        if d.size < 20:
            print('  %s 样本不足（%d），不做检验' % (label, d.size))
            return
        rng = np.random.default_rng(args.seed)
        idx = rng.integers(0, d.size, size=(args.boot, d.size))
        b = d[idx].mean(axis=1)
        lo, hi = np.quantile(b, [0.025, 0.975])
        print('  %s ΔMAE %+.4f  95%%CI [%+.4f, %+.4f]  更好的占比 %.1f%%'
              % (label, d.mean(), lo, hi, 100.0 * float((b < 0).mean())))
        if hi < 0:
            print('    → 双模型**显著更好**')
        elif lo > 0:
            print('    → 双模型**显著更差**')
        else:
            print('    → **无显著差异**（CI 跨 0）')

    print('\n配对 bootstrap（双模型 − 单模型，负=双模型更好）：')
    boot(np.ones(n, dtype=bool), '全区间')
    boot(m17, '17+   ')

    print('\n分档 ΔMAE（负=双模型更好）：')
    for lo_d, hi_d in [(1, 12), (12, 14), (14, 15.5), (15.5, 17), (17, 18), (18, 21)]:
        m = ok & (y >= lo_d) & (y < hi_d)
        if m.sum() >= 30:
            print('  %5.1f-%-4.1f n=%-4d %+.4f' % (lo_d, hi_d, int(m.sum()),
                                                  (e2 - e1)[m].mean()))
        elif m.sum():
            print('  %5.1f-%-4.1f n=%-4d （样本不足 30）' % (lo_d, hi_d, int(m.sum())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
