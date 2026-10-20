<!--
标题格式：type(scope): 一句话（≤ 72 字）
  type  ∈ feat | fix | docs | test | chore | refactor | perf | ci
  scope ∈ rulechart | engine | api | auth | web | docs | ci | db
⚠ 标题会成为 squash 之后的 commit message 首行 —— 它会永久留在 main 上，
   而且永远和这个 PR 的内容绑在一起。写清楚「做了什么」，不要写「按需求调整」。

正文只写**读者从 diff 里看不出来的**：为什么这么改、放弃了哪些方案、怎么验证的。
纯格式调整可以只写一句，但「验证证据」不能省 —— 没有它，reviewer 只能信你。
-->

## 为什么

<!-- 现象 / 痛点 / 出问题的条件。给出复现路径或数据，别写"优化一下"。 -->


## 改了什么

<!-- 与 diff 对应的分点。动了引擎数值 / 数据库 / 鉴权路径的必须单独点名。 -->


## 怎么验证的

<!-- 贴命令与结果。CI 会重跑，但 reviewer 要先看到你自己的判断。 -->

```bash
cd phm-web && npm run check          # →
```

## 类型

- [ ] 用户可见功能 / UI
- [ ] 后端 / API
- [ ] 数据库 / 迁移
- [ ] 测试 / CI / 工具
- [ ] 文档
- [ ] 安全修复

## 自检（缺一不可）

- [ ] `cd phm-web && npm run preflight` 通过（review-gate + 23 项离线检查）
- [ ] CI 的 `check` **和** `audit` 都通过（分支保护会强制）
- [ ] 没有提交任何密钥：`.env` / `write-secret.txt` / token / 私钥 / 带密码的连接串
- [ ] 用户可见改动：版本号（`bump-version.py`）、`CHANGELOG.md`、`versions.js` 已同步
- [ ] API 改动：`/developers` 文档、OpenAPI、测试至少同步一处
- [ ] 新增页面：已加进 `PUBLIC_FILES` + `CLEAN` + `ui.js` 的 `NAV` + `i18n.js` 的 `FRAGMENTS`
      + `ARCHITECTURE.md` + `docs/README.md`（漏了 lint-docs 会红）

## 这几类改动有专门的门（勾了就要按它验）

- [ ] **数据库迁移** → 每个 `create ... function` 都必须有对应的 `grant execute`
      （只 `revoke` 不 `grant` = 部署后每次调用 `permission denied`；`review-gate` 会拦），
      并在发布前跑 `node tools/predeploy.mjs` —— 它会去库里问一句「这些 RPC 真能用吗」
- [ ] **路由工厂**（`lib/*-routes.mjs`）→ **每个分支都要 `return ..., true`**。
      返回 falsy 会被当成"没命中"继续走到 `send404` → `ERR_HTTP_HEADERS_SENT` → 整个进程退出
- [ ] **引擎数值** → `node tools/golden-engine.mjs --update`，正文说明变化量；
      只加字段不算改数值，但要在正文点明「只加字段、点估计未变」
- [ ] **前端交互** → 补 `tools/test-ui-flows.mjs` 断言。页面能加载 ≠ 功能没坏
      （2026-10-17 三次故障全在渲染层，176 条冒烟一条没抓到）
- [ ] **服务端入口 / 兜底层** → 跑 `node tools/fuzz-http.mjs <base>`（145 条恶意输入），
      判据是「打完 `/api/health` 还通不通」
- [ ] **版本号** → 先问过用户，按 `CHANGELOG.md` 的四段规则落档（别用 `npm version`）

## 风险与回滚

- 影响范围：
- 回滚方式：<!-- revert 这个 commit 够不够？有没有已执行、退不回的迁移？ -->
- 需要人工验证的点：

## 关联

<!-- Closes #NN / Refs #NN -->
