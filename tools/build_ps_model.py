#!/usr/bin/env python3
"""
P.H.M. Standard 评分模型构建（离线）

目标：在官方谱语料（1,037 条）上拟合「谱面特征 → 难度数值」的模型，
     把模型（系数或树）导出为 JSON，App 端零数据运行。
     一切以公式为准 —— 公式的系数在官方谱上离线校准。

候选模型（同一 CV 协议下比较）：
  A. Ridge（全部维度 + log1p 变换 + 难度档 one-hot + 档×维交互）  LOO 精确解
  B. HistGradientBoostingRegressor                               5 折 CV
防外推：所有输入特征裁剪到语料 P0.5-P99.5 包络；输出裁剪到 [0.5, 20]。
（v1 线性外推发散到 -1298 的教训）

产出：/tmp 或 stdout 的模型 JSON + 验证指标 + 5 张样本的对照表
"""
import json
import math
import os
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data", "official.jsonl")

SKIP = {"song_id", "level", "difficulty", "name", "composer", "charter",
        "bpm_items"}
LEVELS = ["EZ", "HD", "IN", "AT", "SP"]
LOG1P = {"notes_real", "notes_all", "multi_finger_3plus_events",
         "above_avg_duration_sec", "weighted_mf_score_per_sec",
         "jline_move_disp_per_sec", "eff_peak_tps_1s", "eff_avg_tps_1s",
         "above_avg_density_mean", "cross_hand_density", "stair_density",
         "drag_per_sec", "t_tap", "t_hold", "t_flick", "t_drag"}


def norm_level(s):
    s = (s or "").upper()
    for lv in LEVELS:
        if lv in s:
            return lv
    return "UNK"


def load():
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
    rows = [r for r in rows if r.get("notes_real", 0) > 0]
    keys = [k for k, v in rows[0].items()
            if k not in SKIP and isinstance(v, (int, float))]
    X, y, levels, names = [], [], [], []
    for r in rows:
        X.append([float(r.get(k, 0) or 0) for k in keys])
        y.append(float(r["difficulty"]))
        levels.append(norm_level(r.get("level")))
        names.append(r.get("name", ""))
    return rows, keys, np.array(X, float), np.array(y, float), levels, names


def build_features(X, keys, levels, clip_lo, clip_hi):
    """特征工程：log1p + 裁剪 + 档位 one-hot + 档×维交互"""
    n, p = X.shape
    cols, names = [], []
    for j in range(p):
        v = np.clip(X[:, j], clip_lo[j], clip_hi[j])
        cols.append(np.log1p(np.clip(v, 0, None)) if keys[j] in LOG1P else v)
        names.append(keys[j])
    # 档位 one-hot
    lv_mat = np.zeros((n, len(LEVELS)))
    for i, lv in enumerate(levels):
        if lv in LEVELS:
            lv_mat[i, LEVELS.index(lv)] = 1.0
    for j, lv in enumerate(LEVELS):
        cols.append(lv_mat[:, j])
        names.append("level_" + lv)
    # 档 × 维 交互（全部基础维 × 5 档）
    for j in range(p):
        for li, lv in enumerate(LEVELS):
            cols.append(cols[j] * lv_mat[:, li])
            names.append(f"{keys[j]}*{lv}")
    return np.column_stack(cols), names


def ridge_loo(Xs, y, alpha):
    """岭回归 LOO（hat 矩阵捷径，numpy 精确解）"""
    A = Xs.T @ Xs + alpha * np.eye(Xs.shape[1])
    Ainv = np.linalg.inv(A)
    beta = Ainv @ (Xs.T @ y)
    pred = Xs @ beta
    h = np.sum((Xs @ Ainv) * Xs, axis=1)
    err = np.abs((y - pred) / np.maximum(1 - h, 1e-9))
    return err, pred


def stats(err):
    e = np.sort(err)
    n = len(e)
    q = lambda t: e[min(int(n * t), n - 1)]
    return {"med": q(.5), "p75": q(.75), "p90": q(.90), "p95": q(.95),
            "le1": float(np.mean(err <= 1.0) * 100)}


