#!/usr/bin/env python3
"""
Phira 谱面**列表**抓取器（只取元数据，不下谱面文件）

【为什么要有这个工具】
    现有的 tools/fetch_charts.py 一次性全量下载，用的是本地静态清单
    （_research/meta/regular.json）。结果是：

      data/community.jsonl 里 9,684 行虽然有 fetched_at（下载时刻），
      但**全是同一天**（2026-10-04）——因为它是一次性跑完的。

    而「比随机留出更可信的验证」需要的是**上传时间**（谱面是什么时候发到
    Phira 的），这样才能切出「参照集是老谱、测试集是新谱」的时间外推样本。
    Phira 的公开 API 直接给了这个字段：

        GET https://api.phira.cn/chart?page=1&pageNum=30&order=-created
        → { count, results: [ { id, name, level, difficulty, charter,
                                 rating, ratingCount, created, updated,
                                 uploader, tags, file, preview, ... } ] }

      - `order=-created` = 按上传时间**倒序**（最新的在第一页）
        ⇒ 增量抓取只要翻前面几页，翻到比上次快照还旧就停
      - `pageNum` = 每页条数（最大 30），`page` = 页码（1 起）
      - `count` = 全站谱面总数

    本工具把这些元数据落成 data/chart-list.jsonl，供：
      ① tools/audit-baselines.mjs --split created 做**按上传时间**的留出
         （比用 chart id 分块更接近真时间外推）
      ② 增量抓取时知道「哪些是新谱」（现在的 fetch_charts.py 做不到，
         因为它的清单是一次性快照）

【用法】
    python tools/fetch_chart_list.py                 # 全量（325 页左右）
    python tools/fetch_chart_list.py --since 2026-10-19   # 只要这之后上传的
    python tools/fetch_chart_list.py --merge         # 与已有文件合并（按 id 去重，保留新信息）
    python tools/fetch_chart_list.py --dry-run       # 只看会抓多少，不写文件

【输出】
    data/chart-list.jsonl —— 一行一张谱：
      { id, name, level, difficulty, charter, rating, ratingCount,
        created, updated, uploader, tags, file, preview, illustration }

⚠ **礼貌抓取**：默认 **2 并发 + 每批 0.3s 间隔**（约 6–8 req/s），单次请求超时 30s。
  早先是 4 并发 + 0.15s，实测约 20–30 req/s …… 对一个免费公共 API 偏激进，
  而且它是我们**唯一**的上游数据来源 —— 不值得为了快一分钟拿它冒险。
  全量拉一遍大约 2–3 分钟，而这个脚本本来就是偶尔跑一次。
   这是第三方公开 API，不要打爆它。
"""
import argparse
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
API = "https://api.phira.cn/chart"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; phm-audit/1.0)"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

_print_lock = threading.Lock()
STATS = {"pages": 0, "rows": 0, "fail": 0}


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def fetch_page(page, page_size, order="-created", retries=3):
    """取一页。返回 (results, total_count)"""
    url = f"{API}?page={page}&pageNum={page_size}&order={order}"
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                       "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                data = json.loads(r.read().decode("utf-8"))
            return data.get("results", []), data.get("count", 0)
        except Exception as e:            # 网络抖动很常见，重试
            last = e
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"page {page} 取不到：{last}")


def fetch_list(since=None, page_size=30, workers=2, order="-created", max_pages=0):
    """翻页抓列表。

    since：ISO 日期字符串（如 2026-10-19）。给了之后**只保留 created >= since**
           的行 —— 因为默认按上传时间倒序，命中旧数据就可以停。
    """
    rows, total = [], 0
    page = 1
    stop = threading.Event()
    lock = threading.Lock()

    def work(p):
        try:
            res, cnt = fetch_page(p, page_size, order)
        except RuntimeError as e:
            with lock:
                STATS["fail"] += 1
            log(f"  [fail] {e}")
            return
        with lock:
            STATS["pages"] += 1
            STATS["rows"] += len(res)
        if not res:
            stop.set()
            return
        # 倒序时，一旦遇到比 since 还旧的，整页之后都可以停
        if since:
            oldest = res[-1].get("created", "")[:10]
            if oldest and oldest < since:
                stop.set()
        rows.extend(res)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        # 按批翻页：每批 8 页，批内并发；批与批之间留间隔
        while not stop.is_set():
            batch = list(range(page, page + 8))
            if max_pages and page > max_pages:
                break
            with ThreadPoolExecutor(max_workers=workers) as ex:
                list(ex.map(work, batch))
            page += len(batch)
            if max_pages and page > max_pages:
                break
            if not stop.is_set():
                time.sleep(0.3)
            if page % 40 == 0:
                log(f"  [..] 已翻 {page-1} 页，取到 {len(rows)} 行")
    return rows, total


def normalize(r):
    """只留稳定字段。★ created 是这套工具存在的唯一理由，别把它丢了。"""
    return {
        "id": r.get("id"),
        "name": r.get("name"),
        "level": r.get("level"),
        "difficulty": r.get("difficulty"),
        "charter": r.get("charter"),
        "rating": r.get("rating"),
        "ratingCount": r.get("ratingCount"),
        "created": r.get("created"),
        "updated": r.get("updated"),
        "uploader": r.get("uploader"),
        "tags": r.get("tags"),
    }


def load_existing(path):
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("id") is not None:
                out[r["id"]] = r
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "chart-list.jsonl"))
    ap.add_argument("--since", default=None,
                    help="只要这个日期之后上传的（YYYY-MM-DD）；配合 --merge 做增量")
    ap.add_argument("--merge", action="store_true",
                    help="与已有文件合并（按 id 去重，新信息覆盖旧信息）")
    ap.add_argument("--page-size", type=int, default=30, help="每页条数，最大 30")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--max-pages", type=int, default=0, help="0 = 不限")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    log(f"[init] {API} | order=-created | 每页 {args.page_size}"
        f" | since={args.since or '无'} | 合并={args.merge}")

    t0 = time.time()
    rows, _ = fetch_list(since=args.since, page_size=args.page_size,
                          workers=args.workers, max_pages=args.max_pages)
    log(f"[fetch] 翻页 {STATS['pages']} 页，取到 {STATS['rows']} 行，"
        f"失败 {STATS['fail']} 次，耗时 {time.time()-t0:.1f}s")

    fresh = {}
    for r in rows:
        cid = r.get("id")
        if cid is None:
            continue
        if args.since:
            c = (r.get("created") or "")[:10]
            if c and c < args.since:
                continue
        fresh[cid] = normalize(r)
    log(f"[filter] 命中 {len(fresh)} 张"
        + (f"（上传时间 ≥ {args.since}）" if args.since else ""))

    if args.merge:
        merged = load_existing(out)
        before = len(merged)
        merged.update(fresh)
        final = merged
        log(f"[merge] 原有 {before} 张 + 新增/更新 {len(fresh)} 张 = {len(final)} 张")
    else:
        final = fresh

    if args.dry_run:
        log("[dry-run] 不写文件")
        return 0

    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for cid in sorted(final):
            f.write(json.dumps(final[cid], ensure_ascii=False) + "\n")
    os.replace(tmp, out)
    log(f"[done] {len(final)} 张 → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
