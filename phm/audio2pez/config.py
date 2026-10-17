# -*- coding: utf-8 -*-
"""audio2pez 全局配置：难度分级预设 + 音频分析 + 谱面生成常量。"""

# ── 基本 ─────────────────────────────────────────────
SAMPLE_RATE   = 22050
HOP_LENGTH    = 512
RPE_VERSION   = 160
DEFAULT_SPEED = 10.0
DEFAULT_ALPHA = 255
DEFAULT_SIZE  = 1.0

# 频段 (Hz)
BAND_LOW  = [20, 250]
BAND_MID  = [250, 2000]
BAND_HIGH = [2000, 11025]

# 轨道 (Phigros/Phira 风格, 无中心轨道)
LANES_2 = [-225, 225]
LANES_4 = [-225, -75, 75, 225]
LANES_6 = [-450, -300, -150, 150, 300, 450]

# 音符类型
TAP, HOLD, FLICK, DRAG = 1, 2, 3, 4

# 延音检测
SUSTAIN_THRESHOLD  = 0.08
SUSTAIN_MAX_GAP    = 2

# Hold 可选持续拍数 (长/短结合)
HOLD_BEATS_TIER = [0.25, 0.375, 0.5, 0.75, 1.0, 1.5, 2.0]
HOLD_MAX_BEATS  = 2.0
HOLD_SHORT_TIER = [0.25, 0.375, 0.5]      # 短 hold
HOLD_LONG_TIER  = [0.75, 1.0, 1.5, 2.0]   # 长 hold
HOLD_COOLDOWN_SEC = 0.4     # 同一只手 hold 结束后的冷却，避免 hold 堆叠

# 段落检测
SECTION_WINDOW = 8
DENSITY_LOW, DENSITY_MID, DENSITY_HIGH = 0.25, 0.55, 0.85

# 短语/模式
PHRASE_NOTES = 8          # 每个"乐句"的音符数，切换一种排布模式
BIAS_FLIP_PHRASES = 2     # 每 N 个乐句翻转一次左右偏向

# 谱型段（每个 pattern 段的拍长）
SEGMENT_BEATS = 4

# RMS 延音判定（修复部分歌曲 Hold 数量≈0）
SUSTAIN_RMS_THRESHOLD = 0.25   # 相对最大 RMS 的持续能量阈值
SUSTAIN_RMS_MIN_FRAMES = 3     # 最少持续帧数 (≈70ms @ hop=512, sr=22050)

LEAD_IN_BEATS = 2             # 谱面开头停顿拍数（避免一上来就进 note）

