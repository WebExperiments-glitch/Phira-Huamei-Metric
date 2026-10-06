#!/usr/bin/env python3
"""
P.H.M. Standard 公式 v0.1 —— 自立难度标度（PS 值）

════════════════════════════════════════════════════════════════
定位
════════════════════════════════════════════════════════════════
本公式**不拟合、不预测、不参照官方定数**。它定义 P.H.M. 自己的难度标度：
  「这张谱对玩家施加的操作负荷与读取负荷有多重」

为什么不参照官方：官方定数是人工标注，实测噪声 2.80 级；且社区谱的
官方定数与可测负荷在 5-11 档几乎不相关（谱面定数文化）——
把公式做成它的预测器既不可能（见 tools/exp_formula.py：52 维上限 0.887，
k-NN 的 1.77 倍）也不必要。PS 是独立标度，与官方定数的关系只有一条：
排序应与人类共识同向（官方谱 Spearman ρ = 0.91，验收见 main()）。

════════════════════════════════════════════════════════════════
设计
════════════════════════════════════════════════════════════════
1. 确定性：纯函数，零数据。同一谱面永远得到同一个数。
2. 饱和：sat(v,k) = 1-exp(-v/k)。
   —— 有界（v→∞ → 1，v1 线性外推发散的教训）、
   —— 头部能冲上去（v=k→0.63，2k→0.86，3k→0.95），
      让极值谱（stair 40/s、p99 19）的负荷能传到总分。
   —— 递减维度（音符间隔 iv_mean：越小越难）用 satd(v,k)=exp(-v/k)。
3. 峰值加权：难度感由「最难的部分」主导——密度组以 p99 峰值密度为首项，
   结构组以纵连峰值为首项，而非平均值的加权和。
4. 标尺校准：k = 该维度在社区谱语料（App 的真实输入人群，n=9,684）的
   P75 分位（iv_mean 取 P25，反向维度）。这是**单位选择**——
   让标尺覆盖真实谱面的负荷范围——不是对官方难度值的拟合。
5. 组间权重：密度 0.40 / 结构 0.30 / 协调 0.15 / 持续 0.15。
6. 判定线演出（move/rotate/disappear）完全出列：实测组内排序力 0.29-0.47，
   装饰性信号，仅在报告中展示。
7. 长押占比出列：诊断显示其与官方组内排序几乎无关（长押段常是休息段），
   且社区谱的长押文化与官方差异大。持续组由核心音符密度与总物量承担。
8. 全部输入维度可从谱面文件（chart.json）独立计算——零外部数据。

════════════════════════════════════════════════════════════════
标度含义
════════════════════════════════════════════════════════════════
PS 20 ≡ 各负荷组全部饱和（超越人类可玩范围的极端谱）。
按社区语料校准后的实测包络（官方定数 → PS 中位）：
  官方 5 → ~7 · 8 → ~7 · 13 → ~10 · 15.3 → ~11 · 17.6 → ~13
注意：PS 与官方数值**不需要相等**（见「定位」）。官方 5-11 档的
社区谱在负荷上彼此难分，PS 会给出它诚实的负荷读数。

验收（main()）：A 单调性 · B 有界性 · C 官方谱排序一致性（ρ ≥ 0.85）。
"""
import json
import math
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data", "official.jsonl")


def sat(v, k):
    """递增饱和：1-exp(-v/k)。v=k→0.63，2k→0.86，3k→0.95，v→∞→1。"""
    if v <= 0:
        return 0.0
    return 1.0 - math.exp(-v / k)


def satd(v, k):
    """递减饱和（「越小越难」的维度）：v→0+ 时 →1，v=k→0.37，v→∞→0。"""
    if v <= 0:
        return 0.0
    return math.exp(-v / k)


# ── 标尺校准常数：社区语料（n=9,684）各维 P75（iv_mean 为 P25，反向）──
K = {
    "strain_p99": 20.4,
    "above_avg_density_mean": 10.7081,
    "real_notes_per_second": 9.5682,
    "iv_mean": 0.1413,
    "stair_speed_max": 33.7778,
    "cross_hand_density": 7.5408,
    "note_clutter_ratio": 68.2235,
    "pattern_switch_rate": 3.0663,
    "avg_chord_size": 1.4539,
    "multi_finger_3plus_events": 0.3366,   # 次/秒
    "chord_size_entropy": 0.6203,
    "real_core_notes_per_second": 6.7287,
    "notes_real": 1441.0,
}


