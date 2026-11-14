"""build-behavior-diff.py —— 把反推结果合成为站点用的 behavior-diff.json

【链路】
  data/scores/matrix.jsonl                   原始成绩（2.4GB）
    → tools/behavior_difficulty.py           双向固定效应反推
    → data/scores/chart_difficulty_behavior.json   {raw, scaled, spearman…}
    → 本脚本（+ 旧 behavior-diff 的指纹 + matrix 的每谱人数）
    → phm-web/public/data/behavior-diff.json  {note, charts: {id: [难度,人数,物量,时长,BPM]}}

【为什么要"旧指纹"】
  站点用 [物量, 时长, BPM] 三个指纹把**本地拖进来的谱面**对上号
  （见 public/js/behav.js 的 findByFingerprint）。反推结果里没有这三项，
  谱面文件也不在本地 —— 所以从旧文件沿用；旧文件没有的谱填 0，
  前端会因为 notes=0 跳过指纹匹配，但按 chart_id 深链查询仍然可用。

用法：
  python tools/build-behavior-diff.py            # 只统计，不写文件
  python tools/build-behavior-diff.py --write    # 写入 phm-web/public/data/
"""
import argparse
import json
import os
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW = os.path.join(ROOT, 'data', 'scores', 'chart_difficulty_behavior.json')
OLD = os.path.join(ROOT, 'phm-web', 'public', 'data', 'behavior-diff.json')
OUT = OLD
MATRIX = os.path.join(ROOT, 'data', 'scores', 'matrix.jsonl')


def count_players(path):
    """每谱有多少个不同玩家。⚠ 分块读，2.4GB 不要一次进内存。"""
    seen = {}
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            c = o.get('chart')
            p = o.get('player')
            if c is None or p is None:
                continue
            s = seen.get(c)
            if s is None:
                seen[c] = {p}
            else:
                s.add(p)
    return {c: len(s) for c, s in seen.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--min-players', type=int, default=10)
    a = ap.parse_args()

    new = json.load(open(NEW, encoding='utf-8'))
    old = json.load(open(OLD, encoding='utf-8'))
    old_charts = old.get('charts') or {}
    scaled = new.get('scaled') or {}

    print('  反推产物：%d 张谱，观测 %s 条，玩家 %s 名，与声明定数 Spearman %s'
          % (len(scaled), format(new.get('observations', 0), ','),
             format(new.get('players', 0), ','), new.get('spearman_vs_declared')))

    # 每谱人数：直接数 matrix（比旧文件的"样本数"更准，也覆盖新增谱）
    print('  统计每谱玩家数（扫 matrix.jsonl）…')
    players = count_players(MATRIX)
    print('  matrix 覆盖 %d 张谱' % len(players))

    out = {}
    kept_fp = 0
    no_fp = 0
    for cid, val in scaled.items():
        n = players.get(int(cid), 0)
        if n < a.min_players:
            continue
        prev = old_charts.get(str(cid))
        if prev and len(prev) >= 5:
            fp = prev[2:5]
            kept_fp += 1
        else:
            fp = [0, 0, 0]
            no_fp += 1
        out[str(cid)] = [val, n] + list(fp)

    print('  产出 %d 张谱（≥%d 人）；沿用旧指纹 %d，无指纹 %d'
          % (len(out), a.min_players, kept_fp, no_fp))

    # 与旧版本比一比：同一批谱的难度是否有系统性漂移
    common = [k for k in out if k in old_charts]
    if common:
        diffs = sorted(abs(out[k][0] - old_charts[k][0]) for k in common)
        med = diffs[len(diffs) // 2]
        over = sum(1 for d in diffs if d >= 0.5)
        print('  与旧版共有 %d 张；难度差中位数 %.2f，差 ≥0.5 的 %d 张（%.1f%%）'
              % (len(common), med, over, over / len(common) * 100))
    gained = [k for k in out if k not in old_charts]
    lost = [k for k in old_charts if k not in out]
    print('  新增 %d 张，落选 %d 张（不足 %d 人 或 未进反推）'
          % (len(gained), len(lost), a.min_players))

    if not a.write:
        print('\n  （未写文件；加 --write 才会落盘）')
        return

    payload = {
        'note': ('玩家实测难度：log(std) 双向固定效应（剔除单条记录玩家）；'
                 '与声明定数 Spearman %s；观测 %s 条 / 玩家 %s 名'
                 % (new.get('spearman_vs_declared'),
                    format(new.get('observations', 0), ','),
                    format(new.get('players', 0), ','))),
        'charts': dict(sorted(out.items(), key=lambda kv: int(kv[0]))),
    }
    json.dump(payload, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('  已写入 %s（%.1f KB）' % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == '__main__':
    main()
