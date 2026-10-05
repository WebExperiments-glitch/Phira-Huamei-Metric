#!/usr/bin/env python3
"""
点估计实验：能不能给出「一个精确数值」，精度上限在哪

背景
----
产品诉求：用户想要一个确定的数字，而不是区间。
本脚本对同一批官谱（留一法）比较估计器，回答：
  1. 换更强的估计器能把误差压到多少？
  2. 距离度量该用哪些特征、要不要归一化（不靠拍脑袋，扫描决定）
  3. 点估计的误差分布是什么形状 —— 也就是「一个数字」该标 ±多少？

用法：python tools/exp_point_estimate.py
"""
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, os.path.join(ROOT, "phm"))
sys.path.insert(0, BASE)

from core import Verdict, KNN_K, KNN_BW  # noqa: E402
import official_formula_v2 as fv2         # noqa: E402  （历史查表法，作对比基线）

DATA = os.path.join(ROOT, "data", "official.jsonl")

# 特征名（顺序即向量顺序）
FNAMES = ["nps", "hold", "notes", "stair"]
SUBSETS = {
    "nps+hold": [0, 1],
    "nps+hold+notes": [0, 1, 2],
    "nps+hold+notes+stair": [0, 1, 2, 3],
}


def raw_feats(r):
    nr = max(r["notes_real"], 1)
    return [math.log1p(max(r["nps"], 0.01)),
            math.log1p(max(r["t_hold"] / nr * 100, 0.01)),
            math.log1p(nr),
            math.log1p(max(r.get("stair_speed_avg") or 0, 0.01))]


def wmedian(pairs):
    """加权中位（比加权平均抗离群）"""
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    if tot <= 0:
        return None
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= tot / 2:
            return v
    return pairs[-1][0]


def wquantile(pairs, q):
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    if tot <= 0:
        return None
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= tot * q:
            return v
    return pairs[-1][0]


class Corpus:
    def __init__(self, rows):
        self.rows = rows
        self.X = [raw_feats(r) for r in rows]
        self.y = [r["difficulty"] for r in rows]
        self.lv = [r.get("level") for r in rows]
        self.n = len(rows)

    def pool(self, i, same_level=True):
        if same_level:
            p = [j for j in range(self.n) if j != i and self.lv[j] == self.lv[i]]
            if len(p) >= 10:
                return p
        return [j for j in range(self.n) if j != i]

    def neighbors(self, i, k, cols, zscore, same_level=True):
        pool = self.pool(i, same_level)
        q = [self.X[i][c] for c in cols]
        if zscore:
            mu, sd = [], []
            for c in cols:
                v = [self.X[j][c] for j in pool]
                m = sum(v) / len(v)
                s = (sum((z - m) ** 2 for z in v) / len(v)) ** 0.5 or 1.0
                mu.append(m)
                sd.append(s)
            q = [(q[t] - mu[t]) / sd[t] for t in range(len(cols))]
        out = []
        for j in pool:
            d2 = 0.0
            for t, c in enumerate(cols):
                v = self.X[j][c]
                if zscore:
                    v = (v - mu[t]) / sd[t]
                d2 += (v - q[t]) ** 2
            out.append((math.sqrt(d2), j))
        out.sort(key=lambda p: p[0])
        return out[:k]

    def predict(self, i, k, cols, zscore, same_level=True):
        near = self.neighbors(i, k, cols, zscore, same_level)
        if not near:
            return None
        scale = max(near[-1][0], 1e-6)
        return wmedian([(self.y[j], math.exp(-(d / scale) ** 2 * 2.0))
                        for d, j in near])

    def interval(self, i, k, cols, zscore, lo_q=0.25, hi_q=0.75):
        near = self.neighbors(i, k, cols, zscore)
        if not near:
            return None, None
        scale = max(near[-1][0], 1e-6)
        pairs = [(self.y[j], math.exp(-(d / scale) ** 2 * 2.0))
                 for d, j in near]
        return wquantile(pairs, lo_q), wquantile(pairs, hi_q)


