#!/usr/bin/env python3
"""Crawl Phira public API for difficulty statistics research."""
import json, ssl, time, urllib.request, os, sys
from concurrent.futures import ThreadPoolExecutor

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
OUT = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
os.makedirs(OUT, exist_ok=True)


def api(path, retries=4):
    for a in range(retries):
        try:
            req = urllib.request.Request(
                "https://api.phira.cn" + path,
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=45, context=CTX) as r:
                return json.loads(r.read())
        except Exception as e:
            if a == retries - 1:
                print(f"FAIL {path}: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (a + 1))


def crawl(division):
    tag = division or "regular"
    cache = os.path.join(OUT, f"{tag}.json")
    if os.path.exists(cache):
        d = json.load(open(cache, encoding="utf-8"))
        print(f"[{tag}] cached count={d['count']} n={len(d['results'])}")
        return d
    q = f"&division={division}" if division else ""
    first = api(f"/chart?pageNum=30&page=1&order=created{q}")
    if not first:
        return None
    total = (first["count"] + 29) // 30
    results = list(first["results"])

    def grab(p):
        d = api(f"/chart?pageNum=30&page={p}&order=created{q}")
        time.sleep(0.3)
        return d["results"] if d else []

    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, part in enumerate(ex.map(grab, range(2, total + 1))):
            results.extend(part)
            if i % 50 == 0:
                print(f"[{tag}] {i+1}/{total-1} pages, {len(results)} items", flush=True)
    d = {"count": first["count"], "results": results}
    json.dump(d, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[{tag}] done count={d['count']} got={len(results)}")
    return d


if __name__ == "__main__":
    allr = {}
    for div in [None, "plain", "troll", "visual"]:
        d = crawl(div)
        if d:
            allr[div or "regular"] = d
    print(json.dumps({k: {"count": v["count"], "got": len(v["results"])} for k, v in allr.items()}))
