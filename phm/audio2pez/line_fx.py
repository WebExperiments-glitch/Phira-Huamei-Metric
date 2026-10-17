# -*- coding: utf-8 -*-
"""判定线动效：主判定线 alpha 呼吸 + 侧斜判定线敲击闪光 + 旋转假音符装饰 + 多线拆分。

参考真实 Phigros/Phira 谱（RPE）实现：
  - 装饰线用 isCover=True + 假音符(isFake=1)，否则不渲染/没有旋转观感。
  - 旋转/位移/透明度都通过 moveX/moveY/rotate/alpha 事件驱动。
  - 侧斜判定线：敲击左右 tap/flick 时，从左右两侧引出一条斜线淡入淡出。
  - 假音符：玩家不用敲（isFake=1，无判定、无特效、不计分）。
  - 多线拆分：副线改为斜/竖，音符下落方向反转(above=2)，并默认 y=-300。
"""

import math
from config import DEFAULT_SPEED, LEAD_IN_BEATS

TAP, HOLD, FLICK, DRAG = 1, 2, 3, 4


# ── beat 分数工具 ──────────────────────────────────────────

def _frac(tick: int, tpb: int) -> list:
    tick = max(0, int(tick)); tpb = int(tpb or 480)
    whole, rem = divmod(tick, tpb)
    if rem == 0:
        return [whole, 0, 1]
    g = math.gcd(rem, tpb)
    return [whole, rem // g, tpb // g]


def beat_frac(sec: float, bpm: float, tpb: int) -> list:
    return _frac(round(sec * max(bpm, 1.0) / 60.0 * tpb), tpb)


def _beat_val(frac) -> float:
    if isinstance(frac, (int, float)):
        return float(frac)
    return frac[0] + frac[1] / max(frac[2], 1)


def _beat_to_frac(beat: float, tpb: int) -> list:
    return _frac(int(round(_beat_val(beat) * tpb)), tpb)


def _beat_plus(frac, delta: float, tpb: int) -> list:
    return _frac(int(round(_beat_val(frac) * tpb + delta * tpb)), tpb)


# ── 事件构造 ──────────────────────────────────────────────

def _ev(s, e, st, ed, ease=1):
    return {"bezier": 0, "bezierPoints": [0.0, 0.0, 0.0, 0.0],
            "easingLeft": 0.0, "easingRight": 1.0, "easingType": ease,
            "start": float(st), "end": float(ed), "startTime": s, "endTime": e, "linkgroup": 0}


def _spev(s, e, st, ed):
    return {"start": float(st), "end": float(ed), "startTime": s, "endTime": e, "linkgroup": 0}


def _const_alpha():
    return _ev([0, 0, 1], [999999, 0, 1], 255.0, 255.0)


def _alpha_baseline(events, baseline=0.0):
    """保证 [0, 首事件) 段为 baseline(默认0)，避免 Phira 用 alphaControl 默认值(255)把线常亮。
    用“终止于首事件起点的前导 0 段”，而不是 0~∞ 全程垫底，避免它与闪光事件重叠。"""
    events = list(events)
    if events:
        first_start = _beat_val(events[0]["startTime"])
        if first_start > 1e-9:
            events.insert(0, _ev([0, 0, 1], events[0]["startTime"], baseline, baseline))
    return events


def _const_ev(v, is_speed=False):
    if is_speed:
        return _spev([0, 0, 1], [999999, 0, 1], v, v)
    return _ev([0, 0, 1], [999999, 0, 1], v, v)


def event_layer(alpha=None, movex=None, movey=None, rotate=None,
                speed=None, default_speed=DEFAULT_SPEED):
    return {
        "alphaEvents": alpha if alpha else [_const_alpha()],
        "moveXEvents": movex if movex else [_const_ev(0.0)],
        "moveYEvents": movey if movey else [_const_ev(0.0)],
        "rotateEvents": rotate if rotate else [_const_ev(0.0)],
        "speedEvents": speed if speed else [_const_ev(default_speed, is_speed=True)],
    }


def _incline_placeholder():
    """PhiEdit 要求 extended 里必有 inclineEvents 垫底事件，否则判定线管理会闪退。"""
    return {"bezier": 0, "bezierPoints": [0.0, 0.0, 0.0, 0.0],
            "easingLeft": 0.0, "easingRight": 1.0, "easingType": 0,
            "end": 0.0, "start": 0.0, "endTime": [1, 0, 1], "startTime": [0, 0, 1], "linkgroup": 0}


def _extended_merge(extra=None):
    """合并判定线 extended（保留 inclineEvents 垫底）。"""
    base = {"inclineEvents": [_incline_placeholder()]}
    if isinstance(extra, dict):
        for k, v in extra.items():
            if v:
                base[k] = v
    return base


def _judge_line(name, notes, layers, z_order=0, is_cover=True, texture="line.png",
                 extended_extra=None):
    return {
        "Group": 0, "Name": name, "Texture": texture,
        "alphaControl": [{"alpha": 1.0, "easing": 1, "x": 0.0},
                         {"alpha": 1.0, "easing": 1, "x": 9999999.0}],
        "bpmfactor": 1.0, "eventLayers": layers,
        "extended": _extended_merge(extended_extra), "father": -1,
        "isCover": int(is_cover), "notes": notes, "numOfNotes": len(notes),
        "posControl": [{"easing": 1, "pos": 1.0, "x": 0.0},
                       {"easing": 1, "pos": 1.0, "x": 9999999.0}],
        "sizeControl": [{"easing": 1, "size": 1.0, "x": 0.0},
                        {"easing": 1, "size": 1.0, "x": 9999999.0}],
        "skewControl": [{"easing": 1, "skew": 0.0, "x": 0.0},
                        {"easing": 1, "skew": 0.0, "x": 9999999.0}],
        "yControl": [{"easing": 1, "x": 0.0, "y": 1.0},
                     {"easing": 1, "x": 9999999.0, "y": 1.0}],
        "zOrder": z_order,
    }


# ── 音符工具 ──────────────────────────────────────────────

def _fake_note(start_time, x, ntype, alpha=255, above=1, end_time=None):
    """生成装饰用假音符（isFake=1：玩家不必敲，不计分、无特效）。"""
    return {
        "above": above, "alpha": alpha, "endTime": end_time or start_time,
        "isFake": 1, "positionX": round(float(x), 1), "size": 1.0,
        "speed": 1.0, "startTime": start_time, "type": ntype,
        "visibleTime": 999999.0, "yOffset": 0.0,
    }


# ── 主判定线事件 ──────────────────────────────────────────

def _last_beat_frac(line_fx, bpm, tpb):
    max_sec = 0.0
    for sec in (line_fx.get("sections") or []):
        max_sec = max(max_sec, float(sec.get("end_time", 0.0)))
    if max_sec <= 0:
        max_sec = 120.0
    return beat_frac(max_sec, bpm, tpb)


def _filter_notes_by_when(notes, line_fx, bpm, tpb, when):
    """只保留落在 when 关键词对应时间窗内的音符（用于 mix 把不同动效分配到不同段落）。"""
    ranges = [(_beat_val(s), _beat_val(e)) for (s, e) in _windows_by_when(line_fx, bpm, tpb, when)]
    if not ranges:
        return notes
    out = []
    for n in notes:
        nb = _beat_val(n["startTime"])
        if any(sv <= nb < ev for (sv, ev) in ranges):
            out.append(n)
    return out


def _note_positions_to_beats(notes, positions):
    """把“第 N 个音符”换算成它的出现拍（按 startTime 升序，1 起数）。"""
    srt = sorted(notes, key=lambda n: _beat_val(n["startTime"]))
    beats = []
    for pos in positions:
        idx = int(float(pos)) - 1
        if 0 <= idx < len(srt):
            beats.append(_beat_val(srt[idx]["startTime"]))
    return beats


def _main_swing_events(line_fx, notes, bpm, tpb, base_angle=5.0, shift=40.0):
    """主判定线左右摆动 + 音符合成平移。

    某段左侧 tap/flick 多则向左转/向左滑，右侧多则向右转/向右滑，段末回正。
    返回 (rotate_events, movex_events)；无摆动则返回 (None, None)。
    angle 随段落密度缩放；摆动/平移都用 In-Out Sine(ease 6) 更顺滑。
    """
    secs = line_fx.get("sections") or []
    if not secs:
        return None, None
    ratio = 1.2
    rot_evs, mvx_evs = [], []
    for sec in secs:
        s = beat_frac(sec["start_time"], bpm, tpb)
        e = beat_frac(sec["end_time"], bpm, tpb)
        sv = _beat_val(s); evv = _beat_val(e)
        lc = rc = 0
        for n in notes:
            if n.get("type") in (TAP, FLICK) and not n.get("isFake"):
                nb = _beat_val(n["startTime"])
                if sv <= nb < evv:
                    if n.get("positionX", 0) < 0:
                        lc += 1
                    else:
                        rc += 1
        if lc > rc * ratio:
            direction = -1
        elif rc > lc * ratio:
            direction = 1
        else:
            continue
        density = float(sec.get("density", 0.5))
        amp = base_angle * max(0.5, min(1.6, 0.5 + density))
        swing_in = _beat_plus(s, 1.0, tpb)
        swing_out = _beat_plus(e, -1.0, tpb)
        if _beat_val(swing_in) > evv:
            swing_in = e
        if _beat_val(swing_out) < sv:
            swing_out = s
        if _beat_val(swing_in) > _beat_val(swing_out):
            continue
        # 摆动
        rot_evs.append(_ev(s, swing_in, 0.0, direction * amp, ease=6))
        rot_evs.append(_ev(swing_in, swing_out, direction * amp, direction * amp, ease=1))
        rot_evs.append(_ev(swing_out, e, direction * amp, 0.0, ease=6))
        # 音符合成平移（与摆动同步）
        mvx_evs.append(_ev(s, swing_in, 0.0, direction * shift, ease=6))
        mvx_evs.append(_ev(swing_in, swing_out, direction * shift, direction * shift, ease=1))
        mvx_evs.append(_ev(swing_out, e, direction * shift, 0.0, ease=6))
    if not rot_evs:
        return None, None
    rot_evs.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
    mvx_evs.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
    return rot_evs, mvx_evs


def _main_lift(line_fx, notes, bpm, tpb, main_y, lift_cfg):
    """主判定线上浮特效：某段把判定线从 main_y 缓动上移到 up_y，该段音符改为上升(above=2)，
    一段时间后回到 main_y，恢复正常下落。返回 (moveY_events, modified_notes)。"""
    lift_cfg = lift_cfg or {}
    if lift_cfg.get("start_sec"):
        start_sec = float(lift_cfg["start_sec"])
        end_sec = float(lift_cfg.get("end_sec", start_sec + 12.0))
    else:
        sections = line_fx.get("sections") or []
        if sections:
            best = max(sections, key=lambda s: float(s.get("density", 0.0)))
            start_sec = float(best.get("start_time", 0.0)) + 0.5
            end_sec = start_sec + 12.0
        else:
            start_sec = 40.0; end_sec = start_sec + 12.0
    up_y = float(lift_cfg.get("up_y", 200.0))
    ease = int(lift_cfg.get("ease", 6))
    trans = float(lift_cfg.get("transition_beats", 3.0))
    start_b = start_sec * max(bpm, 1.0) / 60.0
    end_b = end_sec * max(bpm, 1.0) / 60.0
    if end_b <= start_b:
        end_b = start_b + 12.0
    sb = _beat_to_frac(start_b, tpb); eb = _beat_to_frac(end_b, tpb)
    s_in = _beat_plus(sb, trans, tpb); e_out = _beat_plus(eb, -trans, tpb)
    if _beat_val(s_in) > _beat_val(eb):
        s_in = eb
    if _beat_val(e_out) < _beat_val(sb):
        e_out = sb
    evs = []
    evs.append(_ev([0, 0, 1], sb, main_y, main_y, ease=1))
    evs.append(_ev(sb, s_in, main_y, up_y, ease=ease))
    evs.append(_ev(s_in, e_out, up_y, up_y, ease=1))
    evs.append(_ev(e_out, eb, up_y, main_y, ease=ease))
    evs.append(_ev(eb, [999999, 0, 1], main_y, main_y, ease=1))
    evs.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
    out = []
    for n in notes:
        m = dict(n)
        nb = _beat_val(n["startTime"])
        if start_b <= nb < end_b:
            m["above"] = 2
        out.append(m)
    return evs, out


def _main_events(line_fx, bpm, tpb, default_speed, pulse=False, move_y=0.0, rotate=None, move_x=None, lift_move_y=None, bounce_move_y=None):
    lead_sec = LEAD_IN_BEATS * 60.0 / max(bpm, 1.0)
    lead_b = beat_frac(lead_sec, bpm, tpb)
    alpha = [
        _ev([0, 0, 1], lead_b, 0.0, 255.0),
    ]
    if pulse:
        # 段落边界轻闪（时隐时现）
        for sec in (line_fx.get("sections") or []):
            b = beat_frac(sec["end_time"], bpm, tpb)
            bq = _beat_plus(b, 0.25, tpb)
            br = _beat_plus(bq, 0.5, tpb)
            alpha.append(_ev(b, bq, 255.0, 190.0))
            alpha.append(_ev(bq, br, 190.0, 255.0))
    else:
        alpha.append(_ev(lead_b, [999999, 0, 1], 255.0, 255.0))
    alpha.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
    if bounce_move_y is not None:
        mvy = bounce_move_y
    elif lift_move_y is not None:
        mvy = lift_move_y
    else:
        mvy = [_const_ev(move_y)] if abs(move_y) > 1e-6 else None
    return event_layer(alpha=alpha, movex=move_x, movey=mvy, rotate=rotate, default_speed=default_speed)


# ── 侧斜判定线（pulse：敲击左右 tap/flick 时闪光）──────────

def _tap_times_by_side(notes, only_flick=False):
    left, right = [], []
    for n in notes:
        if n.get("isFake"):
            continue
        if only_flick:
            if n.get("type") != FLICK:
                continue
        elif n.get("type") not in (TAP, FLICK):
            continue
        b = _beat_val(n["startTime"])
        (left if n.get("positionX", 0) < 0 else right).append(b)
    return sorted(set(left)), sorted(set(right))


def _consecutive_runs(beats, gap=1.2):
    runs, cur, prev = [], [], None
    for b in beats:
        if prev is None or (b - prev) <= gap:
            cur.append(b)
        else:
            runs.append(cur)
            cur = [b]
        prev = b
    if cur:
        runs.append(cur)
    return runs


def _elastic_shake_events(times, bpm, tpb, amp, sec_len=0.18):
    """RPE 弹性抖动：0->0 垫底(默认常量) + 0->+amp out-elastic + 0->-amp out-elastic（同长，数据相反）。"""
    delta_b = max(sec_len * max(bpm, 1.0) / 60.0, 0.05)
    evs = []
    for b in times:
        s = _beat_to_frac(b, tpb)
        m = _beat_to_frac(b + delta_b, tpb)
        e2 = _beat_to_frac(b + 2 * delta_b, tpb)
        evs.append(_ev(s, m, 0.0, amp, ease=24))
        evs.append(_ev(m, e2, 0.0, -amp, ease=24))
    evs.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
    return evs


def _side_flash_chain(lf, side, beats, bpm, tpb, default_speed, x_sign):
    n = int(lf.get("chain_lines", 5))
    flash_alpha = float(lf.get("flash_alpha", 200.0))
    rot = float(lf.get("flash_angle", 45.0))
    fade = float(lf.get("flash_fade_sec", 0.15))
    delta = fade * max(bpm, 1.0) / 60.0
    runs = _consecutive_runs(beats)
    lines = []
    for j in range(n):
        # 连续点的第 j+1 下亮第 j 条线（从中间到两侧依次亮）
        times = [run[j] for run in runs if len(run) > j]
        if not times:
            continue
        al = []
        for b in times:
            s = _beat_to_frac(b - delta, tpb)
            peak = _beat_to_frac(b, tpb)
            e = _beat_to_frac(b + delta, tpb)
            al.append(_ev(s, peak, 0.0, flash_alpha))
            al.append(_ev(peak, e, flash_alpha, 0.0))
        al.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
        x = x_sign * (80.0 + 120.0 * j)
        rot_ev = [_const_ev(rot * x_sign)]
        mvx_ev = [_const_ev(x)]
        mvy = _elastic_shake_events(times, bpm, tpb, float(lf.get("shake_amp", 30.0)))
        layer = event_layer(alpha=_alpha_baseline(al), rotate=rot_ev, movex=mvx_ev, movey=mvy, default_speed=default_speed)
        lines.append(_judge_line("侧闪线_%s_%d" % (side, j + 1), [], [layer],
                                 z_order=-1 - j, is_cover=True))
    return lines


def _side_flash_sweep(lf, side, beats, bpm, tpb, default_speed, x_sign):
    flash_alpha = float(lf.get("flash_alpha", 200.0))
    rot = float(lf.get("sweep_angle", 80.0))
    fade = float(lf.get("flash_fade_sec", 0.28))
    start_x = float(lf.get("sweep_x", 560.0)) * x_sign
    end_x = -float(lf.get("sweep_endx", 560.0)) * x_sign
    shake_amp = float(lf.get("shake_amp", 30.0))
    delta = fade * max(bpm, 1.0) / 60.0
    al, mvx = [], []
    for b in beats:
        s = _beat_to_frac(b - delta, tpb)
        peak = _beat_to_frac(b, tpb)
        e = _beat_to_frac(b + delta, tpb)
        al.append(_ev(s, peak, 0.0, flash_alpha))
        al.append(_ev(peak, e, flash_alpha, 0.0))
        mvx.append(_ev(s, e, start_x, end_x))
    al.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
    mvx.sort(key=lambda x: (tuple(x["startTime"]), tuple(x["endTime"])))
    mvy = _elastic_shake_events(beats, bpm, tpb, shake_amp)
    rot_ev = [_const_ev(rot * x_sign)]
    layer = event_layer(alpha=_alpha_baseline(al), rotate=rot_ev, movex=mvx, movey=mvy, default_speed=default_speed)
    return [_judge_line("侧闪线_%s" % side, [], [layer], z_order=-1, is_cover=True)]


def _side_flash_lines(line_fx, notes, bpm, tpb, default_speed):
    lf = line_fx or {}
    style = lf.get("pulse_style", "chain")
    only_flick = bool(lf.get("sweep_flick_only", False)) and style == "sweep"
    left, right = _tap_times_by_side(notes, only_flick=only_flick)
    lines = []
    for side, beats, xs in (("left", left, -1), ("right", right, 1)):
        if not beats:
            continue
        if style == "sweep":
            lines.extend(_side_flash_sweep(lf, side, beats, bpm, tpb, default_speed, xs))
        else:
            lines.extend(_side_flash_chain(lf, side, beats, bpm, tpb, default_speed, xs))
    return lines


# ── 装饰旋转假音符线（pinwheel）────────────────────────────

_DECO_DEFAULTS = {
    "pinwheel": {"count": 6, "spin_deg": 360.0, "note_alpha": 220.0, "window_beats": 8},
}


def _windows_by_when(line_fx, bpm, tpb, when, beats=8):
    """按关键词返回 (start,end) beat 窗口列表。
    支持: all / repeat / intro / chorus / verse / intro_chorus / climax(取密度最高段) / altA/altB(交替段)。"""
    sections = line_fx.get("sections") or []
    if when in (None, "all"):
        end_b = max(1, int(_beat_val(_last_beat_frac(line_fx, bpm, tpb))))
        return [(_beat_to_frac(0, tpb), _beat_to_frac(end_b, tpb))]
    if when == "repeat":
        end_b = max(1, int(_beat_val(_last_beat_frac(line_fx, bpm, tpb))))
        return [(_beat_to_frac(b, tpb), _beat_to_frac(min(b + beats, end_b), tpb))
                for b in range(0, end_b, beats)]
    if when == "climax":
        if not sections:
            return [(_beat_to_frac(0, tpb), _beat_to_frac(beats, tpb))]
        dens = [float(s.get("density", 0.0)) for s in sections]
        mx = max(dens) or 1.0
        thr = 0.6 * mx
        out = []
        for s in sections:
            if float(s.get("density", 0.0)) >= thr:
                s0 = beat_frac(s["start_time"], bpm, tpb)
                e0 = beat_frac(s["end_time"], bpm, tpb)
                if _beat_val(e0) > _beat_val(s0):
                    out.append((s0, e0))
        return out or [(_beat_to_frac(0, tpb), _beat_to_frac(beats, tpb))]
    if when in ("altA", "altB"):
        out = []
        for idx, s in enumerate(sections):
            if (idx % 2 == 0) == (when == "altA"):
                s0 = beat_frac(s["start_time"], bpm, tpb)
                e0 = beat_frac(s["end_time"], bpm, tpb)
                if _beat_val(e0) > _beat_val(s0):
                    out.append((s0, e0))
        if not out:
            end_b = max(1, int(_beat_val(_last_beat_frac(line_fx, bpm, tpb))))
            out = [(_beat_to_frac(0, tpb), _beat_to_frac(end_b, tpb))]
        return out
    labels = {"intro": ("intro/break",), "chorus": ("chorus",), "verse": ("verse",),
              "intro_chorus": ("intro/break", "chorus"), "climax": ("chorus",)}.get(when, None)
    out = []
    for s in sections:
        if labels is None or s.get("label") in labels:
            s0 = beat_frac(s["start_time"], bpm, tpb)
            e0 = beat_frac(s["end_time"], bpm, tpb)
            if _beat_val(e0) > _beat_val(s0):
                out.append((s0, e0))
    return out


def _deco_windows(line_fx, bpm, tpb):
    deco = line_fx.get("deco") or {}
    when = deco.get("when", "intro_chorus")
    beats = int(deco.get("window_beats", 8))
    explicit = deco.get("beats")
    if explicit:
        # 用户指定拍位置：在每个拍“左右”各放一个窗口（居中，总宽 window_beats）
        win = []
        half = beats / 2.0
        for b_ in explicit:
            b = float(b_)
            if b - half < 0:
                b = half
            win.append((_beat_to_frac(b - half, tpb), _beat_to_frac(b + half, tpb)))
        seen, out = set(), []
        for w in win:
            k = (tuple(w[0]), tuple(w[1]))
            if k not in seen and _beat_val(w[1]) > _beat_val(w[0]):
                seen.add(k); out.append(w)
        return out[:12]
    wins = _windows_by_when(line_fx, bpm, tpb, when, beats)
    if when != "all":
        start_sec = float(deco.get("start_sec", 12.0))
        start_beat = start_sec * max(bpm, 1.0) / 60.0
        # 推迟开头：去掉结束在 delay 之前的窗口，把跨过 delay 的窗口开头剪到 delay
        trimmed = []
        for w in wins:
            s = _beat_val(w[0]); e = _beat_val(w[1])
            if e <= start_beat:
                continue
            if s < start_beat:
                s = start_beat
            if e > s:
                trimmed.append((_beat_to_frac(s, tpb), w[1]))
        wins = trimmed
        opening = (_beat_to_frac(start_beat, tpb), _beat_to_frac(start_beat + beats, tpb))
        if not any(abs(_beat_val(w[0]) - start_beat) < 1e-6 for w in wins):
            wins.insert(0, opening)
    seen, out = set(), []
    for w in wins:
        if _beat_val(w[1]) <= _beat_val(w[0]):
            continue
        k = (tuple(w[0]), tuple(w[1]))
        if k not in seen:
            seen.add(k); out.append(w)
    return out[:12]


def _deco_notes(count, i, kind, windows, tpb, note_alpha):
    xs = [-300, -150, 0, 150, 300]
    types = [DRAG, TAP, DRAG, FLICK, DRAG]
    notes = []
    total = 0
    MAX_N = 150
    for (w0, w1) in windows:
        w0v = _beat_val(w0); w1v = _beat_val(w1)
        dur = max(w1v - w0v, 1.0)
        # 密度：短窗每 beat 1 个，长窗按 MAX_N 均匀铺满
        step = 1.0 if dur <= 20.0 else max(dur / MAX_N, 1.0)
        k = 0
        b = w0v
        while b < w1v and total < MAX_N:
            x = xs[(i + k) % len(xs)]
            t = types[(i + k) % len(types)]
            notes.append(_fake_note(_beat_to_frac(b, tpb), x, t, alpha=note_alpha))
            total += 1
            k += 1
            b += step
    return notes


def _deco_lines(line_fx, bpm, tpb, default_speed):
    deco = line_fx.get("deco") or {}
    kind = deco.get("type", "pinwheel")
    defaults = _DECO_DEFAULTS.get(kind, _DECO_DEFAULTS["pinwheel"])
    count = int(deco.get("count", defaults["count"]))
    spin = float(deco.get("spin_deg", defaults["spin_deg"]))
    note_alpha = int(deco.get("note_alpha", defaults["note_alpha"]))
    x_off = float(deco.get("xoffset", 0.0))
    windows = _deco_windows(line_fx, bpm, tpb)
    lines = []
    for i in range(max(1, count)):
        base = (360.0 / count) * i
        rot = [_ev(w0, w1, base, base + spin) for (w0, w1) in windows]
        al = []
        for (w0, w1) in windows:
            al.append(_ev(w0, w0, 0.0, 0.0))    # 线隐藏（alpha 0 不藏音符）
            al.append(_ev(w0, w1, 0.0, 0.0))
            al.append(_ev(w1, w1, 0.0, 0.0))    # 线藏(alpha0)，音符随下落自然消失
        al.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
        mvx = [_const_ev(x_off)] if x_off else None
        layer = event_layer(alpha=_alpha_baseline(al), rotate=rot, movex=mvx, default_speed=default_speed)
        notes = _deco_notes(count, i, kind, windows, tpb, note_alpha)
        lines.append(_judge_line("装饰线%d" % (i + 1), notes, [layer],
                                 z_order=-5 - i, is_cover=True))
    return lines


def _grid_alpha_pulse(w0, w1, alpha, tpb):
    delta = 0.08
    fi = _beat_plus(w0, delta, tpb); fo = _beat_plus(w1, -delta, tpb)
    if _beat_val(fi) >= _beat_val(w1): fi = w0
    if _beat_val(fo) <= _beat_val(w0): fo = w1
    if _beat_val(fi) < _beat_val(fo):
        return [_ev(w0, fi, 0.0, alpha), _ev(fi, fo, alpha, alpha), _ev(fo, w1, alpha, 0.0)]
    return [_ev(w0, w1, alpha, alpha)]


def _grid_lines(line_fx, notes, bpm, tpb, default_speed, when="intro_chorus"):
    """事件驱动的竖线(5)+横线(4)，不做常驻网格。
    竖线：开头依次浮现 / flick 时从中间滑向该侧 / 结尾出现；横线：hold 后从主线向上浮现。"""
    lf = line_fx or {}
    alpha = float(lf.get("grid_alpha", 90.0))
    vx = [-400.0, -200.0, 0.0, 200.0, 400.0]
    hy = [-180.0, -60.0, 60.0, 180.0]
    ranges = [(_beat_val(s), _beat_val(e)) for (s, e) in _windows_by_when(line_fx, bpm, tpb, when, 8)]
    def active(bt):
        if not ranges:
            return True
        return any(sv <= bt < ev for (sv, ev) in ranges)
    flicks = sorted([(_beat_val(n["startTime"]), n.get("positionX", 0) < 0)
                     for n in notes if n.get("type") == FLICK and not n.get("isFake")])
    holds = sorted([_beat_val(n["startTime"]) for n in notes
                    if n.get("type") == HOLD and not n.get("isFake")])
    last_beat = int(_beat_val(_last_beat_frac(line_fx, bpm, tpb)))
    lines = []
    for i, x in enumerate(vx):
        al = []
        mvx_ev = [_const_ev(x)]
        if active(0.0):
            open_b = _beat_to_frac(0, tpb); open_e = _beat_to_frac(8, tpb)
            o0 = _beat_plus(open_b, i * 1.2, tpb); o1 = _beat_plus(o0, 1.6, tpb)
            if _beat_val(o1) <= _beat_val(open_e):
                al.extend(_grid_alpha_pulse(o0, o1, alpha, tpb))
        for (bt, is_left) in flicks:
            if active(bt) and ((x < 0) == is_left or x == 0):
                s = _beat_to_frac(max(0.0, bt - 0.25), tpb)
                e = _beat_to_frac(bt + 0.25, tpb)
                al.append(_ev(s, e, 0.0, alpha))
                al.append(_ev(e, _beat_to_frac(bt + 0.6, tpb), alpha, 0.0))
                mvx_ev.append(_ev(s, e, 0.0, x))
        end_w1 = _beat_to_frac(max(0, last_beat), tpb)
        end_w0 = _beat_to_frac(max(0, last_beat - 4), tpb)
        if active(_beat_val(end_w1)):
            e0 = _beat_plus(end_w0, i * 0.6, tpb); e1 = _beat_plus(e0, 1.4, tpb)
            if _beat_val(e1) <= _beat_val(end_w1):
                al.extend(_grid_alpha_pulse(e0, e1, alpha, tpb))
        al.sort(key=lambda z: (tuple(z["startTime"]), tuple(z["endTime"])))
        mvx_ev.sort(key=lambda z: (tuple(z["startTime"]), tuple(z["endTime"])))
        layer = event_layer(alpha=_alpha_baseline(al), rotate=[_const_ev(90.0)], movex=mvx_ev, default_speed=default_speed)
        lines.append(_judge_line("竖线%d" % (i + 1), [], [layer], z_order=-8 - i, is_cover=True))
    for i, y in enumerate(hy):
        al = []
        mvy_ev = [_const_ev(y)]
        for k, hb in enumerate(holds):
            if k % 4 != i or not active(hb):
                continue
            s = _beat_to_frac(hb, tpb)
            e = _beat_to_frac(hb + 1.2, tpb)
            al.append(_ev(s, e, 0.0, alpha))
            al.append(_ev(e, _beat_to_frac(hb + 1.8, tpb), alpha, 0.0))
            mvy_ev.append(_ev(s, e, -300.0, y))
        al.sort(key=lambda z: (tuple(z["startTime"]), tuple(z["endTime"])))
        mvy_ev.sort(key=lambda z: (tuple(z["startTime"]), tuple(z["endTime"])))
        layer = event_layer(alpha=_alpha_baseline(al), rotate=[_const_ev(0.0)], movey=mvy_ev, default_speed=default_speed)
        lines.append(_judge_line("横线%d" % (i + 1), [], [layer], z_order=-8 - 5 - i, is_cover=True))
    return lines


# ── 多线拆分（斜/转 + 反向落点 + 默认 y=-300）─────────────

def _split_notes(notes):
    a, b = [], []
    for n in notes:
        (a if n.get("positionX", 0) < 0 else b).append(n)
    return a, b


def _split_line(line_fx, notes, bpm, tpb, default_speed):
    lf = line_fx or {}
    y = float(lf.get("split_y", 0.0))
    angle = float(lf.get("split_angle", 60.0))
    neg_speed = bool(lf.get("split_neg_speed", False))
    # 保证可玩性：副线音符不能太密，留下反应时间
    gap_ms = float(lf.get("split_min_gap_ms", 160.0))
    gap_b = gap_ms / 1000.0 * max(bpm, 1.0) / 60.0  # 时间->拍
    sub = []
    last = None
    for n in sorted(notes, key=lambda x: _beat_val(x["startTime"])):
        b = _beat_val(n["startTime"])
        if last is not None and (b - last) < gap_b:
            continue
        m = dict(n)
        m["above"] = 2
        sub.append(m)
        last = b
    rot = [_const_ev(angle)]
    mvx = [_const_ev(0.0)]
    mvy = [_const_ev(y)]
    if neg_speed:
        sp = [_const_ev(-abs(default_speed), is_speed=True)]
    else:
        sp = None
    layer = event_layer(movex=mvx, movey=mvy, rotate=rot, speed=sp, default_speed=default_speed)
    return _judge_line("副判定线", sub, [layer], z_order=-2, is_cover=True)


# ── 对外接口 ─────────────────────────────────────────────


# —— 曲线轨迹（Bezier / 参数曲线）事件生成 ——

_CURVE_DEFAULTS = {
    "kind": "arc", "cx": 0.0, "cy": -120.0, "r": 430.0, "a0": 180.0, "a1": 0.0,
    "alpha": 140.0, "n_seg": 32, "fade_beats": 1.0,
}


def _bezier_ev(s, e, st, ed, bezier_points, ease=1):
    """生成 bezier=1 事件：RPE 用它做 CSS cubic-bezier 缓动。
    bezier_points = [x1, y1, x2, y2]，其中 x1/x2 是时间轴控制点（学要 clamp 到 0~1），
    y1/y2 是数值轴控制点（可越界产生过冲）。值 = start → end 按该曲线缓动。
    """
    x1, y1, x2, y2 = (round(float(v), 4) for v in bezier_points)
    return {"bezier": 1, "bezierPoints": [x1, y1, x2, y2],
            "easingLeft": 0.0, "easingRight": 1.0, "easingType": int(ease),
            "start": float(st), "end": float(ed), "startTime": s, "endTime": e, "linkgroup": 0}


def _wrap180(a):
    return (a + 180.0) % 360.0 - 180.0


def _curve_pt(cfg, t):
    """返回 (x, y, angle_deg)，t∈[0,1]。坐标屏幕中心锚点，X∈[-675,675]，Y∈[-450,450]。"""
    kind = cfg.get("kind", "arc")
    if kind == "bezier":
        p0 = cfg.get("p0", [-560.0, -300.0]); p1 = cfg.get("p1", [-200.0, 280.0])
        p2 = cfg.get("p2", [200.0, 280.0]);   p3 = cfg.get("p3", [560.0, -300.0])
        mt = 1.0 - t
        x = mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]
        dx = 3*mt*mt*(p1[0]-p0[0]) + 6*mt*t*(p2[0]-p1[0]) + 3*t*t*(p3[0]-p2[0])
        dy = 3*mt*mt*(p1[1]-p0[1]) + 6*mt*t*(p2[1]-p1[1]) + 3*t*t*(p3[1]-p2[1])
        ang = math.degrees(math.atan2(dy, dx)) if (abs(dx)+abs(dy)) > 1e-9 else 0.0
        return x, y, ang
    if kind == "meteor":
        p0 = cfg.get("p0", [-560.0, 320.0]); p1 = cfg.get("p1", [-370.0, 110.0])
        p2 = cfg.get("p2", [370.0, -110.0]);   p3 = cfg.get("p3", [560.0, -320.0])
        mt = 1.0 - t
        x = mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]
        dx = 3*mt*mt*(p1[0]-p0[0]) + 6*mt*t*(p2[0]-p1[0]) + 3*t*t*(p3[0]-p2[0])
        dy = 3*mt*mt*(p1[1]-p0[1]) + 6*mt*t*(p2[1]-p1[1]) + 3*t*t*(p3[1]-p2[1])
        ang = math.degrees(math.atan2(dy, dx)) if (abs(dx)+abs(dy)) > 1e-9 else 0.0
        return x, y, ang
    if kind == "sine":
        cx = float(cfg.get("cx", 0.0)); cy = float(cfg.get("cy", -300.0))
        ax = float(cfg.get("amp_x", 320.0)); ay = float(cfg.get("amp_y", 120.0))
        freq = float(cfg.get("freq", 1.0)); ph = float(cfg.get("phase", 0.0))
        w = 2.0 * math.pi * freq
        x = cx + ax * math.sin(w * t + ph)
        y = cy + ay * math.sin(w * t + ph + 0.5 * math.pi)
        dx = ax * w * math.cos(w * t + ph)
        dy = ay * w * math.cos(w * t + ph + 0.5 * math.pi)
        ang = math.degrees(math.atan2(dy, dx)) if (abs(dx)+abs(dy)) > 1e-9 else 0.0
        return x, y, ang
    # arc (默认)
    cx = float(cfg.get("cx", 0.0)); cy = float(cfg.get("cy", -120.0))
    r = float(cfg.get("r", 430.0))
    a0 = math.radians(float(cfg.get("a0", 180.0)))
    a1 = math.radians(float(cfg.get("a1", 0.0)))
    th = a0 + (a1 - a0) * t
    x = cx + r * math.cos(th)
    y = cy + r * math.sin(th)
    ang = math.degrees(th + 0.5 * math.pi)
    return x, y, ang


