#!/usr/bin/env python3
"""Larger sample of review histories; quantify how often difficulty is discussed
and whether charts got their difficulty changed to satisfy reviewers."""
import json, ssl, time, urllib.request, os, re, random
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
CACHE = os.path.join(BASE, "..", "review_comments.json")
R = json.load(open(os.path.join(BASE, "regular.json"), encoding="utf-8"))["results"]
byid = {r["id"]: r for r in R}
stable = [r for r in R if r["stable"]]

def get(cid):
    try:
        req = urllib.request.Request(f"https://api.phira.cn/chart/{cid}/stabilize-status",
                                     headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            return cid, json.loads(r.read())
    except Exception:
        return cid, None

cached = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}
random.seed(7)
need = [r["id"] for r in stable if r["id"] not in cached]
target = 400
todo = need[: max(0, target - len(cached))]
print(f"已有缓存 {len(cached)}，本次再拉 {len(todo)} 张", flush=True)
if todo:
    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, (cid, d) in enumerate(ex.map(get, todo)):
            if d: cached[cid] = d
            if i % 60 == 0: print(f"  {i+1}/{len(todo)}", flush=True)
            time.sleep(0.15)
json.dump(cached, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"缓存总数 {len(cached)}")

DIFF_KW = ["定数", "难度", "虚高", "虚低", "偏高", "偏低", "difficulty", "定级"]
LVNUM = re.compile(r"(?<![A-Za-z])(1[0-9]|20|[0-9])(?:\.\d)?\s*(?:-|>|<|→|改|吧)")
rows = []
for cid, d in cached.items():
    for h in d.get("history") or []:
        c = (h.get("comment") or "").strip()
        if not c:
            continue
        rows.append({"cid": cid, "comment": c, "approve": h.get("approve"),
                     "reviewer": h.get("reviewerName"), "time": h.get("time")})

print(f"\n总评语 {len(rows)} 条，来自 {len(cached)} 张 stable 谱")
hits = [r for r in rows if any(k in r["comment"] for k in DIFF_KW)]
print(f"提及定数/难度: {len(hits)} 条 ({len(hits)/len(rows)*100:.2f}%)，涉及 {len(set(r['cid'] for r in hits))} 张谱")

# 只看明确要求改定数的
ADJUST = re.compile(r"(改|调整|降到|降到|上调|下调|建议).{0,12}(1[0-9]|20|[0-9])(\.\d)?\s*(级|档|定数)?|定数.{0,10}(太|偏高|偏低|虚)|难度.{0,8}(偏高|偏低|虚高|虚低|不符|不合适)")
adj = [r for r in hits if ADJUST.search(r["comment"])]
print(f"其中明确要求调整定数: {len(adj)} 条")
print("\n=== 明确要求调整定数的全部评语 ===")
for r in sorted(adj, key=lambda x: x["cid"]):
    ch = byid.get(r["cid"], {})
    cur = f"level={ch.get('level')!r} diff={ch.get('difficulty')}"
    print(f"  谱{r['cid']} | {cur}")
    print(f"     评语: {r['comment'][:230]}")
    print(f"     评议: {r['reviewer']} | approve={r['approve']} | {r['time'][:10]}")
