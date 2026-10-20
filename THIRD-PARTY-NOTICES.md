# 第三方素材与许可清单

> 这个仓库把别人的东西**原样**放进来时，许可证正文必须**跟着一起进来**。
> 这份清单是唯一真源：**新增任何外来物时，往表里加一行**。
>
> 许可证正文的位置若写「本目录」，指该素材所在目录下的同名文件。

## 代码 / 库

| 位置 | 上游 | 许可 | 许可证正文 | 备注 |
|---|---|---|---|---|
| `phm-web/public/vendor/web-audio-beat-detector/` | [`chrisguttandin/web-audio-beat-detector`](https://github.com/chrisguttandin/web-audio-beat-detector) v8.2.39 | MIT | `web-audio-beat-detector/LICENSE` | esbuild 打包，浏览器 ESM |
| `phm-web/public/vendor/uqr.mjs` | [`unjs/uqr`](https://github.com/unjs/uqr) v0.1.2 | MIT | `uqr-LICENSE` | 单文件 ESM，原样放入未改写 |
| `phm/audio2pez/` | [`anikiphi/rephiraedit-audio2pez`](https://github.com/anikiphi/rephiraedit-audio2pez) | MIT | `phm/audio2pez/LICENSE` | 有本地改动，改动清单见 `phm/audio2pez/PATCHES.md` |
| `第三方参考/Phira源码分析/` | [`TeamFlos/phira`](https://github.com/TeamFlos/phira) | GPL-3.0 | `第三方参考/Phira源码分析/LICENSE` | 源码**片段**（`info.rs` / `rpe.rs`），未做修改；用途与义务说明见该目录的 `README.md` |

## 字体

| 位置 | 原始字体 | 上游 | 许可 | 许可证正文 | 备注 |
|---|---|---|---|---|---|
| `phm-web/public/fonts/display-serif.woff2` | Noto Serif SC SemiBold | [`notofonts/noto-cjk`](https://github.com/notofonts/noto-cjk) `Serif/SubsetOTF/SC/` | SIL OFL 1.1 | `phm-web/public/fonts/OFL-NotoSerifSC.txt` | 子集（713 字形），内部族名 `Noto Serif SC SemiBold` |
| `phm-web/public/fonts/display-kai.woff2` | LXGW WenKai Regular | [`lxgw/LxgwWenKai-Lite`](https://github.com/lxgw/LxgwWenKai-Lite) | SIL OFL 1.1 | `phm-web/public/fonts/OFL-LXGWWenKai.txt` | 子集（527 字形）；上游带保留字，附许可允许「为网页字体交付而做子集/转格式」 |

细节、保留字核对、复现命令、以及**子集元数据缺 copyright/license 字段**这个
尚未处理的缺口，见 [`phm-web/public/fonts/README.md`](phm-web/public/fonts/README.md)。

## 数据

| 位置 | 内容 | 来源 | 说明 |
|---|---|---|---|
| `data/official.jsonl` | 1,037 条官谱定数与特征 | **从 Phigros APK 提取**（见 `docs/数据/官谱定数标尺.md`） | ⚠ **再分发边界待确认**：项目自订的 `docs/规范/数据飞轮契约.md` §3 写着「Phigros 官谱素材……提取自用可以，**分发不行**」，而本文件已随仓库公开。**未决**，见 issue。 |
| `data/community.jsonl` | 9,684 条社区谱元数据与特征 | [`api.phira.cn`](https://api.phira.cn) 公开 API | 内容是**各谱师自己声明**的定数与元数据；谱面文件本身不在仓库里（`data/charts/` 已 gitignore） |
| `data/chart-list.jsonl` | 谱面列表（含 `created` 上传时间） | 同上 | **生成物，不入库**（`.gitignore`），由 `tools/fetch_chart_list.py` 随时重拉 |

## 本站自有代码

GPL-3.0，见仓库根目录 [`LICENSE`](LICENSE)。

> 本清单只覆盖**从外部引入**的素材与数据。本站自研代码不在此表。
