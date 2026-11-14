# PhiraiAd 源码调研

> **调研对象**：`https://github.com/Adai-add/PhiraiAd`（Phira 的改版客户端，GPL-3.0），重点是 `phira/src/ai_model/` 与 `phira/src/ai_service.rs`。
> **快照**：main 分支 2026-11-04 抓取。**无法记录 commit sha**（`api.github.com` / `raw.githubusercontent.com` / `github.com` 在本机全部不可达，git 的 `insteadOf` 镜像 `gh.zwy.one` 返回 504；最终走 `codeload.github.com` 与 `cdn.jsdelivr.net`）。因此引用以**文件路径 + 函数名**为准，行号只是定位提示，可能随版本漂移。
> **验证强度**：`network.rs` 的前向过程我用 numpy 逐算子重写并跑通（`tests/ai-vectors/exact_block.features.json` → 15.4708904，期望 15.4708900，差 3.5e-7）。所以模型结构这一节是**读通并复现过**的，不是猜的。
> **对照组**：我们线上的 v3 引擎（`phm-web/public/js/engine-v3.mjs`，20 维事件 → 142 池化 → 岭回归 → IRT b）。

---

## 一句话结论

**他们的模型不值得抄，他们的特征口径值得抄一半。**

- 模型：27,713 参数/折 × 5 折，训练集只有 **373 张谱**（参数:样本 = 74:1），标签是**人工定数**而不是玩家实测。这是我们 2026-11 已用 69k SSM 验证过"深度模型不显著"之后，更不该回头走的路。
- 特征：他们 17 个事件维里，**跳跃距离 / 跳跃速度 / 三连音夹角 / running strain 一个都没有** —— 这恰好是我们 v2→v3 涨 0.03 的全部来源。反过来，他们有 4 类我们完全没有、且方向正确的量，全部指向同一件事：**判定线运动**（屏幕坐标、0.15s 位移、旋转速度、流速）。
- 最值得抄的一件：**把所有"移动"类特征从 `positionX` 改到判定线运动后的屏幕坐标上算**。这正是 `docs/调研/难度特征目录.md` 里标的 P0，他们的 `features.rs::Line::point` + `ai_chart_adapter.rs::geometry` 是一份可对照的参考实现。

---

## 1. 模型

他们导出的是**自定义张量格式**（`format: "phira-events-stats-f32-1"`，metadata 里保留了 `source_checkpoint_sha256`，说明源头是 PyTorch 检查点，但训练代码没公开），推理用纯 Rust 手写、无 ONNX / 无 tch / 无 BLAS（`network.rs` 全文只有 `Vec<f32>` 和 `chunks_exact`）。

### 1.1 结构（`network.rs::Model::predict`，已复现验证）

```
每个音符  17 维 ──► note_encoder 17→32→32 (ReLU)
                   │
每个同刻组 ─► 组内 mean(32) ‖ max(32) ‖ group_features(6) = 70 ──► group_encoder 70→32
                   │
每 32 组一块 ─► 1 层 4 头 Transformer（32 维，FFN 64，pre-norm），
               **窗口向左右各多取 4 个组做上下文**，但只对块内 32 个 token 做池化
                   │
             块内 mean(32) ‖ max(32) = 64 ──► block_projection 64→32
                   │
              1 层 GRU(32) 顺序扫块 ──► state(32)
                   │
      ┌────────────┴─────────────┬───────────────────────┐
 duration 加权 mean(32)      max(32)              2 路 attention 池化(各 32)
      └────────────┬─────────────┴───────────────────────┘
              concat = 160 ──► head.0 160→32 ─┐
                                              ├─ 相加 ─► ReLU ─► head.3 32→1 = 定数
      stats(18) ──► stats_projection 18→32 ──┘
```

关键细节（都在 `network.rs`，我复现时逐条对过）：

| 细节 | 位置 | 说明 |
|---|---|---|
| 注意力有**块内 + 上下文** | `predict` 循环 `left/right` | 窗口 40 个 token 参与 attention，只对中间 32 个做 pool。相当于 1 层滑窗注意力，不是全序列注意力 |
| attention 池化的 logits 加了 `ln(duration)` | `*v += durations[i].max(1e-12).ln()` | 让"长块"天然拿到更高权重，等于把时长当先验 |
| 池化用了 5 路 | mean(duration 加权) / max / GRU state / 2 路 attention | 比我们 7 个分位数更"结构化"，但参数量也上去了 |
| 归一化是**逐 token 的 InstanceNorm** | `fn norm`：用 `x` 自己的 mean/var | 不是 BatchNorm，权重里只有 γ/β。会把"这个音符绝对多极端"抹掉，只留组内形状 ⚠ 我的解读 |
| 数值防线 | `standardize` clamp ±1e4；权重加载时校验 sha256 + 张量 offset 连续性 | 端侧跑，防止坏数据把 UI 干崩 |

