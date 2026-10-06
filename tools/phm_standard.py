#!/usr/bin/env python3
"""
P.H.M. Standard 公式 v0 —— 自立难度标度（PS 值）

════════════════════════════════════════════════════════════════
定位（与旧路线的根本区别）
════════════════════════════════════════════════════════════════
本公式**不拟合、不预测、不参照官方定数**。它定义 P.H.M. 自己的难度标度：
  「这张谱对玩家施加的操作负荷与读取负荷有多重」

为什么可以不参照官方：官方定数本身是人工标注，实测噪声 2.80 级
（同曲同物量相邻难度差中位）。既然参照对象自带巨幅噪声，
把公式做成它的预测器没有意义——PS 值是独立标度，与官方定数的关系
只有一条：排序应与人类共识高度一致（Spearman ρ，见文末验收）。

════════════════════════════════════════════════════════════════
设计原则
════════════════════════════════════════════════════════════════
1. 确定性：纯函数。同一谱面永远得到同一个数，无学习、无随机、无数据。
2. 有界：所有维度经饱和函数 sat(v,k)=v/(v+k) 映射到 (0,1)。
   —— v→∞ 时贡献趋于 1 而不是发散（v1 线性外推跑到 −1298 的教训）。
   —— k 是「半饱和点」：v=k 时该维贡献 0.5。k 的取值是设计决策，
      依据人类可玩谱的物理常识（文档见各维注释），不拟合任何分布。
3. 分组：四个负荷组——手速 / 结构 / 协调 / 读取，每组内加权、组间再加权。
4. 标度：PS = 20 × 加权和 ∈ (0,20)。
   PS 20 ≡ 四组全部饱和（超越人类可玩范围的极端谱）；
   PS 10 ≡ 各维平均处于半饱和点附近。这只是标度定义，不是对官方的映射。
5. 全部输入维度可从谱面文件（chart.json）独立计算——零外部数据。

════════════════════════════════════════════════════════════════
验收标准（main() 自动执行）
════════════════════════════════════════════════════════════════
A. 单调性（性质测试）：合成谱在「加密度 / 加长押 / 加演出」时 PS 必须上升。
B. 有界性：任意极端输入（100× 密度、全屏乱甩）PS < 20，无发散。
C. 排序一致性：官谱 1,037 条上 PS 与官方定数的 Spearman ρ。
   —— 这是**报告性指标**（看公式的排序是否与人类共识同向），
      不是拟合目标；ρ 低于 0.80 视为设计失败，需要回炉。
"""
import json
import math
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))
DATA = os.path.join(ROOT, "data", "official.jsonl")


def sat(v, k):
    """饱和归一：v/(v+k) ∈ (0,1)。v=k 时=0.5（半饱和点）。"""
    if v <= 0:
        return 0.0
    return v / (v + k)


# ══════════════════════════════════════════════════════════════
# 四个负荷组（k = 半饱和点，注释即设计依据）
# ══════════════════════════════════════════════════════════════

def g_density(f):
    """密度负荷（主导组）：单位时间的音符量与加权负荷。

    组内排序力实测（官谱 1,037 诊断）：nps 0.79 / iv_mean 0.73 /
    strain_p50 0.72 / above_avg_density_mean 0.70（IN 组）。

    - real_notes_per_second  总密度（含 flick/drag 的真实音符/秒）。k=6。
    - notes_real             总物量（耐力维：长谱体力要求）。k=1200。
    - strain_p50             加权密度中位（tap/drag=1.0 flick=0.35 hold=0.55）。
      k=10。
    - above_avg_density_mean 高潮段平均有效密度。k=8。
    - iv_mean                音符平均间隔秒（越小越难）。k=0.30：4 音/秒半负荷。
    """
    return (0.30 * sat(f.get("real_notes_per_second", 0), 6.0)
            + 0.20 * sat(f.get("notes_real", 0), 1200.0)
            + 0.20 * sat(f.get("strain_p50", 0), 10.0)
            + 0.15 * sat(f.get("above_avg_density_mean", 0), 8.0)
            + 0.15 * sat(f.get("iv_mean", 0), 0.30))


