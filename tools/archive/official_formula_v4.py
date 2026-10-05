#!/usr/bin/env python3
"""
官谱定数公式 v4 —— 查表基线 + 连续维度局部修正

问题诊断（v3 ablation 实测）：
  v2基线(标签+NPS+Hold)              MAE 0.700   57格  平均26.5样本
  +有效单指密度                       MAE 0.800  148格  平均13.1样本
  +高潮段秒数                         MAE 0.850  136格  平均13.3样本
  +两者                               MAE 1.000  更多格

**根因：加档位维度会让格数指数增长，1,037 条被摊薄到每格 <4 条，
        格内中位数不再稳定 → 精度反而下降。**

解法（保持可解释）：
  定数 = 查表基线(标签, NPS档, Hold%档)      ← 粗定位，格内样本充足
       + 局部线性修正(残差 ~ f(连续维度))    ← 细调节，不增加格数

局部修正的做法（完全可解释）：
  1. 在基线格内，算定数残差（实际 − 基线中位）
  2. 对每个连续维度，按该格内的**四分位**分成 4 档
  3. 每档算残差中位数 → 得到该维度的「档位修正量」
  4. 多个维度的修正量相加（因为已在格内基线之上，量级小、可加）
  5. 每一步都记录修正量，出错可追溯

这样格数不变（57），但每个格内用残差做了二次细分。
"""
import argparse
import bisect
import collections
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

NPS_EDGES = [0, 2.5, 4.5, 6.5, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]

# 连续修正维度：(字段, 中文名, 是否取对数)
# ★ v5 决策：只保留偏相关最强的少数维度。
#   实测偏相关（控制 NPS 后）：
#     stair_speed_avg        +0.5232  ← 唯一强残余信号
#     hold_interference_index -0.4667  ← 强负向
#     chord_size_entropy     +0.2532
#     cross_hand_density     +0.2464
#     real_core_notes_per_second -0.2267
#     chord_ratio            -0.2039
#     weighted_mf_score_per_sec -0.1981
#     above_avg_duration_sec +0.1920
#   其余均 < 0.12，加入只增加过拟合。
ORIG_DIMS = [
    ("stair_speed_avg", "纵连速度", False),
    ("hold_interference_index", "长押干扰", False),
    ("chord_size_entropy", "和弦熵", False),
    ("cross_hand_density", "交叉手", False),
    ("above_avg_duration_sec", "高潮段秒数", False),
    ("real_core_notes_per_second", "核心TPS", False),
]
ADJUST_DIMS = list(ORIG_DIMS)


