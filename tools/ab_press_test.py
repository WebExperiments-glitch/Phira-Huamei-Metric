#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ab_press_test.py —— A/B：press 口径节奏特征是否带来增益

对照组
------
基线 = 现有全部特征（不含 press_* 四个新字段）
实验 = 基线 + press_iv_mean / press_iv_median / press_chord_ratio / press_fast_ratio

方法（与项目既有纪律一致）
--------------------------
* 模型：StandardScaler + Ridge(alpha=3)，与线上 fit_v2 同款形式
* 预处理：与 engine.js 的 ridgeBeta 一致 —— 先 log1p(clip(v,0))，再标准化
* 切分：**按 charter 分组** 5 折（防谱师泄漏），不是随机 KFold
* 结论：配对 bootstrap 10,000 次，看 ΔMAE 的 95% CI 是否跨 0
  ⚠ 按 AGENTS.md 硬约束 4，CI 跨 0 只能写「无显著差异」，不许写「有提升趋势」

用法
----
  python tools/ab_press_test.py
  python tools/ab_press_test.py --folds 5 --boot 10000
"""
import argparse
import io
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEATS = os.path.join(ROOT, 'tmp', 'pde-sample', 'features.jsonl')
PRESS = ['press_iv_mean', 'press_iv_median', 'press_chord_ratio', 'press_fast_ratio']


def load():
    rows = []
    with io.open(FEATS, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def matrix(rows, cols):
    """与 engine.js 一致：log1p(clip(v,0))。非数值按 0。"""
    X = np.zeros((len(rows), len(cols)), dtype=float)
    for i, r in enumerate(rows):
        f = r['feats']
        for j, c in enumerate(cols):
            v = f.get(c)
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = 0.0
            if not np.isfinite(v) or v < 0:
                v = 0.0
            X[i, j] = np.log1p(v)
    return X


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--boot', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=20261124)
    args = ap.parse_args()

    try:
        from sklearn.linear_model import Ridge
        from sklearn.model_selection import GroupKFold
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        print('需要 sklearn：用 binaries/python/envs/default/Scripts/python.exe 跑', file=sys.stderr)
        return 2

    rows = load()
    print('样本 %d 张' % len(rows))

    all_cols = sorted({k for r in rows for k in r['feats']})
    base_cols = [c for c in all_cols if c not in PRESS]
    exp_cols = base_cols + [c for c in PRESS if c in all_cols]
    missing = [c for c in PRESS if c not in all_cols]
    if missing:
        print('⚠ 特征里缺 %s —— A/B 无法进行' % missing, file=sys.stderr)
        return 1
    print('基线 %d 维 → 实验 %d 维' % (len(base_cols), len(exp_cols)))

    y = np.array([r['difficulty'] for r in rows], dtype=float)
    groups = np.array([r['charter'] or ('__solo_%d' % i) for i, r in enumerate(rows)])

    Xb = matrix(rows, base_cols)
    Xe = matrix(rows, exp_cols)

    def oof(X):
        pred = np.full(len(y), np.nan)
        gkf = GroupKFold(n_splits=args.folds)
        for tr, te in gkf.split(X, y, groups):
            sc = StandardScaler().fit(X[tr])
            mdl = Ridge(alpha=3.0).fit(sc.transform(X[tr]), y[tr])
            pred[te] = mdl.predict(sc.transform(X[te]))
        return pred

    pb, pe = oof(Xb), oof(Xe)
    eb, ee = np.abs(pb - y), np.abs(pe - y)

    def report(tag, e):
        print('  %-8s MAE %.4f  中位 %.4f  p90 %.4f  偏差 %+.4f'
              % (tag, e.mean(), np.median(e), np.quantile(e, 0.90), float(np.mean(
                  (pb if tag == '基线' else pe) - y))))

    print('\n按谱师分组 %d 折：' % args.folds)
    report('基线', eb)
    report('实验', ee)

    delta = ee - eb                       # 负 = 实验更好
    obs = delta.mean()
    rng = np.random.default_rng(args.seed)
    idx = rng.integers(0, len(delta), size=(args.boot, len(delta)))
    boot = delta[idx].mean(axis=1)
    lo, hi = np.quantile(boot, [0.025, 0.975])

    print('\nΔMAE（实验 − 基线，负=更好）')
    print('  点估计 %+.4f   95%%CI [%+.4f, %+.4f]' % (obs, lo, hi))
    print('  实验更好的重采样占比 %.1f%%' % (100.0 * float((boot < 0).mean())))
    if lo > 0:
        print('  → 实验**显著更差**')
    elif hi < 0:
        print('  → 实验**显著更好**')
    else:
        print('  → **无显著差异**（CI 跨 0，按规矩不许写"有提升趋势"）')

    # 分档看，防止总体均值掩盖区间内的反向变化
    print('\n分档 ΔMAE（负=更好）：')
    for lo_d, hi_d in [(1, 12), (12, 14), (14, 15.5), (15.5, 17), (17, 21)]:
        m = (y >= lo_d) & (y < hi_d)
        if m.sum() >= 30:
            print('  %5.1f-%-4.1f n=%-4d %+.4f' % (lo_d, hi_d, int(m.sum()), delta[m].mean()))
        elif m.sum():
            print('  %5.1f-%-4.1f n=%-4d （样本不足 30，不报）' % (lo_d, hi_d, int(m.sum())))

    return 0


if __name__ == '__main__':
    sys.exit(main())
