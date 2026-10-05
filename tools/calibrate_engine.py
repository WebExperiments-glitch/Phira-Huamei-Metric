#!/usr/bin/env python3
"""
交付引擎校准：对 phm/core.py 的 Verdict 直接做留一法（LOO）

为什么需要这个脚本
------------------
历史事故：对外公布的精度来自 tools/official_formula_v2.py，而**实际交付**给
CLI / GUI 的是 phm/core.py —— 两者档位不同（9 档 vs 5 档），等于「公布的是
另一个模型的精度」。本脚本直接测【交付引擎本体】，让报告与产物永久一致。

同时测两个指标：
  · 点估计误差   —— 参考中位与官谱标注的差（衡量「准不准」）
  · 区间覆盖率   —— 官谱标注是否落在「它自己的同类区间」内（衡量区间标定）

区间覆盖率是本项目诚实性的关键数字：
  它把「官方标注自身的离散度」直接量化。若官谱自己都只有约六成落在区间内，
  那么任何谱「落在区间外」都不构成虚标证据 —— 这正是本工具不做裁判的实证基础。

用法：
    python tools/calibrate_engine.py            # 用 data/official.jsonl
    python tools/calibrate_engine.py --limit 300  # 快速抽样
"""
import argparse
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, os.path.join(ROOT, "phm"))

from core import Verdict  # noqa: E402

DATA = os.path.join(ROOT, "data", "official.jsonl")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--limit", type=int, default=0,
                    help="只抽前 N 条（0=全部）")
    args = ap.parse_args()

    import json
    rows = [json.loads(l) for l in open(os.path.abspath(args.data),
                                       encoding="utf-8")]
    rows = [r for r in rows if r["notes_real"] > 0]
    if args.limit:
        rows = rows[:args.limit]
    n = len(rows)
    print(f"[calibrate] 官谱 {n} 条，留一法逐条评估交付引擎（Verdict）")

    errs = []
    band = {"high": 0, "mid": 0, "low": 0, "none": 0}
    hit = 0
    got = 0
    for i in range(n):
        sub = rows[:i] + rows[i + 1:]
        vd = Verdict(rows=sub)          # 直接传行，避免磁盘 IO
        r = rows[i]
        hr = r["t_hold"] / r["notes_real"]
        lo, hi, mid, conf, _ = vd.reference_range(r["nps"], hr,
                                                  r.get("level"))
        errs.append(abs(mid - r["difficulty"]))
        band[conf] = band.get(conf, 0) + 1
        if lo is not None:
            got += 1
            if lo <= r["difficulty"] <= hi:
                hit += 1

    errs.sort()
    q = lambda p: errs[min(int(n * p), n - 1)]
    print("\n" + "=" * 68)
    print("交付引擎 LOO 评估（留一法）")
    print("=" * 68)
    print(f"  点误差  中位 {q(.5):.3f}  p75 {q(.75):.3f}  "
          f"p90 {q(.90):.3f}  p95 {q(.95):.3f}")
    print(f"  ≤0.5 {sum(1 for e in errs if e <= .5)/n*100:.1f}%"
          f"   ≤1.0 {sum(1 for e in errs if e <= 1.)/n*100:.1f}%"
          f"   ≤1.5 {sum(1 for e in errs if e <= 1.5)/n*100:.1f}%")
    print(f"  置信分布 {band}")
    print()
    print(f"  区间覆盖率 {hit}/{got} = {hit/max(got,1)*100:.1f}%")
    print(f"    → 官谱自身有 {100-hit/max(got,1)*100:.1f}% 落在「自己的同类区间」之外")
    print(f"    → 因此「落在区间外」不构成虚标证据（官方也会）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
