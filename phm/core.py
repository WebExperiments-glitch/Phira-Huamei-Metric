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
import json
import math
import re
import statistics as st
from collections import defaultdict

# ============================================================
# 档位定义（来自官谱实测分布切分）
# ============================================================
# ★ 全项目唯一真源。phm/gui/index.html 的 NE 常量、
#   tools/official_formula_v2.py 的档位都必须与此保持一致。
#
# NPS 用 9 档而非 5 档，是实测选出来的，不是拍脑袋：
#   留一法（官谱 1,037 条，MIN_N=4，三档回退）
#     5 档  点误差中位 0.700  p90 2.000  ≤1.0 命中 69.5%  区间覆盖 56.2%
#     9 档  点误差中位 0.600  p90 1.500  ≤1.0 命中 74.4%  区间覆盖 57.2%
#   9 档在点误差与区间覆盖上**同时**更优，故采纳。
NPS_EDGES = [0, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 8, 10, 100]
HOLD_EDGES = [0.0, 0.12, 0.25, 0.40, 0.55, 1.01]
NPS_LABEL = ["0~1.5", "1.5~2.5", "2.5~3.5", "3.5~4.5", "4.5~5.5",
             "5.5~6.5", "6.5~8", "8~10", "10+"]
HOLD_LABEL = ["0~12%", "12~25%", "25~40%", "40~55%", "55%+"]
LEVELS = ["EZ", "HD", "IN", "AT"]

# ============================================================
# 难度标签归一化（单一真源）
# ============================================================
# 为什么必须归一化：Phira 的 level 字段是自由文本，实测 1,589 种取值，
# 形如 "IN Lv.15" / "IN.15" / "IN  Lv.15" / "IN" / "15" / "Legacy Lv.16"。
# 旧代码用 `level[:2]` 取前两字符，对 "15" 得到 "15"、对 "Legacy" 得到 "LE"，
# 于是前端难度下拉框被 "15" "LE" "$P" 等垃圾淹没，筛选功能实际不可用。
#
# 策略：白名单（只认标准标签），其余一律返回 None 由调用方降级 —— 宁可说
# 「无法识别」也不静默猜错。这与本项目「不猜、可追溯」的原则一致。
_DIFF_RE = re.compile(r"(?<![A-Za-z])(EZ|HD|IN|AT|SP)(?![A-Za-z])", re.I)


def norm_level(level):
    """把自由文本 level 归一化为 EZ/HD/IN/AT/SP；无法识别返回 None"""
    s = (level or "").replace(".", " ").replace("Lv", " ")
    m = _DIFF_RE.search(s)
    return m.group(1).upper() if m else None

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
    lv = norm_level(level)
    ni = bucket(nps, NPS_EDGES)
    hi = bucket(hold_ratio, HOLD_EDGES)
    if ni is None or hi is None:
        return None
    return (lv, ni, hi)


class Verdict:
    """难度显影引擎"""

    def __init__(self, official_path=None, rows=None):
        """official_path：官谱真源 jsonl 路径；或直接传 rows（list[dict]）。

        直接传 rows 供 tools/calibrate_engine.py 做留一法，避免每轮读写磁盘。
        """
        if rows is None:
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

        # 回退表：(lv, ni) —— 丢掉 Hold 档的粗格。
        # 为什么需要：细格 (lv,ni,hi) 样本不足时，旧实现直接掉到「标签中位」
        # （一个点值、无区间）。加这一层能在样本不足时仍给出区间。
        cells2 = defaultdict(list)
        for r in self.rows:
            lv = norm_level(r.get("level"))
            ni = bucket(r["nps"], NPS_EDGES)
            if lv is not None and ni is not None:
                cells2[(lv, ni)].append(r["difficulty"])
        self.table2 = {}
        for k, ds in cells2.items():
            ds = sorted(ds)
            if len(ds) < 2:
                continue
            self.table2[k] = {
                "med": st.median(ds),
                "p25": ds[len(ds) // 4],
                "p75": ds[min(len(ds) * 3 // 4, len(ds) - 1)],
                "n": len(ds),
                "vals": ds,
            }

        # 标签基线
        by_lv = defaultdict(list)
        for r in self.rows:
            by_lv[norm_level(r.get("level"))].append(r["difficulty"])
        self.lv_base = {k: st.median(v) for k, v in by_lv.items()}

        # 各标签内 NPS 四分位（用于特征差异对比）
        self.lv_nps = defaultdict(list)
        self.lv_hold = defaultdict(list)
        self.lv_stair = defaultdict(list)
        self.lv_notes = defaultdict(list)
        for r in self.rows:
            lv = norm_level(r.get("level"))
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

        ★ 回退链（与 tools/official_formula_v2.py 的评估口径一致）：
          1. (lv, nps档, hold档) 样本 ≥ MIN_N → high
          2. (lv, nps档)         样本 ≥ MIN_N → mid
          3. 标签基线                      → low
          4. 全局中位                      → none
          档位定义与 MIN_N 均取自本文件，是全项目唯一真源。
        """
        k = base_key(nps, hold_ratio, level)
        lv = norm_level(level)
        ni = bucket(nps, NPS_EDGES)
        TOL = 0.2

        t = self.table.get(k) if k else None
        if t and t["n"] >= MIN_N:
            return (round(t["p25"], 2), round(t["p75"] + TOL, 2),
                    round(t["med"], 2), "high",
                    f"官谱同标签同NPS同Hold档（n={t['n']}，"
                    f"区间为格内 P25~P75+{TOL}）")

        t2 = (self.table2.get((lv, ni))
              if (lv is not None and ni is not None) else None)
        if t2 and t2["n"] >= MIN_N:
            return (round(t2["p25"], 2), round(t2["p75"] + TOL, 2),
                    round(t2["med"], 2), "mid",
                    f"官谱同标签同NPS档（n={t2['n']}；"
                    f"Hold 档样本不足，已放宽一档）")

        if lv in self.lv_base:
            return (None, None, round(self.lv_base[lv], 2), "low",
                    "仅标签基线（档位无官谱样本）")
        return (None, None, round(self.global_med, 2), "none", "全局兜底")

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

    def compare(self, nps, hold_ratio, notes_real, stair_speed, level):
        """完整的特征对照报告"""
        lv = norm_level(level)
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
                         top=5, weights=(1.0, 0.8, 0.6), exclude=None):
        """
        找最相似的官谱。
        相似度用对数尺度上的相对距离（各维度量级不同，需归一）

        exclude：需要排除的样本（按对象身份）。自检时传入被查询的官谱行，
                 否则它会以 100% 相似度返回自己，构成无意义的自证。
        """
        lv = norm_level(level)
        cands = [r for r in self.rows
                 if norm_level(r.get("level")) == lv]
        if exclude is not None:
            cands = [r for r in cands if r is not exclude]
        if not cands:
            cands = [r for r in self.rows if r is not exclude]

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
        lv = norm_level(level)
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
