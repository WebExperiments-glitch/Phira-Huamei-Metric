# -*- coding: utf-8 -*-
"""音频分析：频段能量 / onset 包络 / RMS 分段。BPM 由检测模块提供，此处不重复测速。"""

import numpy as np
import librosa

from config import (
    SAMPLE_RATE, HOP_LENGTH,
    BAND_LOW, BAND_MID, BAND_HIGH,
    SECTION_WINDOW, DENSITY_LOW, DENSITY_MID, DENSITY_HIGH,
)


def load_audio(path: str) -> tuple[np.ndarray, float]:
    y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return y, sr


def get_dominant_band(bands: dict, frame_idx: int) -> str:
    values = {k: v[min(frame_idx, len(v) - 1)] for k, v in bands.items()}
    return max(values, key=values.get)


def analyze_audio(path: str, bpm: float, duration_sec: float) -> dict:
    """返回 dict: y / onset_norm / bands / rms / times / sections。"""
    y, sr = load_audio(path)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    env_max = float(onset_env.max()) if len(onset_env) else 1.0
    onset_norm = onset_env / max(env_max, 0.001)

    stft = np.abs(librosa.stft(y, hop_length=HOP_LENGTH))
    freqs = librosa.fft_frequencies(sr=sr)

    def band_energy(lo, hi):
        mask = (freqs >= lo) & (freqs < hi)
        return np.mean(stft[mask], axis=0)

    bands = {
        "low": band_energy(*BAND_LOW),
        "mid": band_energy(*BAND_MID),
        "high": band_energy(*BAND_HIGH),
    }

    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
    rms_max = float(rms.max()) if len(rms) else 1.0
    rms_norm = (rms / max(rms_max, 0.001)).astype(float)
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=HOP_LENGTH)

    sections = _detect_sections(rms, times, duration_sec, bpm)
    return {
        "y": y, "sr": sr, "onset_norm": onset_norm,
        "bands": bands, "rms": rms, "rms_norm": rms_norm, "times": times, "sections": sections,
    }


def _detect_sections(rms, times, duration_sec: float, bpm: float) -> list:
    """按拍数窗口把歌曲分成 intro/verse/chorus，返回含密度信息的段落列表。"""
    if bpm <= 0:
        bpm = 120.0
    window_sec = SECTION_WINDOW * 60.0 / bpm
    n = max(1, int(duration_sec / window_sec))
    median = float(np.median(rms)) if len(rms) else 0.0
    sections = []

    for i in range(n):
        start_t = i * window_sec
        end_t = min((i + 1) * window_sec, duration_sec)
        mask = (times >= start_t) & (times < end_t)
        avg = float(np.mean(rms[mask])) if mask.any() else 0.0

        if median > 0 and avg < median * 0.6:
            label = "intro/break"
            density = DENSITY_LOW
        elif median > 0 and avg < median * 1.3:
            label = "verse"
            density = DENSITY_MID
        else:
            label = "chorus"
            density = DENSITY_HIGH

        sections.append({
            "start_time": start_t,
            "end_time": end_t,
            "label": label,
            "density": density,
        })

    return sections