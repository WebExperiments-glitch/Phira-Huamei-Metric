#!/usr/bin/env python3
"""
公式实验：纯公式（多维度，不用官谱参照）能达到什么精度？

背景
----
用户提案：做一个多维度公式，App 只需公式不需要官谱参照（零内嵌）。
历史数据（docs/结果/社区谱应用-失败报告.md）：v1 线性回归在官谱训练分布内
|残差| 中位 0.806 / p95 2.680，社区谱分布外放大 1.8 倍，且线性外推曾发散。
现行 k-NN（对照基准）：中位 0.500 / p90 1.500，≤1.0 占 80.8%。

本实验：同一协议（官谱 1,037 条留一法）下，公式能做到多少。
- 模型：岭回归（纯 Python 正规方程 + hat-matrix LOO 捷径，一次求解得全部留一残差）
- 特征：官谱真源里全部数值维度（约 60 维），z-score 标准化
- 扫描：全部维度 / 递减维度 / 不同正则强度

用法：python tools/exp_formula.py
"""
import json
import math
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data", "official.jsonl")

# 非特征列（标识/元信息/目标）
SKIP = {"song_id", "level", "difficulty", "name", "composer", "charter",
        "bpm_items"}


def load():
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
    keys = [k for k, v in rows[0].items()
            if k not in SKIP and isinstance(v, (int, float))]
    X, y, names = [], [], []
    for r in rows:
        X.append([float(r[k]) for k in keys])
        y.append(float(r["difficulty"]))
    # 去掉零方差列
    p = len(keys)
    keep = []
    for j in range(p):
        col = [x[j] for x in X]
        m = sum(col) / len(col)
        if max(col) - min(col) > 1e-12:
            keep.append(j)
    keys = [keys[j] for j in keep]
    X = [[x[j] for j in keep] for x in X]
    # z-score
    p = len(keys)
    mu, sd = [], []
    for j in range(p):
        col = [x[j] for x in X]
        m = sum(col) / len(col)
        v = (sum((t - m) ** 2 for t in col) / len(col)) ** 0.5 or 1.0
        mu.append(m); sd.append(v)
    X = [[(x[j] - mu[j]) / sd[j] for j in range(p)] for x in X]
    return X, y, keys


def solve(A, b):
    """Gauss-Jordan 求解 A w = b（A 被复制）"""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[piv][c]) < 1e-12:
            raise ValueError("singular")
        M[c], M[piv] = M[piv], M[c]
        d = M[c][c]
        M[c] = [v / d for v in M[c]]
        for r in range(n):
            if r != c and M[r][c]:
                f = M[r][c]
                M[r] = [v - f * w for v, w in zip(M[r], M[c])]
    return [M[i][n] for i in range(n)]


def ridge_loo(X, y, alpha):
    """岭回归 + hat-matrix LOO。返回每个样本的留一预测误差（绝对值）。"""
    n, p = len(X), len(X[0])
    yc = [t - sum(y) / n for t in y]
    # A = X^T X + αI
    A = [[0.0] * p for _ in range(p)]
    for i in range(n):
        xi = X[i]
        for j in range(p):
            aij = xi[j]
            if aij == 0.0:
                continue
            row = A[j]
            for k in range(p):
                row[k] += aij * xi[k]
    for j in range(p):
        A[j][j] += alpha
    # X^T yc
    xty = [0.0] * p
    for i in range(n):
        yi = yc[i]
        if yi == 0.0:
            continue
        xi = X[i]
        for j in range(p):
            xty[j] += xi[j] * yi
    w = solve([row[:] for row in A], xty)
    # 预测与 hat 对角
    errs = []
    for i in range(n):
        xi = X[i]
        pred = sum(a * b for a, b in zip(xi, w))
        # h_ii = x_i^T Ainv x_i：用 w 无关的方式需 Ainv；这里借一次回代
        h = 0.0
        v = solve([row[:] for row in A], xi)   # Ainv x_i
        h = sum(a * b for a, b in zip(xi, v))
        e = yc[i] - pred
        errs.append(abs(e / max(1e-9, 1 - h)))
    return errs


