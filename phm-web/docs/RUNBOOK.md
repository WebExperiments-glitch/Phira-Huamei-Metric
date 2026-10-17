# RUNBOOK —— 出事时照着做

> 这份文件回答「现在坏了，我该按什么顺序做什么」。
> 部署红线与发版纪律在 HANDOVER.md；本文件只管**运行与恢复**。
> 原则：**先止损，再定位，最后复盘**。任何一步都不要在生产上边猜边改。

---

## 0. 5 分钟分诊

| 症状 | 先查 | 常见原因 |
|---|---|---|
| 整站打不开 | `curl -I https://phm.app.workbuddy.host/`；平台控制台 | 部署失败 / 容器没起来 / 平台故障 |
| 页面能开但空白 | 浏览器控制台；`smoke-page.mjs` | 版本号没升 / 模块 `?v=` 不同串 / 同名版本部署两次 |
| 接口 5xx | 服务端日志；`/api/health` | 数据库不通 / 上游 Phira 超时 / 代码异常 |
| 写入 503 | 日志里 `db-down` / 凭据来源 | 写入凭据丢失或数据库不可用（fail-closed） |
| 贡献 401 | 页面是否旧版本 | 旧缓存页面没有贡献凭证流程 → 刷新 |
| 数据看起来不对 | `reconcile-cache.mjs --stale-only` | 引擎换代后旧缓存 / 缓存被写坏 |

**第一步永远是**：确认是「全站 / 单页 / 单接口 / 单用户」哪一档，再动手。

---

## 1. 本地复现（不要在线上试）

```bash
cd phm-web
npm run check                 # 全部非浏览器检查，1 分钟内
PORT=5199 node server.mjs     # 另开终端
node tools/smoke-page.mjs http://127.0.0.1:5199
```

浏览器测试串行跑（**不要并行开两个无头 Chrome**）：

```bash
node tools/verify-pages.mjs  http://127.0.0.1:5199
node tools/test-ui-flows.mjs http://127.0.0.1:5199
node tools/test-api-routes.mjs http://127.0.0.1:5199
```

---

## 2. 部署

流程与红线见 HANDOVER.md §4。要点：

1. 版本号：`python tools/bump-version.py V{x}.{y}.{z}.{w}`（先问用户动哪一位）。
2. 记账：`CHANGELOG.md` + `public/js/versions.js`。
3. 本地全绿：`npm run check` + 四套浏览器测试。
4. 推送：远程叫 `phm`，用过滤后的 GIT_CONFIG_GLOBAL（见 HANDOVER §4）。
5. 部署：WorkBuddy sites，目录 `phm-web`，language `node`。
6. **生产复验**（缺一不可）：

```bash
curl -s https://phm.app.workbuddy.host/ | grep -o 'app-version" content="[^"]*"'
node tools/smoke-page.mjs https://phm.app.workbuddy.host
curl -s -o /dev/null -w "%{http_code}\n" https://phm.app.workbuddy.host/server.mjs        # 必须 404
curl -s -o /dev/null -w "%{http_code}\n" https://phm.app.workbuddy.host/lib/cloud.mjs    # 必须 404
curl -s -o /dev/null -w "%{http_code}\n" https://phm.app.workbuddy.host/write-secret.txt # 必须 404
curl -s -o /dev/null -w "%{http_code}\n" https://phm.app.workbuddy.host/.env             # 404 或 WAF 403
```

> `.env` 可能被平台 WAF 拦成 403 而不是 Node 的 404；只要没有内容返回就算通过。

---

## 3. 回滚

1. 找上一个 tag：`git tag --sort=-v:refname | head -3`。
2. `git checkout <tag> -- .`（或 `git revert` 对应提交）。
3. 照常部署，然后跑 §2 第 6 步复验。
4. **不要**用「同名版本重新部署」来修缓存问题 —— 换版本号才是解。

> 用户端「页面缺东西 / 半页空白」优先怀疑版本号与缓存，不是代码。

---

## 4. 数据库备份与恢复

现状：数据库是 **WorkBuddy 托管的 PostgreSQL**，没有长期驻留的 pg_dump 通道。

### 每周至少记录一次
用 MCP/SQL 记录核心表行数与时间戳：