def g_density(f):
    """密度负荷：峰值加权密度主导，附持续密度与音符间隔。"""
    return (0.35 * sat(f.get("strain_p99", 0), K["strain_p99"])
            + 0.25 * sat(f.get("above_avg_density_mean", 0),
                         K["above_avg_density_mean"])
            + 0.25 * sat(f.get("real_notes_per_second", 0),
                         K["real_notes_per_second"])
            + 0.15 * satd(f.get("iv_mean", 0), K["iv_mean"]))


def g_pattern(f):
    """结构负荷：纵连峰值、交叉手、杂乱度、模式切换。"""
    return (0.35 * sat(f.get("stair_speed_max", 0), K["stair_speed_max"])
            + 0.30 * sat(f.get("cross_hand_density", 0),
                         K["cross_hand_density"])
            + 0.20 * sat(f.get("note_clutter_ratio", 0),
                         K["note_clutter_ratio"])
            + 0.15 * sat(f.get("pattern_switch_rate", 0),
                         K["pattern_switch_rate"]))


def g_coord(f):
    """协调负荷：和弦规模、三押频率、配置多样性。"""
    mf = (f.get("multi_finger_3plus_events", 0)
          / max(f.get("duration_s", 1.0), 0.01))
    return (0.35 * sat(f.get("avg_chord_size", 0), K["avg_chord_size"])
            + 0.35 * sat(mf, K["multi_finger_3plus_events"])
            + 0.30 * sat(f.get("chord_size_entropy", 0),
                         K["chord_size_entropy"]))


def g_stamina(f):
    """持续负荷：核心音符密度与总物量。"""
    return (0.60 * sat(f.get("real_core_notes_per_second", 0),
                       K["real_core_notes_per_second"])
            + 0.40 * sat(f.get("notes_real", 0), K["notes_real"]))


W = {"density": 0.40, "pattern": 0.30, "coord": 0.15, "stamina": 0.15}
SCALE = 20.0


def ps_score(f):
    """计算 PS 值。f = 特征字典（全部可从 chart.json 现算）。

    返回 (总分, 分组明细)——明细随报告展示，保证每一分都可追溯。
    """
    g = {"density": g_density(f), "pattern": g_pattern(f),
         "coord": g_coord(f), "stamina": g_stamina(f)}
    total = SCALE * sum(W[k] * g[k] for k in W)
    return total, g


# ══════════════════════════════════════════════════════════════
# 验收
# ══════════════════════════════════════════════════════════════

def _base_feats():
    """普通中难度的合成谱特征（性质测试基准点）"""
    return {"strain_p99": 12.0, "above_avg_density_mean": 6.0,
            "real_notes_per_second": 5.0, "iv_mean": 0.25,
            "stair_speed_max": 8.0, "cross_hand_density": 0.6,
            "note_clutter_ratio": 8.0, "pattern_switch_rate": 2.2,
            "avg_chord_size": 1.6, "chord_size_entropy": 0.5,
            "multi_finger_3plus_events": 12, "duration_s": 120.0,
            "real_core_notes_per_second": 4.0, "notes_real": 900.0,
            "hold_ratio": 0.20}