def _curve_traj_events(w0, w1, cfg, tpb, n_seg=None):
    """把参数曲线折线化为 moveX/moveY/rotate 事件（对齐为明 trail）。"""
    n = int(cfg.get("n_seg", n_seg or 32))
    b0 = _beat_val(w0); b1 = _beat_val(w1)
    if b1 <= b0 or n <= 1:
        return [], [], []
    dx_evs, dy_evs, rot_evs = [], [], []
    prev_a = None
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        x0, y0, a0 = _curve_pt(cfg, t0)
        x1, y1, a1 = _curve_pt(cfg, t1)
        if prev_a is not None:
            a0 = prev_a + _wrap180(a0 - prev_a)
        a1 = a0 + _wrap180(a1 - a0)
        sb = _beat_to_frac(b0 + (b1 - b0) * t0, tpb)
        eb = _beat_to_frac(b0 + (b1 - b0) * t1, tpb)
        dx_evs.append(_ev(sb, eb, round(float(x0), 1), round(float(x1), 1)))
        dy_evs.append(_ev(sb, eb, round(float(y0), 1), round(float(y1), 1)))
        rot_evs.append(_ev(sb, eb, round(float(a0), 1), round(float(a1), 1)))
        prev_a = a1
    return dx_evs, dy_evs, rot_evs


