# 自动写谱（MP3 → 规则谱面）v1.4

> 用户只做一件事：**导入 MP3**。难度由系统判定，用户不能手动选择。
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
  → 60–200 BPM 网格搜索 + 半拍/IOI 中位数修正（避免 190 被误判成 152/95）
  → 分频段：低频 kick / 高频噪声 + 谱平坦度 → 鼓点
  → 中频谐波 + 低平坦度 → 钢琴/旋律点
  → 峰值踩音（time / strength）
  → RMS 分段（intro / verse / chorus / outro）
```

页面上直接显示：BPM、时长、拍点数、总踩音点、**鼓点**、**钢琴点**、段落能量。**没有 BPM/时长/密度输入框。**

排谱时：钢琴点不少于鼓点 80% → 用钢琴点；否则用鼓点；两者都没有才回退总 onset。

## 2. 2K 的含义：2 指可打，不是 2 条固定轨道

2K 指“最多两根手指可以完成”。参照 `_research/refs/pont`（charter: RuleEngine）：
**1 条判定线、5 个 x 位置（±405/±202.5/0）、一次一个、无和弦**。

## 3. 节奏：onset 先吸附拍网格

原始频谱峰值不等于“拍点”。生成前先把 onset 吸附到检测到的拍网格：

- EZ：1/4 拍
- HD / IN：1/8 拍
- AT：1/16 拍

然后再按拍点/onset 时间排谱，避免「听起来不在拍上」。

## 4. 难度由系统判定（用户不可选）

`detectDifficulty(analysis)` 用音频特征估算“潜力 NPS”：

```text
potential = onsetRate×1.55 + energy×1.8 + avgCentroid×0.8
          + avgStrength×0.9 + BPM偏离×0.8 + 0.6
```

判档阈值（按 Pont IN13 / 诀别书 IN11.8 校准）：`<4.0 EZ / <4.75 HD / <5.8 IN / ≥5.8 AT`。
目标 NPS：EZ 3.6 / HD 4.4 / IN 4.9 / AT 6.1。
页面只显示「系统判定：IN 14 · 潜力 6.5 NPS（踩音 2.9/s · BPM 120.2）」，
**没有难度按钮**。这样避免用户随意选一个不匹配音频的难度。

### 2.1 预设（系统内部使用）

| 难度 | Level | 目标 NPS | 细分 | 同轨最小间隔 | 和弦上限 | 轨道 | 判定线 |
|---|---|---|---|---|---|---|---|
| EZ | EZ 7 | ~3.6 | 4 | 0.25 拍 | 1 | 5 个 x | 1 主 |
| HD | HD 11 | ~4.4 | 4 | 0.25 拍 | 1 | 5 个 x | 1 主 |
| IN | IN 14 | ~4.9 | 4 | 0.25 拍 | 1 | 5 个 x | 1 主 |
| AT | AT 16 | ~6.1 | 4 | 0.25 拍 | 1 | 5 个 x | 1 主 |

- 参照 RuleEngine：Tap 74% / Hold 11.5% / Drag 14.5% / **Flick 0%**；Hold 长度 0.75/1/1.5 拍。
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
难度选择也由这组 NPS 区间反推，而不是让用户凭感觉选。

## 5. 硬规则（下载前逐条校验）

| # | 规则 |
|---|---|
| R1 | 拍网格按难度细分（4/8/16 分音符） |
| R2 | 第一个 note ≥ 2 拍（lead-in） |
| R3 | 最后一个 note 的 start ≤ 总拍数 − 1 拍 |
| R4 | 同轨最小间隔 = 难度 `minGap` |
| R5 | 同轨 Hold 与下一个 note 不重叠 |
| R6 | 同一时刻 ≤ `maxChord` 个音符 |
| R7 | 只允许 Tap / Hold / Drag（无 Flick） |
| R8 | 2 指可打；5 个 x 位置；同一时刻最多 1 个 note |
| R9 | Hold 长度 0.25–2 拍，且 end > start |
| R10 | 同一音频 + 同一难度 → 逐字节可复现 |
| R11 | 音符必须来自拍点/踩音点（允许按网格吸附） |
| R12 | lead-in / 收尾 / 重叠 / 和弦任一失败 → 禁止下载 |
| R13 | `META.offset` 必须是整数（Phira/RPE 解析要求 i32；本项目固定 0） |
| R14 | 只有一条主判定线（无装饰线、无段落动效） |
| R15 | 补位只使用非 Hold，且不会落入已有 Hold 区间 |

`validateChart(chart)` 返回 `{ok, violations, metrics}`；页面在生成后、显示下载前执行。
失败时隐藏下载按钮并显示前 3 条违规。

## 6. 输出

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

## 7. 不用 Rana / 不接模型

Rana 是 B 站「小百合-official」的 Transformer 踩音模型：作者说「按设定开源」但代码未公开、
权重走 QQ 群、许可证不明确，因此本项目不集成。若以后有合规的踩音 points 输出，
可以用 `phm/audio2pez --from-points notes.json` 走另一条规则排谱路径。

## 8. 调研与参考

- [HorieYuuka/BMS-Generator](https://horieyuuka.github.io/BMS-Generator) —— **规则写谱**管线：band quota、频谱重心选轨、per-measure 确定性 RNG、17 点 conformance；本项目借鉴了重心选轨与确定性/校验思路。
- [anikiphi/rephiraedit-audio2pez](https://github.com/anikiphi/rephiraedit-audio2pez)（MIT，本项目的 `phm/audio2pez` 上游）
- [sedthh/BeatLearning](https://github.com/sedthh/BeatLearning)（Apache-2.0）
- [3podi/audio2chart](https://github.com/3podi/audio2chart)
- [OliBomby/Mapperatorinator](https://github.com/OliBomby/Mapperatorinator)
- *Beat-Aligned Spectrogram-to-Sequence Generation of Rhythm-Game Charts*（ISMIR 2023, arXiv:2311.13687）
- *audio2chart*（arXiv:2511.03337）
- *ITGPT*（arXiv:2607.14148）
- *STRUM*（arXiv:2605.12135）

## 9. 已知边界

- BPM/拍点来自通用谱通量 + 自相关，复杂曲风可能偏 1–2 BPM；页面会显示实际提取值。
- 判定线动效是规则化的（段落级 move/rotate/alpha），不是逐帧手工编排；视觉复杂度和真实谱面仍有差距。
- 规则保证结构合法与可玩性下限，不保证「好听」；质量取决于音频的拍点/能量。
- 只输出 RPE v160；Phira 其它格式未覆盖。
- `.pez` 建议在真 Phira 客户端导入验证一次；不同版本若有字段差异按报错修。
