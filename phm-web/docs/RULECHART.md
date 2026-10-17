# 自动写谱（MP3 → 规则谱面）v1.2

> 用户只做两件事：**导入 MP3**，选 **EZ / HD / IN / AT**。
> BPM、时长、拍点、踩音点、段落能量全部自动提取；生成 **.pez**（ZIP）或 **.zip**。
> 全程浏览器本地，音频不上传。

## 1. 输入与自动提取

页面：`/rulechart`；代码：`public/js/audio-analysis.js` + `public/js/rulechart.js`。

```text
MP3/WAV/OGG/FLAC/M4A
  → decodeAudioData（浏览器）
  → 单声道 22050Hz
  → STFT(1024/512) → 谱通量 onset envelope
  → 自相关估 BPM（60–200，折叠到 80–180）
  → 拍相位 + 拍点序列
  → 峰值踩音（time / strength）
  → RMS 分段（intro / verse / chorus / outro）
```

页面上直接显示：BPM、时长、拍点数、踩音点数、段落能量。**没有 BPM/时长/密度输入框。**

## 2. 难度（Phigros 式）

| 难度 | Level | 目标 NPS | 细分 | 同轨最小间隔 | 和弦上限 | 轨道 | 判定线 |
|---|---|---|---|---|---|---|---|
| EZ | EZ 7 | 3.6 | 4 | 1.0 拍 | 2 | 4K | 1 主 + 3 装饰 |
| HD | HD 11 | 5.2 | 8 | 0.5 拍 | 2 | 6K | 1 主 + 3 装饰 |
| IN | IN 14 | 7.8 | 8 | 0.25 拍 | 3 | 7K | 1 主 + 3 装饰 |
| AT | AT 16 | 11.0 | 16 | 0.2 拍 | 3 | 7K | 1 主 + 3 装饰 |

- 类型权重按真实谱面统计：Tap ~55%、Drag ~25%、Hold ~10–12%、Flick ~6–8%（不再让 Flick 在高难度反超 Tap）。
- 段落能量决定密度：intro 低、chorus 高；踩音强度越高越优先保留。
- 强拍（4 的整数倍）按概率加和弦，且必须换轨。
- 生成后按目标 NPS 补齐/收敛，避免 EZ 过空、AT 过稀。

### 2.1 依据：9,684 张真实 Phira 谱面

从 `data/community.jsonl` 统计（按难度分段）：

| 难度段 | 中位 NPS | 中位物量 | 中位判定线数 | Tap / Hold / Flick / Drag |
|---|---|---|---|---|
| 7–10 | 4.07 | 614 | 24 | 48.1 / 9.0 / 7.7 / 35.3 |
| 10–13 | 4.64 | 641 | 24 | 49.6 / 10.9 / 6.6 / 32.9 |
| 13–15 | 5.93 | 832 | 25 | 54.4 / 13.4 / 8.1 / 24.0 |
| 15–17 | 8.49 | 1220 | 28 | 57.3 / 10.9 / 6.7 / 25.1 |
| 17+ | 12.11 | 1833 | 30 | 61.7 / 11.2 / 5.1 / 22.0 |

这组数据直接决定了：类型权重、目标 NPS、以及「必须有多条判定线/动效」而不是一根静止的线。

## 3. 硬规则（下载前逐条校验）

| # | 规则 |
|---|---|
| R1 | 拍网格按难度细分（4/8/16 分音符） |
| R2 | 第一个 note ≥ 2 拍（lead-in） |
| R3 | 最后一个 note 的 start ≤ 总拍数 − 1 拍 |
| R4 | 同轨最小间隔 = 难度 `minGap` |
| R5 | 同轨 Hold 与下一个 note 不重叠 |
| R6 | 同一时刻 ≤ `maxChord` 个音符 |
| R7 | 类型只能是 Tap/Hold/Flick/Drag |
| R8 | 轨道只能是 4K/6K/7K 的合法 X（7K 含中心 0） |
| R9 | Hold 长度 0.25–2 拍，且 end > start |
| R10 | 同一音频 + 同一难度 → 逐字节可复现 |
| R11 | 音符必须来自拍点/踩音点（允许按网格吸附） |
| R12 | lead-in / 收尾 / 重叠 / 和弦任一失败 → 禁止下载 |
| R13 | `META.offset` 必须是整数（Phira/RPE 解析要求 i32；本项目固定 0） |
| R14 | 主判定线有 moveX/moveY/rotate/alpha 事件；另有 3 条装饰线 |
| R15 | 补位只使用非 Hold，且不会落入已有 Hold 区间 |

`validateChart(chart)` 返回 `{ok, violations, metrics}`；页面在生成后、显示下载前执行。
失败时隐藏下载按钮并显示前 3 条违规。

## 4. 输出

```text
<id>.pez   # 本身就是 ZIP（Phira 直接导入）
<id>.zip   # 同一份 ZIP，方便解压检查
<id>.json  # 单独 chart JSON
```

ZIP 内容：

```text
info.txt
<id>.json
audio.<ext>        # 用户导入的原音频
background.png     # 1280×720 占位封面（stdlib PNG）
```

## 5. 不用 Rana / 不接模型

Rana 是 B 站「小百合-official」的 Transformer 踩音模型：作者说「按设定开源」但代码未公开、
权重走 QQ 群、许可证不明确，因此本项目不集成。若以后有合规的踩音 points 输出，
可以用 `phm/audio2pez --from-points notes.json` 走另一条规则排谱路径。

## 6. 调研与参考

- [anikiphi/rephiraedit-audio2pez](https://github.com/anikiphi/rephiraedit-audio2pez)（MIT，本项目的 `phm/audio2pez` 上游）
- [sedthh/BeatLearning](https://github.com/sedthh/BeatLearning)（Apache-2.0）
- [3podi/audio2chart](https://github.com/3podi/audio2chart)
- [OliBomby/Mapperatorinator](https://github.com/OliBomby/Mapperatorinator)
- *Beat-Aligned Spectrogram-to-Sequence Generation of Rhythm-Game Charts*（ISMIR 2023, arXiv:2311.13687）
- *audio2chart*（arXiv:2511.03337）
- *ITGPT*（arXiv:2607.14148）
- *STRUM*（arXiv:2605.12135）

## 7. 已知边界

- BPM/拍点来自通用谱通量 + 自相关，复杂曲风可能偏 1–2 BPM；页面会显示实际提取值。
- 判定线动效是规则化的（段落级 move/rotate/alpha），不是逐帧手工编排；视觉复杂度和真实谱面仍有差距。
- 规则保证结构合法与可玩性下限，不保证「好听」；质量取决于音频的拍点/能量。
- 只输出 RPE v160；Phira 其它格式未覆盖。
- `.pez` 建议在真 Phira 客户端导入验证一次；不同版本若有字段差异按报错修。
