# 标题字体子集：来源、许可与复现

> 本站只有**标题**用标题字体，正文用系统黑体栈（见 `phm-web/docs/DESIGN.md` §4）。
> 两个子集是**生成物**，不是原始字体 —— 原始字体几十 MB，全量放进仓库/站点
> 会拖死首屏（见 `tools/subset-display-font.py` 的说明）。

## 两套字体的来源与许可

| 仓库内文件 | 原始字体 | 上游 | 许可 | 许可证正文 |
|---|---|---|---|---|
| `display-serif.woff2` | **Noto Serif SC SemiBold** | [`notofonts/noto-cjk`](https://github.com/notofonts/noto-cjk) `Serif/SubsetOTF/SC/NotoSerifSC-SemiBold.otf`（经 jsDelivr CDN） | SIL OFL 1.1 | [`OFL-NotoSerifSC.txt`](OFL-NotoSerifSC.txt) |
| `display-kai.woff2` | **LXGW WenKai Regular**（霞鹜文楷，基于 Fontworks Klee One） | [`lxgw/LxgwWenKai-Lite`](https://github.com/lxgw/LxgwWenKai-Lite) | SIL OFL 1.1 | [`OFL-LXGWWenKai.txt`](OFL-LXGWWenKai.txt) |

> ⚠ **注意名字对不上**：脚本注释里写「思源宋体」，但这两个子集的实际内部族名是
> **Noto Serif SC SemiBold**（`Noto Serif CJK` 与 `Source Han Serif` 是同一套字体的
> 两个发行名）。以**上游链接**为准，别以注释里的中文名为准 ——
> 两者对应的 OFL 文件与版权声明并不完全一样。
> 内部族名可用 fontTools 查：`TTFont('display-serif.woff2')['name'].getDebugName(1)`。

## 保留字（Reserved Font Name）核对

| 字体 | 上游 OFL 的版权声明 | 保留字 | 子集是否合规 |
|---|---|---|---|
| LXGW WenKai | 「…with Reserved Font Name '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'」+ **附加许可** | 有 | ✅ 附加许可明确允许「subsetted or converted to other formats (e.g. WOFF/WOFF2) **solely for web font delivery**」时继续使用保留字名 —— 本站正是这个用途（子集 + woff2 + 网页交付，且不作为可安装桌面字体发布） |
| Noto Serif SC | noto-cjk `Serif/LICENSE` 为**纯 OFL 1.1 文本，未含版权声明**（即未指定保留字） | 未指定 | ✅ 未指定保留字时，修改版本可继续使用原名 |

## ⚠ 一个已知的元数据缺口（尚未修）

两个子集的 `name` 表里 **copyright / license / license URL / version 全是空的**，
只留了 family(1) 与 full name(4)：

```
family      : Noto Serif SC SemiBold
copyright   : (无)
license     : (无)
license URL : (无)
```

OFL 1.1 的分发条款要求「许可证随字体一同提供」。仓库层面已经满足
（两个 `OFL-*.txt` 就在同目录），但**字体的元数据里没有任何指向它的入口**，
下载 woff2 的人看不到许可证。

**责任待确认**：`tools/subset-display-font.py` 用 `fontTools.subset` 裁剪时
**没有传 `--name-IDs`**，走的是默认行为；而上游的 `SubsetOTF` 文件本身
是否已剥离这些记录，**本次未核实**（下载上游 11.7MB 的 OTF 超时，未取到）。
一条命令即可确认：

```bash
python tools/subset-display-font.py      # 会重新下载上游并重裁
python -c "
from fontTools.ttLib import TTFont
f=TTFont('public/fonts/.cache-NotoSerifSC-SemiBold.otf')
n=f['name']
for i,l in [(0,'copyright'),(13,'license'),(14,'url')]:
    print(l, '→', n.getDebugName(i))"
```

**若上游带、裁剪丢** → 在裁剪命令里补 `--name-IDs='*'`
（fontTools 默认只保留 name ID 0–6，13/14 会被丢掉）。
**若上游也不带** → 换用完整字体 `Serif/OTF/SC/NotoSerifSC-SemiBold.otf`，
或在裁剪后手工写入版权与许可字段。

这属于**产品行为**（字体的元数据），改它要重跑子集流水线，
所以本目录只做记录，**不在文档 PR 里顺手改**。

## 复现

```bash
cd phm-web
python tools/subset-display-font.py            # 全部两套
python tools/subset-display-font.py kai        # 只重做其中一套
```

字符集来自 `tools/display-chars.txt`（由 `tools/collect-display-chars.mjs`
从**渲染后的 DOM** 采样标题用字得到 —— 不能 grep 源码，因为很多标题是
JS 用 `t()` 填的）。
上游字体缓存在 `public/fonts/.cache-*`（已 gitignore，不入库）。
