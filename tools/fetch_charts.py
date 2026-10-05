#!/usr/bin/env python3
"""
Phira 谱面语料批量下载器

设计要点：
  1. 断点续传——已存在的 id 跳过，中断后重跑不重复下载
  2. 只保留 chart.json + info.yml，音频/曲绘解 zip 后立即丢弃
  3. 温和并发（默认 6 线程）+ 失败重试，避免打爆服务器
  4. 每 100 张打印进度与速率，实时可观测
  5. 产出 manifest.jsonl：每张谱的 id / level / difficulty / 音符数等关键信息

用法：
  python fetch_charts.py --limit 50              # 先试 50 张
  python fetch_charts.py                          # 全量 regular
  python fetch_charts.py --out ../data/charts --workers 8
"""
import argparse
import io
import json
import os
import random
import ssl
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.dirname(os.path.abspath(__file__))
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"

_print_lock = threading.Lock()
_manifest_lock = threading.Lock()

STATS = {
    "ok": 0, "skip": 0, "fail": 0, "nochart": 0,
    "bytes": 0, "t0": time.time(),
}


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def fetch(url, timeout=90, retries=3):
    """带指数退避的 GET。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, TimeoutError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(1.5 * (2 ** attempt) + random.random())
    raise last


def load_meta(path):
    d = json.load(open(path, encoding="utf-8"))
    return d["results"]


def process_one(rec, out_root, keep_dir=False):
    """下载单个谱面的 zip，抽取 chart.json + info.yml 落盘。"""
    cid = rec["id"]
    dest = os.path.join(out_root, str(cid))
    chart_path = os.path.join(dest, "chart.json")
    meta_path = os.path.join(dest, "info.yml")

    # 断点续传：已完整则跳过
    if os.path.exists(chart_path) and os.path.exists(meta_path):
        try:
            if os.path.getsize(chart_path) > 10:
                STATS["skip"] += 1
                return ("skip", cid, None)
        except OSError:
            pass

    os.makedirs(dest, exist_ok=True)
    raw = fetch(rec["file"])
    STATS["bytes"] += len(raw)

    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()

    # 谱面数据文件：优先 info.yml 里声明的 chart 字段，其次最大的 .json
    chart_name = None
    if "info.yml" in names:
        try:
            info_txt = z.read("info.yml").decode("utf-8", "replace")
            for line in info_txt.splitlines():
                if line.startswith("chart:"):
                    chart_name = line.split(":", 1)[1].strip()
                    break
        except Exception:
            pass
    if not chart_name:
        cands = [n for n in names if n.lower().endswith(".json") and not n.startswith("info")]
        if not cands:
            STATS["nochart"] += 1
            return ("nochart", cid, None)
        chart_name = max(cands, key=lambda n: z.getinfo(n).file_size)

    if chart_name not in names:
        STATS["nochart"] += 1
        return ("nochart", cid, None)

    with open(chart_path, "wb") as f:
        f.write(z.read(chart_name))

    info = None
    if "info.yml" in names:
        b = z.read("info.yml")
        with open(meta_path, "wb") as f:
            f.write(b)
        info = b.decode("utf-8", "replace")

    # 快速统计基本信息（不进 manifest 也能用）
    try:
        j = json.loads(z.read(chart_name))
        lines = j.get("judgeLineList") or []

        # ⚠️ 格式识别：不能假设都是 RPE。
        # PEC 格式用 notesAbove/notesBelow 存音符，字段结构与 RPE 完全不同。
        # 早期版本把 PEC 谱误判为「空谱」，导致 1.4 万个音符被当成无效数据丢掉。
        is_rpe = "BPMList" in j
        is_pec = bool(lines) and "notesAbove" in lines[0]
        fmt = "rpe" if is_rpe else ("pec" if is_pec else "unknown")

        if is_rpe:
            notes = [n for l in lines for n in (l.get("notes") or [])]
            real = [n for n in notes if n.get("isFake") != 1]
            types = Counter(n.get("type") for n in real)
            bpm_list = j.get("BPMList") or []
        elif is_pec:
            # PEC: notesAbove(正面) / notesBelow(背面)，无 isFake 概念
            real = []
            for l in lines:
                real += (l.get("notesAbove") or [])
                real += (l.get("notesBelow") or [])
            types = Counter(n.get("type") for n in real)
            bpm_list = []
        else:
            real, types, bpm_list = [], Counter(), []

        notes_all = len(real)
        row = {
            "id": cid,
            "name": rec.get("name"),
            "level": rec.get("level"),
            "difficulty": rec.get("difficulty"),
            "rating": rec.get("rating"),
            "ratingCount": rec.get("ratingCount"),
            "stable": rec.get("stable"),
            "ranked": rec.get("ranked"),
            "charter": rec.get("charter"),
            "tags": rec.get("tags"),
            "file_size": len(raw),
            "chart_file": chart_name,
            "format": fmt,
            "bpm": bpm_list[0].get("bpm") if bpm_list else None,
            "bpm_items": len(bpm_list),
            "rpe_version": (j.get("META") or {}).get("RPEVersion") if is_rpe else None,
            "lines": len(lines),
            "notes_all": notes_all,
            "notes_real": notes_all,
            "fake": 0 if not is_rpe else (len([n for l in lines for n in (l.get("notes") or [])])
                                          - len([n for l in lines for n in (l.get("notes") or [])
                                                 if n.get("isFake") != 1])),
            "behind": (0 if is_rpe else
                       sum(len(l.get("notesBelow") or []) for l in lines)),
            "t_tap": types.get(1, 0),
            "t_hold": types.get(2, 0),
            "t_drag": types.get(3, 0),
            "t_flick": types.get(4, 0),
            "with_father": sum(1 for l in lines if l.get("father") is not None),
            "bpmfactor_non1": sum(1 for l in lines
                                  if (l.get("bpmfactor") or 1.0) != 1.0),
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with _manifest_lock:
            with open(os.path.join(out_root, "manifest.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as e:
        return ("ok", cid, f"chart-ok-stats-fail:{e}")

    return ("ok", cid, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", default=os.path.join(BASE, "..", "_research", "meta", "regular.json"))
    ap.add_argument("--out", default=os.path.join(BASE, "..", "data", "charts"))
    ap.add_argument("--limit", type=int, default=0, help="0 = 全量")
    ap.add_argument("--workers", type=int, default=6, help="温和并发，默认 6")
    args = ap.parse_args()

    out_root = os.path.abspath(args.out)
    os.makedirs(out_root, exist_ok=True)

    recs = load_meta(os.path.abspath(args.meta))
    if args.limit:
        recs = recs[:args.limit]
    log(f"[init] 待处理 {len(recs)} 张 | 输出 {out_root} | 并发 {args.workers}")

    done_marker = os.path.join(out_root, "manifest.jsonl")
    t0 = time.time()
    last_print = t0
    last_ok = 0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, r, out_root): r for r in recs}
        total = len(futs)
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                status, cid, msg = fut.result()
                if status == "ok":
                    STATS["ok"] += 1
                elif status == "fail":
                    STATS["fail"] += 1
                    log(f"  [fail] id={cid}: {msg}")
            except Exception as e:
                STATS["fail"] += 1
                log(f"  [fail] {futs[fut].get('id')}: {type(e).__name__} {e}")

            now = time.time()
            if now - last_print >= 20 or i == total:
                el = now - t0
                rate = (STATS["ok"] + STATS["skip"]) / max(el, 1e-9)
                eta = (total - i) / max(rate, 1e-9)
                log(f"[{i}/{total}] ok={STATS['ok']} skip={STATS['skip']} "
                    f"fail={STATS['fail']} nochart={STATS['nochart']} | "
                    f"{STATS['bytes']/1048576:.0f}MB | {rate*60:.1f} 张/分 | ETA {eta/60:.1f}min")
                last_print = now

    el = time.time() - t0
    log("")
    log("=" * 60)
    log(f"[done] ok={STATS['ok']} skip={STATS['skip']} fail={STATS['fail']} "
        f"nochart={STATS['nochart']}")
    log(f"[done] 下载 {STATS['bytes']/1048576:.1f} MB，耗时 {el/60:.1f} min")
    log(f"[done] manifest: {done_marker}")


if __name__ == "__main__":
    main()