### 1.2 对照表

| 项 | 他们 | 我们（v3） | 差异是否有意义 |
|---|---|---|---|
| 总体 | 两级 token（音符/同刻组）+ 块内注意力 + GRU + 多路池化 | 20 维事件 → 142 维池化 → 岭回归 | **无**。我们已用 69k 参数 SSM 做过配对检验（0.8162 vs 0.8024，不显著），他们没有提供任何反驳证据 |
| 参数量 | **27,713 / 折**，共 5 折 = 138,565（`seed42_fold1.json` 的 `tensors` 求和；`mod.rs` 的 `assets` 数组载入 5 个） | 142 个权重 | 他们参数:样本 = 74:1；我们 142 / 7504 = 0.019:1 |
| 输入组织 | 17 事件维 + 6 同刻组维 + **18 整谱统计单独成支** | 只有事件维，整谱量靠池化间接得到 | **有**。见 §2.3 |
| 归一化 | 训练集 mean/scale（`preprocessor`），clamp ±1e4 | `W.mu` / `W.sd`（`engine-v3.mjs` `ridgeV3`） | 等价 |
| 输出 | 直接回归**定数**，5 折算术平均 | 回归 IRT `b`，再线性映射到定数 | **有**，但方向不同：他们学"人给的分"，我们学"玩家的感受" |
| 训练数据 | **373 训练 / 94 外层验证**（`seed42_fold1.json` 的 `training_ids` / `outer_validation_ids` 长度），epoch 50 | 7,504 张 | 差 20 倍，这是最本质的差别 |
| 精度 | README：10.0–17.5 段 **MAE ≈ 0.52**（对定数）；进 RKS 后 0.14 | ρ 0.8024，MAE 0.44（对玩家实测） | **不可直接比**：标签不同、口径不同。别拿 0.52 跟 0.44 比高低 |
| 模型分歧 | 同一张谱（`exact_block`）seed42 五折：14.697/14.895/15.383/15.471/16.263，**sd 0.54、极差 1.57**；15 个模型（3 seed × 5 fold）sd 0.81、极差 2.85 | 我们有 bootstrap CI | 他们有 0.5 量级的模型间噪声，和自报的 0.52 MAE 同阶 —— 说明这 0.52 里相当部分是**方差**不是偏差 |

> 5 折混合 + 3 seed 训练但只发 seed42 的 5 个（`tests/ai-vectors/exact_block.expected.json` 里存了 15 个模型的预测，测试代码只比对 `seed == 42` 的 5 个）。也就是说他们**知道**模型方差大，用集成去压。

---

## 2. 特征对照表（最重要）

**我们的 20 维**（`engine-v3.mjs::seqFeatures20`，逐位对齐 `tools/build_seq_dataset.py::to_feats`）：
`0 dt | 1 log dt | 2 x/675 | 3 |x|/675 | 4-7 类型 one-hot | 8 above | 9 log hold | 10 Δx | 11 跳跃距离 | 12 跳跃速度 | 13 cos 夹角 | 14 sin 夹角 | 15 同侧连续 | 16 同按数±20ms | 17 局部密度±250ms | 18 running strain | 19 log 相对时间`

### 2.1 事件级 17 维

