# 自动写谱（MP3 → 规则谱面）v1.1

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

| 难度 | Level | 细分 | 同轨最小间隔（拍） | 和弦上限 | 轨道 | 保留下限 |
|---|---|---|---|---|---|---|
| EZ | EZ 7 | 4 | 1.0 | 1 | 4K | 0.52 |
| HD | HD 11 | 8 | 0.5 | 2 | 6K | 0.70 |
| IN | IN 14 | 8 | 0.25 | 3 | 6K | 0.84 |
| AT | AT 16 | 16 | 0.2 | 3 | 6K | 0.94 |

- 音符类型权重随难度变化（Tap / Hold / Flick / Drag）。
- 强拍（4 的整数倍）按概率加和弦，且必须换轨。
- 段落能量影响密度：intro 低、chorus 高；踩音强度越高越容易保留。

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
| R8 | 轨道只能是 4K/6K 的合法 X |
| R9 | Hold 长度 0.25–2 拍，且 end > start |
| R10 | 同一音频 + 同一难度 → 逐字节可复现 |
| R11 | 音符必须来自拍点/踩音点（允许按网格吸附） |
| R12 | lead-in / 收尾 / 重叠 / 和弦任一失败 → 禁止下载 |

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
- 规则保证结构合法与可玩性下限，不保证「好听」；质量取决于音频的拍点/能量。
- 只输出 RPE v160；Phira 其它格式未覆盖。
- `.pez` 建议在真 Phira 客户端导入验证一次；不同版本若有字段差异按报错修。
