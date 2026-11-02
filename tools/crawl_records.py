"""Phira 游玩记录全量爬取（可断点续跑）。

为什么写成三段式：枚举 → 计数 → 抓取。
  计数那一段会给出**准确的总记录数**，能不能到 2 亿一眼就知道，
  不用先盲跑几小时再发现天花板只有几千万。

目录约定（全部在 data/crawl/ 下）：
  charts.jsonl     全站谱面索引（4 个分区，去重）
  counts.jsonl     每张谱的记录数（同时是「已计数」标记）
  records/*.jsonl  记录本体，按 chart_id % SHARDS 分片，只存必要字段
  done.jsonl       已抓完的谱面 id（断点续跑的唯一依据）

续跑：直接再跑一次同样的命令。已 done 的跳过、计数已有的复用、
     记录按 chart 整块写（一个 chart 写完才记 done，不会出现半张谱的脏数据）。

合规：Phira ToS 禁止再分发。这里只做本地研究用，不对外提供下载。
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
from concurrent.futures import ThreadPoolExecutor, as_completed

API = "https://api.phira.cn"
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "crawl")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
HEAD = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
SHARDS = 8
PAGE = 30              # /chart 单页上限 30
REC_PAGE = 30          # /record/query 尝试 30，被拒就退到 20

_lock = threading.Lock()
_stat = {"req": 0, "err": 0, "retry": 0, "records": 0}


def api(path, timeout=45, tries=4):
    """带退避的 GET。服务端偶发超时很常见，不能一次失败就整段挂掉。"""
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(API + path, headers=HEAD)
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                with _lock:
                    _stat["req"] += 1
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                with _lock:
                    _stat["retry"] += 1
                time.sleep(1.5 * (k + 1) + 0.5 * k)
                continue
            raise
        except Exception as e:      # 超时 / 连接重置 / SSL
            last = e
            with _lock:
                _stat["retry"] += 1
            time.sleep(1.2 * (k + 1))
    with _lock:
        _stat["err"] += 1
    raise last


def ensure_dirs():
    os.makedirs(ROOT, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "records"), exist_ok=True)


# 单实例锁：用文件锁，**进程死了锁自动释放**（不靠 PID 判断，避免 PID 复用误判）。
# 没有这道锁，计划任务 + 手动启动会同时写 counts.jsonl / records，产出脏数据。
_LOCK_FILE = None


def acquire_single_instance():
    global _LOCK_FILE
    import msvcrt
    path = os.path.join(ROOT, "crawl.lock")
    _LOCK_FILE = open(path, "a+")
    try:
        msvcrt.locking(_LOCK_FILE.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        print("已有实例在跑（crawl.lock 被占用），本进程退出。")
        sys.exit(7)   # 与「没有剩余任务」同码：守护脚本停止，别再拉起


def read_jsonl(name):
    p = os.path.join(ROOT, name)
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def append_jsonl(name, rows):
    p = os.path.join(ROOT, name)
    with open(p, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


# ───────────────────────── 1. 枚举 ─────────────────────────
DIVISIONS = ["regular", "plain", "troll", "visual"]


def phase_enum(workers=6):
    path = os.path.join(ROOT, "charts.jsonl")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        got = read_jsonl("charts.jsonl")
        print(f"[enum] 已有 {len(got)} 张，跳过（要重来就删 charts.jsonl）")
        return got

    all_rows = []
    for div in DIVISIONS:
        q = "" if div == "regular" else f"&division={div}"
        first = api(f"/chart?pageNum={PAGE}&page=1&order=created{q}")
        pages = (first["count"] + PAGE - 1) // PAGE
        print(f"[enum] {div}: {first['count']} 张 / {pages} 页")
        rows = first.get("results", [])

        def grab(p):
            time.sleep(0.15)
            d = api(f"/chart?pageNum={PAGE}&page={p}&order=created{q}")
            return d.get("results", [])

        if pages > 1:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                for part in ex.map(grab, range(2, pages + 1)):
                    rows.extend(part)
        for r in rows:
            r["_division"] = div
        all_rows.extend(rows)
        print(f"[enum] {div}: 取到 {len(rows)}")

    seen = set()
    uniq = []
    for r in all_rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    append_jsonl("charts.jsonl", uniq)
    print(f"[enum] 合计 {len(uniq)} 张（去重后）")
    return uniq


# ───────────────────────── 2. 计数 ─────────────────────────
def phase_count(charts, workers=6):
    have = {c["chart"] for c in read_jsonl("counts.jsonl")}
    todo = [c["id"] for c in charts if c["id"] not in have]
    print(f"[count] 待计数 {len(todo)} 张（已有 {len(have)}）")
    if not todo:
        return

    def one(cid):
        d = api(f"/record/query/{cid}?page=1&pageNum=1")
        return {"chart": cid, "count": int(d.get("count") or 0)}

    done = 0
    buf = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(one, c): c for c in todo}
        for f in as_completed(futs):
            try:
                buf.append(f.result())
            except Exception as e:
                print(f"[count] {futs[f]} 失败: {e}")
            done += 1
            if len(buf) >= 200:
                append_jsonl("counts.jsonl", buf)
                buf = []
            if done % 500 == 0:
                print(f"[count] {done}/{len(todo)}  累计记录 "
                      f"{sum(c['count'] for c in read_jsonl('counts.jsonl')):,}")
    if buf:
        append_jsonl("counts.jsonl", buf)

    total = sum(c["count"] for c in read_jsonl("counts.jsonl"))
    print(f"[count] 完成。全站记录总数 ≈ {total:,}")


# ───────────────────────── 3. 抓取 ─────────────────────────
KEEP = ("id", "player", "chart", "score", "accuracy", "perfect", "good", "bad",
        "miss", "speed", "max_combo", "full_combo", "mods", "std", "time")


def slim(rec):
    return {k: rec.get(k) for k in KEEP if k in rec}


def crawl_pages(cid, first, last):
    """抓某张谱的 [first, last] 页（1 基，闭区间）。"""
    out = []
    page = first
    page_size = REC_PAGE
    while page <= last:
        try:
            d = api(f"/record/query/{cid}?page={page}&pageNum={page_size}")
        except urllib.error.HTTPError as e:
            if e.code == 400 and page_size > 20:   # 服务端不接受 30 条
                page_size = 20
                continue
            raise
        rows = d.get("results") or []
        if not rows:
            break
        out.extend(slim(r) for r in rows)
        if len(rows) < page_size:
            break
        page += 1
    return out


def phase_crawl(charts, workers=32, budget=None, chunk_pages=25):
    """按「谱面 + 页区间」切任务并行。

    ⚠ 为什么不能「一张谱一个任务」：单谱最多 42 万条 = 1.4 万页，
      每页往返 2 秒，一个 worker 要连着抓 8 小时。而记录数前 100 的谱
      占了全站 54.5%，不拆页的话最后会卡在这几十张上。
    """
    counts = {c["chart"]: c["count"] for c in read_jsonl("counts.jsonl")}
    done = {(r["chart"], r.get("from"), r.get("to")) for r in read_jsonl("done.jsonl")}

    tasks = []
    for cid, n in counts.items():
        if n <= 0:
            continue
        pages = (n + REC_PAGE - 1) // REC_PAGE
        for a in range(1, pages + 1, chunk_pages):
            b = min(a + chunk_pages - 1, pages)
            if (cid, a, b) in done:
                continue
            tasks.append((cid, a, b))
    # 记录多的谱先跑：前 100 张就占一半数据
    tasks.sort(key=lambda t: (-counts.get(t[0], 0), t[1]))

    total_est = sum(counts.values())
    print(f"[crawl] {len(counts)} 张谱 / 预计 {total_est:,} 条 / "
          f"待跑 {len(tasks)} 个任务块（每块 ≤{chunk_pages} 页）/ 已完成块 {len(done):,}")
    if not tasks:
        return 0

    got = 0
    t0 = time.time()
    shard_files = [open(os.path.join(ROOT, "records", f"r{i}.jsonl"), "a", encoding="utf-8")
                   for i in range(SHARDS)]
    done_f = open(os.path.join(ROOT, "done.jsonl"), "a", encoding="utf-8")

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(crawl_pages, *t): t for t in tasks}
            for k, f in enumerate(as_completed(futs), 1):
                cid, a, b = futs[f]
                try:
                    rows = f.result()
                except Exception as e:
                    print(f"[crawl] {cid} p{a}-{b} 失败: {e}")
                    continue
                sh = shard_files[cid % SHARDS]
                for r in rows:
                    sh.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
                sh.flush()
                done_f.write(json.dumps({"chart": cid, "from": a, "to": b, "n": len(rows)}) + "\n")
                done_f.flush()
                got += len(rows)
                if budget and got >= budget:
                    print(f"[crawl] 达到预算 {budget:,}，停。")
                    for fut in futs:
                        fut.cancel()
                    break
                if k % 200 == 0:
                    el = time.time() - t0
                    print(f"[crawl] 块 {k}/{len(tasks)} · 本次 {got:,} 条 · "
                          f"{got / el:.0f} 条/秒 · 请求 {_stat['req']:,} · "
                          f"重试 {_stat['retry']} · 失败 {_stat['err']}")
    finally:
        for f in shard_files:
            f.close()
        done_f.close()

    print(f"[crawl] 结束：本次 {got:,} 条，用时 {(time.time() - t0) / 60:.1f} 分钟")
    return len(tasks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--budget", type=int, default=0, help="本次最多抓多少条，0 = 不限")
    ap.add_argument("--only", choices=["enum", "count", "crawl"], help="只跑某一段")
    a = ap.parse_args()

    ensure_dirs()
    acquire_single_instance()
    charts = phase_enum(a.workers) if a.only in (None, "enum") else read_jsonl("charts.jsonl")
    if a.only in (None, "count"):
        phase_count(charts, a.workers)
    if a.only in (None, "crawl"):
        left = phase_crawl(charts, a.workers, a.budget or None)
        if left == 0:
            sys.exit(7)   # 约定：7 = 没有剩余任务，守护脚本据此停止


if __name__ == "__main__":
    main()
