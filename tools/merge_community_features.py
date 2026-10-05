#!/usr/bin/env python3
"""
合并社区谱特征文件

问题：特征分散在两个文件里
  manifest_features.jsonl  ← extract_community_features.py 产出
      有 nps / duration_s / strain_peak / 节奏特征
  manifest_v2.jsonl         ← add_community_dims.py 产出
      有 18 维要素 / t_tap 等类型计数

后果：只用其中之一，报告里的「NPS」会显示 0，参考区间降级为「不可信」。

解决：按 id 合并，产出单文件。
"""
import argparse
import json
import os
import statistics as st
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="基础特征（nps/时长/strain）")
    ap.add_argument("--b", required=True, help="要素特征（18维）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    A = {}
    for l in open(os.path.abspath(args.a), encoding="utf-8"):
        r = json.loads(l)
        A[r["id"]] = r
    B = {}
    for l in open(os.path.abspath(args.b), encoding="utf-8"):
        r = json.loads(l)
        B[r["id"]] = r

    print(f"[load] A={len(A)}  B={len(B)}  交集={len(set(A) & set(B))}")

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    n = 0
    miss_nps = 0
    with open(out, "w", encoding="utf-8") as f:
        for cid in sorted(set(A) | set(B)):
            a = A.get(cid, {})
            b = B.get(cid, {})
            r = dict(a)
            # b 里非空的字段覆盖/补充
            for k, v in b.items():
                if v is not None:
                    r[k] = v
            if not r.get("nps"):
                miss_nps += 1
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    print(f"[write] {n} 条 → {out}")
    print(f"[warn] 缺 nps 的 {miss_nps} 条（参考区间会降级）")

    rs = [json.loads(l) for l in open(out, encoding="utf-8")]
    need = ["nps", "duration_s", "strain_peak", "stair_speed_avg",
            "hold_interference_index", "notes_real", "t_tap"]
    print(f"\n{'字段':<28}{'覆盖率':>10}{'中位':>14}")
    print("-" * 52)
    for k in need:
        have = [r for r in rs if r.get(k) is not None]
        v = [r[k] for r in have if isinstance(r.get(k), (int, float))]
        med = st.median(v) if v else 0
        print(f"{k:<28}{len(have)/len(rs)*100:>9.1f}%{med:>14.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
