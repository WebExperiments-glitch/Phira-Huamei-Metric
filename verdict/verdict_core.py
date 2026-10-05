#!/usr/bin/env python3
"""
难度显影引擎 —— Phira Verdict

定位（重要）：
  本工具【不做裁判，不判虚标】。
  官方定数本身是人工标注，噪声 2.80 级（实测：同曲同物量相邻难度定数差中位 2.80）。
  任何工具都无法区分「谱师标错」与「官方也会这么标」。

  本工具做的是【显影】：
  1. 给参考区间（不给点值），基于官谱实测映射，100% 可复现
  2. 给特征差异（你和同类的差距在哪，可争论）
  3. 给官谱参照（最相似的官谱及其定价，完全可查证）
  4. 四条硬判据（不依赖任何模型的事实性检查）

设计约束：
  · 公式 100% 可审计 —— 每个格子都能追溯到具体官谱
  · 超出覆盖范围时诚实降置信度，不静默给值
  · 纯标准库，无第三方依赖
"""
import bisect
import json
import math
import os
import statistics as st
from collections import defaultdict

# ============================================================
# 档位定义（来自官谱实测分布切分）
# ============================================================
NPS_EDGES = [0, 2.5, 4.5, 6.5, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]
NPS_LABEL = ["0~2.5", "2.5~4.5", "4.5~6.5", "6.5~10", "10+"]
HOLD_LABEL = ["0~12%", "12~25%", "25~40%", "40~55%", "55%+"]
LEVELS = ["EZ", "HD", "IN", "AT"]

# 官方难度区间（实测 1,037 条官谱）
LEVEL_RANGE = {
    "EZ": (0.0, 10.5), "HD": (3.0, 14.5),
    "IN": (6.5, 17.5), "AT": (13.0, 18.0),
    "SP": None,
}
MAX_OFFICIAL = 18.0        # 官方历史最高（DesultorySignals AT）
MIN_N = 4                  # 建表最小样本


def bucket(v, edges):
    if v is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= v < edges[i + 1]:
            return i
    return None


def base_key(nps, hold_ratio, level):
    lv = (level or "").upper()[:2]
    ni = bucket(nps, NPS_EDGES)
    hi = bucket(hold_ratio, HOLD_EDGES)
    if ni is None or hi is None:
        return None
    return (lv, ni, hi)


