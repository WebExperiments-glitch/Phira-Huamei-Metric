#!/usr/bin/env python3
"""
官谱定数公式 v2 —— 难度标签分层 + NPS × Hold% 精细查表

v1 的问题：低中位数区（NPS 1.5~3）内 EZ 定 3.5~7、HD 定 5.5~10.4，
谱面数据几乎相同，v1 无法区分 → 误差 0.7。

诊断结论（diag_level_separability.py）：
  · 谱面数据 **无法** 区分 EZ/HD 的重叠区（物量中位 290 vs 571 有区分，
    但 NPS 2.22 vs 4.29 重叠严重）
  · 因此公式必须**按难度标签分层**，先定基线，再做谱型修正

分层后的画像（官谱 1,037 条）：
  LV    n   物量中位  NPS中位  Hold%中位  定数中位
  EZ    327     290     2.22      37.4      5.0
  HD    327     571     4.29      36.9     10.3
  IN    327     888     6.68      23.3     14.7
  AT     56    1266     9.19      17.8     16.7

物理依据（全部来自官方判定与实测）：
  · Tap ±80ms 需精准 → 精度成本
  · Flick/Drag ±140ms 宽松 → 视觉成本
  · Hold 需按住至结束 → 持续成本，压低定数
  · NPS 反映单位时间手数 → 主轴

公式结构（完全可解释，无黑箱）：
  定数 = 查表(难度标签, NPS档, Hold%档)
  覆盖率不足时逐级回退，并**明确标注置信度**
"""
import argparse
import json
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, os.path.join(ROOT, "phm"))

# ★ 单一真源：档位定义与最小样本数一律取自交付引擎 phm/core.py。
#   历史教训：本脚本曾自带 NPS_EDGES=[0,1.5,2.5,…,10,100]（9 档），
#   而 core.py 用 [0,2.5,4.5,6.5,10,100]（5 档）—— 于是这里公布的 LOO
#   精度描述的是「另一个没上线的模型」。任何档位改动都必须只改 core.py。
from core import NPS_EDGES, HOLD_EDGES, MIN_N, norm_level  # noqa: E402

LEVELS = ["EZ", "HD", "IN", "AT"]