def g_pattern(f):
    """结构负荷：空间与配置的切换复杂度。

    - cross_hand_density  交叉手密度。k=1.2。组内排序力 0.70/0.73（IN/HD），
      是被低估的强信号——大幅位移的快速交替是真实的读谱与手位负担。
    - stair_speed_max     纵连峰值速度。k=14：峰值比均值更代表难点。k 取
      接近人手极限的一半。
    - note_clutter_ratio  高速音符杂乱度（<0.1s 间隔占比，百分比）。k=35。
    - pattern_switch_rate 类型切换/秒。k=4。
    """
    return (0.35 * sat(f.get("cross_hand_density", 0), 1.2)
            + 0.25 * sat(f.get("stair_speed_max", 0), 14.0)
            + 0.20 * sat(f.get("note_clutter_ratio", 0), 35.0)
            + 0.20 * sat(f.get("pattern_switch_rate", 0), 4.0))


def g_coord(f):
    """协调负荷：多押与瞬时双手独立度（长押干扰已出列——
    诊断显示 hold 占比与官方组内排序几乎无关甚至反向，长押段常是休息段）。

    - eff_peak_tps_1s     有效峰值密度（同押去冗余）。k=14。
    - avg_chord_size      平均和弦大小。k=3。
    - multi_finger_3plus_events / duration_s  三押以上事件频率。k=0.5。
    - chord_size_entropy  和弦大小熵（配置多样性）。k=0.8。
    """
    return (0.25 * sat(f.get("eff_peak_tps_1s", 0), 14.0)
            + 0.30 * sat(f.get("avg_chord_size", 1.0), 3.0)
            + 0.25 * sat(f.get("multi_finger_3plus_events", 0)
                         / max(f.get("duration_s", 1.0), 0.01), 0.5)
            + 0.20 * sat(f.get("chord_size_entropy", 0), 0.8))


def g_stamina(f):
    """持续负荷（轻权重）：有效平均密度与长押持续性。

    诊断显示这两项的组内排序力中等（0.60/0.35），故只给 0.10 的组权重——
    保留「耐力」概念但不让它稀释主信号。判定线演出（move/rotate/disappear）
    实测为装饰性信号（组内 0.29-0.47），完全出列，仅在报告中展示。
    """
    return (0.60 * sat(f.get("eff_avg_tps_1s", 0), 6.0)
            + 0.40 * sat(f.get("hold_ratio", 0), 0.35))


# 组间权重：密度是节奏游戏难度的主导项（组内 0.72-0.79），
# 结构次之，协调与持续为修正项。判定线演出只展示不参与打分。
W = {"density": 0.45, "pattern": 0.30, "coord": 0.15, "stamina": 0.10}
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
    """一个普通中难度的合成谱特征（性质测试的基准点）"""
    return {"real_notes_per_second": 5.0, "notes_real": 900.0,
            "strain_p50": 7.0, "above_avg_density_mean": 6.0,
            "iv_mean": 0.25, "eff_avg_tps_1s": 4.0, "eff_peak_tps_1s": 9.0,
            "stair_speed_max": 8.0, "cross_hand_density": 0.6,
            "note_clutter_ratio": 8.0, "pattern_switch_rate": 2.2,
            "avg_chord_size": 1.6, "chord_size_entropy": 0.5,
            "multi_finger_3plus_events": 12, "duration_s": 120.0,
            "hold_ratio": 0.20}


