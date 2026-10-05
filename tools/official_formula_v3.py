#!/usr/bin/env python3
"""
官谱定数公式 v3 —— 加入 14 维要素

v2 只用 NPS（底力）+ Hold%（纵连）两个维度，LOO 误差 0.600。
v3 引入竞品的核心要素维度，目标 ≤ 0.40。

设计原则（不变）：
  · 保持查表形式，不走 GB 树（项目定位：任何人都能自己跑一遍验证）
  · 每个维度必须报告**边际贡献**，贡献 < 0.02 的剔除
  · 样本不足的格自动降置信度

维度选择依据（竞品 boost_config.py 的权重 × 归一化系数）：
  above_avg_duration_sec   16.80  ← 耐力，单项占总贡献 52%
  movement_density_index    1.80  ← 位移×密度
  eff_peak_tps_1s           1.44  ← 有效单指密度（同押去冗余）
  above_avg_density_mean    1.41
  tempo_change_count        1.40  ← 变速
  stair_speed_avg           1.36  ← 纵连
  weighted_mf_score_per_sec 1.27  ← 多押
  jline_move_disp_per_sec   1.14
"""
import argparse
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# ---- 档位定义 ----
NPS_EDGES = [0, 2.5, 4.5, 6.5, 10, 100]
STAM_EDGES = [0, 10, 25, 45, 80, 10000]        # 高潮段秒数
EFF_EDGES = [0, 6, 10, 14, 20, 10000]           # 有效单指密度
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]
LEVELS = ["EZ", "HD", "IN", "AT"]