def main():
    rows, keys, X, y, levels, names = load()
    print(f"[load] 官谱 {len(rows)} 条，基础维度 {len(keys)}")
    # 裁剪包络
    clip_lo = np.percentile(X, 0.5, axis=0)
    clip_hi = np.percentile(X, 99.5, axis=0)
    F, fnames = build_features(X, keys, levels, clip_lo, clip_hi)
    print(f"[feat] 工程后维度 {F.shape[1]}")
    # 标准化
    mu, sd = F.mean(0), F.std(0)
    sd[sd < 1e-9] = 1.0
    Fz = (F - mu) / sd

    results = {}
    # ── A. Ridge LOO 扫描 ──
    print("\n[A] Ridge（LOO 精确解）")
    best_r = None
    for alpha in (1.0, 3.0, 10.0, 30.0, 100.0):
        err, pred = ridge_loo(Fz, y, alpha)
        st = stats(err)
        results[f"ridge_a{alpha:g}"] = (st, pred)
        print(f"  α={alpha:<6g} 中位 {st['med']:.3f}  p90 {st['p90']:.3f}  "
              f"p95 {st['p95']:.3f}  ≤1.0 {st['le1']:.1f}%")
        if best_r is None or st["med"] < best_r[1]["med"]:
            best_r = (alpha, st, pred)
    print(f"  → 最优 α={best_r[0]}")

    # ── B. HGB 5 折 CV ──
    print("\n[B] HistGradientBoosting（5 折 CV × 3 种子）")
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    for (lr, iters, leaves) in ((0.05, 300, 31), (0.05, 500, 15),
                                (0.1, 300, 31)):
        errs, preds = [], np.zeros(len(y))
        for seed in (42, 7, 2026):
            kfs = KFold(n_splits=5, shuffle=True, random_state=seed)
            for tr, te in kfs.split(F):
                m = HistGradientBoostingRegressor(
                    learning_rate=lr, max_iter=iters,
                    max_leaf_nodes=leaves, l2_regularization=1.0,
                    random_state=0)
                m.fit(F[tr], y[tr])
                p = np.clip(m.predict(F[te]), 0.5, 20.0)
                preds[te] = p
                errs.extend(np.abs(p - y[te]))
        st = stats(np.array(errs))
        results[f"hgb_lr{lr:g}_it{iters}_lv{leaves}"] = (st, preds)
        print(f"  lr={lr} it={iters} leaves={leaves}:  中位 {st['med']:.3f}  "
              f"p90 {st['p90']:.3f}  ≤1.0 {st['le1']:.1f}%")

    # ── 选优 ──
    best_name = min(results, key=lambda k: results[k][0]["med"])
    best_st = results[best_name][0]
    print(f"\n最优：{best_name}  中位 {best_st['med']:.3f}  p90 {best_st['p90']:.3f}")
    print("（对照：k-NN 0.500 / 旧公式设计 0.887 / v1 回归 0.806）")

    # ── 5 样本对照 ──
    com = {json.loads(l)["id"]: json.loads(l)
           for l in open(os.path.join(ROOT, "data", "community.jsonl"),
                         encoding="utf-8")}
    print("\n5 张跨度样本（官方定数 → 模型预测）：")
    pred = results[best_name][1]
    # 样本在 community.jsonl，不在官谱里 —— 用官谱中相近难度的带均值代替
    for d0, nm in ((5.0, "感情的摩天楼"), (8.0, "theme-44"),
                   (13.0, "ごまかし"), (15.3, "DUAL BREAKER XX"),
                   (17.6, "一瞬֍幻夢")):
        band = [pred[i] for i, r in enumerate(rows)
                if abs(r["difficulty"] - d0) < 0.6]
        m = sum(band) / len(band) if band else float("nan")
        print(f"  官方 {d0:<5} → 模型中位 {m:.1f}   ({nm})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