| # | 他们的特征 | 算法 | 我们的对应 | 该不该补 |
|---|---|---|---|---|
| 0-3 | `tap/drag/hold/flick` | 原始 `type` 做 one-hot（1..4） | 4-7 ✅ | 已有。⚠ 见下方"类型编号"注 |
| 4 | `hit_x` | `point[0] = line_x(t) + x·0.05625·cos(rot)`，**判定线位移 + 旋转后的屏幕 x**（`features.rs::Line::point`） | 2 / 3 用的是 `positionX/675`（**谱面坐标**） | **★ 补（P0）** |
| 5 | `hit_y` | `point[1] = line_y(t)/1.7778 + x·0.05625·sin(rot)` | 无 | 配合 #4 一起补（单独 y 意义不大，但 dy 要用） |
| 6 | `log_hold_seconds` | `ln1p(end - time)`（秒） | 9（ms） | 已有（单调等价） |
| 7-8 | `angle_sin/cos` | `angle = rot - 90°·side + (speed<0 ? 180° : 0)`，再 `rem_euclid(360)` | 无 | P2。只对旋转判定线的谱有信息 |
| 9 | `angle_defined` | 有效速度≈0 时角度无意义，用 0/1 屏蔽 | 无 | 细节，随 #7 一起 |
| 10 | `side` | ±1 | 8 ✅ | 已有 |
| 11 | `signed_log_note_speed` | `log(n.speed)` 保号（`log` = `sign(v)·ln1p(|v|)`）。注：算角度时用的有效速度是 `line_speed × (hold ? 1 : note_speed)`，hold 忽略单音符 speed | 无 | P2（Phira 谱里单音符变速不常见） |
| 12 | `signed_log_line_speed` | 判定线 `speedEvents` 在 t 处的插值，取 log 保号 | 无（14 维里只有 `tempo_change_count` 整谱计数） | P1。流速决定读谱提前量 |
| 13-14 | `anchor_dx/dy_015` | 音符位置 **t 与 t−0.15s** 的屏幕坐标差 = 判定线运动速度 × 0.15s | 无。beta.3 有通道 23 = `\|Δsx\|/675`，但那是**相邻事件差**，不是 0.15s 回溯，且只有绝对值 | **★ 补（P0）** |
| 15-16 | `rotation_delta_sin/cos_015` | 判定线 0.15s 内转角的正余弦 | 无 | P1（判定线旋转是"读谱眩晕"的唯一直接量） |

**我们没有、他们有，且我判断可能有用的：** `hit_x/hit_y`（屏幕坐标）、`anchor_dx/dy_015`、`rotation_delta_*_015`、`signed_log_line_speed`。
**他们没有、我们有的（我们的护城河）：** `Δx / 跳跃距离 / 跳跃速度(25ms 下限)`、`三连音夹角`、`running strain`、`同侧连续标志`、`局部密度`。他们把这四类交给模型自己学 —— 但 373 张训练样本学不出 osu! 那套手调的先验。

> **类型编号注（实测）**：RPE 的 `type` 是 **1=tap、2=hold、3=flick、4=drag**。证据：在我们 `data/charts/*/chart.json` 上统计，`endTime != startTime`（长条）只出现在 type 2（前 80 张谱 8,504 个），`holdTime` 一个都没有；这与 `tools/serialize_chart.py` 的 `TYPE={1:T,2:H,3:F,4:D}`、`engine.js` 用 `type===4` 统计 `drag_per_sec`、以及 PhiraiAd `sanitize.rs::rpe_notes`（`2→hold, 3→flick, 4→drag`）四方一致。
> 但 PhiraiAd **两条提取路径的 kind 编号不一致**：`features::extract` 直接用原始 `type`（2=hold/3=flick/4=drag），而 `ai_chart_adapter` 走 prpr 解析后是 `NoteKind`（1=click/2=drag/3=hold/4=flick）。于是 `weight()`（`1|3→1.0, 4→0.5, _→0`）在两条路径上给出**相反的类型权重**：raw 路径 = tap1 / flick1 / drag0.5 / **hold0**，adapter 路径 = tap1 / hold1 / flick0.5 / **drag0**。⚠ 我无法确定训练特征出自哪条路径 —— 这更像是他们的隐患，而不是可抄的口径。
> 顺带：我们的 `tools/chart_io.py` 写的是 `{1:T, 2:H, 3:D, 4:F}`，3/4 也反了（`serialize_chart.py` 是对的）。当前 20 维数值不受影响（`ch` 只是中间标签又转回数字），但任何按 `ch=="D"/"F"` 分支的分析会踩雷。

### 2.2 同刻组 6 维