def _curve_lines(line_fx, bpm, tpb, default_speed, when="climax"):
    """装饰曲线轨迹判定线：按参数曲线滑动（X/Y）并沿切线旋转，段落内淡入淡出。"""
    lf = line_fx or {}
    cfg = dict(_CURVE_DEFAULTS)
    cfg.update(lf.get("curve") or {})
    alpha = float(cfg.get("alpha", 140.0))
    n_seg = int(cfg.get("n_seg", 32))
    fade = float(cfg.get("fade_beats", 1.0))
    windows = _windows_by_when(line_fx, bpm, tpb, when, 8)
    if not windows:
        return []
    lines = []
    for k, (w0, w1) in enumerate(windows):
        dx, dy, rot = _curve_traj_events(w0, w1, cfg, tpb, n_seg)
        if not dx:
            continue
        al = []
        fi = _beat_plus(w0, fade, tpb); fo = _beat_plus(w1, -fade, tpb)
        # 淡入淡出用 bezier=1 CSS cubic-bezier 缓动（曲线轨迹的微笔就是这个）
        al.append(_bezier_ev(w0, fi, 0.0, alpha, [0.0, 0.0, 1.0, 1.0]))
        if _beat_val(fo) > _beat_val(fi):
            al.append(_ev(fi, fo, alpha, alpha))
        if _beat_val(fo) < _beat_val(w1):
            al.append(_bezier_ev(fo, w1, alpha, 0.0, [0.0, 0.0, 1.0, 1.0]))
        al.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
        mvx = [_const_ev(0.0)] + dx
        mvy = [_const_ev(0.0)] + dy
        rot_all = [_const_ev(0.0)] + rot
        layer = event_layer(alpha=_alpha_baseline(al), movex=mvx, movey=mvy,
                            rotate=rot_all, default_speed=default_speed)
        lines.append(_judge_line("curve_traj%d" % (k + 1), [], [layer],
                                 z_order=-6 - k, is_cover=True))
    return lines



