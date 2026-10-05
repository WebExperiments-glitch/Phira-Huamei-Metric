#!/usr/bin/env python3
"""
语料完整性审计 —— 写模型之前的最后一道闸门

设计原则：
  审计不通过，就不允许进入建模阶段。每条检查都给出明确的通过/失败判据，
  不留「看起来还行」的模糊地带。

三层检查：
  A. 物理完整性 —— 文件完整、格式可识别、结构自洽
  B. 时间轴正确性 —— beat 换算是否与官方一致
  C. 统计一致性 —— manifest 与原始文件是否一致、有无系统性偏差

关键教训（2026-10-04）：
  ⚠️ 扩展名完全不可信。语料里有 870 张「扩展名是 .json 但内容是文本指令」
     的 PEC 谱面。格式识别必须看内容。
  ⚠️ 不能假设所有谱面都是 RPE。语料有 RPE / PEC / PECTX 三种。

用法：
  python audit_corpus.py --full --check-timeline
  python audit_corpus.py --sample 800
"""
import argparse
import json
import os
import random
import re
import statistics as st
import sys
from collections import Counter

BASE = os.path.dirname(os.path.abspath(__file__))
CHARTS = os.path.abspath(os.path.join(BASE, "..", "data", "charts"))
MANIFEST = os.path.join(CHARTS, "manifest.jsonl")

FAIL, WARN, PASS = [], [], []


def ok(msg):
    PASS.append(msg); print(f"  [PASS] {msg}")


def fail(msg):
    FAIL.append(msg); print(f"  [FAIL] {msg}")


def warn(msg):
    WARN.append(msg); print(f"  [WARN] {msg}")


# ============================================================
# 格式识别 —— 必须看内容，扩展名不可信
# ============================================================
def detect_format(path):
    """
    返回 (fmt, json_obj, note_msg)
      rpe    JSON + BPMList，音符在 judgeLineList[].notes
      pec    JSON + notesAbove/notesBelow
      pectx  文本格式，以 bp/cp/cm/n1 等指令开头
    """
    try:
        with open(path, "rb") as f:
            head = f.read(64).lstrip()
    except OSError as e:
        return None, None, f"读取失败: {e}"
    if head[:1] != b"{":
        return "pectx", None, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            j = json.load(f)
    except Exception as e:
        return None, None, f"JSON 解析失败: {type(e).__name__}"
    if "BPMList" in j:
        return "rpe", j, None
    lines = j.get("judgeLineList") or []
    if lines and "notesAbove" in lines[0]:
        return "pec", j, None
    return "unknown", j, "缺 BPMList 且无 notesAbove"