def eval_point(corpus, fn, label, verbose=True):
    errs = []
    for i in range(corpus.n):
        p = fn(i)
        if p is None:
            continue
        errs.append(abs(p - corpus.y[i]))
    errs.sort()
    n = len(errs)
    q = lambda t: errs[min(int(n * t), n - 1)]
    r = {"label": label, "med": q(.50), "p75": q(.75), "p90": q(.90),
         "p95": q(.95),
         "le05": sum(1 for e in errs if e <= .5) / n * 100,
         "le10": sum(1 for e in errs if e <= 1.) / n * 100}
    if verbose:
        print(f"  {label:<34} 中位 {r['med']:.3f}  p75 {r['p75']:.3f}  "
              f"p90 {r['p90']:.3f}  |  ≤0.5 {r['le05']:>5.1f}%  "
              f"≤1.0 {r['le10']:>5.1f}%")
    return r


def main():
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0]
    C = Corpus(rows)
    print(f"[load] 官谱 {C.n} 条\n")

    print("=" * 96)
    print("① 基线 A：历史查表法（tools/official_formula_v2.py，已不在交付路径）")
    print("=" * 96)
    def table_est(i):
        sub = C.rows[:i] + C.rows[i + 1:]
        t, _ = fv2.build(sub)
        m = st.median([x["difficulty"] for x in sub])
        p, _, _ = fv2.predict(C.rows[i], t, m)
        return p
    baseA = eval_point(C, table_est, "A 查表（历史方法）")

    print("\n" + "=" * 96)
    print("② 基线 B：现行交付引擎（phm/core.py，k-NN）")
    print("=" * 96)
    def engine_est(i):
        r = C.rows[i]
        nr = max(r["notes_real"], 1)
        lo, hi, mid, conf, _ = Verdict(rows=C.rows[:i] + C.rows[i + 1:]
                                       ).reference_range(
            r["nps"], r["t_hold"] / nr, r["notes_real"],
            r.get("stair_speed_avg") or 0, r.get("level"))
        return mid
    baseB = eval_point(C, engine_est, f"B 交付引擎 k-NN k={KNN_K}")

    print("\n" + "=" * 96)
    print("③ 距离度量扫描：特征集 × 是否归一化 × k（全部同标签分层）")
    print("=" * 96)
    results = [baseA, baseB]
    for sname, cols in SUBSETS.items():
        for zs in (False, True):
            for k in (10, 20, 40):
                lab = (f"C k-NN k={k} {sname}"
                       + (" [z]" if zs else " [raw]"))
                results.append(eval_point(
                    C, lambda i, k=k, cols=cols, zs=zs:
                    C.predict(i, k, cols, zs), lab))

    best = min(results, key=lambda x: (x["med"], -x["le10"]))
    print("\n" + "=" * 96)
    print(f"最优配置：{best['label']}")
    print(f"  中位误差 {best['med']:.3f}（查表 {baseA['med']:.3f}，"
          f"改善 {(baseA['med']-best['med'])/baseA['med']*100:.0f}%）"
          f"   ≤1.0 命中 {best['le10']:.1f}%（查表 {baseA['le10']:.1f}%）")
    print("=" * 96)

    # ---- 误差分布：一个数字该标 ±多少 ----
    print("\n【一个数字该标 ±多少？】—— 误差分位（选定估计器）")
    for q, lab in ((.50, "一半"), (.68, "约 2/3"), (.80, "约 4/5"),
                   (.90, "约 9 成"), (.95, "约 95%")):
        e = {"0.50": best["med"], "0.68": best["p75"], "0.80": best["p90"],
             "0.90": best["p90"], "0.95": best["p95"]}[f"{q:.2f}"]
        print(f"  {lab:>7}的谱，|误差| ≤ {e:.2f} 级")

    # ---- 区间覆盖率：若用 k-NN 自身给出的区间 ----
    print("\n【区间覆盖率】用 k-NN 邻居的加权四分位区间")
    for sname, colset in SUBSETS.items():
        for k in (10, 20):
            hit = got = 0
            for i in range(C.n):
                lo, hi = C.interval(i, k, colset, True)
                if lo is None:
                    continue
                got += 1
                if lo <= C.y[i] <= hi:
                    hit += 1
            print(f"    k={k:<3} {sname:<24} 有区间 {got:>4}  "
                  f"覆盖 {hit/max(got,1)*100:>5.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