# —— 颜色、缩放、弹跳、魔法阵等安全动效 ——

_cold_rgb = [70, 130, 255]
_warm_rgb = [255, 120, 70]


def _lerp_rgb(a, b, t):
    t = max(0.0, min(1.0, t))
    return [int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3)]


def _color_ev(s, e, c0, c1, ease=1):
    return {"bezier": 0, "bezierPoints": [0.0, 0.0, 0.0, 0.0],
            "easingLeft": 0.0, "easingRight": 1.0, "easingType": int(ease),
            "start": [int(c0[0]), int(c0[1]), int(c0[2])],
            "end": [int(c1[0]), int(c1[1]), int(c1[2])],
            "startTime": s, "endTime": e, "linkgroup": 0}


def _scale_ev(s, e, st, ed, ease=1):
    return {"bezier": 0, "bezierPoints": [0.0, 0.0, 0.0, 0.0],
            "easingLeft": 0.0, "easingRight": 1.0, "easingType": int(ease),
            "start": float(st), "end": float(ed), "startTime": s, "endTime": e, "linkgroup": 0}


def _color_flow_events(line_fx, bpm, tpb):
    """主判定线/装饰线随段落密度从冷色→暖色。"""
    secs = line_fx.get("sections") or []
    if not secs:
        return [_color_ev([0, 0, 1], [999999, 0, 1], _cold_rgb, _warm_rgb, ease=6)]
    dens = [float(s.get("density", 0.5)) for s in secs]
    mx = max(dens) or 1.0
    evs = []
    first = beat_frac(secs[0]["start_time"], bpm, tpb)
    if _beat_val(first) > 1e-9:
        evs.append(_color_ev([0, 0, 1], first, _cold_rgb, _cold_rgb, ease=1))
    for sec in secs:
        s = beat_frac(sec["start_time"], bpm, tpb)
        e = beat_frac(sec["end_time"], bpm, tpb)
        t = float(sec.get("density", 0.5)) / mx
        col = _lerp_rgb(_cold_rgb, _warm_rgb, t)
        evs.append(_color_ev(s, e, col, col, ease=1))
    last_b = _beat_val(_last_beat_frac(line_fx, bpm, tpb))
    last_sec = beat_frac(secs[-1]["end_time"], bpm, tpb)
    t = float(secs[-1].get("density", 0.5)) / mx
    col = _lerp_rgb(_cold_rgb, _warm_rgb, t)
    if _beat_val(last_sec) < last_b:
        evs.append(_color_ev(last_sec, _beat_to_frac(last_b, tpb), col, col, ease=1))
    evs.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
    return evs


