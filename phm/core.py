#!/usr/bin/env python3
"""
难度显影引擎 —— P.H.M.

定位（重要）：
  本工具【不做裁判，不判虚标】。
  官方定数本身是人工标注，噪声 2.80 级（实测：同曲同物量相邻难度定数差中位 2.80）。
  任何工具都无法区分「谱师标错」与「官方也会这么标」。

  本工具输出四样东西：
  1. 点估计 + 不确定带 —— 与你最相似的 N 首官谱，它们定价多少
     （留一法实测：误差中位 0.5 级，p90 1.5 级；见 tools/calibrate_engine.py）
  2. 特征差异（你和同类的差距在哪，可争论）
  3. 官谱参照（最相似的官谱及其定价，完全可查证）
  4. 四条硬判据（不依赖任何模型的事实性检查）

设计约束：
  · 100% 可审计 —— 点估计就是「这 N 首官谱的定价中位」，逐首可查
  · 不确定度必须如实标注，不制造虚假精度
  · 纯标准库，无第三方依赖

方法演进：
  v1 线性回归 → v2 分层查表（档位离散） → **v3 k-NN 点估计（现行）**
  换成 k-NN 的原因是可测量的：留一法中位误差 0.600 → 0.500，
  ≤1.0 命中 74.5% → 80.8%。且 k-NN 能接住「纵连速度」这类连续弱信号，
  离散分档做不到（见 docs/结果/18维要素实验结果.md、tools/exp_point_estimate.py）。
"""
import json
import math
import re
import statistics as st
from collections import defaultdict

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


# ============================================================
# 点估计器参数（k-NN）
# ============================================================
# 为什么用 k-NN 而不是查表 —— 实测（tools/exp_point_estimate.py，留一法，官谱 1,037）：
#   查表（细格 × Hold 档）        中位误差 0.600  ≤1.0 命中 74.5%
#   k-NN k=20 四特征 z-score      中位误差 0.500  ≤1.0 命中 80.7%   ← 采纳
# 选 k=20 而非更小：k=10 中位同为 0.5 但 ≤0.5 命中 54.6% < k=20 的 56.2%。
# 之所以 k-NN 能用上「纵连速度」：它作为离散分档维度加进查表会摊薄样本而变差
# （见 docs/结果/18维要素实验结果.md），但在连续距离度量里是有效信号
# （偏相关 +0.52，全项目最强残余信号）。
KNN_K = 20          # 近邻数
KNN_BW = 2.0        # 高斯核带宽系数
KNN_ZSCORE = True   # 四个特征先 z-score 再算欧氏距离


def knn_feats(nps, hold_pct, notes, stair):
    """k-NN 特征向量（对数空间）—— 前端必须与此完全一致"""
    return (math.log1p(max(nps, 0.01)), math.log1p(max(hold_pct, 0.01)),
            math.log1p(max(notes, 1)), math.log1p(max(stair, 0.01)))


def wquantile(pairs, q):
    """加权分位（pairs = [(value, weight)]）。比加权平均抗离群。"""
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    if tot <= 0:
        return None
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= tot * q:
            return v
    return pairs[-1][0]

