# 贡献与合并规则

这个仓库是**公开**的，且线上有真实用户。合并门槛按「一点纰漏都不能有」设：

## 1. 本地闸门（pre-push）

```bash
git config core.hooksPath .githooks   # 只需一次
```

之后每次 `git push` 会自动跑 `phm-web/tools/preflight.mjs`：

1. **review-gate**：凭据/私钥扫描、版本四处一致、页面白名单、SQL 的 RLS/REVOKE/
   SECURITY DEFINER、禁用 `eval`/`new Function`/客户端 `child_process`/XFF、
   workflow 权限、>2MB 大文件、空白错误。
2. **npm run check**：17 项离线检查（单测、OpenAPI 契约、文档同步、i18n、对比度、版本等）。

失败即拒绝推送。`--no-verify` 可以绕过本地钩子，但绕不过 CI 与分支保护。

## 2. CI 必过

| 检查 | 内容 |
|---|---|
| `check` | 17 项离线检查 |
| `audit` | review-gate + 离线检查 + Chrome 全页面冒烟 + UI 交互流 |
| CodeQL | JS/TS + Python 静态安全扫描 |

`main` 分支保护要求：**必须 PR**、`check` 与 `audit` 绿、线性历史、
对话已解决、禁止 force-push/删除、管理员同样受限。

## 3. 提交前清单

- 不提交任何密钥；数据库写入只走 SECURITY DEFINER RPC。
- 用户可见改动必须升版本号（四段式）+ 更新 `CHANGELOG.md` 与 `versions.js`。
- 新页面必须同时加 `PUBLIC_FILES` + `CLEAN` + `ARCHITECTURE.md`。
- 数据库改动必须附迁移 SQL，并同步 `docs/DATA-MODEL.md`。
- API 改动必须同步 `/developers` 文档与测试。

## 4. 发布

```bash
cd phm-web && python tools/bump-version.py Vx.y.z.w
node tools/preflight.mjs
git push            # 走 PR；CI 绿后 squash merge
git tag -a vx.y.z.w -m "..." && git push phm vx.y.z.w
```

部署由仓库所有者手动执行（WorkBuddy），发布后跑生产复验。