def _breathe_events(line_fx, bpm, tpb):
    """主判定线 X/Y 轻微呼吸缩放（1.0→1.06→1.0）。"""
    secs = line_fx.get("sections") or []
    evs = [_scale_ev([0, 0, 1], [999999, 0, 1], 1.0, 1.0, ease=1)]
    for sec in secs:
        s = beat_frac(sec["start_time"], bpm, tpb)
        e = beat_frac(sec["end_time"], bpm, tpb)
        dens = float(sec.get("density", 0.5))
        amp = 1.0 + 0.06 * max(0.0, min(1.0, dens))
        mid = _beat_plus(s, (_beat_val(e) - _beat_val(s)) / 2.0, tpb)
        if _beat_val(mid) > _beat_val(s):
            evs.append(_scale_ev(s, mid, 1.0, amp, ease=6))
            evs.append(_scale_ev(mid, e, amp, 1.0, ease=6))
    evs.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
    return evs


def _bounce_move_y(line_fx, notes, bpm, tpb, main_y):
    """主判定线在强拍上下弹跳（out-elastic），回到 main_y 附近。"""
    beats = []
    for n in notes:
        if n.get("isFake") or n.get("type") not in (TAP, FLICK):
            continue
        b = _beat_val(n["startTime"])
        if abs(b - round(b)) < 1e-6:
            beats.append(b)
    beats = sorted(set(beats))
    if not beats:
        return None
    amp = float(line_fx.get("bounce_amp", 18.0))
    shake = _elastic_shake_events(beats, bpm, tpb, amp, sec_len=0.14)
    base = _const_ev(main_y)
    out = [base]
    for e in shake:
        e2 = dict(e)
        e2["start"] = round(e["start"] + main_y, 1)
        e2["end"] = round(e["end"] + main_y, 1)
        out.append(e2)
    out.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
    return out


