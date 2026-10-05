#!/usr/bin/env python3
"""
官方模型应用 + 虚标检测器

输入：社区谱特征 + 官方模型
输出：每张谱的客观定数参考、偏差、虚标判定

三档判定（按可信度分级，不搞二元论）：
  1. 合规区间     |diff| ≤ 1.0   → 不可判定，官方自身噪声就在此范围
  2. 关注         1.0 < |diff| ≤ 2.0 → 建议复核
  3. 疑似虚标     |diff| > 2.0   → 超出官方标注波动的 95 分位

额外硬判据（不依赖模型）：
  · 定数 > 18.0        超出官方历史最高
  · 难度标签与定数区间矛盾
"""
import argparse
import collections
import json
import math
import os
import statistics as st
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# 官方定数的难度区间（实测 1,037 条官谱）
# IN: 7.0~17.0  HD: 3.5~14.0  AT: 13.4~18.0  EZ: 0.5~10.0
LEVEL_RANGE = {
    "EZ": (0.0, 10.5),
    "HD": (3.0, 14.5),
    "IN": (6.5, 17.5),
    "AT": (13.0, 18.0),
    "SP": None,          # 无定级
}
MAX_OFFICIAL = 18.0      # 官方历史最高（DesultorySignals AT）

# ★ 护栏：模型在官谱训练集上拟合，社区谱特征分布更宽。
#   若不裁剪，分布外样本会让线性外推发散（实测 pred 从 -1298 到 +51，
#   根源是 pct_hold 权重 −7.21 遇到极端占比）。
#   做法：把每个特征裁剪到官谱训练集的 [p1, p99] 范围。
#   这是「模型只在训练分布内有效」的正确表达，不是掩盖问题。
CLIP_LO, CLIP_HI = 0.01, 0.99


def load_clip(model_path):
    """从训练数据重算每个特征的 p1/p99，用于裁剪。"""
    import statistics as _st
    m = json.load(open(model_path, encoding="utf-8"))
    return m


def clip_to_train_range(x, lo, hi):
    return [min(hi[i], max(lo[i], v)) for i, v in enumerate(x)]


