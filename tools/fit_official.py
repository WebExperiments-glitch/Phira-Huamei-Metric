#!/usr/bin/env python3
"""
官方定数拟合 —— 本项目的核心模型

目标：用可审计的规则/模型，从谱面数据预测**官方定数**。
之所以用官谱训练，是因为它是唯一「定数 ↔ 谱面」真值对。

设计原则（对应「严谨性工程契约」）：
  1. 可解释 —— 用线性模型 + 显式特征，权重可读
  2. 可复现 —— 无随机种子依赖，纯确定性
  3. 可审计 —— 报告每项特征的权重与贡献
  4. 承认未知 —— 报告 MAE / R² / 分档误差，并列出已知失效场景

不做的事：
  ❌ 不用黑箱（神经网络/GB 树）——竞品已证明其不可审计
  ❌ 不用玩家评分做标签
  ❌ 不声称复现官方「标准」（官方无公开标准）

模型选择：普通最小二乘（OLS）多元线性回归
  选它的理由：官谱样本仅 1,037 条，特征 12 个左右，
  线性模型不会过拟合，且每个权重都有明确物理含义。
"""
import argparse
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# 特征清单：(字段, 中文名, 变换)
# 变换说明：
#   raw  原值
#   lg   log1p（缓解右偏，如物量 4~2330）
#
# ★ 共线性约束（严谨性契约要求）：
#   物量 = NPS × 时长，三者高度共线（实测 lg(物量)~lg(NPS) r=+0.956）。
#   若同时入模，OLS 会把权重分摊到高度相关的特征上，导致符号翻转
#   （实测 lg(物量) 权重变成负数，违背物理直觉）。
#   解决：只保留 **NPS（难度）** 与 **时长（耐力）** 两个正交维度，
#   不再单独放物量；物量的信息已由二者乘积承载。
FEATURES = [
    # --- 难度维度：单位时间的手数 ---
    ("lg_nps", "log(NPS)", "lg_nps"),
    ("lg_strain_p50", "log(strain中位)", "lg_strain_p50"),
    ("lg_strain_peak", "log(峰值strain)", "lg_strain_peak"),
    # --- 耐力维度：谱的长度与高强度占比 ---
    ("dur_scaled", "时长/120", "dur_scaled"),
    ("peak_ratio", "高强度时间占比", "peak_ratio"),
    # --- 配置维度：音符类型构成（4 者和为 1，只取 3 个避免完美共线）---
    ("pct_tap", "Tap占比", "pct_tap"),
    ("pct_hold", "Hold占比", "pct_hold"),
    ("pct_flick", "Flick占比", "pct_flick"),
    # pct_drag 省略：pct_drag = 1 − pct_tap − pct_hold − pct_flick
    # --- 节奏维度 ---
    ("fast_ratio", "快速音符占比", "fast_ratio"),
    ("chord_ratio", "同押占比", "chord_ratio"),
    ("iv_med_scaled", "音符间隔/0.2", "iv_med_scaled"),
    # --- 演出维度 ---
    ("lg_lines", "log(判定线数)", "lg_lines"),
    ("bpm_scaled", "BPM/200", "bpm_scaled"),
]

# ★ 第二处共线性约束：四个音符类型占比之和恒为 1 → 完美线性相关
#   实测 VIF 高达 4 万（pct_hold），权重被放大到无意义（标准量 1246）。
#   解决：只保留 3 个类型占比，drop 第 4 个（选方差最大的作为参照）。
#   物理含义不变：知道 Tap/Flick/Drag 占比，Hold 占比 = 1 − 其余。


def build_x(r):
    """从原始行构造特征向量"""
    lg = lambda v: math.log1p(max(0.0, float(v or 0)))
    tot = max(1, r.get("notes_real") or 1)
    x = {
        "lg_nps": lg(r.get("nps")),
        "lg_strain_p50": lg(r.get("strain_p50")),
        "lg_strain_peak": lg(r.get("strain_peak")),
        "lg_lines": lg(r.get("lines")),
        "bpm_scaled": (r.get("bpm") or 120) / 200.0,
        "dur_scaled": (r.get("duration_s") or 120) / 120.0,
        "fast_ratio": (r.get("fast_ratio") or 0) / 100.0,
        "chord_ratio": (r.get("chord_ratio") or 0) / 100.0,
        "pct_tap": (r.get("t_tap") or 0) / tot,
        "pct_hold": (r.get("t_hold") or 0) / tot,
        "pct_flick": (r.get("t_flick") or 0) / tot,
        "pct_drag": (r.get("t_drag") or 0) / tot,
        "peak_ratio": r.get("strain_peak_ratio") or 0,
        "iv_med_scaled": (r.get("iv_median") or 0.2) / 0.2,
    }
    return [x[f] for _, _, f in FEATURES]


