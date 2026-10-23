#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_player_scores.py —— 抓「玩家 × 谱面 × ACC」矩阵（只做本地研究）

【两个模式】

  默认（按谱播种）：种子谱的 top30 → 玩家 ID → 各自最近 20 条
      ⚠ 实测**采样错误**：每谱前 30 名全是强手，92% 记录 ACC ≥ 0.95，
        两参数模型彻底退化（预测恒为 1 也能 MSE 0.0015）。

  --random N（随机抽玩家）：
      Phira 的 user id 空间很密（实测随机 15 个 ID 命中 15 个），
      随机抽能覆盖到中低水平玩家 —— 这才是建客观标度需要的样本。

【接口事实（实测，别再猜）】
  · /record/query/{chart}  每谱只回**分数最高的 30 条**，不支持翻页
  · /record?player={uid}   回**最近 20 条**，是活数据
  · /record/get-pool/{uid} B19 **已停更**（快照最晚 2026-03-19）

【为什么边抓边写】
  第一版在结尾一次性落盘，被 timeout 杀掉 → 15 分钟白跑。
  现在每条记录立刻 append，重跑按 player 续跑。

用法：
  python tools/crawl_player_scores.py --random 400
  python tools/crawl_player_scores.py --charts 40 --players 500
"""
import argparse
import json
import os
import random
import ssl
import threading
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

BASE = "https://api.phira.cn"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "scores")
MATRIX = os.path.join(OUT, "matrix.jsonl")
UID_MAX = 2800000
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def api(path, timeout=40):
    req = urllib.request.Request(BASE + path, headers={
        "User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read())


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


def acc_report():
    accs = []
    with open(MATRIX, encoding="utf-8") as f:
        for line in f:
            try:
                accs.append(json.loads(line)["acc"])
            except Exception:
                pass
    if not accs:
        return
    b = Counter()
    for x in accs:
        b["1.000" if x >= 0.999 else "0.99+" if x >= 0.99 else "0.95+" if x >= 0.95
          else "0.90+" if x >= 0.90 else "0.70+" if x >= 0.70 else "<0.70"] += 1
    print("\n  ACC 分布（全库累计，共 %d 条）：" % len(accs))
    for k in ("1.000", "0.99+", "0.95+", "0.90+", "0.70+", "<0.70"):
        print("    %-7s %7d  %5.1f%%" % (k, b[k], b[k] / len(accs) * 100))
    sat = (b["1.000"] + b["0.99+"] + b["0.95+"]) / len(accs) * 100
    print("  饱和度（>=0.95 占比）：%.1f%%  %s" % (sat, "仍偏高" if sat > 80 else "可以用了"))


def write_records(fout, arr, src):
    n = 0
    for rec in arr or []:
        p, c, a = rec.get("player"), rec.get("chart"), rec.get("accuracy")
        if p is None or c is None or a is None:
            continue
        # std = 击打时间偏差。⚠ 必须存：ACC 在 0.95 以上的记录占 86%，
        # 已经饱和到没法区分；而 std 是连续量 —— 满分谱上 std 0.012 与 0.030
        # 的差别，才是真实水平差。
        fout.write(json.dumps({"chart": int(c), "player": int(p), "acc": float(a),
                               "std": rec.get("std"), "score": rec.get("score"),
                               "miss": rec.get("miss"), "good": rec.get("good"),
                               "time": rec.get("time"), "src": src},
                              ensure_ascii=False) + "\n")
        n += 1
    fout.flush()
    return n


def crawl_random(n_target):
    already = existing_players()
    print("[random] 已落盘 %d 个玩家；目标新增 %d" % (len(already), n_target), flush=True)
    rnd = random.Random(20261024)
    todo, seen = [], set()
    while len(todo) < n_target:
        uid = rnd.randint(1, UID_MAX)
        if uid in already or uid in seen:
            continue
        seen.add(uid)
        todo.append(uid)

    lock = threading.Lock()
    fout = open(MATRIX, "a", encoding="utf-8")
    got = empty = errs = 0

    def probe(uid):
        try:
            return uid, api("/record?player=%d" % uid), None
        except Exception as e:
            return uid, None, str(e)[:40]

    with ThreadPoolExecutor(max_workers=5) as ex:
        for i, (uid, arr, err) in enumerate(ex.map(probe, todo), 1):
            if err:
                errs += 1
            elif not arr:
                empty += 1
            else:
                with lock:
                    write_records(fout, arr, "random")
                got += 1
            if i % 50 == 0:
                print("    %d/%d（有效 %d，无记录 %d，出错 %d）" % (i, len(todo), got, empty, errs), flush=True)
            time.sleep(0.35)
    fout.close()
    print("\n  有效玩家 %d / 探测 %d；无记录 %d；出错 %d" % (got, len(todo), empty, errs))
    acc_report()


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


def crawl_by_chart(n_charts, n_players):
    seeds = pick_seed_charts(n_charts)
    print("[chart] 种子谱 %d 张（难度 %.1f ~ %.1f）" % (
        len(seeds), seeds[0]["difficulty"], seeds[-1]["difficulty"]), flush=True)
    already = existing_players()
    lock = threading.Lock()
    fout = open(MATRIX, "a", encoding="utf-8")
    pool = set()

    def grab(cid):
        try:
            return cid, api("/record/query/%d" % cid).get("results", []), None
        except Exception as e:
            return cid, None, str(e)[:40]

    with ThreadPoolExecutor(max_workers=5) as ex:
        for i, (cid, recs, err) in enumerate(ex.map(grab, [int(r["id"]) for r in seeds]), 1):
            if not err:
                with lock:
                    for rec in recs or []:
                        if rec.get("player") is not None:
                            pool.add(int(rec["player"]))
                    write_records(fout, recs, "chart")
            if i % 10 == 0:
                print("    %d/%d 张，玩家池 %d" % (i, len(seeds), len(pool)), flush=True)
            time.sleep(0.35)

    todo = [p for p in sorted(pool)[:n_players] if p not in already]
    print("[chart] 要抓 %d 个玩家的最近 20 条" % len(todo), flush=True)

    def probe(uid):
        try:
            return uid, api("/record?player=%d" % uid), None
        except Exception as e:
            return uid, None, str(e)[:40]

    got = 0
    with ThreadPoolExecutor(max_workers=5) as ex:
        for i, (uid, arr, err) in enumerate(ex.map(probe, todo), 1):
            if not err and arr:
                with lock:
                    write_records(fout, arr, "player")
                got += 1
            if i % 50 == 0:
                print("    %d/%d 玩家" % (i, len(todo)), flush=True)
            time.sleep(0.35)
    fout.close()
    print("\n  本轮抓玩家 %d" % got)
    acc_report()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, default=0, help="随机抽这么多玩家（修正饱和采样）")
    ap.add_argument("--charts", type=int, default=40)
    ap.add_argument("--players", type=int, default=500)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    if args.random:
        crawl_random(args.random)
    else:
        crawl_by_chart(args.charts, args.players)


if __name__ == "__main__":
    main()