# ── 难度分级预设 (5 档) ──────────────────────────────
DIFFICULTY_PRESETS = {
    "easy": {
        "label": "EASY",   "level": 5,
        "keep_ratio": 0.30, "min_gap_beats": 1.5, "lanes": LANES_4,
        "min_gap_ms": 350, "jack_ms": 350, "roll_gap_ms": 300,
        "tap_weight": 0.50, "hold_weight": 0.12, "flick_weight": 0.18, "drag_weight": 0.20,
        "burst_prob": 0.08,
        "subdivision": 4, "fill_ratio": 0.30,
        "target_npb": {"sparse": 0.4, "mid": 0.8, "dense": 1.2},
        "max_nps": 3.0, "max_chord": 2, "quad_prob": 0.0, "alternate_ms": 260, "jack_max": 2,
        "pattern_weights": {
            "sparse": {"flow": 0.40, "roll": 0.20, "dragchain": 0.20, "holdleft": 0.10, "holdright": 0.10},
            "mid":    {"alternate": 0.30, "holdleft": 0.20, "holdright": 0.20, "flow": 0.20, "chord": 0.10},
            "dense":  {"alternate": 0.30, "chord": 0.30, "flow": 0.20, "mirror": 0.20},
        },
        "patterns": ["flow", "roll", "holdleft", "roll", "holdright", "dragchain"],
    },
    "normal": {
        "label": "NORMAL", "level": 9,
        "keep_ratio": 0.45, "min_gap_beats": 1.0, "lanes": LANES_4,
        "min_gap_ms": 250, "jack_ms": 250, "roll_gap_ms": 220,
        "tap_weight": 0.45, "hold_weight": 0.14, "flick_weight": 0.20, "drag_weight": 0.21,
        "burst_prob": 0.15,
        "subdivision": 8, "fill_ratio": 0.50,
        "target_npb": {"sparse": 0.6, "mid": 1.1, "dense": 1.8},
        "max_nps": 5.0, "max_chord": 2, "quad_prob": 0.0, "alternate_ms": 220, "jack_max": 2,
        "pattern_weights": {
            "sparse": {"flow": 0.35, "roll": 0.30, "dragchain": 0.20, "holdleft": 0.075, "holdright": 0.075},
            "mid":    {"alternate": 0.30, "stair": 0.10, "chord": 0.15, "stream": 0.15, "flow": 0.20, "holdleft": 0.05, "holdright": 0.05},
            "dense":  {"alternate": 0.30, "chord": 0.25, "mirror": 0.15, "stair": 0.15, "flow": 0.15},
        },
        "patterns": ["alternate", "roll", "chord", "holdleft", "roll", "dragchain"],
    },
    "hard": {
        "label": "HARD",   "level": 12,
        "keep_ratio": 0.60, "min_gap_beats": 0.5, "lanes": LANES_6,
        "min_gap_ms": 150, "jack_ms": 150, "roll_gap_ms": 150,
        "tap_weight": 0.38, "hold_weight": 0.18, "flick_weight": 0.22, "drag_weight": 0.22,
        "burst_prob": 0.30,
        "subdivision": 8, "fill_ratio": 0.70,
        "target_npb": {"sparse": 0.8, "mid": 1.5, "dense": 2.8},
        "max_nps": 7.0, "max_chord": 3, "quad_prob": 0.02, "alternate_ms": 170, "jack_max": 3,
        "pattern_weights": {
            "sparse": {"flow": 0.30, "dragchain": 0.25, "roll": 0.20, "holdleft": 0.125, "holdright": 0.125},
            "mid":    {"alternate": 0.25, "stair": 0.15, "chord": 0.15, "stream": 0.15, "syncop": 0.10, "holdleft": 0.10, "holdright": 0.10},
            "dense":  {"alternate": 0.25, "stream": 0.15, "jack": 0.10, "stair": 0.15, "chord": 0.15, "mirror": 0.10, "burst": 0.05, "offsetchord": 0.05},
        },
        "patterns": ["alternate", "zigzag", "chord", "quad", "holdleft", "dragchain", "stream", "holdright", "mirror"],
    },
    "expert": {
        "label": "EXPERT", "level": 15,
        "keep_ratio": 0.72, "min_gap_beats": 0.25, "lanes": LANES_6,
        "min_gap_ms": 120, "jack_ms": 120, "roll_gap_ms": 130,
        "tap_weight": 0.35, "hold_weight": 0.20, "flick_weight": 0.22, "drag_weight": 0.23,
        "burst_prob": 0.45,
        "subdivision": 16, "fill_ratio": 0.80,
        "target_npb": {"sparse": 0.9, "mid": 1.9, "dense": 3.9},
        "max_nps": 9.0, "max_chord": 3, "quad_prob": 0.05, "alternate_ms": 150, "jack_max": 4,
        "pattern_weights": {
            "sparse": {"flow": 0.30, "dragchain": 0.20, "roll": 0.20, "holdleft": 0.15, "holdright": 0.15},
            "mid":    {"alternate": 0.25, "stair": 0.15, "chord": 0.15, "stream": 0.15, "syncop": 0.10, "jack": 0.05, "offsetchord": 0.05, "holdleft": 0.05, "holdright": 0.05},
            "dense":  {"alternate": 0.22, "stream": 0.15, "jack": 0.12, "stair": 0.15, "chord": 0.12, "mirror": 0.08, "burst": 0.06, "offsetchord": 0.06, "triple": 0.04},
        },
        "patterns": ["alternate", "stair", "chord", "quad", "holdleft", "mirror", "jack", "holdright", "stream", "tri_alt"],
    },
    "master": {
        "label": "MASTER", "level": 17,
        "keep_ratio": 0.85, "min_gap_beats": 0.0, "lanes": LANES_6,
        "min_gap_ms": 80, "jack_ms": 80, "roll_gap_ms": 110,
        "tap_weight": 0.32, "hold_weight": 0.20, "flick_weight": 0.24, "drag_weight": 0.24,
        "burst_prob": 0.60,
        "subdivision": 16, "fill_ratio": 1.0,
        "target_npb": {"sparse": 1.0, "mid": 2.4, "dense": 5.4},
        "max_nps": 13.0, "max_chord": 3, "quad_prob": 0.10, "alternate_ms": 130, "jack_max": 4,
        "pattern_weights": {
            "sparse": {"flow": 0.30, "dragchain": 0.20, "roll": 0.20, "holdleft": 0.15, "holdright": 0.15},
            "mid":    {"alternate": 0.25, "stair": 0.15, "chord": 0.15, "stream": 0.15, "syncop": 0.10, "jack": 0.05, "offsetchord": 0.05, "holdleft": 0.05, "holdright": 0.05},
            "dense":  {"alternate": 0.20, "stream": 0.15, "jack": 0.13, "stair": 0.15, "chord": 0.12, "mirror": 0.08, "burst": 0.07, "offsetchord": 0.05, "triple": 0.05},
        },
        "patterns": ["alternate", "stair", "jack", "stream", "chord", "mirror", "offsetchord", "quad", "holdleft", "burst", "holdright", "tri_alt", "2plus3", "cross_alt"],
    },
}