def q(errs, t):
    e = sorted(errs)
    return e[min(int(len(e) * t), len(e) - 1)]


def report(label, errs):
    n = len(errs)
    le1 = sum(1 for e in errs if e <= 1.0) / n * 100
    print(f"  {label:<34} 中位 {q(errs,.5):.3f}  p75 {q(errs,.75):.3f}  "
          f"p90 {q(errs,.90):.3f}  p95 {q(errs,.95):.3f}  |  ≤1.0 {le1:.1f}%")
    return {"label": label, "med": q(errs, .5), "p90": q(errs, .90),
            "le1": le1, "errs": errs}


def main():
    X, y, keys = load()
    print(f"[load] 官谱 {len(X)} 条，数值维度 {len(keys)} 个\n")
    print("=" * 100)
    print("① 公式（岭回归，全部维度）—— 正则强度扫描")
    print("=" * 100)
    res = []
    for a in (0.1, 1.0, 10.0, 100.0, 1000.0):
        res.append(report(f"全部{len(keys)}维 ridge α={a:g}",
                          ridge_loo(X, y, a)))
    print()
    print("=" * 100)
    print("② 公式（压缩维度）—— 用多少维合适")
    print("=" * 100)
    # 按与目标的相关性排序取前 k 维
    n = len(X)
    my = sum(y) / n
    sy = (sum((t - my) ** 2 for t in y) / n) ** 0.5
    corr = []
    for j in range(len(keys)):
        col = [x[j] for x in X]
        mc = sum(col) / n
        sc = (sum((t - mc) ** 2 for t in col) / n) ** 0.5 or 1.0
        cov = sum((x[j] - mc) * (t - my) for x, t in zip(X, y)) / n
        corr.append((abs(cov / (sc * sy)), j))
    corr.sort(reverse=True)
    for k in (4, 8, 16, 32):
        cols = [j for _, j in corr[:k]]
        Xk = [[x[j] for j in cols] for x in X]
        res.append(report(f"top{k}维 ridge α=10",
                          ridge_loo(Xk, y, 10.0)))
    print()
    print("=" * 100)
    print("③ 对照：现行 k-NN（官谱留一，同一协议）")
    print("=" * 100)
    print("  k-NN k=20 四特征 z-score          中位 0.500  p75 1.000  "
          "p90 1.500  |  ≤1.0 80.8%   （现行交付引擎）")
    print("  查表 v2（历史）                   中位 0.600  p90 1.500  "
          "|  ≤1.0 74.5%")
    print("  v1 线性回归（历史，分布内）        中位 0.806  p90 2.204  p95 2.680")
    print()
    best = min(res, key=lambda r: r["med"])
    knn = 0.500
    print("=" * 100)
    print(f"公式最优：{best['label']}  中位 {best['med']:.3f}"
          f"（k-NN 0.500 的 {best['med']/knn:.2f} 倍）")
    print("=" * 100)
    # 公式系数导出（最优配置）——供 App 端零内嵌使用
    if best["label"].startswith("全部"):
        a = float(best["label"].split("α=")[1])
        w = None
        # 重解一次拿系数（展示前 8 个绝对权重）
        n = len(X)
        yc = [t - sum(y) / n for t in y]
        A = [[0.0] * len(keys) for _ in range(len(keys))]
        for i in range(n):
            xi = X[i]
            for j in range(len(keys)):
                aij = xi[j]
                if aij == 0.0:
                    continue
                for k2 in range(len(keys)):
                    A[j][k2] += aij * xi[k2]
        for j in range(len(keys)):
            A[j][j] += a
        xty = [0.0] * len(keys)
        for i in range(n):
            for j in range(len(keys)):
                xty[j] += X[i][j] * yc[i]
        w = solve(A, xty)
        pairs = sorted(zip(keys, w), key=lambda t: -abs(t[1]))[:8]
        print("\n  权重最大的 8 个维度（导出 App 只需这些系数）:")
        for k2, v in pairs:
            print(f"    {k2:<32} {v:+.4f}")


if __name__ == "__main__":
    sys.exit(main())
