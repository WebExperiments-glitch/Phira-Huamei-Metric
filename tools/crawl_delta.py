"""crawl_delta.py —— 增量补抓 Phira 新成绩（crawl_records.py 的二轮）

【为什么需要它】
crawl_records.py 是一次性全量：phase_count 只数「没数过的谱」，
phase_crawl 只补「上次没跑完的页区间」。所以跑完之后，
**这十几天新打出来的成绩永远不会进 matrix.jsonl**。
2026-11-08 实测重跑原爬虫：7 秒、0 条、18 个块全 404（那些谱已下架）。

【做法】
1. 对全部已计数谱面重新查 count（轻量，1 页）
2. 与旧 counts.jsonl 比对，delta > 0 的谱才有新成绩
3. 成绩按 id/时间**升序**返回（实测 22681 的 page1 是 2024-07-05 最早那批），
   所以新增记录在末尾几页：从 floor(old/30)+1 抓到 ceil(new/30)
4. 按 record id 去重后追加 matrix.jsonl，并写回新 counts

【边界】
- 404 NOT_FOUND = 谱面下架，跳过并计数，不算失败
- 单次最多补 20 页/谱（防止某张谱暴增拖死整轮）；剩下的留给下一轮
- 只追加，不动旧数据；旧 counts 备份成 counts.bak-<时间戳>.jsonl
- 并发默认 48。用户 2026-11-08 确认 Phira 抗造（此前 60+ 线程无异常）
"""
import argparse
import json
import os
import shutil
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import crawl_records as cr  # noqa: E402  —— 复用 api()/slim()/crawl_pages()，不重写一套

COUNTS = os.path.join(cr.ROOT, 'counts.jsonl')
MATRIX = os.path.join(os.path.dirname(cr.ROOT), 'scores', 'matrix.jsonl')
MAX_PAGES = 20


def read_counts():
    return {int(c['chart']): int(c['count']) for c in cr.read_jsonl('counts.jsonl')}


def probe(cid):
    """查当前 count。404 = 谱面下架。"""
    try:
        d = cr.api('/record/query/%d?page=1&pageNum=1' % cid)
        return cid, int(d.get('count') or 0), None
    except Exception as e:
        code = getattr(e, 'code', None)
        return cid, None, 'gone' if code == 404 else ('err:' + str(e)[:60])


def fetch_new(cid, old_n, new_n):
    """抓新增的那几页。返回 (cid, rows, err)。"""
    first = old_n // cr.REC_PAGE + 1
    last = (new_n + cr.REC_PAGE - 1) // cr.REC_PAGE
    if last < first:
        return cid, [], None
    if last - first + 1 > MAX_PAGES:
        first = last - MAX_PAGES + 1
    try:
        return cid, cr.crawl_pages(cid, first, last), None
    except Exception as e:
        return cid, [], 'err:' + str(e)[:60]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=48)
    ap.add_argument('--budget', type=int, default=0, help='最多处理多少张有增量的谱，0 = 不限')
    a = ap.parse_args()

    old = read_counts()
    print('[delta] 旧计数 %d 张谱，合计 %s 条' % (len(old), format(sum(old.values()), ',')))
    t0 = time.time()

    # ── 1. 重新计数 ──
    fresh, gone, errs = {}, 0, 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(probe, cid) for cid in old]
        done = 0
        for f in as_completed(futs):
            cid, n, err = f.result()
            if n is not None:
                fresh[cid] = n
            elif err == 'gone':
                gone += 1
            else:
                errs += 1
            done += 1
            if done % 2000 == 0:
                print('[delta] count %d/%d（%.1f 分钟）' % (done, len(old), (time.time() - t0) / 60))
    print('[delta] 计数完成：正常 %d / 下架 %d / 报错 %d' % (len(fresh), gone, errs))

    delta = {cid: fresh[cid] - old[cid] for cid in fresh if fresh[cid] > old[cid]}
    shrunk = sum(1 for cid in fresh if fresh[cid] < old[cid])
    print('[delta] 有新增 %d 张，合计新增 %s 条；减少 %d 张（删记录/回滚，跳过）'
          % (len(delta), format(sum(delta.values()), ','), shrunk))

    targets = sorted(delta, key=lambda c: -delta[c])
    if a.budget:
        targets = targets[:a.budget]

    # ── 2. 抓新增页 ──
    rows_all, fail = [], 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(fetch_new, cid, old[cid], fresh[cid]): cid for cid in targets}
        done = 0
        for f in as_completed(futs):
            cid, rows, err = f.result()
            if err:
                fail += 1
            else:
                rows_all.extend(rows)
            done += 1
            if done % 200 == 0:
                print('[delta] fetch %d/%d，已收 %s 条' % (done, len(targets), format(len(rows_all), ',')))

    # ── 3. 去重 + 追加 ──
    seen, uniq = set(), []
    for r in rows_all:
        rid = r.get('id')
        if rid is not None and rid in seen:
            continue
        if rid is not None:
            seen.add(rid)
        uniq.append(r)
    players = {r.get('player') for r in uniq if r.get('player') is not None}

    if uniq:
        with open(MATRIX, 'a', encoding='utf-8') as f:
            for r in uniq:
                f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')
            f.flush()
            os.fsync(f.fileno())

    # ── 4. 写回 counts（保留下架谱的旧值，避免下次全量重数）──
    if fresh:
        bak = COUNTS.replace('.jsonl', '.bak-%d.jsonl' % int(time.time()))
        shutil.copy2(COUNTS, bak)
        merged = dict(old)
        merged.update(fresh)
        with open(COUNTS, 'w', encoding='utf-8') as f:
            for cid in sorted(merged):
                f.write(json.dumps({'chart': cid, 'count': merged[cid]}) + '\n')
        print('[delta] counts 已写回（旧文件备份 %s）' % os.path.basename(bak))

    print('[delta] 完成：抓回 %s 条 → 去重后 %s 条，涉及 %s 名玩家；失败谱 %d；用时 %.1f 分钟'
          % (format(len(rows_all), ','), format(len(uniq), ','), format(len(players), ','),
             fail, (time.time() - t0) / 60))
    if uniq:
        print('[delta] 下一步：python tools/behavior_difficulty.py --min-players 10')


if __name__ == '__main__':
    main()