def _meteor_lines(line_fx, bpm, tpb, default_speed, when="climax"):
    """装饰线从左上角画弧甩到右下角（模拟流星）。"""
    lf_eff = dict(line_fx or {})
    cfg = dict((line_fx or {}).get("curve") or {})
    cfg.update({"kind": "meteor", "alpha": 150.0, "n_seg": 28, "fade_beats": 1.0,
                "p0": [-560.0, 320.0], "p1": [-370.0, 110.0],
                "p2": [370.0, -110.0], "p3": [560.0, -320.0]})
    lf_eff["curve"] = cfg
    # 限制最密 3 段，避免流星线过多
    secs = sorted((line_fx or {}).get("sections") or [], key=lambda s: float(s.get("density", 0.0)), reverse=True)
    lf_eff["sections"] = [(s.get("start_time"), s.get("end_time"), s.get("density", 0.5), s.get("label", "chorus")) for s in secs[:3]]
    lf_eff["sections"] = [{"start_time": s0, "end_time": s1, "density": de, "label": la} for (s0, s1, de, la) in lf_eff["sections"]]
    return _curve_lines(lf_eff, bpm, tpb, default_speed, when)


def _echo_trail_lines(line_fx, notes, bpm, tpb, default_speed, when="climax"):
    """主判定线摆动时的残影线：把摆动拷贝几条淡出的同向线。"""
    rot, mvx = _main_swing_events(line_fx, notes, bpm, tpb, 5.0, 40.0)
    if not rot:
        return []
    lines = []
    n = int(line_fx.get("echo_count", 3))
    for k in range(n):
        scale = 1.0 - (k + 1) * 0.16
        rot_ev = [_ev(e["startTime"], e["endTime"],
                      round(e["start"] * scale, 1), round(e["end"] * scale, 1),
                      ease=e.get("easingType", 1)) for e in rot]
        mvx_ev = None
        if mvx:
            mvx_ev = [_ev(e["startTime"], e["endTime"],
                          round(e["start"] * scale, 1), round(e["end"] * scale, 1),
                          ease=e.get("easingType", 1)) for e in mvx]
        alpha = [_const_ev(max(8.0, 120.0 * (1.0 - (k + 1) / (n + 1))))]
        layer = event_layer(alpha=alpha, movex=mvx_ev, rotate=rot_ev, default_speed=default_speed)
        lines.append(_judge_line("echo%d" % (k + 1), [], [layer], z_order=-4 - k, is_cover=True))
    return lines


