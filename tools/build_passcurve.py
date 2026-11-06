"""把「一张谱一个 b」换成「一张谱一条难度响应曲线」。

━━━ 为什么要换 ━━━
短谱 ρ 卡在 0.76，诊断结论是「信息不足」，不是模型不足（残差相关 0.877）。
一个标量 b 把几百个玩家的成绩压成一个数，压掉的东西正是短谱最缺的。

━━━ 新标签怎么构造（不依赖重新拟合 IRT）━━━
1. 每个玩家用「他打过的所有谱的中位 accuracy」当能力代理 skill
2. 把玩家按 skill 分成 5 档（全局分位，不是每张谱各自分）
3. 每张谱在每档里的 accuracy 中位数 → 5 维曲线
4. 另存：通过率（acc≥0.90 的比例）、玩家数、skill 跨度

曲线的形状本身是信息：
  · 平（各档都差不多）→ 这张谱难度与水平无关（纯协调/纯耐力）
  · 陡（强的人明显高）→ 这张谱吃硬实力
  · 倒挂（低档反而高）→ 极可能是标注/采样噪音，要单独看

━━━ 与 b 的关系 ━━━
b 大致对应「曲线在中等水平处的水平位置」，而**斜率**是 b 完全没有的信息。
"""
import json
import os
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PAIRS = os.path.join(DATA, "crawl", "pairs.bin")
SEQ = os.path.join(DATA, "seq-dataset-v0.1-beta.2.npz")
OUT = os.path.join(DATA, "passcurve-v1.npz")
NB = 5          # 能力档数
MIN_CHARTS_P = 5   # 玩家至少打过几张谱
MIN_PLAYERS_C = 30  # 谱至少多少个玩家


def main():
    raw = np.memmap(PAIRS, dtype=np.dtype([("p", "<i4"), ("c", "<i4"), ("a", "<f4")]), mode="r")
    print(f"原始 {len(raw):,} 对", flush=True)

    # 去重：同一 (玩家, 谱) 只留最高 acc
    a = np.asarray(raw["a"], dtype=np.float32)
    p = np.asarray(raw["p"], dtype=np.int64)
    c = np.asarray(raw["c"], dtype=np.int64)
    ok = np.isfinite(a) & (a >= 0) & (a <= 1.01)
    p, c, a = p[ok], c[ok], a[ok]
    key = p.astype(np.int64) * (c.max() + 1) + c
    order = np.lexsort((-a, key))          # 同 key 内 acc 降序
    key, p, c, a = key[order], p[order], c[order], a[order]
    first = np.r_[True, key[1:] != key[:-1]]
    p, c, a = p[first], c[first], a[first]
    print(f"去重后 {len(a):,} 对", flush=True)

    # 玩家能力代理
    pc = np.bincount(p)
    keep_p = pc[p] >= MIN_CHARTS_P
    p, c, a = p[keep_p], c[keep_p], a[keep_p]
    order = np.argsort(p, kind="stable")
    p, c, a = p[order], c[order], a[order]
    bounds = np.r_[0, np.flatnonzero(np.diff(p)) + 1, len(p)]
    skill = np.empty(len(p), dtype=np.float32)
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        skill[s:e] = np.median(a[s:e])
    print(f"过滤玩家后 {len(a):,} 对，玩家 {len(bounds)-1:,}", flush=True)

    # 全局能力分档
    qs = np.quantile(skill, np.linspace(0, 1, NB + 1)[1:-1])
    bkt = np.digitize(skill, qs)

    ids = [str(x) for x in np.load(SEQ, allow_pickle=True)["ids"]]
    cid2i = {v: i for i, v in enumerate(ids)}

    # 按谱聚合
    uq, inv = np.unique(c, return_inverse=True)
    curves = np.full((len(uq), NB), np.nan, dtype=np.float32)
    counts = np.zeros((len(uq), NB), dtype=np.int32)
    for b in range(NB):
        m = bkt == b
        if not m.any():
            continue
        cc, aa = inv[m], a[m]
        s = np.argsort(cc, kind="stable")
        cc, aa = cc[s], aa[s]
        bd = np.r_[0, np.flatnonzero(np.diff(cc)) + 1, len(cc)]
        for i in range(len(bd) - 1):
            s0, e0 = bd[i], bd[i + 1]
            if e0 - s0 < 3:
                continue
            curves[cc[s0], b] = np.median(aa[s0:e0])
            counts[cc[s0], b] = e0 - s0

    n_pl = np.bincount(inv)
    keep = n_pl >= MIN_PLAYERS_C
    print(f"谱 {len(uq):,}，其中 ≥{MIN_PLAYERS_C} 人 {keep.sum():,}", flush=True)

    rows, out_ids, npl = [], [], []
    for i in range(len(uq)):
        if not keep[i]:
            continue
        cid = str(uq[i])
        if cid not in cid2i:
            continue
        out_ids.append(cid)
        rows.append(curves[i])
        npl.append(int(n_pl[i]))
    M = np.stack(rows)
    print(f"与数据集交集 {len(out_ids):,} 张", flush=True)

    # 诊断：曲线斜率 vs 标签 b
    z = np.load(SEQ, allow_pickle=True)
    y = {str(k): float(v) for k, v in zip(z["ids"], z["y"])}
    yy = np.array([y.get(i, np.nan) for i in out_ids])
    have = np.isfinite(yy) & np.isfinite(M).all(1)
    slope = (M[:, -1] - M[:, 0])[have]
    lvl = (M[:, 0] + M[:, 2]) / 2[have] if False else (M[have, 0] + M[have, 2]) / 2
    print(f"可用于诊断 {have.sum():,} 张")
    print(f"  曲线斜率（高档−低档）中位 {np.median(slope):+.4f}，sd {slope.std():.4f}")
    print(f"  corr(中等档 acc, b)  = {np.corrcoef(lvl, yy[have])[0,1]:+.4f}  ← 应为负（越难 acc 越低）")
    print(f"  corr(斜率,      b)  = {np.corrcoef(slope, yy[have])[0,1]:+.4f}  ← b 抓不到的那部分")
    med_pl = int(np.median(npl))
    print(f"  每谱玩家数中位 {med_pl}")

    np.savez_compressed(OUT, ids=np.array(out_ids), curve=M, n_players=np.array(npl, np.int32))
    json.dump(dict(n_chart=len(out_ids), n_pairs=int(len(a)), nb=NB,
                   median_players=med_pl,
                   corr_level_b=float(np.corrcoef(lvl, yy[have])[0, 1]),
                   corr_slope_b=float(np.corrcoef(slope, yy[have])[0, 1])),
              open(os.path.join(DATA, "passcurve-meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"已写 {OUT}")


if __name__ == "__main__":
    main()