# 官方难度区间（实测 1,037 条官谱）
LEVEL_RANGE = {
    "EZ": (0.0, 10.5), "HD": (3.0, 14.5),
    "IN": (6.5, 17.5), "AT": (13.0, 18.0),
    "SP": None,
}
MAX_OFFICIAL = 18.0        # 官方历史最高（DesultorySignals AT）


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

        # k-NN 索引（点估计的唯一估计器）
        self._Z, self._Y, self._L = [], [], []
        for r in self.rows:
            nr = max(r["notes_real"], 1)
            self._Z.append(knn_feats(r["nps"], r["t_hold"] / nr * 100,
                                     r["notes_real"],
                                     r.get("stair_speed_avg") or 0))
            self._Y.append(r["difficulty"])
            self._L.append(norm_level(r.get("level")))
        n = len(self._Z) or 1
        self._mu, self._sd = [], []
        for c in range(4):
            col = [z[c] for z in self._Z]
            m = sum(col) / n
            s = (sum((v - m) ** 2 for v in col) / n) ** 0.5 or 1.0
            self._mu.append(m)
            self._sd.append(s)

    # ---------------- 0. k-NN 点估计 ----------------
    def neighbors(self, nps, hold_ratio, notes_real, stair_speed=0,
                  level=None, k=KNN_K, exclude_idx=None):
        """返回 [(距离, 行下标)]，距离升序。

        在同难度标签内检索（实测：全标签混池会把误差从 0.5 抬到 0.8）；
        标签内样本不足 k 时放开到全体，避免小标签（AT 仅 56 条）无法检索。

        exclude_idx：要排除的行下标（自检/留一法时必须排除查询样本自身，
                     否则它会以距离 0 成为自己的最近邻，构成自证）。
        """
        q = knn_feats(nps, hold_ratio * 100, notes_real, stair_speed)
        qz = [(q[c] - self._mu[c]) / self._sd[c] for c in range(4)]
        lv = norm_level(level)
        pool = [i for i, x in enumerate(self._L)
                if x == lv and i != exclude_idx] if lv else []
        if len(pool) < k:
            pool = [i for i in range(len(self.rows)) if i != exclude_idx]
        out = []
        for i in pool:
            z = self._Z[i]
            d2 = 0.0
            for c in range(4):
                v = (z[c] - self._mu[c]) / self._sd[c]
                d2 += (v - qz[c]) ** 2
            out.append((math.sqrt(d2), i))
        out.sort(key=lambda p: p[0])
        return out[:k]

    def point_estimate(self, nps, hold_ratio, notes_real, stair_speed=0,
                       level=None, k=KNN_K, exclude_idx=None):
        """点估计 + 不确定带。

        返回 dict：point（近邻定数的核加权中位）、lo/hi（加权 P25/P75）、
        basis（依据说明）、k（近邻数）、spread（= hi - lo）。

        注意：这里不返回近邻明细 —— 需要展示时调用 similar_official()，
        两者都基于同一个 neighbors()，不重复实现。
        """
        near = self.neighbors(nps, hold_ratio, notes_real, stair_speed,
                              level, k, exclude_idx=exclude_idx)
        if not near:
            return {"point": self.global_med, "lo": None, "hi": None,
                    "basis": "全局兜底（无近邻）", "k": 0, "spread": None}
        scale = max(near[-1][0], 1e-6)
        pairs = [(self._Y[i], math.exp(-(d / scale) ** 2 * KNN_BW))
                 for d, i in near]
        lo = wquantile(pairs, 0.25)
        hi = wquantile(pairs, 0.75)
        return {
            "point": round(wquantile(pairs, 0.50), 3),
            "lo": round(lo, 2),
            "hi": round(hi, 2),
            "spread": round(hi - lo, 2),
            "basis": (f"{len(near)} 首最相似官谱的定价中位"
                      f"（同难度标签内检索；特征 NPS/长条占比/物量/纵连）"),
            "k": len(near),
        }

    # ---------------- 1. 参考区间 ----------------
    def reference_range(self, nps, hold_ratio, notes_real, stair_speed,
                        level, exclude_idx=None):
        """返回 (lo, hi, point, conf, basis)。

        ★ 已由「查表」改为「k-NN 点估计」——与 point_estimate 同源，
          不再有两套模型。留一法实测：中位误差 0.600 → 0.500，
          ≤1.0 命中 74.5% → 80.7%（见 tools/exp_point_estimate.py）。

        ★ 区间不再加 +0.2 容差：那个容差是为了修「查表 P75 偏高导致的
          边界误报」。k-NN 用近邻加权 P25/P75，实测官谱自覆盖 55.8%，
          标定已合理，再加容差反而会放宽到失真。

        conf 由「近邻定价的集中度」直接给出，含义可解释：
          近邻越集中 → 该谱型在官谱里有明确共识 → 估计越可信。
        """
        pe = self.point_estimate(nps, hold_ratio, notes_real,
                                 stair_speed, level, exclude_idx=exclude_idx)
        if pe["lo"] is None:
            return (None, None, pe["point"], "none", pe["basis"])
        spread = pe["spread"]
        conf = "high" if spread <= 1.0 else ("mid" if spread <= 2.0
                                             else "low")
        return (pe["lo"], pe["hi"], pe["point"], conf, pe["basis"])

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
                         top=5, stair_speed=0, exclude=None,
                         exclude_idx=None):
        """最相似的官谱 —— 与点估计共用同一套近邻，口径必然一致。

        旧实现自带一套「相对距离 + 手工权重 (1.0,0.8,0.6)」，与定价用的
        距离不是同一个度量：同一份数据存在两个「相似」，本身就是隐患。
        现在「官谱参照」= 「点估计用到的近邻」，一次计算两处使用。

        exclude / exclude_idx：自检时排除查询样本自身，避免 100% 自证。
        """
        if exclude_idx is None and exclude is not None:
            for i, r in enumerate(self.rows):
                if r is exclude:
                    exclude_idx = i
                    break
        k = max(KNN_K, top + (1 if exclude_idx is not None else 0))
        near = self.neighbors(nps, hold_ratio, notes_real, stair_speed,
                              level, k, exclude_idx=exclude_idx)
        out = []
        for d, i in near:
            if i == exclude_idx:
                continue
            r = self.rows[i]
            nr = max(r["notes_real"], 1)
            out.append({
                "name": r["name"], "level": r.get("level"),
                "difficulty": r["difficulty"],
                "nps": round(r["nps"], 2),
                "notes_real": r["notes_real"],
                "hold_pct": round(r["t_hold"] / nr * 100, 1),
                # d 是 z-score 空间的欧氏距离；exp(-d) 映射到 0~100%
                # （官谱自测最近邻 d 中位 0.179 → 约 84%）
                "similarity": round(math.exp(-d), 3),
                "dist": round(d, 4),
            })
            if len(out) >= top:
                break
        return out

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