# ============================================================
# A. 物理完整性
# ============================================================
def audit_physical(recs, root):
    print("\n" + "=" * 72)
    print("A. 物理完整性")
    print("=" * 72)

    missing, unreadable, notes = [], [], []
    bad_sum, zero_notes, no_bpm = [], [], []
    type_counter = Counter()
    rpe_seen = Counter()
    beat_bad = 0
    pectx_cmds = Counter()
    fmt_ids = {"rpe": [], "pec": [], "pectx": [], "unknown": []}

    for r in recs:
        d = os.path.join(root, str(r["id"]))
        cj = os.path.join(d, "chart.json")

        if not os.path.exists(cj):
            missing.append(r["id"])
            continue

        fmt, j, msg = detect_format(cj)
        if fmt is None:
            unreadable.append((r["id"], msg))
            continue
        fmt_ids[fmt].append(r["id"])

        if fmt == "pectx":
            try:
                with open(cj, "r", encoding="utf-8", errors="replace") as f:
                    txt = f.read(16384)
                for line in txt.splitlines():
                    t = line.split(" ")[0].strip()
                    if t:
                        pectx_cmds[t] += 1
            except OSError:
                pass
            continue

        lines = j.get("judgeLineList")
        if not isinstance(lines, list):
            unreadable.append((r["id"], "judgeLineList 非列表"))
            continue

        if fmt == "rpe":
            bpm = j.get("BPMList")
            if not bpm:
                no_bpm.append(r["id"])
            rpe_seen[(j.get("META") or {}).get("RPEVersion")] += 1

        tot = {"t_tap": 0, "t_hold": 0, "t_drag": 0, "t_flick": 0}
        for ln in lines:
            if fmt == "rpe":
                for n in (ln.get("notes") or []):
                    # ⚠️ 必须先剔除假音符，否则与 manifest.notes_real 不一致
                    if n.get("isFake") == 1:
                        continue
                    k = {1: "t_tap", 2: "t_hold", 3: "t_drag", 4: "t_flick"}.get(n.get("type"))
                    if k:
                        tot[k] += 1
                    stt = n.get("startTime")
                    if isinstance(stt, list) and len(stt) == 3:
                        a, b, c = stt
                        if not all(isinstance(v, (int, float)) for v in (a, b, c)):
                            beat_bad += 1
                        elif c == 0 or a < 0 or b < 0:
                            beat_bad += 1
                    else:
                        beat_bad += 1
            elif fmt == "pec":
                for key in ("notesAbove", "notesBelow"):
                    for n in (ln.get(key) or []):
                        k = {1: "t_tap", 2: "t_hold", 3: "t_drag", 4: "t_flick"}.get(n.get("type"))
                        if k:
                            tot[k] += 1

        s = sum(tot.values())
        if fmt != "pectx" and s != r["notes_real"]:
            bad_sum.append((r["id"], s, r["notes_real"], fmt))
        if r["notes_real"] == 0:
            zero_notes.append(r["id"])
        for k, v in tot.items():
            type_counter[k] += v

    n = len(recs)
    (ok if not missing else fail)(
        f"chart.json 存在：{n-len(missing)}/{n}"
        + (f"，缺 {len(missing)}：{missing[:5]}" if missing else ""))
    (ok if not unreadable else fail)(
        f"内容可解析：{n-len(unreadable)-len(fmt_ids['pectx'])}/{n} 为JSON"
        + (f"，失败 {len(unreadable)}：{unreadable[:3]}" if unreadable else ""))

    # ---- 格式分布 ----
    print(f"\n  格式识别（按内容，扩展名不可信）：")
    print(f"    RPE   (JSON+BPMList)   : {len(fmt_ids['rpe'])}")
    print(f"    PEC   (JSON+notesAbove): {len(fmt_ids['pec'])}  {fmt_ids['pec'][:8]}")
    print(f"    PECTX (文本指令格式)   : {len(fmt_ids['pectx'])}  ← 扩展名为 .json 但内容是文本")
    print(f"    UNKNOWN               : {len(fmt_ids['unknown'])}")
    if pectx_cmds:
        print(f"\n  PECTX 指令类型 TOP12（这批需独立解析器）：")
        for k, v in pectx_cmds.most_common(12):
            print(f"    {k:<8} {v}")

    (ok if not bad_sum else fail)(
        f"音符类型和不守恒：{len(bad_sum)} 处"
        + (f"，例：{bad_sum[:3]}" if bad_sum else "（manifest 与文件完全一致）"))
    (ok if not beat_bad else fail)(
        f"startTime 三元组：{beat_bad} 处异常"
        + ("（全部合法 [a,b,c]）" if not beat_bad else ""))
    (ok if not zero_notes else warn)(
        f"物量=0 的谱：{len(zero_notes)} 张"
        + (f"，例：{zero_notes[:5]}" if zero_notes else ""))
    (ok if not no_bpm else warn)(
        f"RPE 无 BPM 定义：{len(no_bpm)} 张 —— 时间轴不可换算，须单独标记")

    t = sum(type_counter.values())
    print(f"\n  JSON 谱音符总计：{t:,}")
    for k, lab in [("t_tap", "Tap"), ("t_hold", "Hold"),
                   ("t_drag", "Drag"), ("t_flick", "Flick")]:
        if t:
            print(f"    {lab:<6} {type_counter[k]:>9,}  {type_counter[k]/t*100:5.2f}%")
    print(f"\n  RPE 版本：{dict(sorted(rpe_seen.items(), key=lambda x: (x[0] is None, x[0])))}")

    return {"fmt_ids": fmt_ids, "bad_sum": bad_sum, "zero_notes": zero_notes,
            "no_bpm": no_bpm, "missing": missing, "unreadable": unreadable,
            "type_counter": type_counter}


