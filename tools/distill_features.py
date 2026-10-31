#!/usr/bin/env python3
"""蒸馏：让玩家公式当老师，谱面特征当学生。

━━━ 要解决的问题 ━━━
用户的要求：「随便给一个数据库里没打过的谱，也能准确推算难度」。
玩家公式（IRT）**做不到**这件事 —— 没人打过就没有记录，b 无从估计。
但反过来也一样：特征模型能做冷启动，可它现在学的是**谱师标的定数**，
而那把尺子一半是噪声，所以 R² 卡在 0.46。

━━━ 正解 ━━━
把标签换掉：**用 b（玩家实测难度）当监督信号**，特征当输入。
   · b 的分半信度 0.9999 → 标签几乎没有噪声（相对声明定数而言）
   · 学出来的是「玩家实际打起来多难」，不是「谱师觉得多难」
   · 新谱没有记录也照样出数（只要谱面文件在）

这一步就是「完全用玩家公式」和「能推没打过的谱」同时成立的唯一形态：
玩家公式负责当尺子，特征模型负责把它推广到没有记录的谱。

━━━ 评估 ━━━
同一个 test 集上对比两个学生：
  A. 特征 → b       （新标签）
  B. 特征 → 声明定数 （旧标签，就是现在线上那套）
指标用 Spearman（尺度无关）和 R²，并报「特征 → b」的绝对误差（定数级）。
"""
import json
import math
import os

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
COMM = os.path.join(ROOT, "community.jsonl")
IRT = os.path.join(ROOT, "player-irt.json")

# 不参与建模的列：标识 / 文本 / 派生的时长量（避免把"谱有多长"当成难度）
DROP = {"id", "name", "level", "difficulty", "rating", "ratingCount", "stable", "ranked", "charter",
        "tags", "file_size", "chart_file", "format", "bpm_items", "rpe_version",
        "fetched_at", "fmt", "t_sec", "duration_s", "bpm"}


def load_xy():
    rows = []
    with open(COMM, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            rows.append(r)
    feat_names = [k for k in rows[0] if k not in DROP
                  and isinstance(rows[0][k], (int, float))]
    # 只保留在所有行里都是数字的列
    keep = []
    for k in feat_names:
        ok = 0
        for r in rows:
            v = r.get(k)
            if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
                ok += 1
        if ok >= len(rows) * 0.98:
            keep.append(k)
    X, ids, decl = [], [], []
    for r in rows:
        X.append([float(r.get(k) or 0.0) for k in keep])
        ids.append(r["id"])
        decl.append(float(r.get("difficulty") or 0.0))
    return np.array(X, dtype=np.float64), np.array(ids), np.array(decl), keep


def ridge_fit(X, y, lam):
    """带截距的闭式解。X 已标准化。"""
    n, d = X.shape
    A = X.T @ X + lam * np.eye(d)
    return np.linalg.solve(A, X.T @ y)


def ridge_pred(X, w, mu, sd, ym):
    return ((X - mu) / sd) @ w + ym


def spearman(x, y):
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx -= rx.mean()
    ry -= ry.mean()
    return float((rx * ry).sum() / math.sqrt((rx * rx).sum() * (ry * ry).sum()))


def main():
    X, ids, decl, feats = load_xy()
    print(f"特征矩阵 {X.shape[0]:,} 张 × {X.shape[1]} 维")

    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    b = np.array([irt.get(str(i), {}).get("b", np.nan) for i in ids])
    npl = np.array([irt.get(str(i), {}).get("players", 0) for i in ids])
    has = ~np.isnan(b)
    print(f"能和 b 对上的 {has.sum():,} 张（其中 ≥100 人的 {int((has & (npl >= 100)).sum()):,}）")

    # 只用"测量可靠"的谱做训练标签：≥100 人（分半信度那节已证 k=100 → ρ 0.995）
    # ⚠ 声明定数有玩梗值（troll/visual 分区把定数写成 999），必须先截断
    sane = (decl >= 1) & (decl <= 20)
    print(f"声明定数在 1~20 的 {int(sane.sum()):,} 张")
    sel = np.where(has & (npl >= 100) & sane)[0]
    Xs, bs, ds = X[sel], b[sel], decl[sel]
    print(f"训练集候选 {len(sel):,} 张 · b 的 SD {bs.std():.3f} · 声明定数 SD {ds.std():.3f}")

    rng = np.random.default_rng(20261026)
    rng.shuffle(sel_idx := sel.copy())
    order = np.argsort([np.where(sel == i)[0][0] for i in sel_idx])
    cut = int(len(sel) * 0.8)
    tr, te = sel[:cut], sel[cut:]

    def fit_eval(target, name):
        Xtr, ytr = X[tr], target[tr]
        Xte, yte = X[te], target[te]
        mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-9
        Ztr = (Xtr - mu) / sd
        best = None
        for lam in (1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000):
            # 5 折 CV 选 λ（在训练集内部，不碰 test）
            k = 5
            idx = rng.permutation(len(Ztr))
            err = 0.0
            for i in range(k):
                va = idx[i::k]
                trn = np.setdiff1d(idx, va)
                w = ridge_fit(Ztr[trn], ytr[trn] - ytr[trn].mean(), lam)
                p = Ztr[va] @ w + ytr[trn].mean()
                err += ((p - ytr[va]) ** 2).sum()
            if best is None or err < best[1]:
                best = (lam, err)
        lam = best[0]
        w = ridge_fit(Ztr, ytr - ytr.mean(), lam)
        p = ridge_pred(Xte, w, mu, sd, ytr.mean())
        r2 = 1 - ((yte - p) ** 2).sum() / ((yte - yte.mean()) ** 2).sum()
        rho = spearman(p, yte)
        print(f"  {name:<16} λ={lam:<6} R² {r2:6.3f}  ρ {rho:.3f}  "
              f"RMSE {np.sqrt(((yte - p) ** 2).mean()):.3f}")
        return {"name": name, "lam": lam, "r2": round(float(r2), 4),
                "spearman": round(rho, 4),
                "rmse": round(float(np.sqrt(((yte - p) ** 2).mean())), 4)}

    print(f"\n test 集 {len(te):,} 张（按谱面切分，训练时完全没见过）")
    a = fit_eval(b, "特征 → b（新）")
    c = fit_eval(decl, "特征 → 声明定数（旧）")

    # 线上那套是 37 维 → 声明定数，已知 R²≈0.46（不同切分会有波动）
    print(f"\n 结论：换标签后 ρ {c['spearman']:.3f} → {a['spearman']:.3f}")
    json.dump({"n_train": int(len(tr)), "n_test": int(len(te)),
               "old_label": c, "new_label": a},
              open(os.path.join(ROOT, "distill-result.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f" 写出 {os.path.join(ROOT, 'distill-result.json')}")


main()
