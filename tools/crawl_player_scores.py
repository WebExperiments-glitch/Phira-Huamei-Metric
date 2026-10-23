#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_player_scores.py —— 抓「玩家 × 谱面 × ACC」矩阵（只做本地研究）

【接口选择（实测）】
  · /record/query/{chartId}  每张谱只回**分数最高的 30 条**，不支持翻页
    （page=2 与 page=1 完全相同）。按谱取只能看到顶尖玩家。
  · /record?player={uid}     回**最近 20 条**，是活数据（最新能到今天）。
  · /record/get-pool/{uid}   B19 **已停更**（快照最晚 2026-03-19），不能用。

  所以：种子谱的 top30 先收集玩家 ID → 再对每个玩家拉最近 20 条。

【为什么边抓边写】
  第一版在结尾一次性落盘，被 timeout 杀掉 → **15 分钟白跑，一个字节没留下**。
  现在每条记录立刻 append，中断后重跑会跳过已抓到的玩家（看 player 是否已在文件里）。

【产出】
  data/scores/matrix.jsonl   {chart, player, acc, score, time, src}
  data/scores/_meta.json     覆盖率统计

【礼貌】5 并发 + 每请求 0.35s。只做本地研究，不外发（Phira ToS 禁止再分发）。

用法：
  python tools/crawl_player_scores.py --charts 40 --players 800
"""
import argparse
import json
import os
import ssl
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://api.phira.cn"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "scores")
MATRIX = os.path.join(OUT, "matrix.jsonl")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def api(path, timeout=40):
    req = urllib.request.Request(BASE + path, headers={
        "User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read())


def pick_seed_charts(n):
    rows = []
    with open(os.path.join(ROOT, "data", "community.jsonl"), encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            d = r.get("difficulty")
            if isinstance(d, (int, float)) and 0 < d <= 19.5:
                rows.append(r)
    rows.sort(key=lambda r: -(r.get("ratingCount") or 0))
    rows = rows[:4000]
    rows.sort(key=lambda r: r["difficulty"])
    step = max(1, len(rows) // n)
    return [rows[i] for i in range(0, len(rows), step)][:n]


def existing_players():
    s = set()
    if not os.path.exists(MATRIX):
        return s
    with open(MATRIX, encoding="utf-8") as f:
        for line in f:
            try:
                s.add(int(json.loads(line)["player"]))
            except Exception:
                pass
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charts", type=int, default=40)
    ap.add_argument("--players", type=int, default=800)
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    seeds = pick_seed_charts(args.charts)
    print(f"[1/3] 种子谱 {len(seeds)} 张（难度 {seeds[0]['difficulty']:.1f} ~ {seeds[-1]['difficulty']:.1f}）", flush=True)

    already = existing_players()
    print(f"      文件里已有 {len(already)} 个玩家（续跑会跳过）", flush=True)

    lock = threading.Lock()
    fout = open(MATRIX, "a", encoding="utf-8")
    pool_players = set()

    def write(rec):
        fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
        fout.flush()

    def grab_chart(cid):
        try:
            return cid, api(f"/record/query/{cid}").get("results", []), None
        except Exception as e:
            return cid, None, str(e)[:60]

    print("[2/3] 拉种子谱 top 记录", flush=True)
    with ThreadPoolExecutor(max_workers=5) as ex:
        for i, (cid, recs, err) in enumerate(ex.map(grab_chart, [int(r["id"]) for r in seeds]), 1):
            if err:
                print(f"    ✗ {cid} {err}", flush=True)
            else:
                with lock:
                    for rec in recs or []:
                        p, c, a = rec.get("player"), rec.get("chart"), rec.get("accuracy")
                        if p is None or c is None or a is None:
                            continue
                        pool_players.add(int(p))
                        write({"chart": int(c), "player": int(p), "acc": float(a),
                               "score": rec.get("score"), "time": rec.get("time"), "src": "chart"})
            if i % 10 == 0:
                print(f"    {i}/{len(seeds)} 张，玩家池 {len(pool_players)}", flush=True)
            time.sleep(0.35)

    todo = [p for p in sorted(pool_players)[: args.players] if p not in already]
    print(f"[3/3] 要抓 {len(todo)} 个玩家的最近 20 条", flush=True)

    def grab_player(uid):
        try:
            return uid, api(f"/record?player={uid}"), None
        except Exception as e:
            return uid, None, str(e)[:60]

    done = 0
    with ThreadPoolExecutor(max_workers=5) as ex:
        for i, (uid, arr, err) in enumerate(ex.map(grab_player, todo), 1):
            if not err:
                with lock:
                    for rec in arr or []:
                        p, c, a = rec.get("player"), rec.get("chart"), rec.get("accuracy")
                        if p is None or c is None or a is None:
                            continue
                        write({"chart": int(c), "player": int(p), "acc": float(a),
                               "score": rec.get("score"), "time": rec.get("time"), "src": "player"})
                done += 1
            if i % 50 == 0:
                print(f"    {i}/{len(todo)} 玩家", flush=True)
            time.sleep(0.35)
    fout.close()

    # 统计
    seen = set()
    with open(MATRIX, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                seen.add((r["chart"], r["player"]))
            except Exception:
                pass
    per_chart = {}
    for (c, _p) in seen:
        per_chart[c] = per_chart.get(c, 0) + 1
    cov = {n: sum(1 for v in per_chart.values() if v >= n) for n in (2, 5, 10, 20)}
    meta = {"seed_charts": len(seeds), "players_crawled": done, "pairs": len(seen),
            "charts_covered": len(per_chart), "coverage": cov}
    json.dump(meta, open(os.path.join(OUT, "_meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)

    print("\n──────── 结果 ────────", flush=True)
    print(f"  记录对 {meta['pairs']}  覆盖谱面 {meta['charts_covered']}  本轮抓玩家 {done}", flush=True)
    print(f"  有 ≥2 人打：{cov[2]}   ≥5：{cov[5]}   ≥10：{cov[10]}   ≥20：{cov[20]}", flush=True)


if __name__ == "__main__":
    main()
