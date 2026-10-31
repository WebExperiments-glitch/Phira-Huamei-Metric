"""抽样估算 Phira 全站游玩记录总量。

为什么要抽样：要判断「2 亿条」在公开接口上**结构上是否可能**，
只能先用少量请求算出每张谱的平均记录数，再乘全站谱面数。
盲跑几小时才发现天花板只有几千万，是浪费。

判据（一手接口）：
  GET /chart?pageNum=30&page=N         → 分页列表（count 是全站总数）
  GET /record/query/{chartId}?page=1   → 该谱记录数（count 字段），分页可遍历
"""
import json
import ssl
import sys
import random
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://api.phira.cn"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
HEAD = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def api(path, timeout=40):
    req = urllib.request.Request(API + path, headers=HEAD)
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read())


def count_of(chart_id):
    """只要 count，不要结果 —— 用最小的 pageNum 减少流量。"""
    try:
        d = api(f"/record/query/{chart_id}?page=1&pageNum=1")
        return chart_id, int(d.get("count") or 0)
    except Exception as e:
        return chart_id, f"ERR {e}"


def main():
    sample_n = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    first = api("/chart?pageNum=30&page=1&order=created")
    total_charts = first["count"]
    pages = (total_charts + 29) // 30
    print(f"regular 分区谱面数 = {total_charts}，共 {pages} 页")

    # 随机取页，避开「只有首页」的偏差
    rnd = random.Random(20261025)
    pick = sorted(rnd.sample(range(1, pages + 1), min(sample_n, pages)))
    ids = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        def grab(p):
            time.sleep(rnd.random() * 0.2)
            d = api(f"/chart?pageNum=30&page={p}&order=created")
            return [x["id"] for x in d.get("results", [])]
        for got in ex.map(grab, pick):
            ids.extend(got)
    print(f"抽到 {len(ids)} 张谱")

    t0 = time.time()
    counts = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for cid, c in ex.map(count_of, ids):
            if isinstance(c, int):
                counts.append(c)
    dt = time.time() - t0

    if not counts:
        print("全部失败，接口可能限流")
        return
    counts.sort()
    n = len(counts)
    mean = sum(counts) / n
    med = counts[n // 2]
    p90 = counts[int(n * 0.9)]
    mx = counts[-1]
    print(f"\n耗时 {dt:.1f}s · 成功 {n}/{len(ids)} 张")
    print(f"每谱记录数：中位 {med} / 均值 {mean:.1f} / p90 {p90} / 最大 {mx}")
    print(f"零记录谱面：{sum(1 for c in counts if c == 0)} 张")
    print(f"\n全站估算（乘 {total_charts} 张）：约 {mean * total_charts:,.0f} 条")
    print(f"若只算 regular + plain + troll + visual（13,806 张）：约 {mean * 13806:,.0f} 条")
    json.dump({"total_charts": total_charts, "sample": counts}, open("data/crawl/sample.json", "w"))
    print(f"\n单张谱平均请求数（每页 30 条）= {mean / 30 + 1:.1f} 次")
    print(f"全量所需的请求数 ≈ {total_charts * (mean / 30 + 1):,.0f} 次")


main()