| 他们的 | 算法 | 我们的 | 结论 |
|---|---|---|---|
| `log_gap_seconds` | `ln1p(t_g - t_{g-1})`，**组间**间隔 | 0 / 1（**音符间** dt，和弦内部恒 0） | 近似等价，差异只在和弦内 |
| `log_elapsed_seconds` | `ln1p(t - t_first)` | 19 ✅ | 已有 |
| `time_progress` | `(t - t_first) / duration` | 无（我们只有 log 绝对时间） | 便宜，可补；长谱末段状态确实该不同 |
| `log_note_count` | `ln1p(组内音符数)` | 16（±20ms 窗口） | 近似。他们用**精确同刻**，我们用 ±20ms —— 见 §2.3 `max_chord` 的注 |
| `log_press_weight` | `ln1p(Σ weight)`，`weight()` 只对 kind 1/3/4 给权（见类型编号注：两条路径语义相反） | 无（同按数不分类型） | 可补，但**别照抄他的权重表**（他自己没统一） |
| `log_active_holds` | 用一个 `BinaryHeap` 维护"当前还按着的 hold 数" | beta.3 通道 21 ✅，生产 20 维 ❌ | 生产版该补 |

### 2.3 整谱统计 18 维 —— 这里最值得抄

| 他们的 | 算法 | 我们的 | 结论 |
|---|---|---|---|
| `log_duration` / `log_note_count` / `note_rate` | 时长、物量、物量/时长 | 142 维末尾有 `n` 与 `Σdt`（dt 每步截断 3s，`Σdt` 是时长的**下界**）可近似反推 | 近似已有 |
| `press_rate` | Σweight / duration | 无（加权口径） | 便宜 |
| **`press_1s_max` / `press_1s_p90`** | **1 秒滑窗内加权按键数的最大值 / 90 分位**（`press` 用双指针对组时间做 `[t-1, t]` 求和） | 无。我们只有"±250ms 局部密度"的 max（通道 17 池化） | **★ 补（P1）**。这是"体力峰值"，我们抓不到 |
| `tap/drag/hold/flick_fraction` | 各类型占比 | one-hot 通道的 mean ✅ | 已有 |
| **`hold_coverage`** | 所有 hold 区间并集 / duration | 无 | 可补（长条占屏比例） |
| **`hold_overlap_coverage`** | ≥2 个 hold 同时按住的时长 / duration | 无 | 可补（"双手都被占住"是长条谱主要难点） |
| `chord_group_fraction` / `max_chord` | 组内 >1 的组占比 / 最大和弦 | 16 通道的 mean / max ✅ 近似 | 已有（但口径是 ±20ms 不是精确同刻） |
| `press_gap_p50` / `press_gap_min` | 按键间隔中位 / 最小 | dt 通道的 p50 / min ✅ | 已有 |
| **`long_gap_fraction`** | 所有 >1s 空档的总时长 / duration | 无 | 可补（休息段比例 → 恢复量） |
| `hold_seconds_per_second` | Σhold 时长 / duration | 无 | 与 hold_coverage 高度相关，二选一即可 |

**结论（反直觉但重要）：** 这 18 维里大约一半我们**已经**通过分位数池化覆盖了（类型占比、和弦、间隔分位、物量、峰值密度）。**真正不重叠的只有 4~5 个，全是"时间局部量"：1 秒窗峰值、hold 覆盖/重叠、长空档。** 我们的池化（mean/std/min/max/p10/p50/p90）天生抓不到"1 秒窗"这种时间尺度。

### 2.4 他们训练过但**没上线**的特征（负面证据）

`seed42_fold1.json` 的 `event_contract` 里除了 17+6+18，还定义了两组：

- `motif_names`（8 个）：`repeat_3 / repeat_5 / unique_3_fraction / unique_5_fraction / longest_equal_gap_run / gap_entropy / chord_type_change_fraction / unexpected_gap_fraction`
- `margin_names`（8 个）：`budget_deficit_v1/v2/v4 / budget_deficit_mean_v2 / near_zero_margin_v2 / compensation_distance_per_group / hold_occupied_group_fraction / fallback_fraction`

`preprocessor` 里也存了这两组的 mean/scale。**但模型没有任何张量消费它们**：`group_encoder.0` 是 `[32, 70]`（=64+6），`head.0` 是 `[32, 160]`（=32×5），都塞不下 8 维。

> 也就是说：**"模式重复度 / 间隔熵 / 时间预算赤字"这条路，他们已经踩过并且没让它上车。**
> 我们 `docs/调研/难度特征目录.md` 里把"模式重复度"列成"我们的原创想法 P3" —— 实际上他们早有 8 个这方向的量，只是最终模型里没有。⚠ 不能证明无用（可能只是收益不够大），但这至少说明**它不是决定性的**。

---

## 3. 端侧工程

