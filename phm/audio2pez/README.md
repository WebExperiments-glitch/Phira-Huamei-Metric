# P.H.M. 二次修改版（audio2pez fork）

> 上游：`anikiphi/rephiraedit-audio2pez`（MIT）。本目录做了 points 模式去 librosa、stdlib 封面、
> 无音频 click 音轨、移除 Gradio 等修改，详见 [PATCHES.md](PATCHES.md)。

﻿# audio2pez — 音频转 PhiraEdit 谱面生成器

把任意音频文件（.mp3 / .wav / .ogg / .flac）自动分析并生成 RPE (Re:PhiEdit) 格式的 Phira 谱面（.pez）。
只依赖 librosa / numpy 等通用音频库，完全离线运行。

## 特性

- **自动踩音/节拍检测**：基于 librosa 的 BPM、节拍、Onset 检测生成音符时序。
- **难度分级**：EASY / NORMAL / HARD / EXPERT / MASTER 五档，可单档或一次输出全部。
- **音乐情绪编排**：按段落（intro/主歌/副歌/过门）分配乐句母题，重复副歌自动“递进加码”。
- **音符类型**：Tap / Hold / Flick / Drag 由频段与 onset 强度驱动。
- **判定线动效（Line FX）**：alpha 脉冲、风车、网格、曲线轨迹、变色流、光晕、弹跳、聚光、回音残影、主线摆动/抬升等。
- **打包**：生成 RPE v160 chart JSON 并打包成可直接导入 Phira 的 `.pez`（含 MP3、封面、info.txt）。

## 环境依赖

- Python 3.10+
- librosa
- numpy
- Pillow

```bash
pip install librosa numpy Pillow
```

> 可选：`pip install gradio` 以启用 `webui.py` 网页界面。

## 快速开始

```bash
# 最简单：自动检测 BPM 并生成 hard 难度
python main.py song.mp3

# 指定难度 / 覆盖元数据
python main.py song.mp3 --difficulty expert --name "My Song" --artist "Someone" --charter "MyName"

# 一次输出全部 5 档
python main.py song.mp3 --all-tiers

# 指定轨道数 / 判定线动效
python main.py song.mp3 --key 4k --line-fx mix

# 仅检测 BPM（不生成谱面）
python main.py song.mp3 --bpm-only
```

## 命令行参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `input` | 位置参数 | 必填 | 输入音频文件路径 |
| `--difficulty` | str | `hard` | `easy/normal/hard/expert/master` |
| `--all-tiers` | flag | — | 一次输出全部 5 档 |
| `--name` | str | 文件名 | 谱面名称 / 曲名 |
| `--artist` | str | `Unknown` | 曲师 |
| `--charter` | str | `audio2pez` | 谱师名 |
| `--cover` | str | — | 封面图片路径 |
| `--key` | str | `auto` | `auto/2k/4k/6k` 判定线轨道数 |
| `--line-fx` | str | `none` | 判定线动效 |
| `--density` | float | `1.0` | 写谱密度 / 难度倍率（0.7~1.6） |
| `--outdir` | str | `output` | 输出目录 |

此外可用 `--tap-weight / --hold-weight / --flick-weight / --drag-weight` 覆盖各难度音符类型权重。

## 从踩音 points 排布（无需音频检测）

如果你已经有“踩音”之后的音符时序（例如来自其它工具或外部模型），可以跳过音频检测，直接让 charter 自动排布 notes 并打包。
（关于这点，我个人推荐Rana踩音模型，详见：
【Ai也能给音游踩音？全音游通用！玩游戏不求人】 https://www.bilibili.com/video/BV12PNG6dEtW ）

```bash
# 仅用 points 排布
python main.py --from-points notes.json

# 同时提供音频，让音符类型/轨道/段落更贴合音乐
python main.py --from-points notes.json song.mp3
```

points JSON 结构（与 `detector.py` 输出一致）：

```json
{
  "bpm": 128.0,
  "ticks_per_beat": 480,
  "tempo_events": [{"beat_tick": 0, "bpm": 128.0}],
  "offset_sec": 0.0,
  "duration_sec": 20.0,
  "points": [
    {"time_sec": 0.5, "beat": 1.0, "beat_tick": 480, "probability": 0.8, "snap_status": 1}
  ]
}
```

- `points` 允许只给 `time_sec`（会自动按 `bpm` 换算成 `beat`/`beat_tick`）。
- 无音频时，`charter` 会用 points 密度推断段落、用 probability 推断能量；类型/选轨的音乐感弱一些，但仍能排布出可玩谱面。
- 提供 `song.mp3` 作第二参数时，走完整音频分析（频段 / onset / 段落），类型与轨道更准确。

## 工作流程

```
[音频] ──detector(librosa)──▶ [points / BPM]
      ──audio_analyze──▶ [频段能量 / onset / 分段]
      ──charter 难度分级──▶ [EASY/NORMAL/HARD/EXPERT/MASTER]
      ──packager──▶ [Phira .pez]
```

- `detector.py`：librosa 检测 BPM、节拍、Onset，输出与外部踩音模型一致的数据结构。
- `audio_analyze.py`：频段能量 / onset 包络 / RMS 分段（intro/verse/chorus）。
- `charter.py`：按难度下限 + 最小间距选点，做音符类型分类、频段选轨、乐句母题与谱型排布。
- `packager.py`：生成 RPE v160 chart 并打包 `.pez`，谱面 ID 自动转成纯 ASCII 文件夹安全名。
- `line_fx.py`：判定线动效与装饰覆盖线。

## 输出

生成的文件位于 `output/` 目录：

```
output/
├── <谱面ID>.pez   ← 可直接导入 Phira 的谱面包
└── <谱面ID>.json  ← 单独谱面 JSON（便于调试）
```

## 封面图片

如果指定了 `--cover`，会自动转成 PNG 打包；否则生成 1280x720 深色占位图，避免“no picture”。

## 判定线坐标注意

- 判定线锚点在屏幕中心，`X∈[-675,675]`、`Y∈[-450,450]`。
- 装饰/动效线用 `isCover=True + isFake=1`（假音符不判定），保证渲染且不干扰计分。
- alpha 全部用 `0~255`，不出现负值；需要“默认透明、只在事件时发光”的线会在首段前加前导 0 段。

## 2026/8/27
- 重载了原本的排谱逻辑。

## 授权

本项目基于 MIT 许可证发布，详见 `LICENSE`。
