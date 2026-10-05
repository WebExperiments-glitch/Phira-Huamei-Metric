#!/usr/bin/env python3
"""Validate phira.moe web front-end rule: |Lv_number - difficulty| >= 1  => levelDifficultyMismatch warning.
Also confirm display format: `${level} (${difficulty.toFixed(1)})` and rks.toFixed(2)."""
import json, os, re, math
from collections import Counter

BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
R = json.load(open(os.path.join(BASE, "regular.json"), encoding="utf-8"))["results"]

# JS: const ix=/Lv\.\s*(\d+(?:\.\d+)?)/i
ix = re.compile(r"Lv\.\s*(\d+(?:\.\d+)?)", re.I)
# JS: const Xd=/^uk\b/i ; if(/^uk\b/i.test(level.trim())) return null  -> skip check
ukd = re.compile(r"^uk\b", re.I)

def js_check(level, difficulty):
    """Faithful port of the front-end function lx()."""
    lv = (level or "").strip()
    if ukd.search(lv):
        return None
    m = ix.search(lv)
    if not m:
        return None
    return abs(float(m.group(1)) - difficulty) >= 1

print("=" * 72)
print("复现 phira.moe 前端校验规则：|Lv数字 - difficulty| >= 1  →  告警")
print("=" * 72)
flagged = [r for r in R if js_check(r.get("level"), r["difficulty"])]
print(f"regular 分区 n={len(R)}")
print(f"  触发 levelDifficultyMismatch 告警: {len(flagged)} ({len(flagged)/len(R)*100:.2f}%)")
print(f"  未触发: {len(R)-len(flagged)} ({(len(R)-len(flagged))/len(R)*100:.2f}%)")

# Among charts that HAVE a parseable Lv number
haslv = [r for r in R if ix.search((r.get("level") or "")) and not ukd.search((r.get("level") or "").strip())]
f2 = [r for r in haslv if js_check(r.get("level"), r["difficulty"])]
print(f"  仅看含可解析 Lv 数字的谱: {len(haslv)}，其中告警 {len(f2)} ({len(f2)/len(haslv)*100:.2f}%)")

print("\n  按分区状态看告警率:")
for label, sel in [("stable(已上架)", lambda r: r["stable"]),
                   ("ranked", lambda r: r["ranked"]),
                   ("未上架(unstable)", lambda r: not r["stable"])]:
    rows = [r for r in R if sel(r)]
    f = [r for r in rows if js_check(r.get("level"), r["difficulty"])]
    print(f"    {label:<18} n={len(rows):<5} 告警 {len(f):<4} ({len(f)/len(rows)*100:.2f}%)")

print("\n  告警样例 (前 20):")
for r in flagged[:20]:
    print(f"    id={r['id']:<6} level={r['level']!r:<24} diff={r['difficulty']:<12.4f} stable={r['stable']}")

print("\n" + "=" * 72)
print("对照：若按'整数部分必须等于 Lv 整数'的严格规则会误报多少")
print("=" * 72)
strict = [r for r in haslv if int(r["difficulty"]) != int(float(ix.search(r['level']).group(1)))]
print(f"  严格规则(floor(diff)==Lv整数) 告警: {len(strict)} ({len(strict)/len(haslv)*100:.2f}%)")
print(f"  官方前端规则(差值>=1)      告警: {len(f2)} ({len(f2)/len(haslv)*100:.2f}%)")
print("  → 官方规则刻意放宽：允许 |差值| < 1，即 15.9 配 'Lv.15' 合法（压线惯例被容忍）")

print("\n" + "=" * 72)
print("压线惯例的合法区间验证：difficulty=15.9 + level='IN Lv.15'")
print("=" * 72)
for d, lv in [(15.9, "IN Lv.15"), (15.9, "IN Lv.16"), (16.0, "IN Lv.16"),
              (14.9, "IN Lv.15"), (15.4, "IN Lv.15"), (15.6, "IN Lv.15")]:
    print(f"  diff={d:<5} level={lv!r:<12} →告警={js_check(lv, d)}")

print("\n" + "=" * 72)
print("展示格式确认（源码字符串）")
print("=" * 72)
print("  谱面详情页: `${level} (${difficulty.toFixed(1)})`  → 一位小数，四舍五入")
print("  谱面信息页: format!(\"{} ({:.1})\", level, difficulty)  (Rust song.rs:1302)")
print("  选曲列表页: level 不含 'Lv.' 时 write!(\" Lv.{}\", difficulty as i32)  → 截断取整，非四舍五入")
print("  游玩 HUD  : 仅绘制 info.level，完全不显示 difficulty  (prpr/src/scene/game.rs:535-539)")
print("  RKS 显示  : rks.toFixed(2)  → 两位小数")
