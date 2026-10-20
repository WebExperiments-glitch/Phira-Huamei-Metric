# 贡献与合并规则 · P.H.M.

> 这个仓库是**公开**的，且线上有真实用户。合并门槛按「一点纰漏都不能有」设。
> 这份文件管**流程**；代码怎么写看 `phm-web/docs/ARCHITECTURE.md`，怎么跑看 `phm-web/docs/HANDOVER.md`。
> 一句话总纲：**能让下一个人独立验证你的判断**。做不到这一点，改动再漂亮也会被打回。

## 1. 分支与合并

- `main` **只接受 PR**，必需 `check` / `audit` / CodeQL，**管理员也不可绕过**，历史保持线性。
- 一人一分支，从最新 `main` 切：`git checkout -b fix/短横线描述 main`。
- **一律 squash 合并**：一个 PR = 一件事 = 一个 commit，`git log` 读起来就是变更史。
  代价是中间提交消失 —— 所以**不要在分支里打 tag**。
- 合并前必须与 `main` 同步（`strict` 分支保护）。冲突自己解。

## 2. 提交信息

```
type(scope): 一句话（≤ 72 字，祈使句，不加句号）

正文：为什么这么改（现象 → 根因 → 取舍）。没有"为什么"的正文等于没写。
```

- `type`：`feat` `fix` `docs` `test` `chore` `refactor` `perf` `ci`
- `scope`：`rulechart` `engine` `api` `auth` `web` `docs` `ci` `db`
- ⚠ 首行会成为 squash 后的 commit message，**永久留在 main 上**。
- ⚠ **别在 `python -c "…"` 里写反引号**：bash 会把它当命令替换执行掉，文案被掏空。
  要用 `--input <json 文件>`。（真踩过，且改不了：main 不许改写历史。）

## 3. 本地闸门（pre-push）

```bash
git config core.hooksPath .githooks   # 只需一次
```

之后每次 `git push` 自动跑 `phm-web/tools/preflight.mjs`：

1. **review-gate**：凭据/私钥扫描、版本四处一致、页面白名单、SQL 的 RLS/REVOKE/
   SECURITY DEFINER/**函数授权**、禁用 `eval`/`new Function`/客户端 `child_process`/XFF、
   workflow 权限、>2MB 大文件、空白错误。
2. **npm run check**：23 项离线检查（单测、OpenAPI 契约、文档同步、i18n、对比度、版本等）。

失败即拒绝推送。`--no-verify` 可以绕过本地钩子，但绕不过 CI 与分支保护。

## 4. PR

必须包含四块：**为什么 / 改了什么 / 怎么验证的 / 风险与回滚**。
模板见 `.github/pull_request_template.md`（新建 PR 自动带上）。

「怎么验证的」一栏**贴命令与输出**，不要写「已测试」。CI 会重跑，但 reviewer 需要先看到你的判断过程。

### 会被直接打回的情形

| 情形 | 为什么 |
|---|---|
| 正文没有验证证据 | reviewer 只能信你，那就不是 review 了 |
| 改了引擎数值却没 `--update` 金标 | 金标就是为了让「数值变了」必须显式发生 |
| 数据库迁移只 `revoke` 不 `grant` | 部署后每次调用 `permission denied`（2026-10-20 真实事故） |
| 路由工厂有分支漏 `return ..., true` | 响应发出后又走 404 → `ERR_HTTP_HEADERS_SENT` → **整站下线** |
| 加依赖 / 改 CI 不说明理由 | 供应链与流水线是公共资产 |
| 一个 PR 混了多件不相关的事 | squash 之后无法单独回滚 |
| 改版本号但没先问 | 四段规则见 `CHANGELOG.md`，「落哪一档」是产品决定 |

## 5. 额外必跑（按改动类型）

| 改动 | 加跑 |
|---|---|
| 前端交互 / 页面 | `node tools/verify-pages.mjs <base>`、`node tools/test-ui-flows.mjs <base>` |
| 服务端入口 / 路由工厂 / 兜底层 | `node tools/fuzz-http.mjs <base>`（145 条恶意输入，判据是「打完还活着」） |
| 引擎 / 参照集 | `node tools/audit-baselines.mjs` |
| 数据库迁移 / 发版 | `node tools/predeploy.mjs`；部署后 `node tools/predeploy.mjs --prod` |

⚠ 起服务跑浏览器测试时加 `PHM_TEST_NO_RATELIMIT=1`（只绕配额、不绕路径白名单）。
⚠ **别并行跑两个无头 Chrome** —— 会互相干扰出假失败。
⚠ 刚部署完的前两次冒烟不可信（冷启动），判据是**连跑两次全绿**。

## 6. 数据库

- 迁移按序号放 `db/api-v2/`，**每份都能单独执行**（执行通道一次只收一条语句）。
- 表：`create table` + `comment` + `revoke all`。
- 函数：`security definer` + `set search_path = public, pg_temp` + 函数体内**比对 `p_secret`**。
- ⚠ **函数必须有 `grant execute ... to anon, authenticated`**。我们没有 `service_role` 凭据，
  站内所有 RPC 都是用网页里那把 publishable key 以 `anon` 身份调的；
  安全性靠 `p_secret` 比对，不靠权限位。
- ⚠ 变量名别和表列撞：`declare v integer` + `select v from phm_secrets` = `42702 ambiguous`。
- 改了表结构要同步 `phm-web/docs/DATA-MODEL.md`。

## 7. 发布

```bash
cd phm-web && python tools/bump-version.py Vx.y.z.w     # 改前先问
node tools/predeploy.mjs                                 # 发布前闸门（含库里的 RPC 在不在）
git push            # 走 PR；CI 绿后 squash merge
git tag -a vx.y.z.w -m "..." && git push phm vx.y.z.w
# 部署（仓库所有者手动）
node tools/predeploy.mjs --prod                          # 部署后复验
```

⚠ **同名版本号不能部署两次**：内容变了就换版本号，否则用户端会拿到旧模块而整页空白。

## 8. 文档

改行为就要改文档，而且**要改到每一处**。`lint-docs` 会守着：死链、版本号、页面表、模块表、
README 目录树、旧文件名黑名单。加页面/加模块没同步文档，CI 会红。

写文档的两条硬规矩：

1. **改结论要说明「旧结论错在哪」**，而不是把旧文删掉换成新的 —— 读者需要知道为什么变了。
   历史文档建议「原文保留 + 开头加更正注」。
2. **数字必须能复现**：给出复现命令，或说明它由哪个脚本产生。写死一个查不到来源的数，比不写更糟。
