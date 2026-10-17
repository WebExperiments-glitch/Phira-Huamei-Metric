# 规则写谱（Rule Chart）v1.0

> 目标：**不用 AI 模型**，用可解释、可验证的规则生成 RPE v160 谱面，输出可直接导入 Phira 的 `.pez`。
> 代码：`public/js/rulechart.js`（浏览器/Node 通用，零运行时依赖）、`tools/rulechart.mjs`（CLI）、
> `phm/audio2pez`（上游 MIT 的二次修改版，支持 points 输入）。

## 1. 为什么不用 Rana

Rana 是 B 站作者「小百合-official」的 Transformer 踩音模型：72GB 训练集、支持 CPU，
目前主要覆盖邦烤；作者表示「按设定开源」但代码太杂、先只给模型，权重/使用走 QQ 群，
公开仓库与许可证暂时不明确。因此本项目的规则写谱**不依赖任何模型权重**。
如果以后拿到合规的 points 输出，可直接走 `phm/audio2pez --from-points`。

## 2. 输出格式

RPE v160 chart JSON：

```text
.pez (ZIP)
├── info.txt          # Name / Path / Song / Picture / Chart / Level / Composer / Charter
├── <id>.json         # RPE chart
├── audio.wav|mp3     # 用户音频；没有则生成 22050Hz click
└── background.png    # 1280x720 占位封面（stdlib PNG）
```

## 3. 硬规则（校验器逐条检查）

| # | 规则 | 参数 |
|---|---|---|
| R1 | 拍网格 | 4 / 8 / 16 分音符（按难度） |
| R2 | 起手留白 | 第一个 note ≥ **2 拍** |
| R3 | 收尾留白 | 最后一个 note 的 start ≤ 总拍数 − **1 拍** |
| R4 | 同轨最小间隔 | 见难度表 `minGap`（拍） |
| R5 | 同轨 Hold 不重叠 | 下一个 note 的 start ≥ 上一个 Hold 的 end |
| R6 | 和弦上限 | 同一时刻 ≤ `maxChord`（1–3） |
| R7 | 类型合法 | 1 Tap / 2 Hold / 3 Flick / 4 Drag |
| R8 | 轨道合法 | 2K/4K/6K 的固定 X 坐标 |
| R9 | Hold 长度 | 0.25–2 拍（预设列表），且 end > start |
| R10 | 可复现 | 同参数 + 同种子 → 逐字节相同 |
| R11 | 密度曲线 | intro 0.30 / verse 0.72 / chorus 1.08 / outro 0.62 × 难度密度 × 用户倍率 |
| R12 | 强拍和弦 | 仅 4 拍整数倍、概率 0.18×密度、换轨 |

## 4. 难度预设

| 难度 | 细分 | minGap（拍） | maxChord | 基础密度 | 类型权重（Tap/Hold/Flick/Drag） | 乐句模式 |
|---|---|---|---|---|---|---|
| EASY | 4 | 1.0 | 1 | 0.32 | 0.55 / 0.15 / 0.10 / 0.20 | alternate, flow |
| NORMAL | 4 | 0.5 | 2 | 0.52 | 0.48 / 0.16 / 0.14 / 0.22 | alternate, flow, stair |
| HARD | 8 | 0.5 | 2 | 0.72 | 0.40 / 0.18 / 0.18 / 0.24 | alternate, stair, flow, jump |
| EXPERT | 8 | 0.25 | 3 | 0.92 | 0.36 / 0.18 / 0.20 / 0.26 | alternate, stair, jump, stream |
| MASTER | 16 | 0.25 | 3 | 1.12 | 0.32 / 0.18 / 0.22 / 0.28 | alternate, stair, jump, stream, burst |

密度倍率可调 0.4–2.0；轨道 2K/4K/6K。

## 5. 校验与失败处理

`validateChart(chart)` 返回 `{ok, violations, metrics}`；页面/CLI 在下载前执行：

- 任何 violation → 页面隐藏下载按钮并显示前 3 条；CLI 仍输出 JSON 供排查；
- 通过时显示 `规则校验 0 违规（v1.0）`；
- 指标：notes、实际 NPS、实际 maxChord、实际最小同轨间隔、类型分布。

`tools/test-rulechart.mjs` 有 **20 条**断言，包含确定性与约束检查。

## 6. 相关调研

- GitHub [anikiphi/rephiraedit-audio2pez](https://github.com/anikiphi/rephiraedit-audio2pez)（MIT，本目录 `phm/audio2pez` 的上游）
- GitHub [sedthh/BeatLearning](https://github.com/sedthh/BeatLearning)（Apache-2.0，节奏游戏谱面生成模型）
- GitHub [3podi/audio2chart](https://github.com/3podi/audio2chart)、[OliBomby/Mapperatorinator](https://github.com/OliBomby/Mapperatorinator)
- 论文：*Beat-Aligned Spectrogram-to-Sequence Generation of Rhythm-Game Charts*（ISMIR 2023, arXiv:2311.13687）
- 论文：*audio2chart: End to End Audio Transcription into playable Guitar Hero charts*（arXiv:2511.03337）
- 论文：*ITGPT: A Transformer Based Architecture for the Generation of DDR/ITG Charts*（arXiv:2607.14148）
- 论文：*STRUM: Spectral Transcription and Rhythm Understanding Model*（arXiv:2605.12135）
- 论文：*GenerationMania: Learning to Semantically Choreograph*（AIIDE 2019）、*TaikoNation*（2021）

## 7. 已知边界

- 规则写谱保证**结构合法/可玩性下限**，不保证「好听」；音乐感来自拍点/段落，纯规则时是节拍 click。
- 只输出 RPE v160；Phira 其它格式/旧版本未覆盖。
- 音频检测仍走 audio2pez（librosa）；points 模式不依赖 librosa。