def build_x(r, feats):
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
        "peak_ratio": r.get("strain_peak_ratio") or 0,
        "iv_med_scaled": (r.get("iv_median") or 0.2) / 0.2,
    }
    return [x.get(f, 0.0) for f in feats]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--train", default="data/official/manifest_enhanced.jsonl",
                    help="官谱训练数据，用于计算裁剪范围")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    m = json.load(open(args.model, encoding="utf-8"))
    w, mu, b0, feats = m["w"], m["mu"], m["b0"], m["features"]
    print(f"[model] {len(feats)} 特征，λ={m.get('lam')}")

    # ---- 裁剪范围：官谱训练集的分位数 ----
    train_path = os.path.abspath(args.train)
    clip_lo = [float("-inf")] * len(feats)
    clip_hi = [float("inf")] * len(feats)
    if os.path.exists(train_path):
        tr = [json.loads(l) for l in open(train_path, encoding="utf-8")]
        tr = [r for r in tr if r.get("strain_peak") is not None
              and r.get("notes_real", 0) > 0]
        cols = []
        for r in tr:
            cols.append(build_x(r, feats))
        for j in range(len(feats)):
            v = sorted(c[j] for c in cols)
            n = len(v)
            clip_lo[j] = v[int(n * CLIP_LO)]
            clip_hi[j] = v[min(int(n * CLIP_HI), n - 1)]
        print(f"[clip] 训练分布 p1~p99（{len(tr)} 条）")
        for j, f in enumerate(feats):
            print(f"    {f:<18} [{clip_lo[j]:>8.3f}, {clip_hi[j]:>8.3f}]")
    else:
        print("[clip] 未找到训练数据，跳过裁剪（可能发散）")

    rows = [json.loads(l) for l in open(args.data, encoding="utf-8")]
    rows = [r for r in rows if r.get("strain_peak") is not None
            and r.get("notes_real", 0) >= 100
            and 0 < (r.get("difficulty") or 0) <= 20]
    print(f"[data] 有效样本 {len(rows)}")

    n_clip = 0
    for r in rows:
        x = clip_to_train_range(build_x(r, feats), clip_lo, clip_hi)
        if x != build_x(r, feats):
            n_clip += 1
        r["pred"] = b0 + sum(w[j] * (x[j] - mu[j]) for j in range(len(w)))
        r["delta"] = r["difficulty"] - r["pred"]

    print(f"[clip] 触发裁剪的样本：{n_clip} ({n_clip/max(len(rows),1)*100:.2f}%)")
    ps = sorted(r["pred"] for r in rows)
    print(f"[pred] 范围 {ps[0]:.1f} ~ {ps[-1]:.1f}  中位 {st.median(ps):.1f}")

    d = [r["delta"] for r in rows]
    print(f"\n[偏差分布] 均值 {st.mean(d):+.3f}  中位 {st.median(d):+.3f}  "
          f"sd {st.pstdev(d):.3f}")
    pct = sorted(abs(x) for x in d)
    print(f"  |delta| 中位 {pct[len(pct)//2]:.3f}  p90 {pct[int(len(pct)*.9)]:.3f}  "
          f"p95 {pct[int(len(pct)*.95)]:.3f}")

    # 判定
    for r in rows:
        ad = abs(r["delta"])
        if ad > 2.0:
            verdict = "疑似虚标"
        elif ad > 1.0:
            verdict = "建议复核"
        else:
            verdict = "合规区间"
        flags = []
        if r["difficulty"] > MAX_OFFICIAL:
            flags.append(f"定数{r['difficulty']:.1f}超官方上限{MAX_OFFICIAL}")
        lv = (r.get("level") or "").upper()
        pref = lv[:2] if len(lv) >= 2 else ""
        if pref in LEVEL_RANGE and LEVEL_RANGE[pref]:
            lo, hi = LEVEL_RANGE[pref]
            if r["difficulty"] > hi:
                flags.append(f"{pref}定数{r['difficulty']:.1f}超区间上限{hi}")
        r["verdict"] = verdict
        r["flags"] = flags

    cnt = collections.Counter(r["verdict"] for r in rows)
    n = len(rows)
    print(f"\n[判定分布]（n={n}）")
    for k in ("合规区间", "建议复核", "疑似虚标"):
        c = cnt.get(k, 0)
        print(f"  {k:<8} {c:>5} 张  {c/n*100:5.2f}%")

    # 按标签前缀看虚标率
    print(f"\n[按 level 前缀]")
    byp = collections.defaultdict(lambda: collections.Counter())
    for r in rows:
        lv = (r.get("level") or "").upper()
        pref = lv[:2] if len(lv) >= 2 else "??"
        byp[pref][r["verdict"]] += 1
    print(f"  {'前缀':<8}{'总数':>7}{'合规':>8}{'复核':>8}{'疑似':>8}{'疑似率':>9}{'平均偏差':>10}")
    for pref, c in sorted(byp.items(), key=lambda x: -sum(x[1].values()))[:12]:
        tot = sum(c.values())
        sus = c.get("疑似虚标", 0)
        dd = st.mean([r["delta"] for r in rows
                      if (r.get("level") or "").upper().startswith(pref)]) \
            if any((r.get("level") or "").upper().startswith(pref)
                   for r in rows) else 0.0
        print(f"  {pref:<8}{tot:>7}{c.get('合规区间',0):>8}{c.get('建议复核',0):>8}"
              f"{sus:>8}{sus/tot*100:>8.1f}%{dd:>+10.2f}")

    # 疑似虚标 TOP
    sus = sorted([r for r in rows if r["verdict"] == "疑似虚标"],
                 key=lambda x: -x["delta"])
    print(f"\n[疑似虚标 TOP20 · 标定高于实测]")
    print(f"  {'谱名':<24}{'标签':<12}{'标注':>6}{'实测':>7}{'偏差':>7}  标记")
    for r in sus[:20]:
        fl = (";".join(r["flags"])) if r["flags"] else ""
        print(f"  {r.get('name','?')[:22]:<24}{(r.get('level') or '-')[:10]:<12}"
              f"{r['difficulty']:>6.1f}{r['pred']:>7.1f}{r['delta']:>+7.1f}  {fl}")

    low = sorted([r for r in rows if r["verdict"] == "疑似虚标"],
                 key=lambda x: x["delta"])
    print(f"\n[疑似虚标 TOP20 · 标注低于实测]")
    for r in low[:20]:
        fl = (";".join(r["flags"])) if r["flags"] else ""
        print(f"  {r.get('name','?')[:22]:<24}{(r.get('level') or '-')[:10]:<12}"
              f"{r['difficulty']:>6.1f}{r['pred']:>7.1f}{r['delta']:>+7.1f}  {fl}")

    # 硬判据
    hard = [r for r in rows if r["flags"]]
    print(f"\n[硬判据命中] {len(hard)} 张")
    fc = collections.Counter()
    for r in hard:
        for x in r["flags"]:
            fc["超官方上限" if "超官方上限" in x else "标签区间矛盾"] += 1
    print(f"  {dict(fc)}")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({
                "id": r.get("id"), "name": r.get("name"),
                "level": r.get("level"), "difficulty": r.get("difficulty"),
                "pred": round(r["pred"], 2), "delta": round(r["delta"], 2),
                "verdict": r["verdict"], "flags": r["flags"],
                "notes_real": r.get("notes_real"), "nps": r.get("nps"),
                "duration_s": r.get("duration_s"),
                "strain_peak": r.get("strain_peak"),
                "stable": r.get("stable"), "ranked": r.get("ranked"),
                "fmt": r.get("fmt"),
            }, ensure_ascii=False) + "\n")
    print(f"\n[saved] {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
