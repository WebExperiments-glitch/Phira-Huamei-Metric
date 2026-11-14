"""compare-behavior.py —— 新旧两版行为难度在同一批谱上配对比较

【为什么必须配对】
  新版覆盖 9,230 张、旧版 1,700 张，直接比 Spearman 是两批不同的谱 ——
  新加的 7,500 张里如果多是稀疏谱，整体 ρ 被拉低是算术必然，
  不代表模型变差。只有在**交集**上比，才回答"同样的谱，谁估得更准"。
"""
import json
import os
import math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW = os.path.join(ROOT, 'data', 'scores', 'chart_difficulty_behavior.json')
OLD = os.path.join(ROOT, 'phm-web', 'public', 'data', 'behavior-diff.json')
CHARTS = os.path.join(ROOT, 'data', 'crawl', 'charts.jsonl')


def spearman(xs, ys):
    n = len(xs)
    if n < 3:
        return float('nan')

    def rank(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    dy = math.sqrt(sum((b - my) ** 2 for b in ry))
    return num / (dx * dy) if dx and dy else float('nan')


def main():
    new = json.load(open(NEW, encoding='utf-8'))
    old = json.load(open(OLD, encoding='utf-8'))['charts']
    new_s = {int(k): v for k, v in (new.get('scaled') or {}).items()}

    declared = {}
    with open(CHARTS, encoding='utf-8', errors='replace') as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            d = o.get('difficulty')
            if isinstance(d, (int, float)) and d > 0:
                declared[int(o['id'])] = float(d)

    # 旧版的"样本数"在第 2 位
    old_n = {int(k): v[1] for k, v in old.items() if isinstance(v, list) and len(v) >= 2}

    # ⚠ 旧文件的键是字符串，new_s/declared 是 int —— 不归一化交集恒为空
    old_ids = {int(k) for k in old}
    common = sorted(set(new_s) & old_ids & set(declared))
    print('  交集（新版 ∩ 旧版 ∩ 有声明定数）：%d 张' % len(common))
    if not common:
        return

    xs_new = [new_s[c] for c in common]
    xs_old = [old[str(c)][0] for c in common]
    ys = [declared[c] for c in common]

    print('  同批谱上 —— 新版 vs 声明：ρ = %.4f' % spearman(xs_new, ys))
    print('  同批谱上 —— 旧版 vs 声明：ρ = %.4f' % spearman(xs_old, ys))
    print('  新旧两版互相关：          ρ = %.4f' % spearman(xs_new, xs_old))

    # 按旧版样本量分层：小样本谱上模型更容易飘
    for lo, hi, name in ((10, 30, '10–29 人'), (30, 100, '30–99 人'), (100, 10 ** 9, '≥100 人')):
        sub = [c for c in common if lo <= old_n.get(c, 0) < hi]
        if len(sub) < 20:
            continue
        print('    %-10s %5d 张：新 ρ=%.4f  旧 ρ=%.4f'
              % (name, len(sub), spearman([new_s[c] for c in sub], [declared[c] for c in sub]),
                 spearman([old[str(c)][0] for c in sub], [declared[c] for c in sub])))

    # 新版独有的谱（旧版没有）：它们的 ρ 决定"扩覆盖"到底是赚还是亏
    # ⚠ 运算符优先级：& 与 - 同级左结合，不加括号会算成 (new & declared) - old
    only_new = sorted((set(new_s) & set(declared)) - old_ids)
    if len(only_new) > 20:
        print('  新版独有 %d 张 vs 声明：ρ = %.4f'
              % (len(only_new), spearman([new_s[c] for c in only_new], [declared[c] for c in only_new])))


if __name__ == '__main__':
    main()