# ============================================================
# B. 时间轴正确性
# ============================================================
def beat(t):
    """RPE beat: a + b/c  ← 官方 Triple::beats() 实现，竞品漏了 b 项"""
    a, b, c = t
    return a + b / c if c else a


def audit_timeline(recs, root, fmt_ids):
    print("\n" + "=" * 72)
    print("B. 时间轴正确性（beat 换算专项）")
    print("=" * 72)

    multi_bpm, neg, bpm_zero, malformed = [], [], [], []
    durations = []
    okc = 0
    rpe_set = set(fmt_ids["rpe"])

    for r in recs:
        if r["id"] not in rpe_set:
            continue
        cj = os.path.join(root, str(r["id"]), "chart.json")
        if not os.path.exists(cj):
            continue
        _, j, _ = detect_format(cj)
        if j is None:
            continue

        bpm = j.get("BPMList") or []
        if len(bpm) > 1:
            multi_bpm.append(r["id"])
        for b in bpm:
            v, stt = b.get("bpm"), b.get("startTime")
            if v is None or v <= 0:
                bpm_zero.append(r["id"]); continue
            if not (isinstance(stt, list) and len(stt) == 3):
                malformed.append(r["id"])
            elif stt[0] < 0 or stt[1] < 0 or stt[2] < 0:
                neg.append((r["id"], stt))

        if len(bpm) == 1 and bpm[0].get("bpm"):
            ends = []
            for ln in (j.get("judgeLineList") or []):
                for n in (ln.get("notes") or []):
                    if n.get("isFake") == 1:
                        continue
                    for key in ("endTime", "startTime"):
                        t = n.get(key)
                        if isinstance(t, list) and len(t) == 3 and t[2] != 0 and t[0] >= 0:
                            ends.append(beat(t))
            if ends:
                mx = max(ends)
                durations.append((r["id"], 60.0 / bpm[0]["bpm"] * mx, r["notes_real"]))
                okc += 1

    (ok if not malformed else fail)(f"startTime 格式：{len(malformed)} 处异常")
    (ok if not bpm_zero else fail)(f"非法 BPM（≤0/None）：{len(bpm_zero)} 处 —— 会除零")
    (ok if not neg else warn)(
        f"负数 beat：{len(neg)} 处 —— 官方 BpmList::new 同样不检查，解析器须保证不崩"
        + (f"，例：{neg[:3]}" if neg else ""))
    (ok if not multi_bpm else warn)(
        f"多 BPM 段：{len(multi_bpm)} 张 —— 解析器必须逐段累计")

    print(f"\n  单 BPM 谱可估算时长：{okc} 张")
    if durations:
        secs = [d[1] for d in durations]
        print(f"    范围 {min(secs):.1f}s ~ {max(secs):.1f}s，中位 {st.median(secs):.1f}s")
        weird = [d for d in durations if d[1] > 1800]
        (ok if not weird else warn)(
            f"可疑超长谱（>30min）：{len(weird)} 张" + (f"，例：{weird[:3]}" if weird else ""))
        dbl = [d for d in durations if d[1] < 20 and d[2] > 200]
        (ok if not dbl else fail)(
            f"「低时长高物量」异常：{len(dbl)} 张"
            + "（若存在，疑似 beat 换算漏 b 项）" if dbl
            else "「低时长高物量」异常：0 张 —— 排除 beat 换算 4 倍误差")

    print("\n  公式（已从 Phira 源码 prpr/src/core.rs 逐字确认）：")
    print("    beats   = a + b/c                          ← 不是 a/c")
    print("    seconds = 累计时间 + (beats-段起点) × (60/bpm)")
    print("    bpmfactor 全量为 1.0 → 退化为 seconds = 60/BPM × beat")


