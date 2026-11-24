# press 口径节奏特征 A/B（负面结果）

> 2026-11-24 · 一次「拆竞品拆出自己问题」的验证
> 结论：**无显著差异，不采用。** 代码未进产品，只留脚本与本文。

---

## 一、假设从哪来

拆 `pde-src`（`phigros_difficulty_estimator_re`）时发现，它在 `features.py:96-106`
明确要求：

> Drag / Flick 不吃按键，假音符已在解析阶段剔除，因此密度、多押、手部、位移、
> **节奏**全部建立在同一条 press 时间线上。

回查我们 `engine.js`，发现口径不一致：

| 特征 | 音符口径 | 判定 |
|---|---|---|
| `real_core_notes_per_second` / `above_avg_density_*` / `eff_peak_tps_1s` | Tap + Hold（`types===1\|\|2`） | ✅ |
| `iv_mean` / `iv_median` / `chord_ratio` / `fast_ratio` | **全部音符（含 drag/flick）** | ❌ |

`engine.js:791` 调用的是 `rhythmFeatures(ts)`，`ts` 是全量时间轴。

**推测的影响**：drag 密集的「水流型」谱面会被虚高 `chord_ratio`、压小 `iv_mean`，
从而被高估难度。

---

## 二、方法

| 项 | 做法 |
|---|---|
| 样本 | 从 `data/charts-archive.tar.gz` 分层抽 **1,200 张**（按 charter，组内最多 3 张） |
| 标签清洗 | 只保留定数 ∈ (1, 20)；剔除 **180 条**越界（最大值出现过 2024 —— 年份被当成定数） |
| 特征 | 用 `engine.reportFromChart` 提，保证与线上同源（不是平行实现） |
| 格式 | 支持 JSON + PEC；**1200/1200 全部解析成功** |
| 模型 | `StandardScaler + Ridge(alpha=3)`，与线上 `fit_v2` 同款 |
| 预处理 | `log1p(clip(v,0))`，与 `engine.js` 的 `ridgeBeta` 一致 |
| 切分 | **按 charter 分组 5 折**（防谱师泄漏，不是随机 KFold） |
| 判据 | 配对 bootstrap 10,000 次，看 ΔMAE 的 95% CI 是否跨 0 |

对照组：基线 39 维（现有全部特征）→ 实验 43 维（+ `press_iv_mean`、
`press_iv_median`、`press_chord_ratio`、`press_fast_ratio`）。

---

## 三、结果

```
样本 1200 张 · 基线 39 维 → 实验 43 维 · 按谱师分组 5 折

            MAE      中位     p90      偏差
基线      0.8683   0.5190   1.5670   +0.0057
实验      0.8758   0.5190   1.5522   +0.0014

ΔMAE（实验 − 基线，负=更好）
  点估计 +0.0075   95%CI [-0.0053, +0.0212]
  实验更好的重采样占比 12.7%
  → 无显著差异（CI 跨 0）
```

分档：

| 定数段 | n | ΔMAE |
|---|---:|---:|
| 1 – 12 | 69 | −0.0132 |
| 12 – 14 | 152 | +0.0117 |
| 14 – 15.5 | 472 | +0.0059 |
| 15.5 – 17 | 395 | +0.0068 |
| 17 – 21 | 112 | +0.0240 |

**点估计偏向略差，且只有 12.7% 的重采样认为它更好。**

按 `AGENTS.md` 硬约束 4：CI 跨 0，**只能写「无显著差异」，不许写「有提升趋势」**。

---

## 四、为什么没用（推测，未单独验证）

1. **信息冗余**：`press_iv_mean` 与已有的 `real_core_notes_per_second` 高度相关
   （都是 press 密度的一阶描述）。Ridge 拿到新维度后只是把权重重新分配，
   net 增益接近 0。
2. **drag 的密集本身就携带难度信号**：虽然 drag 不吃按键，但「大量 drag 密集出现」
   往往伴随读谱压力。全音符口径统计到的这一部分，可能**恰好是真实信号**而非噪声。
3. **样本量与效应量**：ΔMAE 0.0075 远小于本项目的噪声地板（n≈1000 时 SE≈0.031
   是 ρ 的口径，但 MAE 的 CI 半宽也有 0.013）。这个量级的效应在本样本下无法分辨。

第 2 条最值得注意：**「口径更纯」不等于「信号更好」**。理论优雅和实测有用是两件事。

---

## 五、工程处理

- `engine.js` 的 `press_*` 字段**已回滚**，只在 `out.real_core_notes_per_second` 行尾
  留了一句指针注释。理由：实测无增益的特征不该进产品，否则会变成
  「看起来更严谨、实际更慢」的负担。
- 引擎金标 `golden-engine.mjs` 校验通过（`com-ridge37-v1.1.0` 输出未变）。
- `engine.js` 899 行（上限 900）。

---

## 六、复现

```bash
# 1) 抽样本（约 3 GB，写到 tmp/pde-sample/）
python tools/ab_press_sample.py --n 1200

# 2) 提特征（用引擎本体，含 press_* 需要 engine.js 曾加过那 4 个字段）
node tools/ab_press_feats.mjs

# 3) A/B
"C:/Users/30500/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  tools/ab_press_test.py
```

⚠ 第 2 步依赖 `engine.js` 里的 `press_*` 字段，该字段已回滚。
要复现需先 `git show 3be88e6:phm-web/public/js/engine.js` 对照，或按本文
§二 的定义重新加回（4 个字段：press_iv_mean / press_iv_median /
press_chord_ratio / press_fast_ratio，均基于 `coreT` 时间轴计算）。