class Verdict:
    """难度显影引擎"""

    def __init__(self, official_path):
        rows = [json.loads(l) for l in
                open(official_path, encoding="utf-8")]
        self.rows = [r for r in rows if r["notes_real"] > 0]

        # 建表：格内定数分布
        cells = defaultdict(list)
        for r in self.rows:
            k = base_key(r["nps"],
                         r["t_hold"] / r["notes_real"],
                         r["level"])
            if k:
                cells[k].append(r)

        self.table = {}       # (lv,ni,hi) -> {'med','p25','p75','n','vals'}
        for k, sub in cells.items():
            ds = sorted(r["difficulty"] for r in sub)
            if len(ds) < 2:
                continue
            self.table[k] = {
                "med": st.median(ds),
                "p25": ds[len(ds) // 4],
                "p75": ds[min(len(ds) * 3 // 4, len(ds) - 1)],
                "n": len(ds),
                "vals": ds,
            }

        # 标签基线
        by_lv = defaultdict(list)
        for r in self.rows:
            by_lv[(r.get("level") or "").upper()[:2]].append(r["difficulty"])
        self.lv_base = {k: st.median(v) for k, v in by_lv.items()}

        # 各标签内 NPS 四分位（用于特征差异对比）
        self.lv_nps = defaultdict(list)
        self.lv_hold = defaultdict(list)
        self.lv_stair = defaultdict(list)
        self.lv_notes = defaultdict(list)
        for r in self.rows:
            lv = (r.get("level") or "").upper()[:2]
            self.lv_nps[lv].append(r["nps"])
            self.lv_hold[lv].append(r["t_hold"] / r["notes_real"] * 100)
            self.lv_stair[lv].append(r.get("stair_speed_avg", 0) or 0)
            self.lv_notes[lv].append(r["notes_real"])

        self.global_med = st.median([r["difficulty"] for r in self.rows])
        self.n_official = len(self.rows)

    # ---------------- 1. 参考区间 ----------------
    def reference_range(self, nps, hold_ratio, level):
        """
        返回 (lo, hi, mid, conf, basis)
        区间 = 官谱同类格内的 P25~P75，加回退链

        ★ 上界加 0.2 的容差：
          官谱格内 P75 已经偏高（75% 的样本低于它），
          再直接与标注比较，边界附近会有大量「刚好越界」的误报。
          实测加 0.2 容差后，高于上界的比例从 26.7% 降到合理水平。
        """
        k = base_key(nps, hold_ratio, level)
        lv = (level or "").upper()[:2]
        TOL = 0.2

        if k and k in self.table:
            t = self.table[k]
            conf = "high" if t["n"] >= 8 else "mid"
            return (t["p25"], t["p75"] + TOL, t["med"], conf,
                    f"官谱同标签同NPS同Hold档（n={t['n']}，"
                    f"区间为格内 P25~P75+{TOL}）")

        if lv in self.lv_base:
            return (None, None, self.lv_base[lv], "low",
                    "仅标签基线（档位无官谱样本）")
        return (None, None, self.global_med, "none", "全局兜底")

    # ---------------- 2. 特征差异 ----------------
    @staticmethod
    def _pct_delta(val, pool):
        if not pool:
            return None
        s = sorted(pool)
        p = s[len(s) // 2]
        if p == 0:
            return None
        return (val - p) / p * 100

    @staticmethod
    def _rank_pct(val, pool):
        """在同类中的百分位 0~100"""
        if not pool:
            return None
        n = sum(1 for x in pool if x < val)
        return n / len(pool) * 100

    def feature_diff(self, feat, nps, hold_ratio, level):
        """
        返回特征对照：{值, 同类中位, 百分位, 偏离%, 解读}
        """
        lv = (level or "").upper()[:2]
        specs = {
            "nps": (nps, self.lv_nps.get(lv), "NPS（每秒手数）"),
            "hold_ratio": (hold_ratio * 100 if hold_ratio < 1.5
                           else hold_ratio,
                           self.lv_hold.get(lv), "Hold占比"),
            "notes_real": (None, self.lv_notes.get(lv), "物量"),
            "stair_speed_avg": (None, self.lv_stair.get(lv), "纵连速度"),
        }
        if feat == "notes_real":
            pool = self.lv_notes.get(lv)
            val = nps and None
            return pool
        if feat == "stair_speed_avg":
            return self.lv_stair.get(lv)
        if feat == "hold_ratio":
            return self.lv_hold.get(lv)
        if feat == "nps":
            return self.lv_nps.get(lv)
        return None

    def compare(self, nps, hold_ratio, notes_real, stair_speed, level):
        """完整的特征对照报告"""
        lv = (level or "").upper()[:2]
        hr = hold_ratio * 100 if hold_ratio < 1.5 else hold_ratio
        out = []

        def add(key, val, label, higher_harder):
            pool = {
                "nps": self.lv_nps.get(lv),
                "hold_ratio": self.lv_hold.get(lv),
                "notes_real": self.lv_notes.get(lv),
                "stair_speed_avg": self.lv_stair.get(lv),
            }.get(key)
            if val is None or not pool:
                return
            med = st.median(sorted(pool))
            pct = self._rank_pct(val, pool)
            d = self._pct_delta(val, pool)
            if d is None:
                d = 0.0
            if d > 15:
                tag = "偏高" if higher_harder else "偏高（但难度贡献为负）"
            elif d < -15:
                tag = "偏低"
            else:
                tag = "接近中位"
            out.append({
                "label": label, "val": round(val, 2),
                "peer_median": round(med, 2),
                "percentile": round(pct, 1) if pct is not None else None,
                "delta_pct": round(d, 1),
                "tag": tag,
            })

        add("nps", nps, "NPS（每秒手数）", True)
        add("notes_real", notes_real, "物量", True)
        add("hold_ratio", hr, "Hold占比", False)   # 占比越高强度越分散
        add("stair_speed_avg", stair_speed, "纵连速度", True)
        return out

    # ---------------- 3. 官谱参照 ----------------
    def similar_official(self, nps, hold_ratio, notes_real, level,
                         top=5, weights=(1.0, 0.8, 0.6)):
        """
        找最相似的官谱。
        相似度用对数尺度上的相对距离（各维度量级不同，需归一）
        """
        lv = (level or "").upper()[:2]
        cands = [r for r in self.rows
                 if (r.get("level") or "").upper()[:2] == lv]
        if not cands:
            cands = self.rows

        ln, lh = math.log1p(max(nps, .01)), math.log1p(max(hold_ratio * 100, .01))
        lnn = math.log1p(max(notes_real, 1))
        scored = []
        for r in cands:
            dn = abs(math.log1p(max(r["nps"], .01)) - ln)
            dh = abs(math.log1p(r["t_hold"] / r["notes_real"] * 100) - lh)
            dnn = abs(math.log1p(r["notes_real"]) - lnn)
            # 归一化到相对差异
            rel_n = dn / max(abs(ln), .1)
            rel_h = dh / max(abs(lh), .1)
            rel_nn = dnn / max(abs(lnn), .1)
            dist = (rel_n * weights[0] + rel_h * weights[1]
                    + rel_nn * weights[2])
            scored.append((dist, r))
        scored.sort(key=lambda x: x[0])
        return [{
            "name": r["name"], "level": r["level"],
            "difficulty": r["difficulty"],
            "nps": round(r["nps"], 2),
            "notes_real": r["notes_real"],
            "hold_pct": round(r["t_hold"] / r["notes_real"] * 100, 1),
            "similarity": round(max(0.0, 1 - d), 3),
        } for d, r in scored[:top]]

    # ---------------- 4. 硬判据 ----------------
    def hard_checks(self, difficulty, level, peer_median=None):
        """
        不依赖任何模型的检查。返回 (是否通过, 检查项列表)
        """
        lv = (level or "").upper()[:2]
        out = []

        # 1. 定数超官方历史上限
        if difficulty > MAX_OFFICIAL:
            out.append({
                "kind": "hard", "pass": False, "level": "critical",
                "msg": f"定数 {difficulty:.1f} 超出官方历史最高 {MAX_OFFICIAL}",
                "basis": f"官谱 {self.n_official} 条定数无一超过 {MAX_OFFICIAL}"
                         "（DesultorySignals AT）",
            })
        else:
            out.append({
                "kind": "hard", "pass": True, "level": "info",
                "msg": f"定数 {difficulty:.1f} 在官方历史范围内",
                "basis": f"官方最高 {MAX_OFFICIAL}",
            })

        # 2. 难度标签与定数区间矛盾
        if lv in LEVEL_RANGE and LEVEL_RANGE[lv]:
            lo, hi = LEVEL_RANGE[lv]
            if difficulty > hi:
                out.append({
                    "kind": "hard", "pass": False, "level": "critical",
                    "msg": f"{lv} 定数 {difficulty:.1f} 超出官方 {lv} 区间上限 {hi}",
                    "basis": f"实测官谱 {lv} 区间",
                })
            elif difficulty < lo:
                out.append({
                    "kind": "hard", "pass": False, "level": "warn",
                    "msg": f"{lv} 定数 {difficulty:.1f} 低于官方 {lv} 区间下限 {lo}",
                    "basis": f"实测官谱 {lv} 区间",
                })
            else:
                out.append({
                    "kind": "hard", "pass": True, "level": "info",
                    "msg": f"{lv} 定数 {difficulty:.1f} 在官方 {lv} 区间内",
                    "basis": f"实测官谱 {lv} 区间 [{lo}, {hi}]",
                })

        # 3. Liveness 双字段冲突（phira.moe 前端同款规则）
        import re
        m = re.search(r"Lv\.\s*(\d+(?:\.\d+)?)", (level or ""), re.I)
        if m and not (level or "").strip().upper().startswith("UK"):
            lv_num = float(m.group(1))
            if abs(lv_num - difficulty) >= 1:
                out.append({
                    "kind": "hard", "pass": False, "level": "critical",
                    "msg": f"等级文字(Lv.{lv_num})与定数({difficulty:.1f})相差 "
                           f"{abs(lv_num - difficulty):.1f}，超出 1.0 阈值",
                    "basis": "phira.moe 前端校验器同款规则"
                             "（levelDifficultyMismatch）",
                })
            else:
                out.append({
                    "kind": "hard", "pass": True, "level": "info",
                    "msg": f"等级文字与定数一致（差 "
                           f"{abs(lv_num - difficulty):.1f} < 1.0）",
                    "basis": "phira.moe 前端校验器同款规则",
                })

        # 4. 与同类中位偏离
        if peer_median is not None:
            dev = difficulty - peer_median
            if abs(dev) >= 2.0:
                out.append({
                    "kind": "soft", "pass": False,
                    "level": "warn" if dev > 0 else "info",
                    "msg": f"标注定数比同类中位{'高' if dev>0 else '低'} "
                           f"{abs(dev):.1f} 级",
                    "basis": "同类 = 同难度标签 + 同物量区间",
                })
        return out