# 模式库权重 (按段落结构) —— 供后续精细化使用
PATTERN_WEIGHTS = {
    "even":       {"stair": 0.25, "mirror": 0.10, "alternate": 0.30, "flow": 0.20, "random": 0.15},
    "syncopated": {"stair": 0.10, "mirror": 0.15, "alternate": 0.20, "flow": 0.10, "burst": 0.45},
    "sparse":     {"stair": 0.10, "mirror": 0.05, "alternate": 0.10, "flow": 0.60, "random": 0.15},
}

# ── 乐句母题库（按段落情绪分配，跨段形成可读视觉形状；子段 4 拍为单位切换键型）──
# tier: 1=骨架/常规，2=第二遍副歌递进（更密/加错位双押/三押）
# units: 每个元素是一个"键型单元"，_emit 按单元约束手与 lane，并跨段共享方向状态。
MOTIF_LIBRARY = {
    "intro/break": [
        {"name": "solo_flow",   "tier": 1, "units": ["flow", "dragchain", "flow", "flow"]},
        {"name": "snake_flow",  "tier": 1, "units": ["dragchain", "dragchain", "flow", "holdright"]},
        {"name": "breath_alt",  "tier": 1, "units": ["flow", "dragchain", "flow", "zigzag"]},
    ],
    "verse": [
        {"name": "alt_hold",    "tier": 1, "units": ["alternate", "zigzag", "alternate", "flow"]},
        {"name": "stair_drag",  "tier": 1, "units": ["stair_up", "dragchain", "stair_down", "dragchain"]},
        {"name": "zigzag_alt",  "tier": 1, "units": ["zigzag", "alternate", "zigzag", "alternate"]},
        {"name": "syncop_flow", "tier": 2, "units": ["syncop", "flow", "syncop", "flow"]},
        {"name": "drag_sea",    "tier": 2, "units": ["drag_sea", "drag_sea", "dragchain", "drag_sea"]},
        {"name": "tri_verse",   "tier": 2, "units": ["tri_alt", "alternate", "tri_alt", "flow"]},
    ],
    "chorus": [
        {"name": "sweep",         "tier": 1, "units": ["stair_up", "mirror_chord", "alternate", "stair_down"]},
        {"name": "alt_burst",     "tier": 1, "units": ["alternate", "burst", "alternate", "stair_up"]},
        {"name": "stream_jack",   "tier": 1, "units": ["stream", "jack", "stream", "mirror_chord"]},
        {"name": "roundtrip",     "tier": 1, "units": ["zigzag", "zigzag", "mirror_chord", "alternate"]},
        {"name": "syncop_chord",  "tier": 2, "units": ["syncop", "syncop", "offsetchord", "burst"]},
        {"name": "alt_offset",    "tier": 2, "units": ["alternate", "offsetchord", "stream", "jack"]},
        {"name": "triple_burst",  "tier": 2, "units": ["burst", "offsetchord", "burst", "triple"]},
        {"name": "drag_fury",    "tier": 2, "units": ["drag_sea", "drag_sea", "drag_sea", "drag_sea"]},
        {"name": "snake_fury",   "tier": 2, "units": ["snake_tap", "snake_tap", "offsetchord", "snake_tap"]},
        {"name": "quad_power",   "tier": 2, "units": ["quad", "offsetchord", "quad", "burst"]},
        {"name": "tri_cluster",  "tier": 2, "units": ["tri_alt", "2plus3", "tri_alt", "burst"]},
        {"name": "p23_fury",     "tier": 2, "units": ["2plus3", "alternate", "2plus3", "burst"]},
        {"name": "cross_axis",   "tier": 2, "units": ["cross_alt", "alternate", "cross_alt", "mirror_chord"]},
    ],
}