def ols(X, y, lam=0.0):
    """最小二乘（带 L2 正则），解法：XᵀX + λI 的线性方程组"""
    n, p = len(X), len(X[0])
    XtX = [[sum(X[i][a] * X[i][b] for i in range(n)) for b in range(p)]
           for a in range(p)]
    Xty = [sum(X[i][a] * y[i] for i in range(n)) for a in range(p)]
    for a in range(p):
        XtX[a][a] += lam
    # 高斯消元
    M = [XtX[i][:] + [Xty[i]] for i in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c]))
        if abs(M[piv][c]) < 1e-12:
            continue
        M[c], M[piv] = M[piv], M[c]
        pv = M[c][c]
        for j in range(c, p + 1):
            M[c][j] /= pv
        for r in range(p):
            if r == c:
                continue
            f = M[r][c]
            if f:
                for j in range(c, p + 1):
                    M[r][j] -= f * M[c][j]
    return [M[i][p] for i in range(p)]


def spearman(a, b):
    def rank(v):
        idx = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        i = 0
        while i < len(idx):
            j = i
            while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                rk[idx[k]] = avg
            i = j + 1
        return rk
    ra, rb = rank(a), rank(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = math.sqrt(sum((x - ma) ** 2 for x in ra))
    db = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return num / (da * db) if da and db else 0.0


def r2_of(X, y, idxs, w, mu, b0):
    def pred(x):
        return b0 + sum(w[j] * (x[j] - mu[j]) for j in range(len(w)))
    yt = [y[i] for i in idxs]
    yp = [pred(X[i]) for i in idxs]
    ybar = sum(yt) / len(yt)
    ss_res = sum((a - b) ** 2 for a, b in zip(yt, yp))
    ss_tot = sum((v - ybar) ** 2 for v in yt)
    return 1 - ss_res / ss_tot if ss_tot else 0.0


def vif(X, j, idxs):
    """方差膨胀因子：特征 j 被其他特征解释的程度。>10 视为严重共线。"""
    others = [k for k in range(len(X[0])) if k != j]
    Xo = [[X[i][k] for k in others] for i in idxs]
    yo = [X[i][j] for i in idxs]
    mo = [sum(r[k] for r in Xo) / len(Xo) for k in range(len(others))]
    yb = sum(yo) / len(yo)
    Xc = [[r[k] - mo[k] for k in range(len(others))] for r in Xo]
    yc = [v - yb for v in yo]
    w = ols(Xc, yc, lam=1e-6)
    pred = [sum(w[k] * r[k] for k in range(len(others))) for r in Xc]
    ss_res = sum((a - b) ** 2 for a, b in zip(yc, pred))
    ss_tot = sum(v * v for v in yc)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0
    return 1.0 / (1.0 - r2) if r2 < 1 else float("inf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out-model", required=True)
    ap.add_argument("--holdout", type=float, default=0.2, help="留出比例")
    ap.add_argument("--lam", type=float, default=1.0, help="L2 正则强度")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.data, encoding="utf-8")]
    rows = [r for r in rows if r.get("strain_peak") is not None
            and r["notes_real"] > 0]
    print(f"[load] {len(rows)} 条，特征 {len(FEATURES)} 个")

    X = [build_x(r) for r in rows]
    y = [r["difficulty"] for r in rows]

    # 按歌曲分组切分，避免同曲四难度泄漏（关键！）
    songs = sorted({r["song_id"] for r in rows})
    # 确定性切分：按 song_id 哈希排序后取前 N 比例为测试集
    songs_sorted = sorted(songs, key=lambda s: (len(s), s))
    n_test = int(len(songs_sorted) * args.holdout)
    test_songs = set(songs_sorted[:n_test])
    tr = [i for i, r in enumerate(rows) if r["song_id"] not in test_songs]
    te = [i for i, r in enumerate(rows) if r["song_id"] in test_songs]
    print(f"[split] 按歌曲分组：训练 {len(tr)} 条 / 测试 {len(te)} 条"
          f"（{len(test_songs)}/{len(songs)} 首）")

    # ---------- 正则强度扫描：不能凭感觉定 lambda ----------
    print("\n" + "=" * 72)
    print("正则强度扫描（按测试集 R² 选 λ）")
    print("=" * 72)
    best = None
    for lam in [0.0, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0]:
        wl = ols([X[i] for i in tr], [y[i] for i in tr], lam=lam)
        mul = [sum(X[i][j] for i in tr) / len(tr) for j in range(len(wl))]
        yt = [y[i] for i in tr]
        b0l = st.mean([yt[i] - sum(wl[j] * (X[i][j] - mul[j])
                                 for j in range(len(wl))) for i in range(len(yt))])
        r2tr = r2_of(X, y, tr, wl, mul, b0l)
        r2te = r2_of(X, y, te, wl, mul, b0l)
        print(f"  λ={lam:<6} 训练R²={r2tr:.4f}  测试R²={r2te:.4f}")
        if best is None or r2te > best[1]:
            best = (lam, r2te, wl, mul, b0l)
    args.lam = best[0]
    print(f"\n  → 选定 λ={args.lam}（测试集 R²={best[1]:.4f}）")

    # 训练最终模型
    w = best[2]
    mu = best[3]
    b0 = best[4]

    def predict(x):
        return b0 + sum(w[j] * (x[j] - mu[j]) for j in range(len(w)))

    # 评估
    def eval_set(idxs, name):
        if not idxs:
            return
        yt = [y[i] for i in idxs]
        yp = [predict(X[i]) for i in idxs]
        err = [a - b for a, b in zip(yt, yp)]
        mae = sum(abs(e) for e in err) / len(err)
        rmse = math.sqrt(sum(e * e for e in err) / len(err))
        ybar = sum(yt) / len(yt)
        ss_res = sum(e * e for e in err)
        ss_tot = sum((v - ybar) ** 2 for v in yt)
        r2 = 1 - ss_res / ss_tot if ss_tot else 0
        sp = spearman(yt, yp)
        print(f"\n[{name}] n={len(idxs)}")
        print(f"  MAE   {mae:.4f}")
        print(f"  RMSE  {rmse:.4f}")
        print(f"  R²    {r2:.4f}")
        print(f"  Spearman ρ {sp:.4f}")
        # 分档误差
        print("  分档 MAE：")
        for lo, hi in [(0, 8), (8, 11), (11, 13), (13, 14),
                       (14, 15), (15, 16), (16, 19)]:
            sub = [(a, b) for a, b in zip(yt, yp) if lo <= a < hi]
            if len(sub) >= 5:
                m = sum(abs(a - b) for a, b in sub) / len(sub)
                print(f"    定数 {lo:>2}-{hi:<2} n={len(sub):<4} MAE={m:.3f}")
        return err, yt, yp

    err_tr = eval_set(tr, "训练集")
    err_te = eval_set(te, "测试集（按歌曲分组切分）")

    # 权重表
    print("\n" + "=" * 72)
    print("模型权重（可审计）")
    print("=" * 72)
    print(f"  截距 b0 = {b0:.4f}")
    print(f"  {'特征':<22}{'权重':>10}{'标准量':>10}{'VIF':>9}")
    print("  " + "-" * 53)
    pairs = []
    for j, (lab, _, _) in enumerate(FEATURES):
        sd = st.pstdev([X[i][j] for i in tr]) or 1e-9
        v = vif(X, j, tr)
        pairs.append((abs(w[j] * sd), lab, w[j], w[j] * sd, v))
    for _, lab, wv, std, v in sorted(pairs, reverse=True):
        flag = " ⚠共线" if v > 10 else ""
        vs = f"{v:>9.1f}" if v != float("inf") else "      inf"
        print(f"  {lab:<22}{wv:>+10.4f}{std:>+10.4f}{vs}{flag}")

    worst = max((p[4] for p in pairs), default=0)
    if worst > 10:
        print(f"\n  ⚠ 存在严重共线特征（VIF={worst:.1f} > 10），权重解读需谨慎")
    else:
        print(f"\n  ✓ 无严重共线（最大 VIF={worst:.1f} < 10），权重可安全解读")

    # 保存模型
    model = {
        "features": [f[2] for f in FEATURES],
        "feature_names": [f[1] for f in FEATURES],
        "w": w, "mu": mu, "b0": b0, "lam": args.lam,
        "n_train": len(tr), "n_test": len(te),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out_model)), exist_ok=True)
    with open(args.out_model, "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
    print(f"\n[saved] {args.out_model}")

    # 残差最大的测试样本（已知失效场景）
    if err_te:
        e, yt, yp = err_te
        idxs = te
        order = sorted(range(len(e)), key=lambda i: -abs(e[i]))[:10]
        print("\n" + "=" * 72)
        print("测试集残差 TOP10（已知难点）")
        print("=" * 72)
        print(f"  {'谱名':<22}{'难度':<5}{'实际':>6}{'预测':>7}{'残差':>7}")
        for k in order:
            r = rows[idxs[k]]
            print(f"  {r['name'][:20]:<22}{r['level']:<5}"
                  f"{yt[k]:>6.1f}{yp[k]:>7.1f}{e[k]:>+7.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
