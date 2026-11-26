#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab_residual.py —— 残差诊断：模型在哪类谱上错得最多？

为什么先做这个
--------------
链式 3 段已经到 0.6996（17+）。下一步「再加一个专家」之前，必须先回答：
**这个专家该按什么分？**

按难度分已经做过了（14 / 17 是数据分布的自然断点）。
按「谱面类型」分听起来更本质，但如果拍脑袋定「密集型 / 位移型 / 多线型」，
很可能切出一堆没有实际差异的组 —— 那就是在给自己制造虚假的结构。

所以先量：**沿每个特征维度，误差是否有系统性结构**。

读法
----
* 把样本按某特征分成 10 个等分位，算每档的平均 |残差|
* 若从最低档到最高档单调上升，说明**模型在这个维度上系统性欠拟合**
  —— 该维度具备「分专家」的资格
* `spread` = 最高档 MAE − 最低档 MAE，越大越值得切
* 同时给残差与特征的 Spearman 相关（单调关系，不受量纲影响）

⚠ 特征之间高度相关，一个维度「有结构」不代表**只有它**有结构。
   真正切分时要看几个高 spread 维度在不同样本上是否指向不同组。

用法
----
  python tools/ab_residual.py
  python tools/ab_residual.py --top 20
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
            X[i, j] = np.log1p(v)
    return X, cols


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--bins', type=int, default=10)
    ap.add_argument('--top', type=int, default=15)
    args = ap.parse_args()

    try:
        from sklearn.linear_model import Ridge
        from sklearn.model_selection import GroupKFold
        from sklearn.preprocessing import StandardScaler
        from scipy.stats import spearmanr
    except ImportError as e:
        print('缺依赖：%s' % e, file=sys.stderr)
        return 2

    rows, y = load()
    X, cols = matrix(rows)
    groups = np.array([d.get('charter') or ('__solo_%d' % i) for i, d in enumerate(rows)])
    print('样本 %d · 特征 %d 维' % (len(y), len(cols)))

    # 基线 OOF（与 ab_two_model / ab_multi_expert 的主模型同款）
    pred = np.full(len(y), np.nan)
    for tr, te in GroupKFold(n_splits=args.folds).split(X, y, groups):
        sc = StandardScaler().fit(X[tr])
        m = Ridge(alpha=3.0).fit(sc.transform(X[tr]), y[tr])
        pred[te] = m.predict(sc.transform(X[te]))
    ok = ~np.isnan(pred)
    res = pred - y
    abserr = np.abs(res)
    print('基线全区间 MAE %.4f · 残差均值 %+.4f' % (abserr[ok].mean(), res[ok].mean()))

    # 沿每个特征维度做分位分桶
    out = []
    for j, name in enumerate(cols):
        v = X[:, j]
        if np.allclose(v.std(), 0):
            continue
        qs = np.quantile(v[ok], np.linspace(0, 1, args.bins + 1))
        qs[0] -= 1e-9
        idx = np.clip(np.searchsorted(qs, v, side='right') - 1, 0, args.bins - 1)
        per = []
        for b in range(args.bins):
            m = ok & (idx == b)
            per.append(abserr[m].mean() if m.sum() >= 20 else np.nan)
        per = np.asarray(per)
        if np.isnan(per).any():
            continue
        spread = float(per[-1] - per[0])
        rho, _ = spearmanr(v[ok], abserr[ok])
        out.append((name, spread, float(rho), per))

    out.sort(key=lambda t: -abs(t[1]))
    print('\n按「最高档 − 最低档」MAE 差排序（前 %d）：' % args.top)
    print('  %-34s %8s %8s   最低档→最高档' % ('特征', 'spread', 'rho'))
    for name, spread, rho, per in out[:args.top]:
        print('  %-34s %+8.4f %+8.3f   %.3f → %.3f'
              % (name[:34], spread, rho, per[0], per[-1]))

    # 误差最大的那一批谱：它们有什么共性？
    thr = np.quantile(abserr[ok], 0.95)
    bad = ok & (abserr >= thr)
    print('\n误差最大的 5%%（n=%d，阈 |err|>=%.3f）vs 全体：' % (int(bad.sum()), thr))
    print('  %-34s %10s %10s %8s' % ('特征(原始值)', '差组均值', '全体均值', '倍数'))
    raw = []
    for j, name in enumerate(cols):
        a = float(np.expm1(X[bad, j]).mean())
        b = float(np.expm1(X[ok, j]).mean())
        if b > 1e-9:
            raw.append((name, a, b, a / b))
    raw.sort(key=lambda t: -abs(np.log(max(t[3], 1e-9))))
    for name, a, b, ratio in raw[:12]:
        print('  %-34s %10.3f %10.3f %7.2fx' % (name[:34], a, b, ratio))

    # 差组 vs 全体 的难度分布（确认不是「只是高难谱误差大」）
    print('\n差组的难度分布：')
    for lo_d, hi_d in [(1, 12), (12, 14), (14, 15.5), (15.5, 17), (17, 21)]:
        m = bad & (y >= lo_d) & (y < hi_d)
        tot = ok & (y >= lo_d) & (y < hi_d)
        if tot.sum():
            print('  %5.1f-%-4.1f  差组占该档 %.0f%%（%d/%d）'
                  % (lo_d, hi_d, 100.0 * m.sum() / tot.sum(), int(m.sum()), int(tot.sum())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
