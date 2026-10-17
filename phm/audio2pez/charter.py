# -*- coding: utf-8 -*-
"""谱面生成：消费检测踩音 points，按难度分级 + 密度细分 + 乐句模式 + 手部协同排布。

音符类型: 1=Tap, 2=Hold, 3=Flick, 4=Drag。

加难策略（读谱易、上手难）：
- _select_flat   从检测 points 选基础点
- _density_fill  按段落目标密度在细分网格(1/8~1/16)上补音，优先落在 onset/能量高处
- _plan_segments 按段落密度 + 乐句切换谱型（交互/纵连/楼梯/双押/三押/爆发等）
- _emit          按谱型约束手与 lane，保证 fast single 交替手、chord 每手一键、无同手超短连点
"""

import math
import random
import bisect

from config import (
    SAMPLE_RATE, HOP_LENGTH, DEFAULT_ALPHA, DEFAULT_SIZE,
    SUSTAIN_THRESHOLD, SUSTAIN_MAX_GAP, HOLD_MAX_BEATS,
    HOLD_SHORT_TIER, HOLD_LONG_TIER, HOLD_COOLDOWN_SEC,
    SUSTAIN_RMS_THRESHOLD, SUSTAIN_RMS_MIN_FRAMES,
    TAP, HOLD, FLICK, DRAG, PHRASE_NOTES, BIAS_FLIP_PHRASES, SEGMENT_BEATS,
    MOTIF_LIBRARY, LEAD_IN_BEATS,
)

from audio_analyze import get_dominant_band