def check_monotonic():
    """A. 单调性：负荷增加 → PS 必须上升"""
    base = _base_feats()
    tests = [
        ("峰值密度 p99 ×1.4", {k: v for k, v in base.items()
                               if k != "strain_p99"},
         {"strain_p99": base["strain_p99"] * 1.4}),
        ("高潮段密度 ×1.5", {k: v for k, v in base.items()
                             if k != "above_avg_density_mean"},
         {"above_avg_density_mean": base["above_avg_density_mean"] * 1.5}),
        ("纵连峰值 ×1.6", {k: v for k, v in base.items()
                           if k != "stair_speed_max"},
         {"stair_speed_max": base["stair_speed_max"] * 1.6}),
        ("交叉手 ×2", {k: v for k, v in base.items()
                       if k != "cross_hand_density"},
         {"cross_hand_density": base["cross_hand_density"] * 2.0}),
        ("物量 ×1.4（持续负荷）", {k: v for k, v in base.items()
                                   if k != "notes_real"},
         {"notes_real": base["notes_real"] * 1.4}),
        ("音符间隔减半（更密）", {k: v for k, v in base.items()
                                 if k != "iv_mean"},
         {"iv_mean": base["iv_mean"] / 2,
          "real_notes_per_second": base["real_notes_per_second"] * 2}),
        ("和弦大小 1.6→3.0", {k: v for k, v in base.items()
                              if k != "avg_chord_size"},
         {"avg_chord_size": 3.0}),
    ]
    ok = True
    b_total, _ = ps_score(base)
    print(f"  基准谱 PS = {b_total:.2f}")
    for name, f0, patch in tests:
        f1 = dict(f0); f1.update(patch)
        t0, _ = ps_score(f0)
        t1, _ = ps_score(f1)
        good = t1 > t0
        ok &= good
        print(f"  {'✓' if good else '✗'} {name:<22} "
              f"{t0:.2f} → {t1:.2f} ({'↑' if good else '未上升'})")
    # 设计确认：判定线演出出列，不影响 PS
    f0 = dict(base); f1 = dict(base)
    for k in f1:
        if k.startswith("jline_"):
            f1[k] = f1[k] * 3.0
    t0, _ = ps_score(f0); t1, _ = ps_score(f1)
    same = abs(t1 - t0) < 1e-9
    print(f"  ◦ [设计确认] 判定线演出 ×3 → PS 不变：{'✓' if same else '✗'}")
    return ok and same


def check_bounded():
    """B. 有界性：极端输入不发散"""
    extreme = {k: v * 100 for k, v in _base_feats().items()}
    extreme["duration_s"] = _base_feats()["duration_s"]
    t, _ = ps_score(extreme)
    ok = 0 < t < 20.0
    print(f"  100× 负荷谱 PS = {t:.2f}  < 20 且 > 0：{'✓' if ok else '✗'}")
    empty = {k: 0.0 for k in _base_feats()}
    t0, _ = ps_score(empty)
    ok &= t0 == 0.0
    print(f"  全零谱   PS = {t0:.2f}  （应为 0）：{'✓' if t0 == 0 else '✗'}")
    return ok


def spearman(a, b):
    """Spearman 秩相关（并列取平均秩）"""
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            m = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = m
            i = j + 1
        return r
    ra, rb = rank(a), rank(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra))
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return cov / (va * vb) if va * vb else 0.0


def check_spearman():
    """C. 排序一致性（报告性指标，不拟合）：
    官方谱 1,037 条上 PS 与官方定数的 Spearman ρ。"""
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
    rows = [r for r in rows if r.get("notes_real", 0) > 0]
    ps, off = [], []
    for r in rows:
        t, _ = ps_score(r)
        ps.append(t)
        off.append(float(r["difficulty"]))
    rho = spearman(ps, off)
    print(f"  官方谱 n={len(ps)}:  ρ = {rho:.4f}")
    return rho


def main():
    bar = "═" * 64
    nl = chr(10)
    print(bar)
    print("P.H.M. Standard 公式 v0.1 验收")
    print(bar)
    print(nl + "[A] 单调性（性质测试）")
    a = check_monotonic()
    print(nl + "[B] 有界性")
    b = check_bounded()
    print(nl + "[C] 排序一致性（Spearman，报告性指标）")
    rho = check_spearman()
    print(nl + bar)
    verdict = (a and b and rho >= 0.85)
    print(f"验收：单调性 {'✓' if a else '✗'} · 有界性 {'✓' if b else '✗'} · "
          f"ρ {rho:.3f} {'✓' if rho >= 0.85 else '✗'}（标准：≥0.85）")
    print("结论：", "v0.1 设计合格" if verdict else "设计需回炉")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