def bucket(v, edges):
    if v is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def key2(r, use_eff=False, use_stam=False):
    """两层键：标签 + 主维度（避免格内过稀）"""
    lv = (r.get("level") or "").upper()[:2]
    ni = bucket(r["nps"], NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    if ni is None or hi is None:
        return None
    if use_eff and use_stam:
        ei = bucket(r.get("eff_peak_tps_1s", 0), EFF_EDGES)
        si = bucket(r.get("above_avg_duration_sec", 0), STAM_EDGES)
        if ei is not None and si is not None:
            return (lv, ni, hi, ei, si)
    if use_eff:
        ei = bucket(r.get("eff_peak_tps_1s", 0), EFF_EDGES)
        if ei is not None:
            return (lv, ni, hi, ei)
    if use_stam:
        si = bucket(r.get("above_avg_duration_sec", 0), STAM_EDGES)
        if si is not None:
            return (lv, ni, hi, si)
    return (lv, ni, hi)


def build(rs, kf):
    cells = {}
    for r in rs:
        k = kf(r)
        if k:
            cells.setdefault(k, []).append(r["difficulty"])
    return cells


def predict(r, cells, kf, fallback_pool, min_n):
    """逐级回退：完整键 → 去掉最细维度 → 标签基线 → 全局"""
    k = kf(r)
    if not k:
        return fallback_pool, "none", "档位外"
    if k in cells and len(cells[k]) >= min_n:
        return st.median(cells[k]), "high", f"n={len(cells[k])}"
    for cut in range(len(k) - 1, 1, -1):
        kk = k[:cut]
        if kk in cells and len(cells[kk]) >= min_n:
            return st.median(cells[kk]), "mid", f"n={len(cells[kk])}"
    lv = k[0]
    if lv in cells and len(cells[lv]) >= min_n:
        return st.median(cells[lv]), "low", f"n={len(cells[lv])}"
    return fallback_pool, "none", "兜底"


def loo_eval(rows, kf, min_n, label):
    errs, confs = [], []
    for i, r in enumerate(rows):
        sub = rows[:i] + rows[i + 1:]
        cells = build(sub, kf)
        pool = st.median([x["difficulty"] for x in sub])
        p, c, _ = predict(r, cells, kf, pool, min_n)
        errs.append(abs(p - r["difficulty"]))
        confs.append(c)
    n = len(errs)
    es = sorted(errs)
    cc = {}
    for c in confs:
        cc[c] = cc.get(c, 0) + 1
    print("  %-28s MAE %.3f  p75 %.3f  p90 %.3f  p95 %.3f  "
          "≤0.5 %.1f%%  ≤1.0 %.1f%%  %s"
          % (label, es[n // 2], es[int(n * .75)], es[int(n * .90)],
             es[int(n * .95)],
             sum(1 for e in errs if e <= .5) / n * 100,
             sum(1 for e in errs if e <= 1.) / n * 100,
             {k: f"{v*100/n:.0f}%" for k, v in sorted(cc.items())}))
    return errs, confs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(
        BASE, "..", "data", "official", "manifest_v3.jsonl"))
    ap.add_argument("--out", default=os.path.join(
        BASE, "..", "data", "official", "formula_v3.json"))
    ap.add_argument("--min-n", type=int, default=4)
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(os.path.abspath(args.data), encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0
            and "eff_peak_tps_1s" in r and "above_avg_duration_sec" in r]
    print(f"[load] {len(rows)} 条（含 v3 要素）\n")

    print("=" * 78)
    print("留一法精度：逐层加入维度（ablation）")
    print("=" * 78)
    variants = [
        (lambda r: key2(r, False, False), "v2基线 (标签+NPS+Hold)"),
        (lambda r: key2(r, True, False), "  + 有效单指密度"),
        (lambda r: key2(r, False, True), "  + 高潮段秒数(耐力)"),
        (lambda r: key2(r, True, True), "  + 两者 (v3完整)"),
    ]
    best = None
    for kf, lab in variants:
        e, c = loo_eval(rows, kf, args.min_n, lab)
        if best is None or st.median(e) < st.median(best[1]):
            best = (lab, e, c, kf)
    print()
    print(f"  → 最优: {best[0]}  MAE {st.median(best[1]):.3f}")

    # ---- 要素边际贡献（用 spearman 与定数的相关性做初筛）----
    print("\n" + "=" * 78)
    print("18 维要素与定数的相关性（用于筛选）")
    print("=" * 78)
    DIMS = ["real_core_notes_per_second", "eff_peak_tps_1s", "eff_avg_tps_1s",
            "above_avg_density_mean", "above_avg_duration_sec",
            "chord_size_entropy", "weighted_mf_score_per_sec", "stair_speed_avg",
            "pattern_switch_rate", "tempo_change_count", "hold_interference_index",
            "jline_move_disp_per_sec", "jline_rotate_density",
            "jline_disappear_density", "type_switch_per_sec",
            "note_clutter_ratio", "drag_per_sec", "cross_hand_density",
            "nps", "strain_peak", "fast_ratio", "chord_ratio"]

    def pear(xs, ys):
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        dx = sum((x - mx) ** 2 for x in xs) ** .5
        dy = sum((y - my) ** 2 for y in ys) ** .5
        return num / (dx * dy) if dx and dy else 0

    d = [r["difficulty"] for r in rows]
    pairs = []
    for k in DIMS:
        x = [r.get(k, 0) for r in rows]
        pairs.append((abs(pear(x, d)), k, pear(x, d)))
    for a, k, p in sorted(pairs, reverse=True):
        star = "★" if a > 0.15 else " "
        print(f"  {star} {k:<32} r = {p:+.4f}")

    # ---- 保存 ----
    cells = build(rows, best[3])
    ser = {
        "version": "v3",
        "method": "难度标签 × NPS × Hold% × 有效单指密度 × 高潮段秒数 查表",
        "edges": {"nps": NPS_EDGES, "hold": HOLD_EDGES,
                  "eff": EFF_EDGES, "stam": STAM_EDGES},
        "levels": LEVELS,
        "min_n": args.min_n,
        "best": best[0],
        "loo_mae": st.median(best[1]),
        "table": {"|".join(str(x) for x in k): st.median(v)
                  for k, v in cells.items() if len(v) >= args.min_n},
        "table_n": {"|".join(str(x) for x in k): len(v)
                    for k, v in cells.items()},
        "global_median": st.median([r["difficulty"] for r in rows]),
        "n_official": len(rows),
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(ser, f, ensure_ascii=False, indent=1)
    print(f"\n[saved] {out}  ({len(ser['table'])} 格）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