def _spotlight_lines(line_fx, bpm, tpb, default_speed, when="climax"):
    """高潮段加一层深色大屏遮罩（模拟聚光/降亮）。"""
    alpha = float(line_fx.get("spot_alpha", 110.0))
    windows = _windows_by_when(line_fx, bpm, tpb, when, 8)
    if not windows:
        return []
    # 限制最密 2 段，避免太多降亮层
    secs = sorted((line_fx or {}).get("sections") or [], key=lambda s: float(s.get("density", 0.0)), reverse=True)
    if secs:
        keep = [beat_frac(secs[k]["start_time"], bpm, tpb) for k in range(min(2, len(secs)))]
        keep2 = [beat_frac(secs[k]["end_time"], bpm, tpb) for k in range(min(2, len(secs)))]
        windows = [(keep[i], keep2[i]) for i in range(len(keep))]
    lines = []
    for k, (w0, w1) in enumerate(windows):
        al = []
        fi = _beat_plus(w0, 1.5, tpb); fo = _beat_plus(w1, -1.5, tpb)
        al.append(_ev(w0, fi, 0.0, alpha))
        if _beat_val(fo) > _beat_val(fi):
            al.append(_ev(fi, fo, alpha, alpha))
        if _beat_val(fo) < _beat_val(w1):
            al.append(_ev(fo, w1, alpha, 0.0))
        al.sort(key=lambda e: (tuple(e["startTime"]), tuple(e["endTime"])))
        ext = {"scaleXEvents": [_scale_ev([0,0,1],[999999,0,1], 42.0, 42.0)],
               "scaleYEvents": [_scale_ev([0,0,1],[999999,0,1], 90.0, 90.0)],
               "colorEvents": [_color_ev([0,0,1],[999999,0,1], [12,12,24],[12,12,24])]}
        layer = event_layer(alpha=_alpha_baseline(al), default_speed=default_speed)
        lines.append(_judge_line("spotlight%d" % (k + 1), [], [layer],
                                 z_order=-20, is_cover=True, extended_extra=ext))
    return lines


