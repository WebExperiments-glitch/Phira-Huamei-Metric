# -*- coding: utf-8 -*-
"""audio2pez 流水线：音频检测 -> 频谱/段落分析 -> 难度分级排布 -> 打包 .pez。

也可以只提供“踩音”后的音符时序 points（不再检测音频），由 charter 自动排布成谱面。
"""

import re
import hashlib
import time
import statistics
from pathlib import Path

from config import (
    DIFFICULTY_PRESETS, LANES_2, LANES_4, LANES_6,
    SAMPLE_RATE, HOP_LENGTH, SECTION_WINDOW,
    DENSITY_LOW, DENSITY_MID, DENSITY_HIGH,
)
from charter import Charter
from packager import build_chart_json, pack_pez, save_json


def _safe_stem(audio_stem: str) -> str:
    return "".join(c for c in audio_stem if c not in r'\/:*?"<>|')


def _parse_mix(spec: str) -> list:
    out = []
    for tok in (spec or "").split(";"):
        tok = tok.strip()
        if not tok:
            continue
        if "@" in tok:
            typ, when = tok.split("@", 1)
            out.append({"type": typ.strip(), "when": (when.strip() or "all")})
        else:
            out.append({"type": tok.strip(), "when": "all"})
    return out


def _build_line_fx(mode: str, sections: list, pulse_style: str = "chain",
                   deco_when: str = "intro_chorus", main_y: float = -300.0,
                   mix_spec: str = "", main_swing: bool = None,
                   sweep_flick_only: bool = False) -> dict:
    if not mode or mode == "none":
        return None
    cfg = {"mode": mode, "sections": sections, "main_y": float(main_y)}
    if main_swing is not None:
        cfg["main_swing"] = bool(main_swing)
    if sweep_flick_only:
        cfg["sweep_flick_only"] = True
    if mode in ("alpha_pulse", "pulse", "grid", "pinwheel", "curve", "color_flow",
                "glow", "bounce", "breathe", "meteor", "echo_trail", "spotlight"):
        cfg["alpha_pulse"] = True
    if mode in ("alpha_pulse", "pulse"):
        cfg["pulse_style"] = pulse_style or "chain"
    if mode == "pinwheel":
        cfg["deco"] = {"type": mode, "when": deco_when or "intro_chorus"}
    if mode == "curve":
        cfg["curve_when"] = deco_when or "climax"
    if mode == "mix":
        effects = _parse_mix(mix_spec)
        if not effects:
            effects = [
                {"type": "grid", "when": "all"},
                {"type": "sweep", "when": "all"},
                {"type": "pinwheel", "when": "climax"},
            ]
        cfg["effects"] = effects
        cfg["alpha_pulse"] = True
        cfg["lift"] = {"ease": 6, "up_y": 200.0, "transition_beats": 3.0}
    return cfg


def _safe_id(name: str) -> str:
    """生成纯 ASCII 的谱面 ID，避免导入器因非 ASCII/空格文件名丢失图片。"""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_") or "song"
    digest = hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:24]}_{digest}"


# ── points 归一化 ────────────────────────────────────────────────────────────
def normalize_points(points: list, bpm: float, ticks_per_beat: int) -> list:
    """确保每个点都有 time_sec / beat / beat_tick / probability / snap_status。"""
    tpb = int(ticks_per_beat or 480)
    bpm = float(bpm) if bpm and bpm > 0 else 120.0
    out = []
    for p in points or []:
        t = float(p.get("time_sec", 0.0))
        if "beat_tick" in p and p.get("beat_tick") is not None:
            tick = int(p["beat_tick"])
        else:
            tick = int(round(t * bpm / 60.0 * tpb))
        beat = float(p.get("beat", tick / tpb))
        prob = float(p.get("probability", 0.4))
        out.append({
            "time_sec": t,
            "beat": beat,
            "beat_tick": tick,
            "probability": max(0.05, min(1.0, prob)),
            "snap_status": int(p.get("snap_status", 1)),
        })
    return out


