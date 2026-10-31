# 写谱链路（/write · /agent）的边界与开关

> 一句话：**它不再继续开发，但它是产品的一部分，不拆站。**
> 这份文档说明它和主站的界线在哪、出问题怎么一键关掉、以后要动它得守什么。

定了这件事的日期：2026-10-25。

## 为什么不拆站

写谱是「一句话生成谱面」的入口，跟引擎、参照集、规则写谱是同一个产品的不同侧面。
把它拆成独立站，用户要在两个域名之间跳，谱面数据还得跨站传 —— 换来的只是
「CI 更省心」，代价是产品被切碎。所以选择**解耦而不分离**：

- 它崩了，主站照常跑；
- 主站重构，不必连带改它；
- 它自己不长新东西。

## 它的边界

清单写在 `lib/write-scope.mjs` 的 `WRITE_OWNED`，**这是唯一真源**。
判断标准是「**只为它存在**的文件」：

```
public/write.html            /write 页面
public/agent.html            /agent 页面
public/js/write-page.js      /write 的交互
public/js/agent-page.js      /agent 的交互
public/js/agent.js           createWriter（对外唯一入口）
public/js/agent-runtime.js   对话循环
public/js/agent-commands.js  工具注册表
public/js/agent-prompt.js    系统提示词
public/js/markdown.js        回复渲染
public/js/script-eval.js     脚本解释器（CSP 没有 unsafe-eval）
public/js/i18n/agent.js      文案分片
lib/agent-routes.mjs         /api/agent/*（转发到模型）
lib/write-scope.mjs          这份边界本身
```

`chart-lint.js` / `chart-geom.js` / `beat-time.js` / `rulechart.js` / `engine.js`
**不属于它** —— 主站也在用，那是共享资产。它只能**读**这些（白名单 `WRITE_MAY_USE`）。

## 三条硬约束（都有测试守着）

`node tools/test-write-scope.mjs`，也挂在 `npm run check` 里。

1. **清单完整**：磁盘上按命名约定（`agent-*` / `write-*`）看起来属于它的文件，
   必须在 `WRITE_OWNED` 里。新加文件忘了登记 → 红。
2. **依赖单向**：主站**不许静态** import 它的模块。写谱可以 import 主站。
   - 反例（已修）：`rulechart.html` 曾经顶部静态 `import { createWriter } from '/js/agent.js'`，
     agent.js 只要有一处语法错，整个规则写谱页白屏。现在改成第一次点「AI 改谱」时
     `import()` 按需加载，失败只影响那一块面板。
   - 例外（已写明原因）：`js/i18n.js` 必须同步 import `i18n/agent.js`，
     否则 `lint-i18n` 会报「分片没人 import，等于没翻」。那是纯数据。
3. **开关可用**：`PHM_WRITE=off` 时，`/write`、`/agent` 返回一张**不依赖任何脚本**的
   静态说明页，`/api/agent/*` 一律 `503 {"code":"write_disabled"}`。

## 出问题怎么关

```bash
PHM_WRITE=off PORT=3000 node server.mjs
```

或者在你的部署环境里加这个变量再重启。关掉之后：

| 路径 | 关闭后的行为 |
|---|---|
| `/write` `/agent` | 200，静态说明页（含「怎么恢复」和回主站的链接） |
| `/api/agent/*` | 503 `write_disabled` |
| 其余所有页面/接口 | **完全不受影响** |

⚠ 说明页刻意**不引任何 JS/CSS 外链**：它要在「写谱链路已经坏了」的时候也能显示。
给一个坏掉的页面加载 `ui.js`，就是自找难看。

## 要动它的时候

- **改提示词 / 加工具**：可以直接改，但改完跑 `npm run check`（含边界测试）。
- **加新文件**：必须同步加进 `WRITE_OWNED`，否则 check 红。
- **让它读主站新模块**：加进 `WRITE_MAY_USE`，并在 PR 说明里写清为什么它需要。
- **想让它反向影响主站**（比如主站页面 import 它）：**不要这么干**。
  真要共享，把那段逻辑提到 `public/js/` 下作为独立模块，两边都引它。

## 冻结的契约

这几样东西一旦改了，等于换了产品形态，要单独评估：

- **导出格式**：`.pez` / `.zip` 里的 `chart.json` 必须保持 Phira 可导入
  （`visibleTime` 等字段由 `buildPez` 的 `normalizeForPhira()` 统一补齐）。
- **音频白名单**：`mp3 / ogg / wav / flac` 透传，其余转 16-bit PCM WAV ——
  依据是 Phira 源码 `prpr/Cargo.toml:65` 启用的 symphonia features。
- **工具表**（`agent-commands.js` 的 12 条）：`/write` 只发主路径那几条，
  发太多弱模型会挑错工具。

## 已知的限制（写在这里，免得下次当成 bug 修）

- 产出质量不稳定，同一段音频两次结果差别可能很大 —— 页面已标注**实验性**。
- 免费模型档位有每日次数上限，超了会报错。
- 它不会自己判断「这段写坏了」：体检只给分项指标，要不要重写由模型自己决定。
