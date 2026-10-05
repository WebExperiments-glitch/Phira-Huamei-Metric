#!/usr/bin/env python3
"""
P.H.M. 命令行报告生成器

用法：
  python phm/cli.py --model data/official.jsonl \
                    --chart data/community.jsonl --id 22681
  python phm/cli.py --model data/official.jsonl \
                    --chart data/community.jsonl --batch
"""
import argparse
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
sys.path.insert(0, BASE)

from core import Verdict                                # noqa


def fmt(v, n=2):
    return "-" if v is None else f"{v:.{n}f}"


def make_report(vd, r, peer_median=None, exclude=None):
    """生成单张谱的显影报告

    exclude：官谱自检时传入被查询的那一行，避免其在「官谱参照」里
             以 100% 相似度自我印证（无意义）。
    """
    nps = r.get("nps") or 0
    hr = (r.get("t_hold") or 0) / max(r.get("notes_real", 1), 1)
    notes = r.get("notes_real", 0)
    stair = r.get("stair_speed_avg", 0) or 0
    lv = r.get("level") or ""
    diff = r.get("difficulty") or 0

    lo, hi, mid, conf, basis = vd.reference_range(nps, hr, lv)
    feats = vd.compare(nps, hr, notes, stair, lv)
    similar = vd.similar_official(nps, hr, notes, lv, top=5, exclude=exclude)
    checks = vd.hard_checks(diff, lv, peer_median)

    lines = []
    A = lines.append
    A("=" * 68)
    A(f"  {r.get('name','?')}   [{lv or '(无标签)'}]   标注定数 {diff:.1f}")
    A("=" * 68)
    A(f"  物量 {notes}   判定线 {r.get('lines','?')}   "
      f"NPS {nps:.2f}   时长 {fmt(r.get('duration_s'),1)}s")
    if r.get("charter"):
        A(f"  谱师 {r['charter']}")
    A("")

    # ---- 参考区间 ----
    A("─" * 68)
    A("【参考区间】—— 基于官谱实测映射，非「你的定数是多少」")
    A("─" * 68)
    if conf == "high" or conf == "mid":
        A(f"  同类定数区间   [{lo:.1f}, {hi:.1f}]   中位 {mid:.1f}")
        A(f"  置信度         {conf}（{basis}）")
        if diff < lo:
            A(f"  你的标注 {diff:.1f} 低于区间下界（同类通常更高）")
        elif diff > hi:
            A(f"  你的标注 {diff:.1f} 高于区间上界（同类通常更低）")
        else:
            A(f"  你的标注 {diff:.1f} 落在区间内")
    else:
        A(f"  参考中位       {mid:.1f}（置信度低：{basis}）")
        A("  ⚠ 同标签无官谱样本可比，区间不可靠")
    A("")

    # ---- 特征差异 ----
    if feats:
        A("─" * 68)
        A("【特征对照】—— 你和同难度标签官谱的差距")
        A("─" * 68)
        A(f"  {'特征':<20}{'你的值':>10}{'同类中位':>10}"
          f"{'百分位':>9}{'偏离':>9}  说明")
        A("  " + "-" * 66)
        for f in feats:
            A(f"  {f['label']:<20}{f['val']:>10.2f}"
              f"{f['peer_median']:>10.2f}"
              f"{f['percentile']:>8.0f}%{f['delta_pct']:>8.0f}%  {f['tag']}")
        A("")
        # 自动解读
        up = [f for f in feats if f["delta_pct"] > 15]
        dn = [f for f in feats if f["delta_pct"] < -15]
        if up or dn:
            A("  解读：")
            if up:
                A("    偏高 → " + "、".join(
                    f["label"].split("（")[0] for f in up))
            if dn:
                A("    偏低 → " + "、".join(
                    f["label"].split("（")[0] for f in dn))
            A("    注：Hold占比高表示强度分散（单次操作持续成本高），"
              "非正向难度因子")
        else:
            A("  解读：各项特征均接近同类中位")
        A("")

    # ---- 官谱参照 ----
    if similar:
        A("─" * 68)
        A("【官谱参照】—— 与你最相似的官谱及其定价")
        A("─" * 68)
        A(f"  {'曲名':<24}{'难度':<5}{'定数':>6}{'相似度':>9}"
          f"{'NPS':>7}{'物量':>7}")
        A("  " + "-" * 62)
        for s in similar:
            A(f"  {s['name'][:22]:<24}{s['level']:<5}"
              f"{s['difficulty']:>6.1f}{s['similarity']*100:>8.1f}%"
              f"{s['nps']:>7.2f}{s['notes_real']:>7}")
        ds = [s["difficulty"] for s in similar]
        if ds:
            A(f"  → 这 {len(ds)} 首官谱的定价为 "
              f"{min(ds):.1f} ~ {max(ds):.1f}")
        A("")

    # ---- 硬判据 ----
    A("─" * 68)
    A("【事实性检查】—— 不依赖模型，可直接核验")
    A("─" * 68)
    for c in checks:
        icon = "✗" if not c["pass"] else "✓"
        A(f"  {icon} [{c['level']:<8}] {c['msg']}")
        A(f"      依据：{c['basis']}")
    A("")

    A("─" * 68)
    A("【本工具不做的事】")
    A("─" * 68)
    A("  · 不判定「虚标」——官方定数本身噪声 2.80 级，任何工具无法区分")
    A("    「谱师标错」与「官方也会这么标」")
    A("  · 不给单一数字——只给区间。定数的 0.1 是滑块机械精度，")
    A("    不是语义精度（实测整数定数比一位小数常用 3.9 倍）")
    A("  · 所有计算可复现 —— 官谱 {n} 条，"
      "每个数字都能追溯到具体样本".format(n=vd.n_official))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True,
                    help="官谱真源 data/official.jsonl")
    ap.add_argument("--chart", default="",
                    help="社区谱真源 data/community.jsonl")
    ap.add_argument("--id", type=int, help="单谱报告")
    ap.add_argument("--name", help="按曲名查")
    ap.add_argument("--batch", action="store_true", help="批量生成全部")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    base = os.path.join(BASE, "..", "data")
    mp = args.model if os.path.isabs(args.model) else os.path.join(
        BASE, "..", args.model)
    vd = Verdict(mp)

    if not args.chart:
        # 自检：对官谱跑一遍，看引擎是否正确
        print(f"[engine] 官谱 {vd.n_official} 条，建表 {len(vd.table)} 格")
        print("[engine] 自检：取一条官谱做报告（官谱参照中排除其自身）")
        r = dict(vd.rows[100])
        # 用 dict 副本查询，但 exclude 必须指向【表内同一行对象】，故用身份匹配
        exclude = vd.rows[100]
        print(make_report(vd, r, exclude=exclude))
        return 0

    cp = args.chart if os.path.isabs(args.chart) else os.path.join(
        BASE, "..", args.chart)
    com = [json.loads(l) for l in open(cp, encoding="utf-8")]
    com = [r for r in com if r.get("notes_real", 0) >= 50
           and (r.get("difficulty") or 0) > 0]

    if args.id:
        r = next(x for x in com if x.get("id") == args.id)
        print(make_report(vd, r, exclude=r))
        return 0

    if args.name:
        cands = [x for x in com
                 if args.name.lower() in (x.get("name") or "").lower()]
        if not cands:
            print(f"[abort] 未找到 {args.name}")
            return 1
        r = cands[0]
        print(make_report(vd, r, exclude=r))
        return 0

    if args.batch:
        outdir = args.out or os.path.join(BASE, "..", "reports")
        os.makedirs(outdir, exist_ok=True)
        idx = []
        for i, r in enumerate(com, 1):
            txt = make_report(vd, r, exclude=r)
            with open(os.path.join(outdir, f"{r['id']}.txt"), "w",
                      encoding="utf-8") as f:
                f.write(txt)
            lo, hi, mid, conf, _ = vd.reference_range(
                r.get("nps") or 0,
                (r.get("t_hold") or 0) / max(r.get("notes_real", 1), 1),
                r.get("level") or "")
            flags = [c for c in vd.hard_checks(
                r.get("difficulty") or 0, r.get("level") or "")
                if not c["pass"]]
            idx.append({
                "id": r["id"], "name": r.get("name"),
                "level": r.get("level"),
                "difficulty": r.get("difficulty"),
                "range": [lo, hi], "mid": mid, "conf": conf,
                "flags": len(flags),
                "nps": r.get("nps"), "notes": r.get("notes_real"),
            })
            if i % 2000 == 0:
                print(f"  [{i}/{len(com)}]")
        with open(os.path.join(outdir, "index.jsonl"), "w",
                  encoding="utf-8") as f:
            for x in idx:
                f.write(json.dumps(x, ensure_ascii=False) + "\n")
        print(f"[done] {len(idx)} 份报告 → {outdir}")
        return 0

    # 交互式示例
    print(f"[engine] 官谱 {vd.n_official} 条 | 社区谱 {len(com)} 条")
    r = com[0]
    print(make_report(vd, r, exclude=r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
