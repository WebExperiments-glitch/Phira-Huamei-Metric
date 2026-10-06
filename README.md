# P.H.M. — Phira Huamei Metric

> 为 Phira / Phigros 谱面提供**可审计的难度参考**。
> 给出**一个确定的数值 + 它的不确定度**，附特征差异、官谱参照与事实性检查。
> 不给判决。

**版本：V0.3.2 · 开发者测试版**
> ⚠️ 版本号在正式版发布后**重新计算**。

**在线使用**：https://webexperiments-glitch.github.io/Phira-Huamei-Metric/ （无需安装，打开即用）

---

## 一句话定位

**本工具不判定「虚标」。** 这不是谦辞，是可测量的结论：

| 事实 | 数值 |
|---|---|
| 官方定数自身的标注噪声 | **2.80 级**（同曲同物量相邻难度定数差中位） |
| 本工具不确定带的覆盖率 | **55.4%** —— 即 **44.6% 的官谱落在「自己的同类区间」之外** |

在这个噪声水平下，没有任何工具能区分「谱师标错」与「官方也会这么标」。
**声称能区分就是造假。**

---

## 快速开始

### 方式一：单文件 GUI（推荐，零依赖）

双击 `phm/P.H.M..html` 即可。无需 Python、无需起服务、无需联网。

- 默认只给**一个答案**：一个点估计数值 + `±1.0` 不确定度
- 右上角 ⚙ 可开**专业模式**（特征对照 / 官谱参照 / 判据明细）与**浅色主题**
- 专业模式**默认关闭** —— 多数人只想知道「这谱大概多难」

### 方式二：命令行报告

```bash
python phm/cli.py --model data/official.jsonl --chart data/community.jsonl --id 22681
python phm/cli.py --model data/official.jsonl --chart data/community.jsonl --name Pandemic
python phm/cli.py --model data/official.jsonl                     # 引擎自检
```

---

## 精度（对交付引擎实测，可一键复现）

```bash
python tools/calibrate_engine.py     # 或 python tools/pipeline.py calibrate
```

留一法（每条官谱留出、用其余重建索引），官谱 1,037 条：

| 指标 | 值 |
|---|---|
| 点误差 中位 | **0.500** |
| p75 / p90 / p95 | 1.000 / **1.500** / 1.900 |
| ≤0.5 占比 | **55.5%** |
| ≤1.0 占比 | **80.8%** |
| ≤1.5 占比 | 93.2% |
| 近邻集中度分布 | high 563 · mid 446 · low 28 |
| 不确定带覆盖率 | **55.4%** |

即：**给出一个数，误差中位 0.5 级；约 2/3 的谱误差 ≤1.0 级。**

> ⚠️ 校准脚本直接调用 `phm/core.py` 的 `Verdict`，**不是**另一个平行实现。
> 历史上「公布的精度来自评估脚本、实际交付的是 core」曾造成两者脱节，现已永久消除。
>
> ⚠️ 浏览器端是独立实现，另有一道 `tools/verify_gui_parity.py`：
> 把 GUI 的 k-NN 抽出来在 node 里跑真实语料，与引擎**逐谱比对** point/lo/hi。
> 已实测它抓到过一次真 bug（query 的长条占比漏了 ×100，近邻全错）。
> 两个脚本都在 `pipeline.py calibrate` 里，随流水线自动跑。

---

## 目录结构

```
自研AI 生成谱面/
├── README.md              # 本文件（唯一入口）
├── phm/                   # ★ 交付物
│   ├── core.py            #   难度显影引擎（唯一真源：档位定义 / 归一化 / 回退链）
│   ├── cli.py             #   命令行报告
│   ├── P.H.M..html        #   单文件 GUI（3.9MB，双击即开）
│   └── gui/
│       ├── index.html     #   GUI 源码（含 fetch，供本地服务调试）
│       ├── build_standalone.py  # 打包单文件（含三重产物自检）
│       └── data/          #   裁剪后的前端数据
├── data/                  # ★ 数据真源
│   ├── official.jsonl     #   官谱 1,037 条（从 Phigros APK 提取）
│   ├── community.jsonl    #   社区谱 9,684 条
│   ├── charts/            #   原始语料 31GB / 9,689 个谱面目录
│   └── .stages/           #   中间产物（可删，重跑重建）
├── tools/                 # 可复现脚本
│   ├── pipeline.py        #   ★ 流水线统一入口
│   ├── calibrate_engine.py#   交付引擎留一法校准
│   └── archive/           #   已归档的一次性脚本（23 个）
├── docs/                  # 文档（索引见 docs/README.md）
└── _research/             # 调研素材与 APK 提取产物（不入版本控制）
```

---

## 流水线（可复现）

```bash
python tools/pipeline.py --status      # 查看数据状态
python tools/pipeline.py official      # 官谱：_research/pgr → data/official.jsonl   （约 80s）
python tools/pipeline.py community     # 社区谱：data/charts → data/community.jsonl  （较久）
python tools/pipeline.py calibrate     # 校准引擎 + 校验浏览器端与引擎逐谱一致
python tools/pipeline.py gui           # 前端数据 + 单文件 P.H.M..html
python tools/pipeline.py all           # 全流程，按依赖顺序
```

---

## 数据真源

| 文件 | 条数 | 来源 |
|---|---|---|
| `data/official.jsonl` | 1,037 | Phigros APK（MuMu 模拟器 ADB 提取，EZ/HD/IN 各 327 + AT 56） |
| `data/community.jsonl` | 9,684 | Phira 公开 API 全量下载 |
| `data/charts/` | 9,689 目录 | 31GB 原始谱面语料 |

**一切以官方为基线**：定数与谱面特征均来自游戏本体提取，非第三方转录。

---

## 本工具不做的事

- ❌ **不判定虚标** —— 见开头，官方噪声 2.80 级
- ⚠️ **不会声称精确到 0.1** —— 定数的 0.1 是滑块机械精度、不是语义精度
  （实测整数定数比一位小数常用 3.9 倍，是「拖滑块」的指纹）。
  所以给的是一个数 **+ 明确的不确定度**，而不是一个假精确的数
- ❌ **不声称复现官方标准** —— 它不存在。Phigros 从未发布制谱难度规范

## 本工具做的事

- ✅ **点估计 + 不确定带** —— 最相似 20 首官谱的定价中位，及它们的四分位
- ✅ **特征差异** —— 你与同类的差距（NPS / 物量 / Hold占比 / 纵连速度）
- ✅ **官谱参照** —— 与你最相似的 5 首官谱及其定价，可逐条查证（与点估计同一批近邻）
- ✅ **事实性检查** —— 超官方上限 / 标签区间矛盾 / Liveness 双字段冲突

---

## 文档

完整索引见 [`docs/README.md`](docs/README.md)。必读三篇：

| 文档 | 内容 |
|---|---|
| [调研报告2-定数由谁定](docs/调研/调研报告2-定数由谁定.md) | 定数到底谁定（**结论：没人按标准写**） |
| [定数公式v2](docs/结果/定数公式v2.md) | 现行公式与精度 |
| [18维要素实验结果](docs/结果/18维要素实验结果.md) | **负面结果**：加维度反而变差 |

---

## 技术栈说明

原计划用 Rust 分 `Windows/` `IOS/` 两个平台目录。实际落地为
**Python（纯标准库）+ 单文件 HTML GUI** —— 零依赖、零服务、双击即开，
在 Windows 上直接可用。空目录 `Windows/` `IOS/` 已移除。