| 项 | 做法（出处） |
|---|---|
| 权重格式 | 每个模型 = 1 份 JSON 元数据 + 1 份**裸 f32 小端二进制**。二进制按 `tensors[].offset_bytes / nbytes` 首尾相接，`shape` 行主序，线性层是 `[out, in]`（`seed42_fold1.json` 的 `layout` / `linear_weight_layout`）。**没有 ONNX / tch / gguf / safetensors** |
| 体积 | `.bin` 110,852 B × 5 = 554,260 B；`.json` 45,1xx B × 5 ≈ 226 KB；`manifest.json` 1,514 B → **合计约 782 KB**（文件清单 size 字段）。全部 `include_bytes!` 进二进制（`mod.rs::Predictor::new`） |
| 完整性 | 两级 sha256：`manifest` 校验元数据、元数据校验权重（`mod.rs:72`、`network.rs:65`），并且要求"张量 offset 连续 + 总长等于文件长"（`network.rs:69/78`） |
| 推理 | 纯标量 Rust，单线程，无 SIMD intrinsics。5 个模型顺序跑完取算术平均（`mod.rs::predict`） |
| 耗时 | **⚠ 我读到的 `ai_model/*` 与 `ai_service.rs` 里没有任何推理计时**（`Instant` 只用于 UI 心跳与让步）；未对全仓库 grep（tarball 两次下载都在 300 s 超时处被截断）。按 MAC 计数估算：600 音/500 组 ≈ 9.1M MAC/模型，1500 音/1200 组 ≈ 21.7M MAC/模型，5 模型 ≈ 45M / 109M MAC → 标量 f32 大约 **0.1–0.5 s/谱**。⚠ 未验证：本机 rustc 不可用（`Missing manifest in toolchain`），无法编译实测 |
| 缓存形态 | **不建数据库**：预测结果作为字段 `phiraAiDifficulty` **写回谱面 JSON 本身**（`CACHE_FIELD`，`cache.rs::Document::save`）；PEC/PBC 写进 `info.yml` |
| 缓存键 | `bytes:{文件字节数}:{format}:{是否 rpe170}`（`cache.rs::Source::key`）。**不是内容哈希** —— 作者注释原话：`chartHash is retained as a JSON field for backwards compatibility; its new value is an explicit size/options key, not a content hash` |
| 缓存失效 | 键里含 `VERSION`（`mod.rs:13`，现在是 `kit1-whole-events1-seed42-fold1-5-native1`）+ `model_hash`（manifest 的 sha256）+ 结构自检（5 个值、均值自洽，`Prediction::valid`）。**改模型必然全量失效** |
| 自洽难题 | 因为键就是"文件长度"，而写回又会改变长度，`save` 里要迭代最多 8 次求定点（`cache.rs:161-177`）。这是把"缓存写进被缓存对象"的必然代价 |
| 索引 | `ai-difficulty-index.json`（`BTreeMap<path, Record>`，`index.rs`）：重启时不必解析任何谱面就能恢复列表；`restore` 校验路径前缀 + 文件字节数 |
| 调度 | 单后台线程 `phira-ai-low`（`ai_service.rs`）。`checkpoint()` 在特征提取每 128 音符 / 每 64 组、推理每 16 组 / 每 128 音符 / 每 32 块被调用：① 检查是否仍被允许、② 有新优先级任务就 `bail` 中断、③ **UI 心跳 <300ms（前台）就 100ms 一睡**、④ 干完活按 9× 工时睡（≤100ms）做占空比 |
| 上限 | 谱面文件 127 MiB（`cache.rs:10`）、音符 20 万、判定线 1 万（`features.rs`） |
| 内存 | 解析完立刻 `release_input()` 丢原始字节（`cache.rs:112`） |

**一句话**：他们真正的工程贡献不是模型，是"**低优先级协作式后台线程 + checkpoint 可中断 + 结果内嵌谱面 + 启动索引**"。这套东西只在"手机、几万张谱、不能卡 UI"的约束下才有价值。

---

## 4. 可以立刻做的三件事（按性价比排序）

### 4.1 【P0】把所有"移动"类特征换到屏幕坐标上算