class Charter:
    def __init__(self, points, bpm, ticks_per_beat, bands, onset_norm,
                 sections, difficulty, sr=SAMPLE_RATE, rms_norm=None, density_mult=1.0):
        self.points = points
        self.bpm = bpm
        self.ticks_per_beat = int(ticks_per_beat or 480)
        self.bands = bands
        self.onset_norm = onset_norm
        self.rms_norm = rms_norm if rms_norm is not None else onset_norm
        self.sections = sections
        self.difficulty = difficulty
        self.sr = sr
        self.density_mult = float(density_mult or 1.0)

        self.lanes = difficulty["lanes"]
        self.n_lanes = len(self.lanes)
        half = self.n_lanes // 2
        self.left_lanes = self.lanes[:half]
        self.right_lanes = self.lanes[half:]
        self.span = abs(self.lanes[-1] - self.lanes[0])

        self._last_time = -1e9
        self._last_hold_time = -1e9
        self._last_hold_hand = None
        self._last_hand = None
        self._last_lane_hand = [None, None]
        self._lane_last_time = {lane: -1e9 for lane in self.lanes}
        self._lane_count = {lane: 0 for lane in self.lanes}
        self._lane_streak = {0: (None, 0), 1: (None, 0)}

        self.min_gap_ms = float(difficulty.get("min_gap_ms", 180))
        self.jack_ms = float(difficulty.get("jack_ms", 180))
        self.roll_gap_ms = float(difficulty.get("roll_gap_ms", 170))
        self.alternate_ms = float(difficulty.get("alternate_ms", self.roll_gap_ms))
        self.max_chord = int(difficulty.get("max_chord", 2))
        # 轨道数少于和弦数时 clamp，避免 2K 下排 3 押
        self.max_chord = min(self.max_chord, max(1, self.n_lanes))
        self.jack_max = int(difficulty.get("jack_max", 2))
        self.quad_prob = float(difficulty.get("quad_prob", 0.0))
        self.disable_drag = bool(difficulty.get("disable_drag", False))
        self.disable_hold = bool(difficulty.get("disable_hold", False))
        self.flick_w = float(difficulty.get("flick_weight", 0.2))

        self.subdivision = int(difficulty.get("subdivision", 8))
        self.fill_ratio = float(difficulty.get("fill_ratio", 0.5))
        self.target_npb = difficulty.get("target_npb", {"sparse": 0.8, "mid": 1.3, "dense": 2.0})
        self.max_nps = float(difficulty.get("max_nps", 8.0))
        self.flick_gap_ms = float(difficulty.get("flick_gap_ms", 150))
        self._rms_sustain_th = float(difficulty.get("rms_sustain", SUSTAIN_RMS_THRESHOLD))

        self._hand_hold_until = [0.0, 0.0]
        self._hold_cd_beats = HOLD_COOLDOWN_SEC * self.bpm / 60.0

        self._phrase_idx = 0
        self._bias = 1
        self._zh_pos = {0: 0, 1: 0}
        self._zh_dir = {0: 1, 1: 1}

        # tick -> time 锚点（用于 density fill 插值；与 BPMList/tempo 一致）
        self._tick_anchor = sorted(
            [(p["beat_tick"], p["time_sec"]) for p in points if "beat_tick" in p],
            key=lambda x: x[0],
        )

        # 段落重复检测：同一 label 的第 N 次出现（用于副歌"递进"编排）
        self._sec_run = {}
        _occ = {}
        _prev = None
        _run_occ = 1
        for _i, _s in enumerate(self.sections):
            _lab = _s["label"]
            if _lab != _prev:
                _occ[_lab] = _occ.get(_lab, 0) + 1
                _run_occ = _occ[_lab]
                _prev = _lab
            self._sec_run[_i] = (_run_occ, _lab)

    # ── 工具 ────────────────────────────────────────

    def _frac_time(self, tick: int) -> list[int]:
        tick = max(0, int(tick))
        whole, rem = divmod(tick, self.ticks_per_beat)
        if rem == 0:
            return [whole, 0, 1]
        g = math.gcd(rem, self.ticks_per_beat)
        return [whole, rem // g, self.ticks_per_beat // g]

    def _onset_at(self, time_sec: float) -> float:
        frame = int(time_sec * self.sr / HOP_LENGTH)
        if 0 <= frame < len(self.onset_norm):
            return float(self.onset_norm[frame])
        return 0.0

    def _time_at_tick(self, tick: float) -> float:
        anchor = self._tick_anchor
        if not anchor:
            return tick * 60.0 / max(self.bpm, 1.0)
        if tick <= anchor[0][0]:
            return anchor[0][1]
        if tick >= anchor[-1][0]:
            return anchor[-1][1]
        ts = [a[0] for a in anchor]
        i = bisect.bisect_left(ts, tick)
        t0, s0 = anchor[i - 1]
        t1, s1 = anchor[i]
        if t1 == t0:
            return s0
        frac = (tick - t0) / (t1 - t0)
        return s0 + (s1 - s0) * frac

    def _tick_at_time(self, sec: float) -> int:
        anchor = self._tick_anchor
        if not anchor:
            return int(round(sec * max(self.bpm, 1.0) / 60.0))
        if sec <= anchor[0][1]:
            return int(round(anchor[0][0]))
        if sec >= anchor[-1][1]:
            return int(round(anchor[-1][0]))
        ss = [a[1] for a in anchor]
        i = bisect.bisect_left(ss, sec)
        s0, t0 = anchor[i - 1][1], anchor[i - 1][0]
        s1, t1 = anchor[i][1], anchor[i][0]
        if s1 == s0:
            return int(round(t0))
        frac = (sec - s0) / (s1 - s0)
        return int(round(t0 + (t1 - t0) * frac))

    def _detect_sustain(self, time_sec: float) -> float:
        frame = int(time_sec * self.sr / HOP_LENGTH)
        env = self.rms_norm
        if frame >= len(env):
            return 0.0
        th = self._rms_sustain_th
        sustain_frames, gap_frames = 0, 0
        max_off = min(SUSTAIN_RMS_MIN_FRAMES + 32, len(env) - frame)
        for off in range(1, max_off):
            val = env[frame + off]
            if val >= th:
                sustain_frames += 1
                gap_frames = 0
            else:
                gap_frames += 1
                if gap_frames > SUSTAIN_MAX_GAP:
                    break
        if sustain_frames < SUSTAIN_RMS_MIN_FRAMES:
            return 0.0
        return sustain_frames * HOP_LENGTH / self.sr

    # ── 选点 ────────────────────────────────────────

    def _select_flat(self) -> list:
        ratio = float(self.difficulty.get("keep_ratio", 0.5))
        per = [[] for _ in self.sections]
        for p in sorted(self.points, key=lambda x: x["time_sec"]):
            per[self._section_index(p["time_sec"])].append(p)
        selected = []
        for i, sec in enumerate(self.sections):
            pts = per[i]
            if not pts:
                continue
            beats_n = max(1.0, (sec["end_time"] - sec["start_time"]) * self.bpm / 60.0)
            # 每拍期望保留数：按拍分组取代表音，避免"第X拍漏踩"的节奏洞
            keep_per_beat = max(1, int(round(ratio * sec["density"] * len(pts) / beats_n)))
            groups = {}
            for p in sorted(pts, key=lambda x: x["beat"]):
                b = int(math.floor(p["beat"] + 1e-6))
                groups.setdefault(b, []).append(p)
            for b in sorted(groups):
                gp = sorted(groups[b], key=lambda x: -x["probability"])
                selected.extend(gp[:keep_per_beat])
        selected.sort(key=lambda x: x["time_sec"])
        out, last_time, last_beat = [], -1e9, -1e18
        gap_beats = float(self.difficulty.get("min_gap_beats", 0.0))
        lead_in_sec = LEAD_IN_BEATS * 60.0 / max(self.bpm, 1.0)
        for p in selected:
            if p["time_sec"] < lead_in_sec:
                continue   # 开头停顿：前几拍不进 note
            if p["time_sec"] - last_time < self.min_gap_ms / 1000.0:
                continue
            if p["beat"] - last_beat < gap_beats:
                continue
            out.append(p)
            last_time = p["time_sec"]
            last_beat = p["beat"]
        return out

    def _section_index(self, time_sec: float) -> int:
        for i, s in enumerate(self.sections):
            if s["start_time"] <= time_sec < s["end_time"]:
                return i
        return max(0, len(self.sections) - 1)

    def _density_key(self, density: float) -> str:
        if density <= 0.3:
            return "sparse"
        if density <= 0.6:
            return "mid"
        return "dense"

    # ── 密度补充（提高 NPS，细分到 1/8~1/16/1/32 网格）──

    def _density_fill(self, selected: list) -> list:
        gap_sec = self.min_gap_ms / 1000.0
        gap_beats = float(self.difficulty.get("min_gap_beats", 0.0))
        step = max(1, round(self.ticks_per_beat / max(self.subdivision, 1)))
        existing = {int(p["beat_tick"]) for p in selected}
        extras = []

        for i, sec in enumerate(self.sections):
            start_t, end_t = sec["start_time"], sec["end_time"]
            key = self._density_key(sec["density"])
            occ, lab = self._sec_run.get(i, (1, sec["label"]))
            prog_mult = (1.0 + 0.18 * (occ - 1)) if (key == "dense" and lab == "chorus") else 1.0
            npb = float(self.target_npb.get(key, 1.0)) * self.density_mult * prog_mult
            # 尾杀：歌曲末段强度递进，制造结尾高潮
            if i >= len(self.sections) - 1:
                npb *= 1.10
            beats = max(0.0, (end_t - start_t) * self.bpm / 60.0)
            max_total = int(round(self.max_nps * (end_t - start_t)))
            target_total = int(round(npb * beats * self.fill_ratio))
            target_total = min(target_total, max_total)
            existing_in_sec = sum(1 for p in selected if start_t <= p["time_sec"] < end_t)
            need = max(0, target_total - existing_in_sec)
            if need <= 0:
                continue

            # 每拍配额 qpb：逐拍均匀补，杜绝"中间拍漏掉"的节奏洞
            qpb = max(1, int(round(npb))) if npb >= 0.5 else 1
            grid_sub = max(qpb, min(self.subdivision, 16))
            step_i = max(1, round(self.ticks_per_beat / grid_sub))
            start_tick = self._tick_at_time(start_t)
            end_tick = self._tick_at_time(end_t)
            base_times = [p["time_sec"] for p in selected if start_t <= p["time_sec"] < end_t]
            base_per_beat = {}
            for p in selected:
                if start_t <= p["time_sec"] < end_t:
                    b = int(math.floor(max(0.0, (p["time_sec"] - start_t) * self.bpm / 60.0 + 1e-6)))
                    base_per_beat[b] = base_per_beat.get(b, 0) + 1

            kept = []
            last_t, last_beat = None, None
            n_beats = int(math.ceil(beats)) + 1
            for bi in range(n_beats):
                if len(kept) >= need:
                    break
                quota_here = max(0, qpb - base_per_beat.get(bi, 0))
                if quota_here <= 0:
                    continue
                beat_lo = start_tick + bi * self.ticks_per_beat
                beat_hi = beat_lo + self.ticks_per_beat
                beat_cand = []
                tick = ((beat_lo + step_i - 1) // step_i) * step_i
                while tick < min(beat_hi, end_tick):
                    if tick not in existing:
                        ts = self._time_at_tick(tick)
                        # 只补在有真实 onset 能量的位置，避免凭空生拍
                        if (not any(abs(ts - bt) < gap_sec for bt in base_times)
                                and self._onset_at(ts) >= 0.10):
                            beat_cand.append((self._onset_at(ts), tick, ts))
                    tick += step_i
                beat_cand.sort(key=lambda x: -x[0])
                taken = 0
                for score, tick, ts in beat_cand:
                    if taken >= quota_here or len(kept) >= need:
                        break
                    tb = tick / self.ticks_per_beat
                    if last_t is not None and ts - last_t < gap_sec:
                        continue
                    if gap_beats > 0 and last_beat is not None and tb - last_beat < gap_beats:
                        continue
                    kept.append((score, tick, ts))
                    existing.add(tick)
                    last_t, last_beat = ts, tb
                    taken += 1

            for score, tick, ts in kept:
                beat = tick / self.ticks_per_beat
                extras.append({
                    "time_sec": ts, "beat": beat, "beat_tick": tick,
                    "probability": max(0.2, min(1.0, 0.3 + score)),
                    "snap_status": 1, "_fill": True, "_section": i,
                })

        # 最终全局最小间距（base 与 fill 之间也需满足，避免 <min_gap 的不可打微间隔）
        merged = selected + extras
        merged.sort(key=lambda x: x["time_sec"])
        lead_in_sec = LEAD_IN_BEATS * 60.0 / max(self.bpm, 1.0)
        out, last_t, last_beat = [], -1e9, -1e18
        for p in merged:
            if p["time_sec"] < lead_in_sec:
                continue   # 开头停顿：前几拍不进 note
            if p["time_sec"] - last_t < gap_sec:
                continue
            if gap_beats > 0 and p["beat"] - last_beat < gap_beats:
                continue
            out.append(p)
            last_t, last_beat = p["time_sec"], p["beat"]
        return out

    # ── 音符类型（只返回 Tap/Flick/Drag；Hold 由 hold 引擎决定）──

    def _classify_type(self, time_sec: float) -> int:
        strength = self._onset_at(time_sec)
        frame = int(time_sec * self.sr / HOP_LENGTH)
        band = get_dominant_band(self.bands, frame)
        diff = self.difficulty
        is_accent = strength > 0.35 or (strength > 0.20 and band == "high")
        # 采音分层：鼓组/bass 重音用 Flick 强调（强拍重音比普通 accent 更突出）
        if band == "low" and strength > 0.35 and self.flick_w > 0.01:
            return FLICK
        if is_accent and self.flick_w > 0.01 and random.random() < 0.60 * min(1.0, self.flick_w * 3.0):
            return FLICK
        # 高频/人声/合成器：装饰性，偏 Drag / 切分（避免抢主旋律）
        if band == "high" and not is_accent and not self.disable_drag and random.random() < diff.get("drag_weight", 0.2) * 0.6:
            return DRAG
        # Drag 作"填充/流动"：只在非重音处出现，贴弱拍/切分
        if not is_accent and not self.disable_drag and random.random() < diff.get("drag_weight", 0.2) * 0.6:
            return DRAG
        tw = diff["tap_weight"] + diff.get("hold_weight", 0.15)
        fw = tw + diff["flick_weight"]
        r = random.random()
        if r < tw:
            return TAP
        elif r < fw:
            return FLICK
        else:
            return DRAG if not self.disable_drag else TAP

    # ── 手部/轨道基础 ───────────────────────────────

    def _preferred_hand(self) -> int:
        return 0 if self._bias < 0 else 1

    def _choose_hand(self, time_sec: float) -> int:
        gap_ms = (time_sec - self._last_time) * 1000.0
        if self._last_hand is not None and gap_ms < self.roll_gap_ms:
            return 1 - self._last_hand
        if not self.left_lanes or not self.right_lanes:
            return random.choice([0, 1])
        # 慢速/零散音符：按每只手整体空闲时长取平衡（避免偏手）
        lrest = max(time_sec - self._lane_last_time[l] for l in self.left_lanes)
        rrest = max(time_sec - self._lane_last_time[l] for l in self.right_lanes)
        if lrest - rrest > 300.0:
            return 0
        if rrest - lrest > 300.0:
            return 1
        return random.choice([0, 1])

    def _choose_hand_for_pattern(self, pattern: str, time_sec: float) -> int:
        gap_ms = (time_sec - self._last_time) * 1000.0
        if self._last_hand is not None and gap_ms < self.alternate_ms:
            return 1 - self._last_hand
        return self._choose_hand(time_sec)

    def _pick_lane_in_hand(self, time_sec: float, hand: int) -> float:
        lane_pool = self.left_lanes if hand == 0 else self.right_lanes
        cand = [l for l in lane_pool
                if (time_sec - self._lane_last_time[l]) * 1000.0 >= self.jack_ms]
        if not cand:
            cand = list(lane_pool)
        last = self._last_lane_hand[hand]
        if last is not None:
            cand = [l for l in cand if l != last] or cand

        def score(l):
            idle = (time_sec - self._lane_last_time[l]) * 1000.0
            dist = abs(l - last) if last is not None else 0.0
            same_pen = 420.0 if (last is not None and l == last and idle < self.alternate_ms) else 0.0
            return -idle * 0.6 + dist * 0.35 + random.random() * self.span * 0.12 + self._lane_count.get(l, 0) * 0.015 + same_pen

        cand.sort(key=score)
        return cand[0]

    def _pick_adjacent_in_hand(self, time_sec: float, hand: int) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        last = self._last_lane_hand[hand]
        if last is not None and last in pool:
            i = pool.index(last)
            cand = [pool[max(0, i - 1)], pool[min(len(pool) - 1, i + 1)]]
            cand = list(dict.fromkeys(cand))
        else:
            cand = list(pool)
        cand = [l for l in cand if l != last]   # 禁止折回同一轨道
        if not cand:
            cand = list(pool)
        good = [l for l in cand if (time_sec - self._lane_last_time[l]) * 1000.0 >= self.jack_ms]
        if not good:
            good = sorted(cand, key=lambda l: -abs(l - last) if last is not None else 0)
        return random.choice(good)

    def _pick_alt_in_hand(self, time_sec: float, hand: int) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        last_other = self._last_lane_hand[1 - hand]
        if last_other is not None and random.random() < 0.5:
            cand = sorted(pool, key=lambda l: abs(l - last_other))
        else:
            cand = list(pool)
        last = self._last_lane_hand[hand]
        cand = [l for l in cand if l != last] or cand
        def score(l):
            idle = (time_sec - self._lane_last_time[l]) * 1000.0
            dist = abs(l - last) if last is not None else 0.0
            same_pen = 420.0 if (last is not None and l == last and idle < self.alternate_ms) else 0.0
            return -idle * 0.5 + dist * 0.3 + random.random() * self.span * 0.2 + self._lane_count.get(l, 0) * 0.015 + same_pen
        good = [l for l in cand if (time_sec - self._lane_last_time[l]) * 1000.0 >= self.jack_ms] or cand
        return max(good, key=score)

    def _stair_next(self, hand: int) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        n = len(pool)
        if self._stair_hand != hand or self._stair_idx is None:
            self._stair_hand = hand
            self._stair_idx = random.randrange(n)
            self._stair_dir = random.choice([1, -1])
        idx = self._stair_idx
        lane = pool[idx]
        nxt = idx + self._stair_dir
        if nxt >= n:
            nxt = n - 2 if n > 1 else 0
            self._stair_dir = -1
        elif nxt < 0:
            nxt = 1 if n > 1 else 0
            self._stair_dir = 1
        self._stair_idx = nxt
        return lane

    def _zig_lane(self, time_sec: float, hand: int) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        n = len(pool)
        idx = self._zh_pos.get(hand, 0) % n
        lane = pool[idx]
        nxt = idx + self._zh_dir.get(hand, 1)
        if nxt >= n:
            nxt = n - 2 if n > 1 else 0
            self._zh_dir[hand] = -1
        elif nxt < 0:
            nxt = 1 if n > 1 else 0
            self._zh_dir[hand] = 1
        self._zh_pos[hand] = nxt
        return lane

    def _chord_lanes(self, mirror: bool = False) -> tuple[float, float]:
        if not self.left_lanes or not self.right_lanes:
            return self.lanes[0], self.lanes[-1]
        if mirror and self.n_lanes >= 4:
            # 镜像对称双押：lane0↔laneN, lane1↔laneN-1 ...
            half = self.n_lanes // 2
            idx = random.randrange(half)
            return self.lanes[idx], self.lanes[-1 - idx]
        if self.n_lanes >= 6:
            left = random.choice(self.left_lanes)
            right = random.choice(self.right_lanes)
        else:
            left = self.left_lanes[-1]
            right = self.right_lanes[0]
            if random.random() < 0.25:
                left = self.left_lanes[0]
                right = self.right_lanes[-1]
        return left, right

    def _lane_for_hand(self, hand: int) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        if pool:
            return min(pool, key=lambda l: self._lane_count.get(l, 0))
        return self.lanes[0]

    def _hold_lane(self, side: int) -> float:
        pool = self.right_lanes if side > 0 else self.left_lanes
        if pool:
            return min(pool, key=lambda l: self._lane_count.get(l, 0))
        return self.lanes[0] if side < 0 else self.lanes[-1]

    def _register(self, time_sec: float, hand: int, lane: float) -> None:
        self._last_time = time_sec
        self._last_hand = hand
        self._last_lane_hand[hand] = lane
        self._lane_last_time[lane] = time_sec
        self._lane_count[lane] = self._lane_count.get(lane, 0) + 1
        _pl, _cnt = self._lane_streak.get(hand, (None, 0))
        self._lane_streak[hand] = (lane, _cnt + 1 if _pl == lane else 0)

    def _free_hands(self, beat: float) -> list:
        return [h for h in (0, 1) if beat >= self._hand_hold_until[h]]

    def _pick_hold_beats(self, sustain: float) -> float:
        # 缩短 hold 占比：长 hold 仅极高持续时出现，其余用短/中 hold
        if sustain > 0.65:
            cands = [0.5, 0.75, 1.0, 1.5]
        elif sustain > 0.45:
            cands = [0.375, 0.5, 0.75]
        else:
            cands = [0.25, 0.375, 0.5]
        return min(random.choice(cands), HOLD_MAX_BEATS)
    def _make_note(self, point, ntype, lane=None, hold_beats=None) -> dict:
        tick = point["beat_tick"]
        start_time = self._frac_time(tick)
        if lane is None:
            frame = int(point["time_sec"] * self.sr / HOP_LENGTH)
            band = get_dominant_band(self.bands, frame)
            hand = self._choose_hand(point["time_sec"])
            lane = self._pick_lane_in_hand(point["time_sec"], hand)
            self._register(point["time_sec"], hand, lane)
        end_time = start_time
        if ntype == HOLD:
            hb = hold_beats if hold_beats is not None else min(random.choice(HOLD_SHORT_TIER), HOLD_MAX_BEATS)
            end_time = self._frac_time(tick + int(round(hb * self.ticks_per_beat)))
        return {
            "above": 1, "alpha": DEFAULT_ALPHA, "endTime": end_time,
            "isFake": 0, "positionX": round(float(lane), 1), "size": DEFAULT_SIZE,
            "speed": 1.0, "startTime": start_time, "type": ntype,
            "visibleTime": 999999.0, "yOffset": 0.0,
        }

    # ── 乐句/谱型规划 ───────────────────────────────

    def _pick_pattern(self, key: str, default_pats: list) -> str:
        weights = (self.difficulty.get("pattern_weights") or {}).get(key)
        if weights:
            names = list(weights.keys())
            w = [float(weights[k]) for k in names]
            total = sum(w)
            if total > 0:
                r = random.random() * total
                acc = 0.0
                for k, wv in zip(names, w):
                    acc += wv
                    if r < acc:
                        return k
                return names[-1]
        return default_pats[(self._phrase_idx - 1) % len(default_pats)]

    def _plan_segments(self, all_notes: list) -> list:
        pats = self.difficulty.get("patterns", ["roll"]) or ["roll"]
        seg_beats = max(1, int(self.difficulty.get("segment_beats", SEGMENT_BEATS)))
        segments = []
        if not all_notes:
            return segments
        # 1) 拆成 4 拍原始段，记录所属 section
        raw = []
        i = 0
        n = len(all_notes)
        while i < n:
            sec_idx = self._section_index(all_notes[i]["time_sec"])
            key = self._density_key(self.sections[sec_idx]["density"])
            chunk = []
            while i < n and self._section_index(all_notes[i]["time_sec"]) == sec_idx:
                chunk.append(all_notes[i])
                i += 1
            if not chunk:
                continue
            cur = 0
            while cur < len(chunk):
                start_beat = chunk[cur]["beat"]
                end_beat = start_beat + seg_beats
                sub = []
                while cur < len(chunk) and chunk[cur]["beat"] < end_beat:
                    sub.append(chunk[cur])
                    cur += 1
                if not sub:
                    sub = chunk[cur:cur + 1]
                    cur += 1
                raw.append({"sub": sub, "key": key, "sec_idx": sec_idx})

        # 2) 按段落 label 聚合为"乐句 run"，并统计重复出现次数
        runs = []
        for seg in raw:
            lab = self.sections[seg["sec_idx"]]["label"]
            if runs and runs[-1]["label"] == lab:
                runs[-1]["segments"].append(seg)
            else:
                runs.append({"label": lab, "segments": [seg]})
        occ_count = {}
        for run in runs:
            lab = run["label"]
            occ_count[lab] = occ_count.get(lab, 0) + 1
            run["occurrence"] = occ_count[lab]

        # 3) 为每个 run 分配母题，段间共享 block_state 形成连续视觉形状
        for run in runs:
            key = run["segments"][0]["key"]
            units = self._motif_for_run(run["label"], key, run["occurrence"])
            run_bias = self._bias
            bs = {
                "block_seed": random.random(),
                "run_label": run["label"],
                "occurrence": run["occurrence"],
                "key": key,
                "units": units,
                "stair_dir": run_bias,
                "stair": {},
                "zig": {},
            }
            for j, seg in enumerate(run["segments"]):
                unit = units[j % len(units)]
                self._phrase_idx += 1
                segments.append((seg["sub"], unit, run_bias, key, bs))
            self._phrase_idx += 1
            self._bias = -self._bias   # 母题块之间左右手交替，衔接更顺
        return segments

    # ── 谱型发射（手部协同）─────────────────────────

    def _jack_hand_lane(self, time_sec: float, free: list) -> tuple[int, float]:
        if self._jack_remaining <= 0:
            if self._last_hand is not None and (1 - self._last_hand) in free:
                hand = 1 - self._last_hand
            else:
                hand = random.choice(free)
            lane = self._pick_lane_in_hand(time_sec, hand)
            self._jack_hand = hand
            self._jack_lane = lane
            self._jack_remaining = random.randint(2, min(self.jack_max, 3))
        else:
            hand = self._jack_hand
            lane = self._jack_lane
            if hand not in free:
                hand = free[0]
                lane = self._pick_lane_in_hand(time_sec, hand)
                self._jack_hand = hand
                self._jack_lane = lane
        self._jack_remaining -= 1
        return hand, lane

    def _lane_for_pattern(self, pattern: str, hand: int, pos: int,
                          p: dict, time_sec: float, ntype: int,
                          block_state: dict = None) -> float:
        bs = block_state if block_state is not None else {}

        if pattern in ("tri_alt", "2plus3"):
            return self._tri_alt_lane(hand, bs)
        if pattern == "cross_alt":
            return self._cross_alt_lane(hand, time_sec)
        if pattern == "stair_up":
            return self._stair_next_dir(hand, 1, bs)
        if pattern == "stair_down":
            return self._stair_next_dir(hand, -1, bs)
        if pattern == "stair":
            return self._stair_next_dir(hand, int(bs.get("stair_dir", 1) or 1), bs)
        if pattern in ("zigzag", "roundtrip"):
            return self._zig_next(hand, bs)
        if pattern in ("stream", "burst"):
            return self._pick_adjacent_in_hand(time_sec, hand)
        if pattern in ("alternate", "syncop"):
            return self._pick_alt_in_hand(time_sec, hand)
        if pattern in ("dragchain", "drag_sea", "snake_tap"):
            return self._drag_next(bs)
        return self._pick_lane_in_hand(time_sec, hand)

    def _emit_triple(self, p: dict, ntype: int, notes: list, time_sec: float) -> None:
        left = self.left_lanes
        right = self.right_lanes
        use_left_double = random.random() < 0.5
        if use_left_double:
            lanes = [left[-1], left[0], right[0]]
        else:
            lanes = [left[-1], right[0], right[-1]]
        for lane in lanes:
            notes.append(self._make_note(p, ntype, lane=lane))
            self._register(time_sec, 0 if lane in left else 1, lane)

    # ── 乐句母题 / 方向性谱型（读谱形状）────────────

    def _stair_next_dir(self, hand: int, direction: int, bs: dict) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        n = len(pool)
        if n <= 1:
            return pool[0]
        st = bs.setdefault("stair", {})
        key = str(hand)
        cur = st.get(key)
        if cur is None:
            counts = [self._lane_count.get(l, 0) for l in pool]
            start = counts.index(min(counts))
            cur = {"idx": start, "dir": direction}
            st[key] = cur
        idx = cur["idx"]
        lane = pool[idx]
        d = cur["dir"]
        nxt = idx + d
        if nxt >= n:
            nxt = n - 2 if n > 1 else 0
            cur["dir"] = -1
        elif nxt < 0:
            nxt = 1 if n > 1 else 0
            cur["dir"] = 1
        cur["idx"] = nxt
        return lane

    def _zig_next(self, hand: int, bs: dict) -> float:
        pool = self.left_lanes if hand == 0 else self.right_lanes
        n = len(pool)
        if n <= 1:
            return pool[0]
        st = bs.setdefault("zig", {})
        key = str(hand)
        cur = st.get(key)
        if cur is None:
            counts = [self._lane_count.get(l, 0) for l in pool]
            start = counts.index(min(counts))
            cur = {"pos": start, "dir": random.choice([1, -1])}
            st[key] = cur
        idx = cur["pos"]
        lane = pool[idx]
        nxt = idx + cur["dir"]
        if nxt >= n:
            nxt = n - 2 if n > 1 else 0
            cur["dir"] = -1
        elif nxt < 0:
            nxt = 1 if n > 1 else 0
            cur["dir"] = 1
        cur["pos"] = nxt
        return lane

    def _drag_next(self, bs: dict) -> float:
        # Drag 蛇形：沿轨道做来回流动的"蛇"，读谱更自然、贴合音乐流向
        n = self.n_lanes
        if n <= 1:
            return self.lanes[0]
        st = bs.setdefault("drag", {})
        if "idx" not in st:
            counts = [self._lane_count.get(l, 0) for l in self.lanes]
            st["idx"] = counts.index(min(counts))
            st["dir"] = random.choice([1, -1])
        idx = st["idx"]
        lane = self.lanes[idx]
        nxt = idx + st["dir"]
        if nxt >= n:
            nxt = n - 2 if n > 1 else 0
            st["dir"] = -1
        elif nxt < 0:
            nxt = 1 if n > 1 else 0
            st["dir"] = 1
        st["idx"] = nxt
        return lane

    def _in_beat_slot(self, p: dict) -> tuple[float, int, int]:
        tick = int(p.get("beat_tick", 0))
        rel = (tick % max(self.ticks_per_beat, 1)) / max(self.ticks_per_beat, 1)
        sub = max(8, self.subdivision)
        slot = int(round(rel * sub))
        return rel, slot, sub

    def _is_downbeat(self, p: dict) -> bool:
        return int(p.get("beat_tick", 0)) % max(self.ticks_per_beat, 1) == 0

    def _syncop_type(self, p: dict, time_sec: float) -> int:
        _, slot, _sub = self._in_beat_slot(p)
        if slot % 2 == 1:
            return DRAG
        if self._onset_at(time_sec) > 0.4 and random.random() < 0.5:
            return FLICK
        return TAP

    def _pick_motif(self, avail: list) -> dict:
        weights = self.difficulty.get("motif_weights") or {}
        if weights:
            named = [m for m in avail if m.get("name") in weights]
            if len(named) == len(avail):
                w = [float(weights[m["name"]]) for m in named]
                total = sum(w)
                if total > 0:
                    r = random.random() * total
                    acc = 0.0
                    for m in named:
                        acc += w[named.index(m)]
                        if r < acc:
                            return m
                    return named[-1]
        if not avail:
            return {"units": ["flow"]}
        # 降权 drag 独奏母题，避免"drag 独奏段太多"
        wnames = []
        for m in avail:
            base = 1.0
            if "drag" in m.get("name", "").lower():
                base = 0.30
            wnames.append(base)
        total = sum(wnames)
        r = random.random() * total
        acc = 0.0
        for m, w in zip(avail, wnames):
            acc += w
            if r < acc:
                return m
        return avail[-1]

    def _motif_for_run(self, label: str, key: str, occurrence: int) -> list:
        lib = self.difficulty.get("motif_library") or MOTIF_LIBRARY
        pool = list(lib.get(label) or lib.get(key) or [])
        if not pool:
            return list(self.difficulty.get("patterns", ["roll"]) or ["roll"])
        tier = 2 if occurrence >= 2 else 1
        level = int(self.difficulty.get("level", 10))
        # 低难度始终用 tier1，避免第二遍副歌被过度加难
        if level < 12:
            avail = [m for m in pool if m.get("tier", 1) == 1] or pool
        else:
            avail = [m for m in pool if m.get("tier", 1) == tier] or pool
        motif = self._pick_motif(avail)
        units = list(motif.get("units", ["flow"]))
        if self.max_chord < 3:
            units = [u for u in units if u != "triple"]
        if self.n_lanes < 6:
            units = ["chord" if u in ("mirror_chord", "mirror") else u for u in units]
        if self.n_lanes < 4 or self.quad_prob <= 0:
            units = [u for u in units if u != "quad"]
        if self.disable_drag:
            units = ["flow" if u in ("dragchain", "drag_sea", "snake_tap", "drag") else u for u in units]
        if not units:
            units = ["flow"]
        return units

    def _quad_lanes(self):
        """6K 也可以四开：左手 2 条 + 右手 2 条，共 4 键同时。"""
        left = self.left_lanes or self.lanes[:2]
        right = self.right_lanes or self.lanes[-2:]
        ll = sorted(random.sample(left, 2)) if len(left) >= 2 else list(left)
        rr = sorted(random.sample(right, 2)) if len(right) >= 2 else list(right)
        return ll + rr


    # ── 高级键型：三角交互 / 反手交互（读谱形状分节）──────────
    def _interaction_type(self, time_sec: float) -> int:
        # 密集 16 分交互/三角/2+3/反手中保持纯 Tap，避免 flick 后 150ms 内把下一音转成 drag_
        return TAP

    def _tri_alt_step(self, bs: dict) -> tuple[int, float]:
        # 三角交互：3 连 16 分 L-R-L / R-L-R 交替，三条不同 lane 构成可读三角/折返
        st = bs.setdefault("tri", {})
        step = int(st.get("pos", 0)) % 3
        st["pos"] = step + 1
        if step == 0:
            sw = int(st.get("start_hand", 0)) % 2
            st["start_hand"] = 1 - sw
            st["sw"] = sw
            pool = self.left_lanes if sw == 0 else self.right_lanes
            if not pool:
                pool = self.lanes
            idx = int(st.get("l_idx", 0)) % len(pool)
            st["base"] = idx
            st["l_idx"] = (idx + 1) % len(pool)
            return sw, pool[idx]
        sw = int(st.get("sw", 0)) % 2
        hand = (sw + step) % 2
        if step == 1:
            mirror_pool = self.right_lanes if hand == 1 else self.left_lanes
            if not mirror_pool:
                mirror_pool = self.lanes
            base = int(st.get("base", 0)) % len(mirror_pool)
            ridx = (len(mirror_pool) - 1 - base) % len(mirror_pool)
            return hand, mirror_pool[ridx]
        pool = self.left_lanes if hand == 0 else self.right_lanes
        if not pool:
            pool = self.lanes
        base = int(st.get("base", 0)) % len(pool)
        nxt = (base + 1) % len(pool) if len(pool) > 1 else 0
        return hand, pool[nxt]

    def _tri_alt_lane(self, hand: int, bs: dict) -> float:
        st = bs.setdefault("tri", {})
        if hand == 0:
            idx = int(st.get("l_idx", 0)) % len(self.left_lanes)
            return self.left_lanes[idx]
        return self.right_lanes[0]

    def _cross_alt_lane(self, hand: int, time_sec: float) -> float:
        # 反手/轴交互：偶发反向接近中心，形成"跨手"；高难度才用
        if self.n_lanes >= 6 and random.random() < 0.35:
            if hand == 0:
                return self.right_lanes[0]
            return self.left_lanes[-1]
        return self._pick_alt_in_hand(time_sec, hand)

    def _emit(self, chunk: list, pattern: str, bias: int, notes: list,
              density_key: str, block_state: dict = None) -> None:
        bs = block_state if block_state is not None else {}
        occurrence = int(bs.get("occurrence", 1))
        prog_boost = 1.0 + 0.20 * max(0, occurrence - 1)
        base_burst = float(self.difficulty.get("burst_prob", 0.0))
        burst_prob = min(1.0, base_burst * prog_boost)
        hold_bias_phrase = pattern in ("holdleft", "holdright")
        pref_hand = self._preferred_hand()
        dense = density_key == "dense"

        self._jack_lane = None
        self._jack_hand = None
        self._jack_remaining = 0
        self._stair_hand = None
        self._stair_idx = None
        self._stair_dir = bias if bias else 1

        for pos, p in enumerate(chunk):
            time_sec = p["time_sec"]
            frame = int(time_sec * self.sr / HOP_LENGTH)
            band = get_dominant_band(self.bands, frame)
            sustain = self._detect_sustain(time_sec)
            free = self._free_hands(p["beat"])

            # ── 蛇形交互/拉面海：drag 蛇为底，强拍加 tap/double/flick/hold 确认（单/双压）──
            if pattern in ("drag_sea", "snake_tap"):
                if not free:
                    continue
                base_hand = self._choose_hand_for_pattern("dragchain", time_sec)
                if base_hand not in free:
                    base_hand = free[0]
                other = 1 - base_hand
                snake_lane = self._drag_next(bs)
                _, slot, sub = self._in_beat_slot(p)
                is_conf = (slot % max(1, sub // 2) == 0)   # 每半拍一个确认点
                hot = (pattern == "snake_tap")
                ctype = None
                if is_conf:
                    # hold 确认前一个确认点应为 tap/double（非 flick），避免被 flick-then-tap/hold 规则消解
                    if hot:
                        seq = ["hold", "tap", "double", "flick", "double", "tap", "hold", "double"]
                    else:
                        seq = ["hold", "tap", "double", "flick", "double", "hold", "tap", "double"]
                    ci = bs.setdefault("conf_i", 0) % len(seq)
                    ctype = seq[ci]
                    bs["conf_i"] = ci + 1
                # hold 确认：可短可长，另一手补 tap/flick（双压/多压）
                if ctype == "hold":
                    hb = self._pick_hold_beats(sustain)
                    self._hand_hold_until[base_hand] = p["beat"] + hb + self._hold_cd_beats
                    notes.append(self._make_note(p, HOLD, lane=snake_lane, hold_beats=hb))
                    self._register(time_sec, base_hand, snake_lane)
                    if len(free) == 2:
                        oth = self._lane_for_hand(other)
                        notes.append(self._make_note(p, TAP if random.random() < 0.5 else FLICK, lane=oth))
                        self._register(time_sec, other, oth)
                    continue
                # 默认放一根 drag 蛇
                notes.append(self._make_note(p, DRAG, lane=snake_lane))
                self._register(time_sec, base_hand, snake_lane)
                if ctype == "tap":
                    # 单压确认：同轨道 tap 与 drag 重叠（点划）
                    notes.append(self._make_note(p, TAP, lane=snake_lane))
                elif ctype == "double":
                    # 双压确认：另一手 tap/flick，左右开弓
                    if len(free) == 2:
                        oth = self._lane_for_hand(other)
                        notes.append(self._make_note(p, TAP if random.random() < 0.5 else FLICK, lane=oth))
                        self._register(time_sec, other, oth)
                elif ctype == "flick":
                    # flick 确认：同轨道 flick 与 drag 重叠
                    notes.append(self._make_note(p, FLICK, lane=snake_lane))
                continue


            # ── 三角交互 / 2+3 / 反手交互（读谱形状分节）──
            if pattern == "tri_alt":
                if not free:
                    continue
                hand, lane = self._tri_alt_step(bs)
                if hand not in free:
                    hand = free[0]
                    lane = self._tri_alt_lane(hand, bs)
                ntype = self._interaction_type(time_sec)
                notes.append(self._make_note(p, ntype, lane=lane))
                self._register(time_sec, hand, lane)
                continue
            if pattern == "2plus3":
                if not free:
                    continue
                if self._is_downbeat(p) and len(free) == 2:
                    li, ri = self._chord_lanes(mirror=(random.random() < 0.4))
                    bs.setdefault("tri", {})["pos"] = 0
                    ntype0 = self._interaction_type(time_sec)
                    notes.append(self._make_note(p, ntype0, lane=li))
                    notes.append(self._make_note(p, ntype0, lane=ri))
                    self._register(time_sec, 0, li)
                    self._register(time_sec, 1, ri)
                    continue
                hand, lane = self._tri_alt_step(bs)
                if hand not in free:
                    hand = free[0]
                    lane = self._tri_alt_lane(hand, bs)
                ntype = self._interaction_type(time_sec)
                notes.append(self._make_note(p, ntype, lane=lane))
                self._register(time_sec, hand, lane)
                continue
            if pattern == "cross_alt":
                if not free:
                    continue
                hand = self._choose_hand_for_pattern("alternate", time_sec)
                if hand not in free:
                    hand = free[0]
                lane = self._cross_alt_lane(hand, time_sec)
                ntype = self._interaction_type(time_sec)
                notes.append(self._make_note(p, ntype, lane=lane))
                self._register(time_sec, hand, lane)
                continue
            # ── hold ──
            prev_gap_ms = (time_sec - self._last_time) * 1000.0 if self._last_time > -1e8 else 1e9
            min_sustain = 0.28 if dense else 0.18
            sp = 0.6 if sustain > 0.55 else (0.42 if sustain > 0.4 else 0.22)
            if hold_bias_phrase:
                sp = max(sp, 0.4)
            if dense:
                sp *= 0.25
            # 只在"呼吸"处起 hold，避免打断密集连打
            breathe = prev_gap_ms > 320.0 or sustain > 0.55
            budget_ok = time_sec - self._last_hold_time > 1.0

            wants_hold = (not self.disable_hold and sustain > min_sustain and bool(free) and breathe and budget_ok
                          and random.random() < sp)
            if wants_hold:
                # 选取持键手：长条偏向一侧时优先用该侧的手，否则左右交替
                if hold_bias_phrase:
                    bias_hand = 0 if bias < 0 else 1
                    hhand = bias_hand if bias_hand in free else free[0]
                elif self._last_hold_hand is None:
                    hhand = pref_hand if pref_hand in free else random.choice(free)
                else:
                    hhand = 1 - self._last_hold_hand
                    if hhand not in free:
                        hhand = free[0]
                self._last_hold_hand = hhand
                other = 1 - hhand
                hb = self._pick_hold_beats(sustain)
                # 长条落在持键手所在侧，避免与"另一边加 hold"同轨
                lane_h = self._hold_lane(1 if hhand == 1 else -1) if hold_bias_phrase else self._lane_for_hand(hhand)
                self._hand_hold_until[hhand] = p["beat"] + hb + self._hold_cd_beats
                notes.append(self._make_note(p, HOLD, lane=lane_h, hold_beats=hb))
                self._register(time_sec, hhand, lane_h)
                self._last_hold_time = time_sec
                if other in free and sustain > 0.6 and random.random() < 0.10:
                    lane_o = self._hold_lane(1 if other == 1 else -1)
                    if lane_o == lane_h:
                        pool = self.right_lanes if other == 1 else self.left_lanes
                        alt = [l for l in pool if l != lane_h and l != lane_o]
                        lane_o = random.choice(alt) if alt else self._lane_for_hand(other)
                    self._hand_hold_until[other] = p["beat"] + hb + self._hold_cd_beats
                    notes.append(self._make_note(p, HOLD, lane=lane_o, hold_beats=hb))
                    self._register(time_sec, other, lane_o)
                    continue
                if other in free and random.random() < 0.45:
                    # hold 开头双押：长条起始对拍另一手，强音用 Flick 强调
                    ntype2 = FLICK if (self._onset_at(time_sec) > 0.5 and random.random() < 0.5) else TAP
                    lane2 = self._pick_lane_in_hand(time_sec, other)
                    if lane2 == lane_h:
                        pool = self.right_lanes if other == 1 else self.left_lanes
                        alt = [l for l in pool if l != lane_h and l != lane2]
                        if alt:
                            lane2 = random.choice(alt)
                    notes.append(self._make_note(p, ntype2, lane=lane2))
                    self._register(time_sec, other, lane2)
                # hold 结尾补音：长条收尾时给另一手一个 tap，首尾呼应，给 tap 加花样
                if hb >= 1.0 and self._free_hands(p["beat"] + hb) and random.random() < 0.2:
                    end_beat = p["beat"] + hb
                    end_tick = int(round(end_beat * self.ticks_per_beat))
                    end_time = self._time_at_tick(end_tick)
                    end_p = {"time_sec": end_time, "beat": end_beat, "beat_tick": end_tick,
                             "probability": 0.6, "snap_status": 1}
                    lane_end = self._hold_lane(1 if other == 1 else -1)
                    if lane_end != lane_h:
                        notes.append(self._make_note(end_p, TAP, lane=lane_end))
                        self._register(end_time, other, lane_end)
                continue

            if not free:
                continue

            # ── 类型 ──
            if pattern == "syncop":
                ntype = self._syncop_type(p, time_sec)
            elif pattern == "dragchain":
                ntype = DRAG if random.random() < 0.85 else self._classify_type(time_sec)
            elif pattern in ("stream", "jack", "stair", "stair_up", "stair_down",
                             "burst", "alternate", "zigzag", "roundtrip"):
                # Flick 顺节拍重音：强 onset + 强拍才出 Flick，弱拍仍以 Tap 为主
                a = self._onset_at(time_sec)
                if self.flick_w > 0.01 and a > 0.55 and random.random() < 0.55 * min(1.0, self.flick_w * 3.0):
                    ntype = FLICK
                else:
                    ntype = TAP
            else:
                ntype = self._classify_type(time_sec)

            # ── 高潮段双手激活：强拍给单押加一个双手和弦，左右手都用足 ──
            if (dense and pattern in ("alternate", "stream", "stair", "stair_up", "stair_down",
                                      "burst", "zigzag", "roundtrip", "syncop")
                    and self._is_downbeat(p) and self.n_lanes >= 4 and len(free) == 2
                    and ntype in (TAP, FLICK) and random.random() < 0.6):
                li, ri = self._chord_lanes(mirror=(random.random() < 0.4))
                notes.append(self._make_note(p, ntype, lane=li))
                notes.append(self._make_note(p, ntype, lane=ri))
                self._register(time_sec, 0, li)
                self._register(time_sec, 1, ri)
                continue

            # ── 多押：双押 / 镜像双押 / 三押 / 错位双押 ──
            if pattern in ("chord", "mirror", "mirror_chord") and self.n_lanes >= 4 \
                    and ntype in (TAP, FLICK) and len(free) == 2:
                is_acc = self._is_downbeat(p)
                cprob = 0.9 if is_acc else 0.0
                if p["probability"] > 0.35 and random.random() < cprob:
                    li, ri = self._chord_lanes(mirror=(pattern == "mirror_chord"))
                    notes.append(self._make_note(p, ntype, lane=li))
                    notes.append(self._make_note(p, ntype, lane=ri))
                    self._register(time_sec, 0, li)
                    self._register(time_sec, 1, ri)
                    continue
            if pattern == "offsetchord" and self.n_lanes >= 4 and ntype in (TAP, FLICK):
                # 强拍双押，弱拍单押——错位/对切，读谱更利落
                if self._is_downbeat(p) and len(free) == 2 and random.random() < 0.75:
                    li, ri = self._chord_lanes(mirror=(random.random() < 0.5))
                    bs["offset_lanes"] = (li, ri)
                    notes.append(self._make_note(p, ntype, lane=li))
                    notes.append(self._make_note(p, ntype, lane=ri))
                    self._register(time_sec, 0, li)
                    self._register(time_sec, 1, ri)
                    continue
                ntype = TAP
                off = bs.get("offset_lanes")
                hand = self._choose_hand_for_pattern("alternate", time_sec)
                if hand not in free:
                    hand = free[0]
                if off:
                    target = random.choice(off)
                    pool = self.left_lanes if hand == 0 else self.right_lanes
                    lane = min(pool, key=lambda l: (abs(l - target) + random.random() * self.span * 0.12))
                else:
                    lane = self._pick_lane_in_hand(time_sec, hand)
                notes.append(self._make_note(p, ntype, lane=lane))
                self._register(time_sec, hand, lane)
                continue
            if pattern == "triple" and self.max_chord >= 3 and self.n_lanes >= 3 \
                    and ntype in (TAP, FLICK) and len(free) == 2 and self._is_downbeat(p) \
                    and p["probability"] > 0.7:
                if random.random() < 0.25 * prog_boost:
                    self._emit_triple(p, ntype, notes, time_sec)
                    continue
            # 四键全开（4K 特有）：强拍 4-lane 同时声嗤
            if pattern == "quad" and self.n_lanes >= 4 and ntype in (TAP, FLICK) \
                    and self._is_downbeat(p) and len(free) == 2 and p.get("probability", 0) > 0.7:
                if random.random() < self.quad_prob * (1.6 if prog_boost else 1.0):
                    ql = self._quad_lanes()
                    for ln in ql:
                        notes.append(self._make_note(p, ntype, lane=ln))
                    for ln in ql:
                        self._lane_last_time[ln] = time_sec
                    self._register(time_sec, 0, ql[0])
                    self._register(time_sec, 1, ql[-1])
                    continue

            # ── 手 + lane ──
            if pattern == "jack":
                hand, lane = self._jack_hand_lane(time_sec, free)
            elif len(free) == 1:
                hand = free[0]
                lane = self._lane_for_pattern(pattern, hand, pos, p, time_sec, ntype, bs)
            else:
                hand = self._choose_hand_for_pattern(pattern, time_sec)
                if hand not in free:
                    hand = free[0]
                lane = self._lane_for_pattern(pattern, hand, pos, p, time_sec, ntype, bs)

            # 禁止同手连续 3 连以上同一轨道（非 jack）——避免"连续五连同一列"
            _pl, _cnt = self._lane_streak.get(hand, (None, 0))
            if _cnt >= 2 and _pl == lane and ntype in (TAP, FLICK) and pattern != "jack":
                _pool = self.left_lanes if hand == 0 else self.right_lanes
                _alt = [l for l in _pool if l != lane]
                if _alt:
                    lane = random.choice(_alt)
            notes.append(self._make_note(p, ntype, lane=lane))
            self._register(time_sec, hand, lane)
            # 提高 drag/tap/flick 结合率：强拍 Flick 上叠 Drag、强拍 Tap 上叠 Drag（点划）
            if not self.disable_drag:
                if ntype == FLICK and self._is_downbeat(p) and self._onset_at(time_sec) > 0.5:
                    if random.random() < 0.5:
                        notes.append(self._make_note(p, DRAG, lane=lane))
                elif ntype == TAP and self._is_downbeat(p) and self._onset_at(time_sec) > 0.45:
                    if random.random() < 0.28:
                        notes.append(self._make_note(p, DRAG, lane=lane))

    # ── 谱面纠错（强制 note 放置规则）──────────────

    def _frac_val(self, frac):
        if isinstance(frac, (int, float)):
            return float(frac)
        return frac[0] + frac[1] / max(frac[2], 1)

    def _note_beat(self, n: dict) -> float:
        return self._frac_val(n["startTime"])

    def _enforce_placement_rules(self, notes: list) -> list:
        # 1) 同一 (time,lane) 上非 drag note 不得相互/自我叠加；多余的非 drag 转成 drag
        groups = {}
        for n in notes:
            groups.setdefault((tuple(n["startTime"]), n["positionX"]), []).append(n)
        for grp in groups.values():
            nondrag = [n for n in grp if n["type"] != DRAG]
            if len(nondrag) > 1:
                for n in nondrag[1:]:
                    n["type"] = DRAG
        # 2) hold 内部（非端点）在其轨道上只允许 drag；tap/flick 落入则转 drag
        holds = [n for n in notes if n["type"] == HOLD]
        for n in notes:
            if n["type"] in (TAP, FLICK):
                nb = self._note_beat(n)
                for h in holds:
                    hs = self._note_beat(h)
                    he = self._frac_val(h["endTime"])
                    if n["positionX"] == h["positionX"] and hs < nb < he:
                        n["type"] = DRAG
                        break
        # 3) flick 之后极短时间内不得跟 tap/hold，落进来的 tap/hold 转 drag
        ordered = sorted(notes, key=lambda n: (self._note_beat(n), n["positionX"]))
        gap = self.flick_gap_ms / 1000.0
        last_flick_beat = None
        for n in ordered:
            nb = self._note_beat(n)
            if last_flick_beat is not None:
                if nb - last_flick_beat < gap and n["type"] in (TAP, HOLD):
                    n["type"] = DRAG
                elif nb - last_flick_beat >= gap:
                    last_flick_beat = None
            if n["type"] == FLICK:
                last_flick_beat = nb
        return notes

    # ── 主流程 ──────────────────────────────────────

    def generate(self) -> list[dict]:
        selected = self._select_flat()
        all_notes = self._density_fill(selected)
        segments = self._plan_segments(all_notes)
        notes = []
        for chunk, pattern, bias, key, bs in segments:
            self._zh_pos = {0: random.randrange(len(self.left_lanes)) if self.left_lanes else 0,
                            1: random.randrange(len(self.right_lanes)) if self.right_lanes else 0}
            self._zh_dir = {0: random.choice([1, -1]), 1: random.choice([1, -1])}
            self._emit(chunk, pattern, bias, notes, key, bs)
        notes.sort(key=lambda n: n["startTime"])
        notes = self._enforce_placement_rules(notes)
        return notes
