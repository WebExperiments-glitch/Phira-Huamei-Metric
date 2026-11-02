#!/usr/bin/env python3
"""生成「标称 vs 实测」差值数据 → phm-web/public/js/discrepancy-data.js

━━━ ⚠ 一个必须记住的坑（2026-11-02 踩到）━━━
Phira 的 chart 对象里有**两个**看起来像定数的字段：

    level       "IN Lv.14.5"   ← 真正的标称定数（要正则解析）
    difficulty  5.0            ← **不是同一个东西**

我们一直用的是 `difficulty`。实测 8,757 张里只有 **30%** 两个字段相等，
其余 70% 不一致（样例：level 13.0 / difficulty 10.0；level 16.0 / difficulty 0.0）。
用它算出来的"标称 vs 实测"差值全是假的（会出现 +19 级的荒谬结论）。

**判据：标称一律从 `level` 里正则取 `Lv.数字`，不要用 `difficulty`。**

━━━ 其它必须做的过滤 ━━━
1. `players ≥ 200`：低于此 b 的估计不稳
2. `level ∈ [1, 20]`：有 130 张是垃圾值（最大 9,999,999）
3. `level ≥ 5`：低于 5 的多是占位（谱师没认真填），会造出假的巨大差值
4. `|diff| ≤ 5`：超过 5 级的差值基本是数据坏，不是真难度差

用法：python tools/gen_discrepancy.py [输出路径] [条数]
"""
import json
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IRT = os.path.join(ROOT, "data", "player-irt.json")
CHARTS = os.path.join(ROOT, "data", "crawl", "charts.jsonl")
OUT = os.path.join(ROOT, "phm-web", "public", "js", "discrepancy-data.js")

MIN_PLAYERS = 200
LEVEL_RANGE = (5.0, 17.5)
MAX_DIFF = 5.0


def parse_level(s):
    """从 "IN Lv.14.5" 里取 14.5。"""
    m = re.search(r"Lv\.?\s*([0-9]+(?:\.[0-9]+)?)", s or "")
    return float(m.group(1)) if m else None


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else OUT
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 600

    irt = json.load(open(IRT, encoding="utf-8"))["items"]
    meta = {}
    for line in open(CHARTS, encoding="utf-8"):
        r = json.loads(line)
        meta[str(r["id"])] = r

    rows = []
    for cid, v in irt.items():
        b = v.get("b")
        pl = v.get("players") or 0
        if b is None or pl < MIN_PLAYERS:
            continue
        lv = parse_level((meta.get(cid) or {}).get("level"))
        if lv is None or not (LEVEL_RANGE[0] <= lv <= LEVEL_RANGE[1]):
            continue
        rows.append((cid, float(b), lv, pl))

    b = np.array([r[1] for r in rows])
    d = np.array([r[2] for r in rows])
    A = np.stack([b, np.ones_like(b)], 1)
    k, c = np.linalg.lstsq(A, d, rcond=None)[0]
    print(f"可信样本 {len(rows)} 张 · 换算 定数 ≈ {k:.2f}·b + {c:.2f}")

    items = []
    for cid, bb, lv, pl in rows:
        m = k * bb + c
        diff = m - lv
        if abs(diff) > MAX_DIFF:          # 超过 5 级基本是数据坏，不是难度差
            continue
        mc = meta.get(cid) or {}
        items.append({
            "id": cid, "d": round(lv, 1), "m": round(float(m), 1),
            "x": round(float(diff), 1), "p": int(pl),
            "n": (mc.get("name") or "")[:40],
            "c": (mc.get("charter") or "")[:24],
            "lv": (mc.get("level") or "")[:16],
        })
    items.sort(key=lambda r: -abs(r["x"]))
    ad = np.array([abs(r["x"]) for r in items])
    print(f"可展示 {len(items)} 张 · 差值 中位 {np.median(ad):.2f} · "
          f">1 级 {100*(ad>1).mean():.1f}% · >1.5 级 {100*(ad>1.5).mean():.1f}%")

    top = items[:limit]
    js = ("// 自动生成，勿手改。生成器：tools/gen_discrepancy.py\n"
          "// 标称取自 level 字段（正则 Lv.数字），不是 difficulty —— 后者 70% 是错的\n"
          "export const ROWS = " + json.dumps(top, ensure_ascii=False) + ";\n"
          "export const META = " + json.dumps({
              "n": len(items), "minPlayers": MIN_PLAYERS,
              "rho": round(float(np.corrcoef(k * b + c, d)[0, 1]), 4),
              "gt1": round(float((ad > 1).mean()), 4),
              "gt15": round(float((ad > 1.5).mean()), 4),
          }, ensure_ascii=False) + ";\n")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w", encoding="utf-8").write(js)
    print(f"写出 {out_path}（{len(js)/1024:.0f} KB · {len(top)} 条）")


if __name__ == "__main__":
    main()