```sql
SELECT 'phm_charts', count(*), max(computed_at) FROM phm_charts
UNION ALL SELECT 'phm_scores', count(*), max(created_at) FROM phm_scores
UNION ALL SELECT 'phm_profiles', count(*), max(last_seen) FROM phm_profiles
UNION ALL SELECT 'hm_accounts', count(*), max(created_at) FROM hm_accounts
UNION ALL SELECT 'hm_plays', count(*), max(created_at) FROM hm_plays;
```

保存到 `.deepseek/ops/` 或本地备份目录（**不要写进公开仓库**）。

### 出事后恢复
1. 先确认平台侧数据库快照/回档能力（控制台或工单）——唯一权威恢复路径。
2. 从最近一次行数快照判断损失范围。
3. 只读恢复优先：先让站点能读（缓存表），再处理写入。
4. 恢复后跑 `node tools/reconcile-cache.mjs --stale-only` 与 `npm run check`。

> 没有「删表重建」脚本。结构变更只走 MCP + 同步 DATA-MODEL.md。

---

## 5. 密钥与凭据

| 凭据 | 用途 | 位置（优先级） |
|---|---|---|
| `PHM_WRITE_SECRET` | 写数据库 RPC / 贡献凭证签名 | 环境变量 → `.env` → `write-secret.txt` |
| `PHM_TOKEN_SECRET` | huamei 账号 JWT 签名 | 环境变量 → `.env` → 从写入凭据派生 |
| GitHub token | 推送、分支保护 | 本机 keyring（不进仓库） |
| 平台登录 | 部署 | 平台账号（不进仓库） |

**轮换写入凭据**（两步必须同时做）：
1. 改数据库 `phm_secrets` 的 `writer` 行（MCP SQL）。
2. 改运行环境 `PHM_WRITE_SECRET`（或 `.env` / `write-secret.txt`），重启服务。
3. 验证：`/api/health` 200 + 一次真实写入。

**轮换 token 密钥**：会使所有 huamei token 失效（用户需重新登录），确认可接受再动。

> 目标状态：生产凭据放 GitHub Environment secrets；本机只留开发假值。当前仍手动，迁移见 TODO。

---

## 6. 客户端构建（Windows）

见 HANDOVER.md §6。三条最容易忘：

1. `cargo build --release --no-default-features --bin phira-main`（**必须** `--no-default-features`）。
2. `-p phira` 只编 lib；可执行文件在 `-p phira-main`。
3. 改完客户端版本同步 `HUAMEI_CLIENT_VER`，重跑 `gen-release.mjs`。

---

## 7. 数据备份（仓库真源）

```bash
node tools/backup.mjs                 # 默认写 backups/<时间戳>/
node tools/backup.mjs --out D:/phm-backup
node tools/backup-verify.mjs <dir>    # 逐文件 sha256 校验
```

备份内容：`data/official.jsonl`、`data/community.jsonl`、语料 manifest、前端参照集、release 元数据、
客户端 exe（若存在）。**不包含** 31GB 原始语料与凭据。每次生成 `manifest.json`。

31GB 原始语料另存一份离线/对象存储快照（可重建，但重建要下很久）。

---

## 8. 巴士因子演练（每季度一次）

目标：**一个没参与过项目的人（或全新 AI 会话）能按文档跑起来。**

1. 全新目录 `git clone`。
2. 按 README 安装（只需 Node + Python，无第三方包）。
3. `cd phm-web && npm run check` —— 必须全绿。
4. 起服务、跑一套浏览器测试。
5. 按本 RUNBOOK 部署到**临时域名**（不要动生产）。
6. 记录卡住的每一步，回写到本文件。

> 第 3 步跑不过说明 CI 假设已漂移；先修脚本，不要绕。

---

## 9. 事故复盘模板

```md
## YYYY-MM-DD 事故
- 影响：谁 / 多久 / 什么功能
- 时间线：发现 → 止血 → 恢复
- 根因：
- 为什么测试没抓到：
- 修法（代码/流程/文档）：
- 新增的守卫（哪条测试/哪条 lint）：
```

复盘写进 `.deepseek/logs/YYYY-MM-DD.md`；若改变操作纪律，同步 HANDOVER.md。