def coerce_points_dict(data, bpm: float = None) -> dict:
    """把用户输入（dict 含 points，或纯 list）统一成 result dict。"""
    if isinstance(data, dict):
        bpm = float(data.get("bpm") or bpm or 120.0)
        ticks = int(data.get("ticks_per_beat") or 480)
        points = normalize_points(data.get("points", []), bpm, ticks)
        if not data.get("duration_sec"):
            mx = max((p["time_sec"] for p in points), default=0.0)
            dur = mx + 60.0 / bpm * 2.0
        else:
            dur = float(data["duration_sec"])
        return {
            "bpm": bpm,
            "bpm_changes": data.get("bpm_changes", []),
            "tempo_events": data.get("tempo_events") or [{"beat_tick": 0, "bpm": bpm}],
            "offset_sec": float(data.get("offset_sec", 0.0)),
            "ticks_per_beat": ticks,
            "duration_sec": dur,
            "points": points,
        }
    # 纯 list
    bpm = float(bpm or 120.0)
    ticks = 480
    points = normalize_points(data, bpm, ticks)
    dur = max((p["time_sec"] for p in points), default=0.0) + 60.0 / bpm * 2.0
    return {
        "bpm": bpm, "bpm_changes": [], "tempo_events": [{"beat_tick": 0, "bpm": bpm}],
        "offset_sec": 0.0, "ticks_per_beat": ticks, "duration_sec": dur, "points": points,
    }


# ── 无音频时的兜底分析（用 points 推断段落/能量）─────────────────────────────
def fallback_audio(points: list, bpm: float, duration_sec: float) -> dict:
    import numpy as np  # points 模式只需要 numpy；不需要 librosa
    sr = int(SAMPLE_RATE); hop = int(HOP_LENGTH)
    frames = max(1, int(duration_sec * sr / hop))
    onset = np.zeros(frames, dtype=float)
    for p in points:
        frame = int(p["time_sec"] * sr / hop)
        if 0 <= frame < frames:
            onset[frame] = max(onset[frame], float(p["probability"]))
    if onset.max() > 0:
        onset = onset / onset.max()
    else:
        onset[:] = 0.3
    bands = {"low": onset.copy(), "mid": onset.copy(), "high": onset.copy()}
    rms = onset.copy()
    times = np.arange(frames) * hop / sr

    # 用每窗口的 points 密度推断段落标签
    window_sec = SECTION_WINDOW * 60.0 / max(bpm, 1.0)
    n = max(1, int(round(duration_sec / window_sec))) if window_sec else 1
    counts = [0] * n
    for p in points:
        idx = min(n - 1, int(p["time_sec"] / window_sec)) if window_sec else 0
        counts[idx] += 1
    nps = [c / window_sec for c in counts]
    med = statistics.median(nps) if nps else 0.0
    sections = []
    for i in range(n):
        start = i * window_sec
        end = min((i + 1) * window_sec, duration_sec)
        v = nps[i]
        if med > 0 and v < med * 0.6:
            label, density = "intro/break", DENSITY_LOW
        elif med > 0 and v < med * 1.3:
            label, density = "verse", DENSITY_MID
        else:
            label, density = "chorus", DENSITY_HIGH
        sections.append({"start_time": start, "end_time": end, "label": label, "density": density})

    return {"y": None, "sr": sr, "onset_norm": onset, "bands": bands,
            "rms": rms, "rms_norm": rms, "times": times, "sections": sections}


