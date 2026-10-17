# P.H.M. 二次修改说明

上游：[anikiphi/rephiraedit-audio2pez](https://github.com/anikiphi/rephiraedit-audio2pez)（MIT）。

本目录是在上游基础上的**二次修改版**，用于接「踩音 points」：

## 改动

1. **points 模式去掉 librosa 硬依赖**
   - `generate.py` 把 `numpy` / `detector` / `audio_analyze` 改为按需导入。
   - 只跑 `--from-points` 时只需要 `numpy`；不安装 librosa 也能生成。
   - 只有提供音频、走 `python main.py song.mp3` 时才需要 librosa。
2. **封面改纯 stdlib PNG**
   - `packager._placeholder_png()` 用 `zlib + struct` 直接生成 1280×720 PNG，不再强制 Pillow。
   - `Pillow` 变成可选：有就用它转用户封面，没有就回退占位图。
3. **无音频时自动生成 click 音轨**
   - 只给 points、不给音频时，`packager.pack_pez()` 会生成 `audio.wav`（22050Hz 节拍 click），
     保证 .pez 能被 Phira 导入试听；正式发布请换成原曲。
4. **移除了 Gradio webui**
   - 本目录只保留 CLI；网页端用 P.H.M. 的 `/rulechart` 或外部工具。
5. **依赖改为可选**
   - `requirements.txt` 默认只装 numpy；librosa / Pillow 注释掉。

## 用法

```bash
# 只需要 numpy
python main.py --from-points notes.json --name "My Song" --difficulty hard

# 有音频时（需要 librosa）
python main.py song.mp3 --difficulty expert

# 一次输出五档
python main.py --from-points notes.json --all-tiers
```

points JSON（与上游/Rana 输出兼容）：

```json
{
  "bpm": 128,
  "ticks_per_beat": 480,
  "duration_sec": 30,
  "points": [{"time_sec": 0.5}, {"time_sec": 1.0, "probability": 0.8}]
}
```