# ============================================================
# C. 统计一致性
# ============================================================
def audit_stats(recs, phys):
    print("\n" + "=" * 72)
    print("C. 统计一致性")
    print("=" * 72)

    f32, oob = [], []
    for r in recs:
        d = r.get("difficulty")
        if isinstance(d, (int, float)):
            n = round(d * 10) / 10
            if abs(d - n) > 1e-4:
                f32.append((r["id"], d, n))
            if d < 0 or d > 20:
                oob.append((r["id"], d))
    z = [r["id"] for r in recs if r["difficulty"] == 0]

    (ok if True else fail)(
        f"difficulty f32 伪影：{len(f32)} 个需 round(x*10)/10"
        + (f"，例：{f32[:3]}" if f32 else ""))
    (ok if not oob else warn)(f"difficulty 超界 [0,20]：{len(oob)} 张")
    (ok if not z else warn)(f"difficulty = 0：{len(z)} 张（元数据缺失，建模须过滤）")

    lv_re = re.compile(r"Lv\.\s*(\d+(?:\.\d+)?)", re.I)
    uk_re = re.compile(r"^uk\b", re.I)
    no_lv, uk, mis_web, mis_strict = 0, 0, 0, 0
    prefixes = Counter()
    for r in recs:
        lv = (r.get("level") or "").strip()
        if not lv:
            no_lv += 1; continue
        if uk_re.search(lv):
            uk += 1; continue
        m = lv_re.search(lv)
        if not m:
            no_lv += 1
        else:
            num, d = float(m.group(1)), r["difficulty"]
            if abs(num - int(d)) < 1e-6:
                mis_strict += 1
            if abs(num - d) >= 1:
                mis_web += 1
        low = lv.lower()
        cut = low.find("lv.")
        prefixes[(lv[:cut] if cut > 0 else (lv.split()[0] if lv.split() else "?")).strip().upper()[:8]] += 1

    print(f"\n  level 字段（n={len(recs)}）：")
    print(f"    无 Lv 数字或为空：{no_lv}（{no_lv/len(recs)*100:.1f}%）")
    print(f"    UK 开头（跳过校验）：{uk}")
    print(f"    官方前端规则告警：{mis_web}（{mis_web/len(recs)*100:.2f}%）")
    print(f"    严格规则告警（floor(diff)!=Lv）：{mis_strict}")
    print(f"\n    前缀 TOP15（前缀才是难度语义）：")
    for p, c in prefixes.most_common(15):
        print(f"      {p:<10} {c:>6}")

    nl = sorted(r["notes_real"] for r in recs if r["notes_real"] > 0)
    if nl:
        print(f"\n  物量分布：min={nl[0]} p25={nl[len(nl)//4]} 中位={nl[len(nl)//2]} "
              f"p75={nl[len(nl)*3//4]} max={nl[-1]}")
        print(f"    均值={st.mean(nl):.1f}（远高于中位=右偏，勿用均值）")
        print(f"    ⚠️ max/中位 = {nl[-1]/nl[len(nl)//2]:.1f} 倍")
    dv = sorted(r["difficulty"] for r in recs
                if isinstance(r.get("difficulty"), (int, float)) and 0 < r["difficulty"] <= 20)
    if dv:
        print(f"\n  定数分布（0<diff≤20, n={len(dv)}）：中位 {dv[len(dv)//2]:.1f} "
              f"均值 {st.mean(dv):.2f} max {dv[-1]:.1f}")
        print(f"    {dict(sorted(Counter(int(x) for x in dv).items()))}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--check-timeline", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        print(f"[abort] manifest 不存在：{MANIFEST}")
        return 1

    recs = {}
    for l in open(MANIFEST, encoding="utf-8"):
        r = json.loads(l)
        recs[r["id"]] = r
    recs = list(recs.values())
    print(f"[load] manifest {len(recs)} 条（去重后）")

    if args.sample and not args.full:
        random.seed(42)                     # 固定种子，可复现
        recs = random.sample(recs, min(args.sample, len(recs)))
        print(f"[load] 抽样 {len(recs)} 张（seed=42）")

    phys = audit_physical(recs, CHARTS)
    if args.check_timeline:
        audit_timeline(recs, CHARTS, phys["fmt_ids"])
    audit_stats(recs, phys)

    print("\n" + "=" * 72)
    print(f"审计结论：PASS={len(PASS)}  WARN={len(WARN)}  FAIL={len(FAIL)}")
    print("=" * 72)
    if FAIL:
        print("\n❌ 存在 FAIL，禁止进入建模阶段：")
        for m in FAIL:
            print(f"   - {m}")
        return 2
    if WARN:
        print("\n⚠️ WARN（建模须显式处理）：")
        for m in WARN:
            print(f"   - {m}")
    print("\n✅ 物理完整性通过，可进入建模阶段。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
