#!/usr/bin/env python3
"""带特征裁剪的岭回归 —— 生产口径。

━━━ 为什么需要裁剪 ━━━
398 维里有十几列在**某个训练集上近似常量**（如 `n8|max|bbox_area` 在训练集里
全是 0，只有极少数谱非零）。标准化时 `sd + 1e-6` 会把 1e-4 量级的偏离放大到
z ≈ 4,000，单列就能把 b 推到 −20。实测切分 12345（未裁剪）短谱预测标准差 5.2、
MAE 0.744（基线 0.529）—— 排名还凑合，但绝对尺度已经不可用。

把标准化后的 z 裁到 ±8（与序列模型侧同口径），三个切分上：
  · 短谱 ρ 反而更高（0.753→0.761 / 0.739→0.749 / 0.765→0.776）
  · 12345 的 MAE 从 0.744 回到 0.479
  · 长谱不再出现 −0.014 的掉点（→ +0.018）
代价：极少数确实超出 8σ 的谱被截断（影响被有意限制在一个线性项内）。

⚠ 这改变了 `ab_handshape.py` 里 `Ridge` 的行为，所以**不复用那个类**：
历史报告的数字仍由旧类产生，两边不能混。
"""
import numpy as np

ALPHAS = [1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0]
CLIP_Z = 8.0
FOLDS = 3


def rankdata(x):
    x = np.asarray(x, dtype=np.float64)
    order = np.argsort(x, kind="mergesort")
    sx = x[order]
    obs = np.r_[True, sx[1:] != sx[:-1], True]
    idx = np.flatnonzero(obs)
    avg = (idx[:-1] + idx[1:] - 1) / 2.0 + 1.0
    out = np.empty(len(x), dtype=np.float64)
    out[order] = np.repeat(avg, np.diff(idx))
    return out


def spearman(a, b):
    ra, rb = rankdata(a), rankdata(b)
    ra, rb = ra - ra.mean(), rb - rb.mean()
    return float(ra @ rb / (np.sqrt((ra @ ra) * (rb @ rb)) + 1e-12))


class RidgeClip:
    def __init__(self, alpha=10.0, clip=CLIP_Z):
        self.alpha = alpha
        self.clip = clip

    def _z(self, X):
        return np.clip((X - self.mu) / self.sd, -self.clip, self.clip)

    def fit(self, X, y):
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-6
        Zs = self._z(X)
        A = Zs.T @ Zs + self.alpha * np.eye(X.shape[1])
        self.w = np.linalg.solve(A, Zs.T @ (y - y.mean()))
        self.b = float(y.mean())
        return self

    def predict(self, X):
        return self._z(X) @ self.w + self.b


def inner_alpha(X, y, alphas=ALPHAS, folds=FOLDS, seed=20261028):
    """训练集内部 K 折，按平均 ρ 选 α（只碰训练集）。"""
    perm = np.random.default_rng(seed + 17).permutation(len(y))
    parts = np.array_split(perm, folds)
    best, best_s = alphas[0], -np.inf
    for a in alphas:
        sc = []
        for k in range(folds):
            va = parts[k]
            tr = np.concatenate([parts[j] for j in range(folds) if j != k])
            m = RidgeClip(a).fit(X[tr], y[tr])
            sc.append(spearman(m.predict(X[va]), y[va]))
        s = float(np.mean(sc))
        if s > best_s:
            best, best_s = a, s
    return best, best_s
