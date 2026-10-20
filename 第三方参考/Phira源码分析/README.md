# 第三方参考：Phira 源码分析

> 这里放的是**从 Phira 源码里摘出来的片段**，用于回答「Phira 到底怎么算的」这类问题，
> 不是完整的 Phira 仓库、也不是本项目的依赖。

## 来源与许可

| 项 | 值 |
|---|---|
| 上游 | [`TeamFlos/phira`](https://github.com/TeamFlos/phira)（Phira 客户端，AGPL/GPL 系许可） |
| 许可 | **GPL-3.0**（见本目录 [`LICENSE`](LICENSE) —— 逐字取自上游 `LICENSE`） |
| 摘录的文件 | [`info.rs`](info.rs)、[`rpe.rs`](rpe.rs) |

## 为什么要摘

Phira 客户端决定了「一张谱怎么被解析、判定怎么算、难度怎么渲染」——
这些是**规范级事实**，不能靠猜。本项目里多处结论都建立在逐字核对源码之上：

- `beat ↔ 秒` 的换算必须是 `a + b/c`（不是 `a/c`）——
  竞品漏了 `b` 项，280BPM 谱时长少算 131 秒、定数偏差 0.56。
  见 [`docs/规范/严谨性工程契约.md`](../../docs/规范/严谨性工程契约.md) §零点五。
- `difficulty` 与 `level` 是**两个独立字段**，客户端不做换算，只是单向补全 `Lv.`。
- 定数渲染有四条路径，其中列表页是**截断**（`as i32`）、信息面板是**四舍五入**。
- PECTX / PEC 的词法定义。

## GPL 的分发义务（已履行）

GPL-3.0 第 5 条：分发受 GPL 保护的源码时，**必须随源码提供完整的许可证正文**，
并保留原有的版权与声明。本目录因此包含：

- `LICENSE` —— 上游 `TeamFlos/phira` 的 `LICENSE` 逐字副本
- 片段文件本身保持原样，**未做修改**（若日后修改，需在文件内标注改动，
  与 `phm/audio2pez/PATCHES.md` 的做法一致）

> ⚠ 本目录的 `.gitignore` 里有 `第三方参考/`，但**已入库的文件不受 gitignore 影响**
> （gitignore 只对未跟踪文件生效）。所以这里的片段与 LICENSE 都在版本控制里。

## 完整仓库在哪

完整 Phira 源码在 `_research/phira-main/`（**已 gitignore，不入库**），
需要时按 `docs/调研/调研报告2-定数由谁定.md` 里的说明重新拉取。