def apply_line_fx(line_fx, notes, bpm, ticks_per_beat, default_speed):
    """返回 (main_events, extra_judge_lines, main_notes)。"""
    line_fx = line_fx or {}
    mode = line_fx.get("mode", "none")
    if mode == "none":
        return None, [], notes, {}
    tpb = int(ticks_per_beat or 480)
    main_y = float(line_fx.get("main_y", -300.0))
    pulse = bool(line_fx.get("alpha_pulse")) or mode in ("alpha_pulse", "pulse", "grid", "mix", "curve", "color_flow", "glow", "bounce", "breathe", "meteor", "echo_trail", "spotlight")
    # 颜色流/光晕：主判定线随密度变色
    main_extended = {}
    eff_types = [e.get("type") for e in (line_fx.get("effects") or [])]
    want_color = mode in ("color_flow", "glow") or "color_flow" in eff_types or "glow" in eff_types
    if want_color:
        main_extended["colorEvents"] = _color_flow_events(line_fx, bpm, tpb)
    want_breathe = mode == "breathe" or "breathe" in eff_types
    if want_breathe:
        _be = _breathe_events(line_fx, bpm, tpb)
        main_extended["scaleXEvents"] = list(_be)
        main_extended["scaleYEvents"] = list(_be)
    bounce_move = None
    if mode == "bounce" or "bounce" in eff_types:
        bounce_move = _bounce_move_y(line_fx, notes, bpm, tpb, main_y)
    # 主判定线左右摆动：非 split 时按左右 tap/flick 数量摆 ±angle
    swing = slide = None
    if line_fx.get("main_swing", False):
        swing, slide = _main_swing_events(
            line_fx, notes, bpm, tpb,
            float(line_fx.get("main_swing_angle", 5.0)),
            float(line_fx.get("main_swing_shift", 40.0)))
    extra = []
    if mode == "mix":
        # 分段叠加：每个 effect 只在其 when 段出现，其余段落透明
        for eff in (line_fx.get("effects") or []):
            etype = eff.get("type")
            enotes = _filter_notes_by_when(notes, line_fx, bpm, tpb, eff.get("when", "all"))
            if etype in ("pinwheel",):
                deco = dict(line_fx.get("deco") or {})
                deco["type"] = etype
                deco["when"] = eff.get("when", "intro_chorus")
                if eff.get("note_positions"):
                    nb = _note_positions_to_beats(notes, eff.get("note_positions"))
                    if nb:
                        deco["beats"] = nb
                elif eff.get("beats"):
                    deco["beats"] = eff.get("beats")
                lf_eff = dict(line_fx); lf_eff["deco"] = deco
                extra.extend(_deco_lines(lf_eff, bpm, tpb, default_speed))
            elif etype == "grid":
                extra.extend(_grid_lines(line_fx, notes, bpm, tpb, default_speed, eff.get("when", "intro_chorus")))
            elif etype in ("chain", "sweep", "alpha_pulse", "pulse"):
                lf_eff = dict(line_fx)
                lf_eff["pulse_style"] = "chain" if etype in ("alpha_pulse", "pulse", "chain") else "sweep"
                extra.extend(_side_flash_lines(lf_eff, enotes, bpm, tpb, default_speed))
            elif etype == "curve":
                extra.extend(_curve_lines(line_fx, bpm, tpb, default_speed, eff.get("when", "climax")))
            elif etype == "meteor":
                extra.extend(_meteor_lines(line_fx, bpm, tpb, default_speed, eff.get("when", "climax")))
            elif etype == "echo_trail":
                extra.extend(_echo_trail_lines(line_fx, notes, bpm, tpb, default_speed, eff.get("when", "climax")))
            elif etype == "spotlight":
                extra.extend(_spotlight_lines(line_fx, bpm, tpb, default_speed, eff.get("when", "climax")))
    elif mode in ("alpha_pulse", "pulse"):
        extra.extend(_side_flash_lines(line_fx, notes, bpm, tpb, default_speed))
    elif mode == "grid":
        extra.extend(_grid_lines(line_fx, notes, bpm, tpb, default_speed, line_fx.get("grid_when", "intro_chorus")))
    elif mode == "pinwheel":
        extra.extend(_deco_lines(line_fx, bpm, tpb, default_speed))
    elif mode == "curve":
        extra.extend(_curve_lines(line_fx, bpm, tpb, default_speed, line_fx.get("curve_when", "climax")))
    elif mode in ("color_flow", "glow", "bounce", "breathe"):
        pass
    elif mode == "meteor":
        extra.extend(_meteor_lines(line_fx, bpm, tpb, default_speed, line_fx.get("meteor_when", "climax")))
    elif mode == "echo_trail":
        extra.extend(_echo_trail_lines(line_fx, notes, bpm, tpb, default_speed, line_fx.get("echo_when", "climax")))
    elif mode == "spotlight":
        extra.extend(_spotlight_lines(line_fx, bpm, tpb, default_speed, line_fx.get("spot_when", "climax")))
    final_notes = notes
    # 主判定线上浮（可选）：上浮段的音符改为上升(above=2)
    lift_move = None
    if line_fx.get("lift"):
        lift_move, final_notes = _main_lift(line_fx, final_notes, bpm, tpb, main_y, line_fx.get("lift"))
    main_ev = [_main_events(line_fx, bpm, tpb, default_speed, pulse=pulse,
                            move_y=main_y, rotate=swing, move_x=slide, lift_move_y=lift_move,
                            bounce_move_y=bounce_move)]
    return main_ev, extra, final_notes, main_extended