def bucket(v, edges):
    if v is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def key(r):
    lv = norm_level(r.get("level"))
    ni = bucket(r["nps"], NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    return lv, ni, hi


def build(rows):
    """分层建表：(level, nps_i, hold_i) -> {med, n, all_med}

    ⚠️ 同时写入 (level, None, None) 的标签基线。
       旧实现只写三元组键，而 predict() 会去查 (lv,None,None) ——
       该键永远不存在，导致第三层回退是死代码，样本不足的谱直接掉到
       全局中位（实测 69/1037）。这里补上，使回退链真正四级生效。
    """
    cells = {}
    for r in rows:
        k = key(r)
        cells.setdefault(k, []).append(r["difficulty"])
    bylv = {}
    for r in rows:
        bylv.setdefault(norm_level(r.get("level")), []).append(r["difficulty"])
    byni = {}
    for r in rows:
        lv, ni, _ = key(r)
        if lv is not None and ni is not None:
            byni.setdefault((lv, ni), []).append(r["difficulty"])

    table = {}
    for k, ds in cells.items():
        table[k] = {"med": st.median(ds), "n": len(ds),
                    "all_med": st.median(ds)}
    # 第二层：(lv, nps档) 粗格（丢掉 Hold 档）
    for k, ds in byni.items():
        table[(k[0], k[1], None)] = {"med": st.median(ds), "n": len(ds),
                                     "all_med": st.median(ds)}
    # 第三层：标签基线
    for lv, ds in bylv.items():
        if lv is None:
            continue
        table[(lv, None, None)] = {"med": st.median(ds), "n": len(ds),
                                   "all_med": st.median(ds)}
    return table, cells


def predict(r, table, rows_med):
    """
    回退链：
      1. (lv, nps档, hold档)  样本≥4 → 高置信
      2. (lv, nps档)          样本≥4 → 中置信
      3. (lv,)                → 低置信（仅难度基线）
      4. 全局中位              → 兜底
    """
    lv, ni, hi = key(r)
    for k, conf in (((lv, ni, hi), "high"),
                    ((lv, ni, None), "mid"),
                    ((lv, None, None), "low")):
        if k in table and table[k]["n"] >= MIN_N:
            return table[k]["med"], conf, f"{k} n={table[k]['n']}"
    return rows_med, "none", "全局兜底"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(
        BASE, "..", "data", "official.jsonl"),
        help="官谱真源（含 NPS / Hold / stair 等特征）")
    ap.add_argument("--out", default=os.path.join(
        BASE, "..", "data", "formula.json"),
        help="公式查表输出")
    ap.add_argument("--eval", action="store_true")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(os.path.abspath(args.data), encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0]
    med = st.median([r["difficulty"] for r in rows])
    print(f"[load] 官谱 {len(rows)} 条，全局定数中位 {med}")

    # ---------- 分层基线表 ----------
    print("\n" + "=" * 76)
    print("分层基线（难度标签 → 定数中位）")
    print("=" * 76)
    for lv in LEVELS:
        s = [r["difficulty"] for r in rows if norm_level(r.get("level")) == lv]
        if s:
            print(f"  {lv:<3} n={len(s):<4} 定数 {min(s):.1f}~{max(s):.1f} "
                  f"中位 {st.median(s):.1f}")

    # ---------- 分层 × NPS ----------
    print("\n" + "=" * 76)
    print("分层 × NPS 档 → 定数中位")
    print("=" * 76)
    for lv in LEVELS:
        sub = [r for r in rows if norm_level(r.get("level")) == lv]
        if not sub:
            continue
        print(f"\n  【{lv}】 n={len(sub)}")
        print("  NPS档".ljust(12) + "".join(
            (f"{NPS_EDGES[i]}-{NPS_EDGES[i+1] if NPS_EDGES[i+1]<100 else '+'}")
            .rjust(10) for i in range(len(NPS_EDGES) - 1)))
        for i in range(len(NPS_EDGES) - 1):
            c = [r["difficulty"] for r in sub
                 if bucket(r["nps"], NPS_EDGES) == i]
            lab = f"{NPS_EDGES[i]}-{NPS_EDGES[i+1] if NPS_EDGES[i+1]<100 else '+'}"
            line = "  " + lab.ljust(12)
            line += (f"{st.median(c):>9.1f}*" if len(c) >= MIN_N
                     else (f"{st.median(c):>9.1f} " if c else "        — "))
            if c:
                line += f"  (n={len(c)})"
            print(line)

    # ---------- 精度评估 ----------
    if args.eval:
        print("\n" + "=" * 76)
        print("留一法（LOO）精度评估 —— 每条留出，用其余建表")
        print("=" * 76)
        errs = []
        conf_cnt = {}
        for i, r in enumerate(rows):
            sub = rows[:i] + rows[i + 1:]
            t, _ = build(sub)
            m2 = st.median([x["difficulty"] for x in sub])
            p, conf, _ = predict(r, t, m2)
            errs.append(abs(p - r["difficulty"]))
            conf_cnt[conf] = conf_cnt.get(conf, 0) + 1
        errs.sort()
        n = len(errs)
        print(f"  总体 |误差| 中位 {errs[n//2]:.3f}  p75 {errs[int(n*.75)]:.3f}"
              f"  p90 {errs[int(n*.90)]:.3f}  p95 {errs[int(n*.95)]:.3f}")
        print(f"  ≤0.5 {sum(1 for e in errs if e<=0.5)/n*100:.1f}%"
              f"   ≤1.0 {sum(1 for e in errs if e<=1.0)/n*100:.1f}%"
              f"   ≤1.5 {sum(1 for e in errs if e<=1.5)/n*100:.1f}%")
        print(f"  置信分布: {conf_cnt}")

        # 分置信度的误差
        print("\n  分置信度误差：")
        for i, r in enumerate(rows):
            sub = rows[:i] + rows[i + 1:]
            t, _ = build(sub)
            m2 = st.median([x["difficulty"] for x in sub])
            p, conf, _ = predict(r, t, m2)
            r["_conf"] = conf
            r["_err"] = abs(p - r["difficulty"])
        for conf in ("high", "mid", "low", "none"):
            e = sorted(x["_err"] for x in rows if x["_conf"] == conf)
            if e:
                print(f"    {conf:<5} n={len(e):<4} 中位 {e[len(e)//2]:.3f}"
                      f"  p90 {e[min(int(len(e)*.9),len(e)-1)]:.3f}")

    # ---------- 保存 ----------
    table, _ = build(rows)
    ser = {
        "version": "v2",
        "method": "难度标签分层 × NPS档 × Hold%档 查表",
        "nps_edges": NPS_EDGES,
        "hold_edges": HOLD_EDGES,
        "levels": LEVELS,
        "min_n": MIN_N,
        "table": {f"{k[0]}|{k[1]}|{k[2]}" if k[1] is not None and k[2] is not None
                  else (f"{k[0]}|" if k[1] is None else f"{k[0]}|{k[1]}|-"): v
                  for k, v in table.items()},
        "global_median": med,
        "n_official": len(rows),
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(ser, f, ensure_ascii=False, indent=1)
    print(f"\n[saved] {out}  ({len(table)} 格)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
