"""看一眼爬取进度。不起任何请求，纯读本地文件。

用法：python tools/crawl_status.py
"""
import json
import os
import sys
import time

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "crawl")


def lines(name):
    p = os.path.join(ROOT, name)
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for l in f:
            l = l.strip()
            if l:
                try:
                    out.append(json.loads(l))
                except json.JSONDecodeError:
                    pass
    return out


def size_of(name):
    p = os.path.join(ROOT, name)
    return os.path.getsize(p) if os.path.exists(p) else 0


def main():
    charts = lines("charts.jsonl")
    counts = {c["chart"]: c["count"] for c in lines("counts.jsonl")}
    done = lines("done.jsonl")

    total_charts = len(charts)
    counted = len(counts)
    est_total = sum(counts.values())
    mean = est_total / max(counted, 1)
    projected = mean * total_charts

    got = sum(d.get("n", 0) for d in done)
    # 分片里的真实行数（done 只记块，两者应一致）
    rec_bytes = sum(size_of(os.path.join("records", f)) for f in os.listdir(os.path.join(ROOT, "records"))) \
        if os.path.isdir(os.path.join(ROOT, "records")) else 0

    print(f"谱面索引      {total_charts:,} 张")
    print(f"已计数        {counted:,} 张（{100 * counted / max(total_charts, 1):.1f}%）")
    print(f"已抓记录      {got:,} 条")
    print(f"落盘          {rec_bytes / 1e9:.2f} GB")
    if counted:
        print(f"抽样均值      {mean:,.0f} 条/谱")
        print(f"全站推算      {projected / 1e8:.2f} 亿条")
        print(f"完成度        {100 * got / max(projected, 1):.2f}%")

    # 速率：用 done.jsonl 的修改时间反推最近 10 分钟
    p = os.path.join(ROOT, "done.jsonl")
    if os.path.exists(p) and got:
        age = time.time() - os.path.getmtime(p)
        print(f"\n最后写入      {age:.0f} 秒前")
        if age > 300:
            print("⚠ 超过 5 分钟没有新数据，进程可能已停。重跑 crawl_records.py 会从断点继续。")


main()
