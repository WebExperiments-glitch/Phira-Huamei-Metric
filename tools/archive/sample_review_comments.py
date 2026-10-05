#!/usr/bin/env python3
"""Sample stabilize-status (review history) comments from stable/ranked charts.
Goal: check empirically whether reviewers ever raise 定数/难度 issues in their comments."""
import json, ssl, time, urllib.request, os, re, random, sys
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
BASE = os.path.join(os.path.dirname(__file__), "..", "_research", "meta")
R = json.load(open(os.path.join(BASE, "regular.json"), encoding="utf-8"))["results"]
stable = [r for r in R if r["stable"]]
print(f"stable 谱 n={len(stable)}，抽样 120 张拉取评议历史", flush=True)

def get(cid):
    try:
        req = urllib.request.Request(f"https://api.phira.cn/chart/{cid}/stabilize-status",
                                     headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            return cid, json.loads(r.read())
    except Exception as e:
        return cid, None

random.seed(7)
sample = random.sample(stable, min(120, len(stable)))
out = {}
with ThreadPoolExecutor(max_workers=5) as ex:
    for i, (cid, d) in enumerate(ex.map(get, [r["id"] for r in sample])):
        if d: out[cid] = d
        if i % 30 == 0: print(f"  {i+1}/{len(sample)}", flush=True)
        time.sleep(0.2)

json.dump(out, open(os.path.join(BASE, "..", "review_comments.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"成功获取 {len(out)} 张")

# Analyze comments
DIFF_KW = ["定数", "难度", "虚高", "虚低", "偏高", "偏低", "difficulty", "Lv", "lv", "定级", "级别"]
comments = []
for cid, d in out.items():
    for h in d.get("history") or []:
        c = (h.get("comment") or "").strip()
        if c:
            comments.append((cid, c))
print(f"\n总评语数 {len(comments)}，来自 {len(out)} 张谱")
hit = [(cid, c) for cid, c in comments if any(k in c for k in DIFF_KW)]
print(f"含难度/定数相关关键词的评语: {len(hit)} ({len(hit)/max(1,len(comments))*100:.2f}%)")
print("\n命中的评语（全部）:")
for cid, c in hit[:60]:
    print(f"  [{cid}] {c[:160]}")

print("\n最常见评语前缀 Top 25:")
for c, n in Counter(c for _, c in comments).most_common(25):
    print(f"  {n:>4}×  {c[:90]}")
