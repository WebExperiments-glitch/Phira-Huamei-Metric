# 合规文档（PHM 侧权威副本）

> 本目录是**权威源**。线上页面（`public/privacy-game*.html`）由这里的内容落成。
> 改动顺序：先改这里 → 再改 HTML → 再改 i18n 字典 → 跑 `npm run check`。

## 四份文档与线上地址

| 文件 | 线上路由 | 对应 i18n 前缀 |
|---|---|---|
| `01-隐私政策.md` | `/privacy-game` | `gp.` |
| `02-儿童隐私协议.md` | `/privacy-game/children` | `gc.` |
| `03-个人信息收集清单.md` | `/privacy-game/collect` | `gk.` |
| `04-第三方共享清单.md` | `/privacy-game/third-party` | `gt.` |

线上需带分享码访问：`?sharecode=NXNUI4YAVG`（站点 2026-11 起设了门槛，裸访问 403）。

## 铁律

**页面里的每个数据项都必须能对上代码。** 改动采集逻辑（客户端载荷或服务端
`validatePost`）必须同步改这里与 HTML，否则构成虚假披露。

`01-隐私政策.md` 文末有「核对依据」表，列了每个数据项对应的源码位置。

## 不在本仓库的部分

客户端（Phira 话梅构建）里那四个入口 URL 常量属于**游戏侧**维护，
位于 `phira-huamei/phira/src/page/settings.rs`，已由游戏侧改到 `/privacy-game*`
并接入 `with_sharecode()`。本仓库只保证这四个地址可访问、内容与采集一致。