def bucket(v, edges):
    if v is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def base_key(r):
    lv = (r.get("level") or "").upper()[:2]
    ni = bucket(r.get("nps"), NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    if ni is None or hi is None:
        return None
    return (lv, ni, hi)


def qcut_index(v, v_sorted, q):
    """返回 v 在该格内的四分位序号 0..3"""
    n = len(v_sorted)
    if n < 4:
        return 0
    import bisect
    i = bisect.bisect_left(v_sorted, v)
    for k in range(1, 4):
        if i < n * k / 4:
            return k - 1
    return 3


def build_tables(rs, min_n):
    """
    构建：
      base[(lv,ni,hi)] = {'med': 中位, 'resid': [(dim_idx, q, med_resid)...]}
    修正量在该格内按维度独立计算后相加
    """
    cells = collections.defaultdict(list)
    for r in rs:
        k = base_key(r)
        if k:
            cells[k].append(r)
    base = {}
    for k, sub in cells.items():
        if len(sub) < min_n:
            continue
        ds = [r["difficulty"] for r in sub]
        med = st.median(ds)
        entry = {"med": med, "n": len(sub), "adj": {}}
        # 各维度的四分位修正
        for di, (fld, _lab, use_log) in enumerate(ADJUST_DIMS):
            vals = []
            for r in sub:
                v = r.get(fld)
                if v is None:
                    v = 0.0
                vals.append(math.log1p(max(0.0, v)) if use_log
                           else float(v))
            srt = sorted(vals)
            buckets = collections.defaultdict(list)
            for r, v in zip(sub, vals):
                q = qcut_index(v, srt, 4)
                buckets[q].append(r["difficulty"] - med)
            if len(buckets) < 2:
                continue
            # 修正量：各四分位残差中位数，相对于整体残差中心
            all_res = [d for q in buckets for d in buckets[q]]
            center = st.median(all_res) if all_res else 0.0
            adj = {}
            for q, ds2 in buckets.items():
                if len(ds2) >= 2:
                    adj[q] = round(st.median(ds2) - center, 3)
            if adj:
                entry["adj"][di] = adj
        base[k] = entry
    return base, cells


def predict(r, base, cells, global_med, min_n):
    k = base_key(r)
    if k is None:
        return global_med, "none", "档位外"
    e = base.get(k)
    if e is None:
        # 回退：标签基线（cells 存的是行对象，取其 difficulty）
        lv = k[0]
        allv = [r2["difficulty"] for kk, v in cells.items()
                if kk[0] == lv and len(v) >= min_n for r2 in v]
        if allv:
            return st.median(allv), "low", "标签基线"
        return global_med, "none", "兜底"
    val = e["med"]
    detail = []
    for di, (fld, lab, use_log) in enumerate(ADJUST_DIMS):
        adj = e["adj"].get(di)
        if not adj:
            continue
        v = r.get(fld)
        if v is None:
            v = 0.0
        v = math.log1p(max(0.0, v)) if use_log else float(v)
        srt = sorted(
            (math.log1p(max(0.0, (x.get(fld) or 0.0))) if use_log
             else float(x.get(fld) or 0.0))
            for x in cells[k])
        q = qcut_index(v, srt, 4)
        if q in adj:
            val += adj[q]
            detail.append(f"{lab}{adj[q]:+.2f}")
    conf = "high" if e["n"] >= 8 else "mid"
    return val, conf, f"n={e['n']} " + " ".join(detail)


def loo(rows, min_n, label):
    errs, confs = [], []
    for i, r in enumerate(rows):
        sub = rows[:i] + rows[i + 1:]
        base, cells = build_tables(sub, min_n)
        g = st.median([x["difficulty"] for x in sub])
        p, c, _ = predict(r, base, cells, g, min_n)
        errs.append(abs(p - r["difficulty"]))
        confs.append(c)
    n = len(errs)
    es = sorted(errs)
    cc = {}
    for c in confs:
        cc[c] = cc.get(c, 0) + 1
    print("  %-26s MAE %.3f  p75 %.3f  p90 %.3f  p95 %.3f  "
          "≤0.5 %.1f%%  ≤1.0 %.1f%%  %s"
          % (label, es[n // 2], es[int(n * .75)], es[int(n * .90)],
             es[int(n * .95)],
             sum(1 for e in errs if e <= .5) / n * 100,
             sum(1 for e in errs if e <= 1.) / n * 100,
             {k: f"{v*100/n:.0f}%" for k, v in sorted(cc.items())}))
    return es, confs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(
        BASE, "..", "data", "official.jsonl"))
    ap.add_argument("--out", default=os.path.join(
        BASE, "..", "data", "official", "formula_v4.json"))
    ap.add_argument("--min-n", type=int, default=4)
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(os.path.abspath(args.data), encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0]
    print(f"[load] {len(rows)} 条\n")

    print("=" * 82)
    print("v4：查表基线 + 连续维度局部修正")
    print("=" * 82)

    es0, _ = loo_base(rows, args.min_n, "v2 基线（无修正）")

    # 逐步加入修正维度（只保留偏相关最强的）
    results = []
    for k in (1, 2, 3, 4, 5, 6):
        if k > len(ORIG_DIMS):
            break
        ADJUST_DIMS[:] = ORIG_DIMS[:k]
        es, _ = loo(rows, args.min_n, f"+前 {k} 个修正维度")
        results.append((st.median(es), k, es))

    ADJUST_DIMS[:] = ORIG_DIMS
    es_all, _ = loo(rows, args.min_n, "全 6 维修正")

    # 基线也作为一个候选
    results.append((st.median(es0), 0, es0))
    best = min(results, key=lambda x: x[0])

    if best[1] == 0:
        ADJUST_DIMS[:] = []
        es = es0
        print("\n  → 结论：所有修正维度都降低精度，采纳纯基线")
    else:
        ADJUST_DIMS[:] = ORIG_DIMS[:best[1]]
        es = best[2]
        print(f"\n  → 采纳最优 {best[1]} 个修正维度")

    print(f"  基线 MAE {st.median(es0):.3f}  "
          f"全维度 MAE {st.median(es_all):.3f}  "
          f"采纳 MAE {st.median(es):.3f}")

    # 保存
    base, cells = build_tables(rows, args.min_n)
    ser = {
        "version": "v4",
        "method": "查表基线(标签×NPS×Hold) + 连续维度四分位局部修正",
        "edges": {"nps": NPS_EDGES, "hold": HOLD_EDGES},
        "adjust_dims": [{"field": f, "label": l, "log": g}
                        for f, l, g in ADJUST_DIMS],
        "min_n": args.min_n,
        "loo_mae": st.median(es),
        "base": {"|".join(str(x) for x in k): v for k, v in base.items()},
        "cells": {"|".join(str(x) for x in k): [r["difficulty"] for r in v]
                  for k, v in cells.items()},
        "global_median": st.median([r["difficulty"] for r in rows]),
        "n_official": len(rows),
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(ser, f, ensure_ascii=False, indent=1)
    print(f"\n[saved] {out}")
    return 0


def loo_base(rows, min_n, label):
    errs = []
    for i, r in enumerate(rows):
        sub = rows[:i] + rows[i + 1:]
        cells = collections.defaultdict(list)
        for x in sub:
            k = base_key(x)
            if k:
                cells[k].append(x["difficulty"])
        g = st.median([x["difficulty"] for x in sub])
        k = base_key(r)
        if k and k in cells and len(cells[k]) >= min_n:
            p = st.median(cells[k])
        else:
            lv = k[0] if k else ""
            cand = [d for kk, v in cells.items()
                    if kk[0] == lv and len(v) >= min_n for d in v]
            p = st.median(cand) if cand else g
        errs.append(abs(p - r["difficulty"]))
    n = len(errs)
    es = sorted(errs)
    print("  %-26s MAE %.3f  p75 %.3f  p90 %.3f  p95 %.3f  "
          "≤0.5 %.1f%%  ≤1.0 %.1f%%"
          % (label, es[n // 2], es[int(n * .75)], es[int(n * .90)],
             es[int(n * .95)],
             sum(1 for e in errs if e <= .5) / n * 100,
             sum(1 for e in errs if e <= 1.) / n * 100))
    return es, None


if __name__ == "__main__":
    import math
    sys.exit(main())
