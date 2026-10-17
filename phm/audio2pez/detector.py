# -*- coding: utf-8 -*-
"""基于 librosa 的音符/节拍检测，替代外部踩音模型。

返回结构与外部模型一致：points/BPM/tempo 等，供 charter 消费。
不依赖任何神经网络或外部服务，因此完全离线、无隐私/授权问题。
"""

import os
import numpy as np
import librosa

from config import SAMPLE_RATE, HOP_LENGTH

TICKS_PER_BEAT = 480


def load_audio(path: str):
    y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return y, sr


def detect_bpm(y, sr) -> float:
    try:
        bpm, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(bpm)[0])
    except Exception:
        bpm = 120.0
    if not np.isfinite(bpm) or bpm <= 0:
        bpm = 120.0
    return float(bpm)


def detect_beats(y, sr, bpm) -> np.ndarray:
    try:
        _, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=bpm, tightness=100)
        return librosa.frames_to_time(beats, sr=sr)
    except Exception:
        return np.array([], dtype=float)


def detect_onsets(y, sr):
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    frames = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP_LENGTH,
        delta=0.08,
        wait=HOP_LENGTH // 128,
        pre_max=3,
        post_max=3,
        pre_avg=3,
        post_avg=5,
    )
    times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP_LENGTH)
    return times, onset_env


def _normalize(env) -> np.ndarray:
    e = np.asarray(env, dtype=float)
    m = float(e.max()) if e.size else 0.0
    return e / max(m, 1e-3)


def detect_result(audio_path: str, bpm: float | None = None) -> dict:
    """返回与外部踩音模型结果字典一致的结构。"""
    y, sr = load_audio(audio_path)
    duration_sec = float(len(y) / sr)
    if bpm is None:
        bpm = detect_bpm(y, sr)
    beat_times = detect_beats(y, sr, bpm)
    onset_times, onset_env = detect_onsets(y, sr)
    onset_norm = _normalize(onset_env)

    # 若无 onset，则退回用 beats 作为候选时序
    times = onset_times if onset_times.size else beat_times

    points = []
    for t in times:
        t = float(t)
        if t < 0:
            continue
        frame = int(t * sr / HOP_LENGTH)
        prob = float(onset_norm[min(frame, len(onset_norm) - 1)]) if onset_norm.size else 0.3
        beat_f = t * bpm / 60.0
        tick = int(round(beat_f * TICKS_PER_BEAT))
        beat = tick / TICKS_PER_BEAT
        points.append({
            "time_sec": t,
            "beat": beat,
            "beat_tick": tick,
            "probability": max(0.05, min(1.0, prob)),
            "snap_status": 1,
        })

    offset_sec = float(beat_times[0]) if beat_times.size else 0.0
    return {
        "bpm": float(bpm),
        "bpm_changes": [],
        "tempo_events": [{"beat_tick": 0, "bpm": float(bpm)}],
        "offset_sec": offset_sec,
        "ticks_per_beat": TICKS_PER_BEAT,
        "duration_sec": duration_sec,
        "audio_name": os.path.splitext(os.path.basename(str(audio_path)))[0],
        "game": "auto",
        "difficulty": 0,
        "model_name": "librosa",
        "threshold": 0.08,
        "points": points,
    }
