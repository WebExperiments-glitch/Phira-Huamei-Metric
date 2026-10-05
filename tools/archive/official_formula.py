#!/usr/bin/env python3
"""
官谱定数公式 v1 —— NPS × Hold占比 二维表

设计依据（全部来自官谱实测，非拍脑袋）：

1. **物量分档的 IQR 只有 0.8~3.3 级**，是精度的天然下界。
2. **Hold 占比在同一物量、NPS 几乎相同的条件下，能造成 6.3 级跨度**
   （0-10% → 13.6，70-100% → 7.3）。
   物理原因：Hold 需按住至结束，一个 Hold 占用手数但不产生连续点击；
   NPS 相同意味着「每秒手数」相同，但 Hold 越多，单次操作的**持续成本**越高，
   连续点击的**密度**越低。官方据此给出显著更低的定数。

3. 因此主表用 **NPS（手数密度）× Hold 占比（操作持续性）**，
   物量作为**边界校验**而非主轴。

覆盖策略：
  · 表格只覆盖官谱实测范围
  · 超出范围**明确标记为外推**，不静默给值
  · 官谱覆盖：物量 4~2330、NPS 0.2~15、Hold% 0~100%
"""
import argparse
import bisect
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# ---- 档位定义（依据官谱分布切分，保证每格有足够样本）----
NPS_EDGES = [0, 1.5, 3, 4.5, 6, 8, 11, 100]          # 最后一档为开区间
HOLD_EDGES = [0.0, 0.10, 0.20, 0.32, 0.45, 0.62, 1.01]

LEVELS = ["EZ", "HD", "IN", "AT"]


def bucket(v, edges):
    """返回档位索引；超出上界返回 None（标记外推）"""
    if v is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def build_table(rows, min_n=6):
    """
    构建 NPS × Hold% 的定数中位数表。
    返回 (table, stats)
      table[(nps_i, hold_i)] = {level: 中位定数, "_n": 样本数, "_all": 合并中位}
    """
    cells = {}
    for r in rows:
        ni = bucket(r["nps"], NPS_EDGES)
        hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
        if ni is None or hi is None:
            continue
        cells.setdefault((ni, hi), []).append(r)

    table = {}
    for (ni, hi), sub in cells.items():
        entry = {"_n": len(sub)}
        ds = [r["difficulty"] for r in sub]
        entry["_all"] = st.median(ds)
        for lv in LEVELS:
            s = [r["difficulty"] for r in sub if r["level"] == lv]
            if len(s) >= 3:
                entry[lv] = st.median(s)
        table[(ni, hi)] = entry
    return table, cells


