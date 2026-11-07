#!/usr/bin/env python3
"""LLM 训练包 below 音符覆盖率审计。

量的是 make_kaggle_pack.compact() 的一个历史 quirk：
serialize_chart 会给 below(above=0) 音符的位置打上 "b" 后缀（如 `-2.5b`），
而 compact() 用 `float(f[1])` 解析位置 → below 行永远 ValueError 被吞。
本工具对同一份语料分别复算「现行实现」与「修复实现」的事件覆盖，给出差值。

用法:
  python tools/audit_llm_pack_coverage.py                 # 全量（按 data/charts）
  python tools/audit_llm_pack_coverage.py --sample 500    # 抽样（可复现种子）
  python tools/audit_llm_pack_coverage.py --text 序列化文本文件.txt   # 单点复算
零依赖（跟随仓库 NON-GOALS：不引入第三方运行时依赖）。
"""
import argparse
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from serialize_chart import serialize  # noqa: E402

ROOT = os.path.join(os.path.dirname(HERE), "data")
CHARTS = os.path.join(ROOT, "charts")


def parse_events(text):
    """序列化文本 → (kept_now, below, dropped_by_bug, malformed)。

    dropped_by_bug 只记「修复能救回」的行（位置列去掉 b 后缀即可解析）；
    真坏行记 malformed，不归这个 bug。kept_now 是现行实现实际保住的行。
    """
    ev, below, dropped_by_bug, malformed = [], 0, 0, 0
    for L in text.split("\n")[1:]:
        f = L.split()
        if len(f) < 3:
            continue
        if f[1].rstrip("b") != f[1]:
            below += 1
        try:
            float(f[1])
            ev.append((f[0], f[1], f[2], f[3] if len(f) > 3 else None))
        except ValueError:
            try:
                float(f[1].rstrip("b"))
                dropped_by_bug += 1
            except ValueError:
                malformed += 1
    return ev, below, dropped_by_bug, malformed


def audit_text(text, name=""):
    ev, below, dropped_by_bug, malformed = parse_events(text)
    total = len(ev) + dropped_by_bug + malformed
    share = (dropped_by_bug / total * 100) if total else 0.0
    return {
        "name": name, "events": total, "below": below,
        "kept_now": len(ev), "dropped_by_bug": dropped_by_bug,
        "malformed": malformed,
        "dropped_share_pct": round(share, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charts", default=CHARTS)
    ap.add_argument("--sample", type=int, default=0, help="0=全量；N=可复现抽样")
    ap.add_argument("--text", default=None, help="单点复算：一个序列化文本文件")
    ap.add_argument("--irt", default=os.path.join(ROOT, "player-irt.json"),
                    help="按IRT名单过滤（默认 data/player-irt.json）")
    ap.add_argument("--cache", default=None,
                    help="per-chart 结果：文件在就复用，不在就计算后写入（跨次调用复用 serialize 成本）")
    ap.add_argument("--min-players", type=int, default=0,
                    help=">0 时只审计 players≥N 且 b 非空的谱（=训练包实际选中的人口）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 便于机器核对")
    a = ap.parse_args()

    if a.text:
        rows = [audit_text(open(a.text, encoding="utf-8").read(), a.text)]
    else:
        ids = sorted(os.listdir(a.charts))
        if a.min_players > 0:
            irt = json.load(open(a.irt, encoding="utf-8"))["items"]
            un = {cid for cid, v in irt.items()
                  if v.get("players", 0) >= a.min_players and v.get("b") is not None}
            ids = sorted(un)
        if a.sample:
            ids = sorted(random.Random(20261104).sample(ids, min(a.sample, len(ids))))
        if a.cache and os.path.exists(a.cache):
            cache = json.load(open(a.cache, encoding="utf-8"))
            rows = [cache[cid] for cid in ids if cid in cache]
        else:
            rows = []
            for cid in ids:
                d = os.path.join(a.charts, cid)
                if not os.path.isdir(d):
                    continue
                f = next((x for x in os.listdir(d) if x.lower().endswith((".json", ".pgr", ".pec"))), None)
                if not f:
                    continue
                try:
                    text, _, _ = serialize(os.path.join(d, f), max_notes=10 ** 6)
                except Exception:
                    continue
                rows.append(audit_text(text, cid))
            if a.cache:
                json.dump({r["name"]: r for r in rows},
                          open(a.cache, "w", encoding="utf-8"), ensure_ascii=False)

    tot_e = sum(r["events"] for r in rows)
    tot_bug = sum(r["dropped_by_bug"] for r in rows)
    tot_bad = sum(r["malformed"] for r in rows)
    tot_below = sum(r["below"] for r in rows)
    hit = sum(1 for r in rows if r["dropped_by_bug"] > 0)
    worst = sorted(rows, key=lambda r: -r["dropped_share_pct"])[:5]

    if a.json:
        print(json.dumps({"charts": len(rows), "events": tot_e,
                          "below": tot_below, "dropped_by_bug": tot_bug,
                          "malformed": tot_bad, "charts_hit": hit,
                          "worst": worst},
                         ensure_ascii=False, indent=1))
        return

    print(f"谱面        {len(rows):,} 张（序列化失败的不计）")
    print(f"事件        {tot_e:,}（现行实现能保住：{tot_e - tot_bug - tot_bad:,}）")
    print(f"below 音符  {tot_below:,}")
    print(f"bug 吞掉    {tot_bug:,} 行（{tot_bug / max(tot_e, 1) * 100:.2f}% 事件；修复后可全额救回）")
    print(f"受影响谱面  {hit:,} 张（{hit / max(len(rows), 1) * 100:.1f}%）")
    print("\n丢失占比最高的 5 张：")
    for r in worst:
        print(f"  {r['name']:<40} {r['dropped_by_bug']}/{r['events']} ({r['dropped_share_pct']}%)")


if __name__ == "__main__":
    main()