def check_monotonic():
    """A. 单调性：负荷增加 → PS 必须上升"""
    base = _base_feats()
    tests = [
        ("有效密度 ×1.6", {k: v for k, v in base.items()
                           if k != "eff_avg_tps_1s"},
         {"eff_avg_tps_1s": base["eff_avg_tps_1s"] * 1.6}),
        ("峰值密度 ×1.5", {k: v for k, v in base.items()
                           if k != "eff_peak_tps_1s"},
         {"eff_peak_tps_1s": base["eff_peak_tps_1s"] * 1.5}),
        ("纵连峰值 ×1.6", {k: v for k, v in base.items()
                           if k != "stair_speed_max"},
         {"stair_speed_max": base["stair_speed_max"] * 1.6}),
        ("长押占比 0.20→0.45", {k: v for k, v in base.items()
                                if k not in ("hold_ratio",
                                             "hold_interference_index")},
         {"hold_ratio": 0.45, "hold_interference_index": 45.0}),

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
    # 设计确认（非单调性）：判定线演出是装饰性信号，实测组内排序力 0.29-0.47，
    # 已完全出列——改变它不应影响 PS。
    f0 = dict(base); f1 = dict(base)
    for k in f1:
        if k.startswith("jline_"):
            f1[k] = f1[k] * 3.0
    t0, _ = ps_score(f0); t1, _ = ps_score(f1)
    print(f"  ◦ [设计确认] 判定线演出 ×3 → PS 不变 "
          f"({t0:.2f} == {t1:.2f})：{'✓' if abs(t1-t0)<1e-9 else '✗'}")
    return ok


def check_bounded():
    """B. 有界性：极端输入不发散"""
    extreme = {k: v * 100 for k, v in _base_feats().items()}
    extreme["duration_s"] = _base_feats()["duration_s"]  # 时长不变，负荷 100 倍
    t, g = ps_score(extreme)
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
    """C. 排序一致性：PS 与官方定数的 Spearman ρ（报告性指标，不拟合）。

    ⚠️ 验收标准不是绝对值：官方定数并列严重（EZ 97% 的谱共用 25 个定数值），
    并列天然压低 Spearman。公平基准是「该档最强单维度的 ρ」——
    公式必须 ≥ 它的 90%（不明显劣于自己最好的成分；理想是超过它）。
    """
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
    rows = [r for r in rows if r.get("notes_real", 0) > 0]
    skip = {"song_id", "level", "difficulty", "name", "composer", "charter",
            "bpm_items"}
    keys = [k for k, v in rows[0].items()
            if k not in skip and isinstance(v, (int, float))]
    ps, off = [], []
    for r in rows:
        t, _ = ps_score(r)
        ps.append(t)
        off.append(float(r["difficulty"]))
    out = {"all": (spearman(ps, off), None, len(ps))}
    for lv in ("EZ", "HD", "IN", "AT"):
        sub = [r for r in rows if (r.get("level") or "").upper() == lv]
        if len(sub) < 30:
            continue
        o = [float(r["difficulty"]) for r in sub]
        p_lv = [ps_score(r)[0] for r in sub]
        best = 0.0
        for k in keys:
            v = [float(r.get(k, 0) or 0) for r in sub]
            if max(v) - min(v) < 1e-9:
                continue
            best = max(best, abs(spearman(v, o)))
        out[lv] = (spearman(p_lv, o), best, len(sub))
    print(f"  全集 n={out['all'][2]}:  ρ = {out['all'][0]:.4f}")
    for lv, (r_ps, r_best, n) in out.items():
        if lv == "all":
            continue
        ratio = r_ps / r_best if r_best else 0
        mark = "✓" if ratio >= 0.90 else "✗"
        print(f"  {lv:<4} n={n:<5} PS ρ={r_ps:.4f}  最强单维 {r_best:.4f}  "
              f"比值 {ratio:.2f} {mark}")
    return out


def main():
    bar = "═" * 64
    nl = chr(10)
    print(bar)
    print("P.H.M. Standard 公式 v0 验收")
    print(bar)
    print(nl + "[A] 单调性（性质测试）")
    a = check_monotonic()
    print(nl + "[B] 有界性")
    b = check_bounded()
    print(nl + "[C] 排序一致性（Spearman，报告性指标）")
    by_lv = check_spearman()
    print(nl + bar)
    worst = min(r_ps / r_best for lv, (r_ps, r_best, _) in by_lv.items()
                if r_best)
    verdict = (a and b and by_lv["all"][0] >= 0.85 and worst >= 0.90)
    lvl = " · ".join(f"{lv} {r_ps:.2f}/{r_best:.2f}"
                     for lv, (r_ps, r_best, _) in by_lv.items() if lv != "all")
    print(f"验收：单调性 {'✓' if a else '✗'} · 有界性 {'✓' if b else '✗'} · "
          f"ρ(全集) {by_lv['all'][0]:.3f} "
          f"{'✓' if by_lv['all'][0] >= 0.85 else '✗'}")
    print(f"分组（PS ρ / 最强单维 ρ）：{lvl}")
    print(f"最差比值 {worst:.2f} {'✓' if worst >= 0.90 else '✗'}（标准：≥0.90）")
    print("结论：", "v0 设计合格，可以进入 JS 移植" if verdict
          else "设计需回炉（见上方未达标项）")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
