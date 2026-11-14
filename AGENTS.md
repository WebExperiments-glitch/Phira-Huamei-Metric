# AGENTS.md · P.H.M.

> 给 AI 代理的**导航图**，不是说明书。本文档 ≤120 行，细节一律外链。
> 判断标准：删掉某一行，代理会不会犯一个原本不会犯的错？不会就删。

## 这是什么项目

谱面难度预测（Phira / Phigros）。谱面 → 特征 → 模型 → 定数。
两条产品线：
- `phm-web/` —— 线上站点（Node + 浏览器端引擎，**用户可见**）
- `tools/` `docs/` —— 离线研究（Python，数据集、训练、A/B）

## 一条命令

```bash
cd phm-web && npm run check          # 37 项闸门，与 CI 同款
```

改完还要跑冒烟（`check` 不覆盖真实浏览器）：

```bash
PHM_TEST_NO_RATELIMIT=1 PORT=5251 node server.mjs &
MSYS_NO_PATHCONV=1 node tools/smoke-page.mjs http://127.0.0.1:5251
```

## 墙（不要靠自觉，靠闸门）

| 规则 | 谁在守 |
|---|---|
| 引擎数值不许漂 | `tools/golden-engine.mjs`、`verify-engine-v3.mjs`、`verify-engine-v4.mjs` |
| JS 与 Python 必须对得上 | `verify-seq-model.mjs`（纯数学 1e-5 / 端到端 1e-4） |
| 首页/表单不能白屏 | `smoke-page.mjs`（404 条断言） |
| 中英文案不能漏 | `check-i18n-page.mjs` |
| 基线不许退化 | `tools/audit-baselines.mjs` |
| 提交前必过全套 | `.husky/pre-push` |

**Markdown 只是指路，闸门才是墙。任何"重要的规则"最终都要变成一条会红的检查。**

## 五条硬约束（违反过一次，代价很大）

1. **动版本号前必须问用户**。四段 `V{a}.{b}.{c}.{d}`，真源 `CHANGELOG.md`。
   内容变了就必须换版本号——同名部署两次 = 用户端永久空白。
2. **`git reset --hard` 之前先看有没有未提交改动**。
   2026-11-05 冲掉过另一个代理的 4 处修复（PEC 排序、null 图层、extra 参数、类型映射）。
   正确做法：`git stash list` + `git status`，确认干净再 reset。
3. **20 维特征的顺序与语义冻结**。只能追加，不许重排、不许改语义。
   改它 = v3 权重全废。
4. **不许用 ρ 的绝对值下结论**。任何提升必须给配对 bootstrap 的 95% CI；
   CI 跨 0 就写"无显著差异"，不许写"有提升趋势"。
5. **训练没跑完不许下结论**，报清 epoch 数与是否中断。

## 已知的坑（先读再动手）

完整清单：`docs/AI-PITFALLS.md`。最常犯的三个：

- **同名变量覆盖**：`for sd in seeds` 覆盖了特征标准差数组 `sd`，三 seed 各用了错误缩放，
  跑出的 0.8294/0.8209/0.8340 全部无效。
- **排序错位**：预测值按长度排序输出、标签没跟着排，首版 ρ=0.03，看起来像"模型完全无效"。
- **想当然的"等价改动"**：以为改一个类型标签不影响数值，实际 `chart_io` 与 `to_feats`
  两处映射互为反向、互相抵消，只改一处会让 flick/drag 的权重互换。

## 找代码：先查索引，别 grep 全库

`258 个文件 / 43,900 行`。grep 一个词会命中几十处注释，然后逐个打开 —— 上下文就这么烧光的。

**改任何功能前，先用 MCP `codebase-search` 定位文件**：

| 索引名 | 覆盖 | 规模 |
|---|---|---|
| `phm-backend` | `phm-web/lib/` | 36 文件 / 327 chunk |
| `phm-frontend` | `phm-web/public/js/` | 66 文件 / 618 chunk |
| `phm-tools` | `phm-web/tools/` | 90 文件 / 920 chunk |

工具：`search_codebases`（查）→ `get_chunk_content`（读命中块）→ `get_file_content`（读全文）。
改完代码跑 `update_codebase_scan` 刷新对应库。

**两条注意**：
- 搜索结果显示索引过期 → 先刷新，否则你会照着旧代码改。
- 它原本**不认 `.mjs`**（只认 .js/.jsx/.py/.ts/.tsx）。补丁在 `phm-web/tools/patch-codebase-search.mjs`，
  改的是全局包 —— **`npm update -g` 之后必须重跑**，否则后端 98 个 .mjs 会再次被跳过。


## 什么时候读哪份

| 任务 | 读 |
|---|---|
| 改站点代码 | `phm-web/docs/HANDOVER.md` |
| 难度引擎方向 / 被否掉的方案 | `phm-web/docs/ENGINE-DIRECTION.md` |
| 实现细节（i18n / 样式 / 站点表 / Phira API） | `.workbuddy/memory/DETAILS.md` |
| 模型与数据集版本 | `docs/调研/模型版本规范.md` |
| 基准测试口径 | `docs/调研/难度模型-基准规范.md` |
| 别人的项目怎么做的 | `docs/调研/` |
| 踩过的坑 | `docs/AI-PITFALLS.md` |

## 提 PR 的规矩

- **一个 PR 只做一件事**。超过 300 行改动先想能不能拆。
- commit message 用 `git commit -F 文件`（本机 bash 里反引号会被当命令替换）。
- 提交前跑 `npm run check`；红了不许 push，不许 `--no-verify`。
- 网上推送要用过滤版 gitconfig（见用户级 MEMORY.md），推前先 `ls` 那个临时文件。

## 关于用代理

- **用户没明确要求时，不要自作主张开子代理**（2026-11-05 明确要求）。
- 派出去的任务必须写清：目标、判据、不许动哪些文件、卡住怎么报。
- **子代理产出必须先落到磁盘再算完成**。只在消息里贴结论、没有文件改动 = 没做完。
- 代理之间不许互相"审"超过 3 轮——实测会陷入自我循环。第 3 轮起只看新增 diff。

## 汇报口径

- 数字要带 n、CI、seed 数。
- 失败要写"卡在哪"，不许糊一个半成品说完成。
- **不允许把"没验证"包装成"已验证"**。这一条比任何指标都重要。