- **怎么做**：用现成的 `chart_io.load_notes_ex`（已经输出 `sx/sy/rot`），把通道 `10 Δx / 11 跳跃距离 / 12 跳跃速度 / 13-14 三连音夹角 / 15 同侧连续` 以及 `18 strain` **全部改到 (sx, sy) 上重算**；同时新增 4 维：`anchor_dx_015`、`anchor_dy_015`（t 与 t−0.15s 的屏幕位移）、`rot_delta_sin/cos_015`。他们的参考实现在 `ai_model/features.rs::Line::point` + `ai_chart_adapter.rs::geometry`（含判定线父链的旋转合成）。
- **预期收益**：我们自己的文档估计"约 5% 谱面受影响明显，但这 5% 恰恰是特效多的谱"。修好这 5% 会同时改善**均值**和**尾部误差**；ρ 估计 +0.005~0.02（⚠ 纯估算，无先验）。另外它顺手修掉一个隐患：现在 `sy` 完全没进模型，判定线"上下飞"的谱我们只看到了横向分量。
- **风险**：判定线的下落运动会改变 `dx` 的含义（从"横向位移"变成"屏幕位移"），可能把原本干净的 aim 信号弄脏。**必须做 A/B 配对检验，不要直接替换**。工作量：Python 侧重算 + 重训，半天；JS 侧同步 + `verify-engine-v3.mjs` 对拍，半天。

### 4.2 【P1】补 5 个"时间局部"整谱量，直接接在 142 维后面

- **怎么做**：不改事件结构，只加特征：`press_1s_max`、`press_1s_p90`（加权按键数，权重先用他们 adapter 路径的口径：tap=1、hold=1、flick=0.5、drag=0）、`hold_coverage`、`hold_overlap_coverage`、`long_gap_fraction`。用他们的口径（`features.rs` 末尾 `press` 双指针 + `edges` 扫描线算覆盖/重叠）当规格书。
- **预期收益**：这条补的是我们池化**结构性抓不到**的东西（1 秒窗、区间并集）。估计 +0.005~0.015（⚠ 估算）。风险低：只加 5 维，共线性可以看系数稳定性判断。
- **风险**：`press_1s_max` 与现有 `max(±250ms 局部密度)`、`max(strain)` 高度相关，可能只贡献共线性。先算一下与现有 142 维的相关系数再决定要不要全加。

### 4.3 【P2】两个零成本 A/B（不改模型，只改数据口径）

- **(a) 过滤 `isFake`**：他们无条件丢弃 fake 音符（`features.rs:204-207`），**我们的 `chart_io.load_notes_ex` 一个 fake 都没过滤**（`grep isFake tools/chart_io.py` 为空；`engine-v3.mjs` 头部注释也写明"输入用全部音符（含 fake）"）。fake 音符不需要打，纯演出，把它们的密度/跳跃算进难度会**系统性高估演出谱**。做法：加一个开关重跑数据集 + 岭回归，配对检验。半天。
- **(b) 类型权重口径**：我们 strain 的权重是 `(0.2+2·speed) × (tap/flick=1.0, hold/drag=0.5)`（`engine-v3.mjs:47`，`k = type-1`，type 1/2/3/4 = tap/hold/flick/drag）。他们的权重表**自己自相矛盾**（见 §2.1 类型编号注），所以不能"抄"，只能"用数据裁决"：按谱面的 hold / drag 占比分箱看残差，如果高 drag 谱系统性高估，说明我们对 drag 的 0.5 给高了（他们给 0）；如果长条谱低估，说明 hold 的 0.5 给低了（他们给 1）。半天，不动模型。

---

## 5. 不值得学的

1. **27.7k 参数 / 373 张训练谱（74:1）的深度模型。** 我们能出活的根本原因是 7,504 张 + 玩家实测标签；他们已经把"参数多"这条路走到极端却只有 0.52。我们自己的 69k SSM 配对检验都不显著，没有理由回头。
2. **把预测写回谱面文件本身。** 修改用户文件、破坏内容哈希、等长修改会静默复用旧值、还要为"嵌入后长度不变"迭代求定点。我们应该把缓存放在服务端或 IndexedDB，键用**内容哈希**。
3. **用"文件字节数"当缓存键。** `cache.rs::Source::key` 是明确的反面教材：改一个字符长度不变 → 缓存永远不失效。
4. **5 个模型烘焙进客户端。** 5 倍算力换取方差下降；服务端一次算完即可，端上没必要跑 5 遍。他们的模型间 sd 高达 0.54–0.81，说明真正该做的是**把不确定性报出来**（我们已经在做 CI），而不是靠堆 5 份权重掩盖。
5. **逐 token 的 InstanceNorm。** `network.rs::norm` 用的是 token 自己的 mean/var，会抹掉"这个音符绝对有多极端"。⚠ 我的解读，作者可能有别的理由（例如端侧数值稳定）。
6. **`sanitize.rs` 式的静默修补。** 他们 clamp 字段、补默认值、断判定线父链环、给 PEC 补 `cp/cd/ca/cv`，然后照常推理 —— 对"显示个数字"是合理的；对**做数据集**是污染：一张坏谱会被修成一张看似正常的谱，而我们在 `ρ` 的评测里根本发现不了。我们应该**解析失败就跳过并计数**。
7. **他们的场景特化件**：内置谱面 stage 到磁盘（`stage_builtin`）、`:song:diff` 虚拟路径、心跳驱动的占空比让出、`phira-ai-low` 线程优先级 —— 我们是离线批量/服务端，一个都不需要。