# ── 公共：多难度打包 ──────────────────────────────────────────────────────────
def _build_tiers(result, audio, *, audio_path, name, artist, charter_name, image_path,
                 outdir, difficulty, all_tiers, key_mode, disable_drag,
                 tap_weight, hold_weight, flick_weight, drag_weight, density_mult,
                 line_fx, pulse_style, deco_when, main_y, mix_spec, main_swing,
                 sweep_flick_only) -> dict:
    log = []
    started = time.perf_counter()
    log.append(f"      段落 {len(audio['sections'])} | 已完成")

    tiers = list(DIFFICULTY_PRESETS.keys()) if all_tiers else [difficulty]
    results = {}
    for tier in tiers:
        log.append(f"[3/3] 生成难度 <{tier}> ...")
        presets = DIFFICULTY_PRESETS[tier]
        if key_mode == "2k":
            presets = dict(presets); presets["lanes"] = LANES_2
        elif key_mode == "4k":
            presets = dict(presets); presets["lanes"] = LANES_4
        elif key_mode == "6k":
            presets = dict(presets); presets["lanes"] = LANES_6
        if disable_drag:
            presets = dict(presets); presets["disable_drag"] = True; presets["drag_weight"] = 0.0
        if tap_weight is not None or hold_weight is not None or flick_weight is not None or drag_weight is not None:
            presets = dict(presets)
            if tap_weight is not None: presets["tap_weight"] = float(tap_weight)
            if hold_weight is not None: presets["hold_weight"] = float(hold_weight)
            if flick_weight is not None: presets["flick_weight"] = float(flick_weight)
            if drag_weight is not None: presets["drag_weight"] = float(drag_weight)
            if hold_weight is not None and float(hold_weight) <= 0.01: presets["disable_hold"] = True
            if drag_weight is not None and float(drag_weight) <= 0.01: presets["disable_drag"] = True

        charter = Charter(
            points=result["points"],
            bpm=result["bpm"],
            ticks_per_beat=result["ticks_per_beat"],
            bands=audio["bands"],
            onset_norm=audio["onset_norm"],
            sections=audio["sections"],
            difficulty=presets,
            rms_norm=audio["rms_norm"],
            density_mult=float(density_mult),
        )
        notes = charter.generate()
        log.append(f"      {presets['label']} {presets['level']}: {len(notes)} notes")

        chart_id = f"{_safe_id(name)}_{tier}"
        ext = Path(audio_path).suffix.lower() or ".mp3" if audio_path else ".mp3"
        mp3_name = f"{chart_id}{ext}"
        img_name = f"{chart_id}.png"
        meta = {
            "id": chart_id,
            "name": name,
            "level": f"{presets['label']} {presets['level']}",
            "charter": charter_name,
            "composer": artist,
            "illustration": artist or "",
            "song": mp3_name,
            "background": img_name,
            "offset": int(round(float(result["offset_sec"]) * 1000.0)),
            "duration": float(result["duration_sec"]),
        }
        line_fx_cfg = _build_line_fx(line_fx, audio["sections"], pulse_style, deco_when,
                                     main_y, mix_spec, main_swing, sweep_flick_only)
        chart = build_chart_json(
            notes, bpm=result["bpm"], meta=meta,
            tempo_events=result["tempo_events"], ticks_per_beat=result["ticks_per_beat"],
            line_fx=line_fx_cfg,
        )
        pez_path = pack_pez(audio_path, str(outdir), chart, image_path=image_path)
        save_json(chart, str(outdir))
        results[tier] = str(pez_path)

    log.append(f"完成，耗时 {time.perf_counter() - started:.1f}s")
    return {"results": results, "log": "\n".join(log)}


def _finalize_outdir(outdir, audio_path):
    if outdir:
        d = Path(outdir)
    else:
        d = Path(__file__).parent / "output"
    d.mkdir(parents=True, exist_ok=True)
    return d