def predict(r, table, default_pool):
    """
    查表预测。
    返回 (值, 是否可信, 说明)
      优先用 难度前缀 专属值（样本≥3）
      退而用 合并值（样本≥min_n）
      再退到全局同物量中位
    """
    ni = bucket(r["nps"], NPS_EDGES)
    hi = bucket(r["t_hold"] / r["notes_real"], HOLD_EDGES)
    lv = (r.get("level") or "").upper()[:2]
    if ni is None or hi is None:
        return default_pool, False, "档位外推"
    e = table.get((ni, hi))
    if not e:
        return default_pool, False, "空格"
    if lv in e:
        return e[lv], True, f"{lv}专属(n={e['_n']})"
    if e["_n"] >= 6:
        return e["_all"], True, f"合并(n={e['_n']})"
    return default_pool, False, f"样本不足(n={e['_n']})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(
        BASE, "..", "data", "official.jsonl"))
    ap.add_argument("--out", default=os.path.join(
        BASE, "..", "data", "official", "formula.json"))
    ap.add_argument("--eval", action="store_true", help="在官谱上评估精度")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(os.path.abspath(args.data), encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0]
    print(f"[load] 官谱 {len(rows)} 条")

    table, cells = build_table(rows)
    print(f"[table] 非空格 {len(table)} 个（NPS {len(NPS_EDGES)-1} × Hold {len(HOLD_EDGES)-1}）")

    # ---- 输出表 ----
    print("\n" + "=" * 78)
    print("定数表：行=Hold占比档，列=NPS档")
    print("=" * 78)
    hdr = "  Hold%\\NPS ".ljust(13) + "".join(
        (f"{NPS_EDGES[i]}-{NPS_EDGES[i+1] if NPS_EDGES[i+1]<100 else '+'}").rjust(9)
        for i in range(len(NPS_EDGES) - 1))
    print(hdr)
    print("  " + "-" * (13 + 9 * (len(NPS_EDGES) - 1)))
    for hi in range(len(HOLD_EDGES) - 1):
        lab = f"{HOLD_EDGES[hi]*100:.0f}-{HOLD_EDGES[hi+1]*100:.0f}%"
        line = "  " + lab.ljust(13)
        for ni in range(len(NPS_EDGES) - 1):
            e = table.get((ni, hi))
            line += (f"{e['_all']:>8.1f}*" if e and e["_n"] >= 6
                     else (f"{e['_all']:>8.1f} " if e else "       — "))
        print(line)
    print("  （* = 样本≥6，可信）")

    # 按难度前缀分别输出
    for lv in ("IN", "AT"):
        print(f"\n  【{lv} 专属表】（样本≥3）")
        print("  Hold%\\NPS ".ljust(13) + "".join(
            f"{NPS_EDGES[i]}-{NPS_EDGES[i+1] if NPS_EDGES[i+1]<100 else '+'}".rjust(9)
            for i in range(len(NPS_EDGES) - 1)))
        for hi in range(len(HOLD_EDGES) - 1):
            lab = f"{HOLD_EDGES[hi]*100:.0f}-{HOLD_EDGES[hi+1]*100:.0f}%"
            line = "  " + lab.ljust(13)
            for ni in range(len(NPS_EDGES) - 1):
                e = table.get((ni, hi))
                line += (f"{e[lv]:>8.1f}*" if e and lv in e else "       — ")
            print(line)

    # ---- 精度评估 ----
    if args.eval:
        print("\n" + "=" * 78)
        print("官谱内精度评估（leave-one-out，避免自证）")
        print("=" * 78)
        # LOO：每次留出一条，用其余样本建表
        errs = []
        n_unc = 0
        for i, r in enumerate(rows):
            sub = rows[:i] + rows[i + 1:]
            t, _ = build_table(sub)
            pool = st.median([x["difficulty"] for x in sub])
            p, ok, _why = predict(r, t, pool)
            errs.append(abs(p - r["difficulty"]))
            if not ok:
                n_unc += 1
        errs.sort()
        n = len(errs)
        print(f"  LOO |误差| 中位 {errs[n//2]:.3f}")
        print(f"         p75    {errs[int(n*.75)]:.3f}")
        print(f"         p90    {errs[int(n*.90)]:.3f}")
        print(f"         p95    {errs[int(n*.95)]:.3f}")
        print(f"         ≤0.5   {sum(1 for e in errs if e<=0.5)/n*100:.1f}%")
        print(f"         ≤1.0   {sum(1 for e in errs if e<=1.0)/n*100:.1f}%")
        print(f"  不可信格 {n_unc} ({n_unc/n*100:.1f}%)")

    # ---- 保存 ----
    ser = {
        "nps_edges": NPS_EDGES,
        "hold_edges": HOLD_EDGES,
        "table": {f"{k[0]}_{k[1]}": v for k, v in table.items()},
        "global_median": st.median([r["difficulty"] for r in rows]),
        "n_official": len(rows),
        "coverage": {
            "notes_real": [min(r["notes_real"] for r in rows),
                           max(r["notes_real"] for r in rows)],
            "nps": [min(r["nps"] for r in rows), max(r["nps"] for r in rows)],
        },
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(ser, f, ensure_ascii=False, indent=1)
    print(f"\n[saved] {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