---

## 附录 A：他们训练了什么、我们看不到什么

- 训练集划分只留了 **sha256 列表**（`training_ids` / `outer_validation_ids`），不是路径 —— 刻意不公开数据集，**无法反查是哪些谱**。
- 仓库里**没有训练代码**（无 `.py` / `.ipynb`），所以**损失函数、正则化、早停策略、标签来源全部未知**。`epoch: 50` 是终值还是最优值也未知。⚠ 只能从 `config`（dropout 0.2、gru_hidden 32、head_hidden 32、attention 16×2、block 32 组、context ±4）与 `preprocessor` 反推。
- `analysis_config` 里还有一整套**分段/合并判定线**的参数（`window_seconds 0.8`、`min/max_segment_seconds`、`angle_merge_degrees 60`、`merge_coincident_lines`、`line_sample_seconds 0.2`），但 `features.rs` 里**没有实现任何分段或合并** —— 它是训练侧管线的残留，或者只用于特征设计阶段。⚠ 推断，未验证。这带来一个潜在风险：训练时的特征口径可能与 `features.rs` 不完全一致（虽然 5 条测试向量能对上 1e-7，说明至少这 5 条是一致的）。
- 二进制权重**能读**（不是黑盒）：我按 `network.rs` 重写前向后结果对上了，说明张量语义与代码一致。

## 附录 B：我这次的验证动作

1. `git clone` 失败（全局 `insteadOf` 把 GitHub 改写成了 `gh.zwy.one`，504）；`github.com` / `raw.githubusercontent.com` / `api.github.com` 直连均不通（curl exit 35 / 000）。
2. 改用 `codeload.github.com` 下 tarball（两次尝试都在 300 s 上限处被截断，第二次到 7.7 MB、解压只到 `assets/` 之前）+ `cdn.jsdelivr.net/gh/...` 逐文件取，拿到了 `ai_model/` 全部 7 个源文件、5 份权重元数据、`manifest.json`、`ai_service.rs`、`ai_chart_adapter.rs`、`prpr-auto-offset/`、测试向量。**因此没有做全仓库 grep** ，涉及"仓库里有没有 X"的判断都限定在已读文件范围内。
3. 用 numpy 按 `network.rs` 重写前向（含窗口注意力、GRU 手写门、duration 加权池化、stats 残差支路），跑 `tests/ai-vectors/exact_block.features.json` → **15.4708904 vs 期望 15.4708900**，差 3.5e-7。
4. 参数按 `tensors[].shape` 求和得 27,713/折；MAC 按层形状手算。
5. 未做：编译实测耗时（本机 rustc 坏）、全仓库 grep（tarball 未下完）。

## 附录 C：`prpr-auto-offset/` 与难度的关系

结论：**没有关系，不用看**。

`prpr-auto-offset/src/estimate.rs` 做的是**音频 novelty（SuperFlux 频谱通量）与音符能量包络（高斯核）的归一化互相关**，输出一个全局时间 offset（`AlignConfig::default()`：搜索 ±0.30 s、步长 5 ms、可靠阈值 r > 0.2）。它是给谱师对齐音轨用的工具，和"这张谱有多难"零交集。

唯一可借的抽象：他们把"音符序列"变成了一条**可采样的连续信号**（`Signal` trait + `GaussianNote::samples(t)`）。如果哪天我们想把事件序列做成一维时间信号喂卷积，这个接口设计比直接摊平成矩阵干净。但那是另一个方向，不在本次范围。