def generate(
    audio_path: str,
    difficulty: str = "hard",
    bpm: float = None,
    all_tiers: bool = False,
    image_path: str = None,
    title: str = None,
    artist: str = "",
    charter_name: str = None,
    outdir: str = None,
    density_mult: float = 1.0,
    line_fx: str = "none",
    pulse_style: str = "chain",
    deco_when: str = "intro_chorus",
    main_y: float = -300.0,
    mix_spec: str = "",
    key_mode: str = "auto",
    main_swing: bool = None,
    sweep_flick_only: bool = False,
    disable_drag: bool = False,
    tap_weight: float = None,
    hold_weight: float = None,
    flick_weight: float = None,
    drag_weight: float = None,
) -> dict:
    """从音频直接生成。"""
    from detector import detect_result
    from audio_analyze import analyze_audio
    audio_path = str(Path(audio_path))
    outdir = _finalize_outdir(outdir, audio_path)
    log = ["[1/3] 音频检测（节拍 / 音符起点）..."]
    result = detect_result(audio_path, bpm=bpm)
    log.append(f"      踩音 {len(result['points'])} 点 | bpm={result['bpm']:.2f} | "
               f"offset={result['offset_sec']:.3f}s | duration={result['duration_sec']:.1f}s")
    log.append("[2/3] 音频分段落 / 频段分析 ...")
    audio = analyze_audio(audio_path, bpm=result["bpm"], duration_sec=result["duration_sec"])
    name = (title or Path(audio_path).stem).strip()
    artist = artist or "Unknown"
    charter_name = charter_name or "audio2pez"
    out = _build_tiers(
        result, audio, audio_path=audio_path, name=name, artist=artist,
        charter_name=charter_name, image_path=image_path, outdir=outdir,
        difficulty=difficulty, all_tiers=all_tiers, key_mode=key_mode,
        disable_drag=disable_drag, tap_weight=tap_weight, hold_weight=hold_weight,
        flick_weight=flick_weight, drag_weight=drag_weight, density_mult=density_mult,
        line_fx=line_fx, pulse_style=pulse_style, deco_when=deco_when, main_y=main_y,
        mix_spec=mix_spec, main_swing=main_swing, sweep_flick_only=sweep_flick_only,
    )
    out["log"] = "\n".join(log + out["log"].splitlines())
    return out


def arrange(
    points_dict,
    audio_path: str = None,
    difficulty: str = "hard",
    bpm: float = None,
    all_tiers: bool = False,
    image_path: str = None,
    title: str = None,
    artist: str = "",
    charter_name: str = None,
    outdir: str = None,
    density_mult: float = 1.0,
    line_fx: str = "none",
    pulse_style: str = "chain",
    deco_when: str = "intro_chorus",
    main_y: float = -300.0,
    mix_spec: str = "",
    key_mode: str = "auto",
    main_swing: bool = None,
    sweep_flick_only: bool = False,
    disable_drag: bool = False,
    tap_weight: float = None,
    hold_weight: float = None,
    flick_weight: float = None,
    drag_weight: float = None,
) -> dict:
    """给定已踩音 points（dict 或 list），自动排布 notes 并打包 .pez。

    如果同时提供 audio_path，则用真实音频做频段/onset/段落分析（类型/选轨更准）；
    否则用 points 推断段落与能量（仍能排布，只是类型/轨道的音乐感弱一些）。
    """
    result = coerce_points_dict(points_dict, bpm=bpm)
    outdir = _finalize_outdir(outdir, audio_path)
    log = ["[1/3] 已提供踩音 points，跳过音频检测"]
    log.append(f"      {len(result['points'])} 点 | bpm={result['bpm']:.2f} | "
               f"offset={result['offset_sec']:.3f}s | duration={result['duration_sec']:.1f}s")
    if audio_path:
        from audio_analyze import analyze_audio
        log.append("[2/3] 音频分段落 / 频段分析 ...")
        audio = analyze_audio(audio_path, bpm=result["bpm"], duration_sec=result["duration_sec"])
    else:
        log.append("[2/3] 无音频，由 points 推断段落/能量 ...")
        audio = fallback_audio(result["points"], result["bpm"], result["duration_sec"])
    name = (title or (Path(audio_path).stem if audio_path else "chart")).strip()
    artist = artist or "Unknown"
    charter_name = charter_name or "audio2pez"
    out = _build_tiers(
        result, audio, audio_path=audio_path or "", name=name, artist=artist,
        charter_name=charter_name, image_path=image_path, outdir=outdir,
        difficulty=difficulty, all_tiers=all_tiers, key_mode=key_mode,
        disable_drag=disable_drag, tap_weight=tap_weight, hold_weight=hold_weight,
        flick_weight=flick_weight, drag_weight=drag_weight, density_mult=density_mult,
        line_fx=line_fx, pulse_style=pulse_style, deco_when=deco_when, main_y=main_y,
        mix_spec=mix_spec, main_swing=main_swing, sweep_flick_only=sweep_flick_only,
    )
    out["log"] = "\n".join(log + out["log"].splitlines())
    return out
