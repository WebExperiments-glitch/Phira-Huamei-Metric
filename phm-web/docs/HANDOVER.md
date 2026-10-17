# 交接说明 · 给下一位改这个项目的 AI

> 这份文件只讲一件事：**动这个项目之前必须知道什么，部署之前必须做什么。**
> 不讲产品理念（那是 `README.md`）、不讲设计（`DESIGN.md`）、不讲安全模型推导（`SECURITY.md`）。
>
> 读的顺序建议：**本文 → `ARCHITECTURE.md` → 你要改的那一块**。
> 每一条"不许"后面都跟着**真实事故**，不是风格偏好。跳过任何一条，出事的样子都在下面写着。

---

## 0. 先搞清楚目录关系

这里有**两个独立的 git 仓库**，别搞混：

| 路径 | 是什么 | 远程 |
|---|---|---|
| `D:\自研AI 生成谱面`（Git 根） | 站点仓库。Git 根在**上一层**，`phm-web/` 是它的子目录 | `phm` → `WebExperiments-glitch/Phira-Huamei-Metric` |
| `D:\自研AI 生成谱面\phm-web` | 站点本体（Node HTTP 服务） | 同上（子目录） |
| `D:\自研AI 生成谱面\phira-huamei` | Windows 客户端（Rust / Phira 分支），**自己一个 .git** | `origin` → `WebExperiments-glitch/phira-huamei` |

⚠ 在 `phm-web/` 里 `git commit` 提交的是**整个根仓库**，客户端改动**不会**跟着进去 ——
客户端要在 `phira-huamei/` 里单独提交、单独推。

⚠ 站点远程名叫 **`phm`**，不叫 `origin`。`git push origin` 会报
`'origin' does not appear to be a git repository`。

---

## 1. 六十秒跑起来

```bash
cd D:/自研AI 生成谱面/phm-web
PORT=5199 node server.mjs          # 另开一个终端，别占着不放
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5199/api/health
```

- 写入凭据走三条路：环境变量 `PHM_WRITE_SECRET` → `.env` → `write-secret.txt`。
  启动日志会打印**实际用的是哪一条**，先看那行再调试"写不进去"。
- 没有凭据也能跑：定数照常算，只是写不进共享缓存。**这是有意的**（fail-closed）。

⚠ 改完 `server.mjs` / `lib/*` **必须真的重启进程**。端口被旧进程占着时，
新进程会静默 `EADDRINUSE`，你测的其实是旧代码 —— 这一条坑过至少两次
（其中一次导致"注册不需要验证码"的**假通过**）。

Windows / Git Bash 下 `pkill -f "node server.mjs"` **无效**，按端口杀：

```powershell
Get-NetTCPConnection -LocalPort 5199 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

---

## 2. 部署前必跑（一条都不能省）

```bash
cd phm-web && npm run check                           # ★ 全部非浏览器检查（CI 同款）
```

下面这些是上面那条命令的展开，方便单独排查：

```bash
node tools/gen-ref.mjs --check                        # 参照集与真源同步
node tools/verify-engine.mjs                          # 45 条 · 引擎纯计算
node tools/test-ratelimit.mjs                         # 80 条 · 限流
PORT=5199 node server.mjs &                           # 先起服务

node tools/smoke-page.mjs      http://127.0.0.1:5199  # 222 条 · 页面加载/版本号/缓存策略
node tools/verify-pages.mjs    http://127.0.0.1:5199  # 123 条 · 真浏览器驱动 UI + 双语
node tools/test-ui-flows.mjs   http://127.0.0.1:5199  #  24 条 · 真浏览器**交互**（拖文件/结果卡/字体）
node tools/test-api-routes.mjs http://127.0.0.1:5199  #  22 条 · 打完接口 + 贡献凭证认证再验进程没死
node tools/test-contribute-ticket.mjs                  #  11 条 · 贡献凭证签/验（不联网）

node tools/lint-slop.mjs                              # 必须 0
node tools/lint-i18n.mjs                              # 必须 0（821 词条 / 803 引用）
node tools/lint-docs.mjs                              # 94 条 · 死链 / 版本号 / 页面与模块清单

node tools/review-gate.mjs                            # ★ 静态审计（凭据/版本/白名单/SQL/禁用模式/workflow）
node tools/preflight.mjs                              # ★ review-gate + npm run check（pre-push 自动跑）
```

**期望数字**：222 / 123 / 24 / 22 / 80 / 45 / 79，加 `test-contribute-ticket` 11，全部 `0 失败`。
`lint-slop` / `lint-i18n` 必须 0。

> **CI**：`.github/workflows/ci.yml` 在每次 push/PR 跑 `npm run check`（15 项）；
> `.github/workflows/audit.yml` 在每次 push/PR 跑 **review-gate + check + Chrome smoke（218 条）+ ui-flows（24 条）**；
> `.github/workflows/codeql.yml` 扫 JS/TS + Python；`.github/workflows/e2e.yml` 每晚（北京时间 02:00）和手动触发跑同款浏览器测试。
>
> **合并门（2026-10-17 起）**：`main` 必须走 PR，必需检查 `check` + `audit`，
> 线性历史、对话必须解决、禁止 force-push/删除，**管理员同样不可绕过**。
> 本地 `.githooks/pre-push` 自动跑 `review-gate + check`；仓库已开 secret scanning /
> push protection / Dependabot alerts。规则见根目录 `CONTRIBUTING.md`。
> CI 没有生产数据库读写权限，所以 smoke 用 `PHM_SMOKE_OFFLINE=1` 跳过数据页分页断言；
> `verify-pages` / `api-routes` 依赖真实数据与 Phira 写入路径，留在本地发版前跑。
> 出事时的操作顺序见 [`RUNBOOK.md`](RUNBOOK.md)。

> `verify-pages` 偶发 3 条字体断言失败时，先确认没有残留的无头 Chrome 进程，
> 再重跑一次；**连续两次失败**才算真失败（2026-10-17 实测过一次假失败，重跑 123/0）。

### ⚠ 别只跑 smoke 就发版

2026-10-17 一天之内坏了**三次**，176 条 smoke 断言**一条都没抓到**：

| 事故 | 现象 | smoke 为什么没抓到 |
|---|---|---|
| `card()` 里引用了已删除的 `rows` | 拖谱面完全没反应 | 它只"打开页面看有没有报错"，没人真的拖过文件 |
| 模块缺导出 | 半页空白 | 同上，页面 DOM 在，只是不工作 |
| `.btn.primary` 选择器漏了 | 两个主按钮没样式 | 样式类问题 smoke 不断言 |

**动到前端交互，必须补 `test-ui-flows.mjs`。** 现在它会真拖一个（故意坏的）`.pez`。

### ⚠ 别并行跑两个无头 Chrome

`smoke-page` / `verify-pages` / `test-ui-flows` 同时跑会互相干扰，出**假失败**。串行跑。

---

## 3. 🚫 红线（做了就出事）

### 3.1 同一个版本号，绝不部署两次

**事故**：`V0.9.4.0` 下部署了两遍（内容不同）。当时 `?v=` 资源带 `immutable`，
浏览器**连强刷都不重新校验** → 用户手里是旧模块、页面是新模块 → 模块链断 →
**下半页整块空白，而且 7 天内自己好不了**。

规矩：**内容变了就必须换版本号**，哪怕只改一个错字、哪怕只隔 5 分钟。

```bash
python tools/bump-version.py V0.x.y.z     # 一处改全站：9 个 meta + 所有 ?v= + package.json
```

⚠ 改完 `bump-version.py` 还要**同步 `public/js/versions.js`**（`RELEASES[0].v` 必须等于
新版本号，smoke 有断言守着），以及 `CHANGELOG.md` 那一行。

### 3.2 别把 `immutable` 加回缓存头

`server.mjs` 的 `sendFile`：`?v=` 资源是 `public, max-age=3600, must-revalidate` + ETag。
`immutable` 会把"一次失误"放大成"七天不可修复"。smoke 有三条断言守着这件事。

### 3.3 版本号：四段，第 1 位要先问人

`V{a}.{b}.{c}.{d}` —— 两段（`V0.9`）、三段（`V0.9.0`）都不合规。

| 改动 | 动哪一位 |
|---|---|
| 纯前端小改（间距、动效、文案） | 第 4 位 +1 |
| UI / 界面结构 / 交互逻辑 | 第 3 位 +1，末位归零 |
| 后端 / 数据层 / 引擎 / 安全策略 | 第 2 位 +1，后两位归零 |
| **第 1 位** | **没有规则 —— 动之前必须问用户** |

**唯一真源是 `phm-web/CHANGELOG.md`**（开发者向），`public/js/versions.js` 是用户向的版本历史，
两者受众不同，不要合并，但都要写。

### 3.4 不许手改这三类生成物

| 文件 | 真源 | 重新生成 |
|---|---|---|
| `public/js/ref-official.js`、`public/data/ref-com.json` | `tools/gen-ref.mjs` | `node tools/gen-ref.mjs` |
| `public/js/release.js`（大小 / sha256 / 客户端版本） | 实际的 `downloads/phira-huamei.exe` | `node tools/gen-release.mjs` |
| 各页的 `?v=` 串 | `tools/bump-version.py` | 跑它 |

**过期的 sha256 比没有更糟** —— 用户照着校验对不上，然后**合理地**怀疑包被投毒。

### 3.5 不许把凭据提交进仓库

仓库是**公开的**。凭据只走：环境变量 → `.env` → `write-secret.txt`，后两者已 gitignore。
另有一份**交接/灾备副本**放在 GitHub 的 `production` Environment secrets（`PHM_WRITE_SECRET` /
`PHM_TOKEN_SECRET`，2026-10-17 建立）。它不是部署通道：WorkBuddy 仍是手工部署、读不到它；
**不要因此删本地文件**，也不要把它写进代码或日志。
推之前如果想提交任何密钥，先跑：

```bash
gh api repos/WebExperiments-glitch/Phira-Huamei-Metric --jq '{private,visibility}'
```

（结论：**PUBLIC**。别凭记忆。）

### 3.6 不许改存储键名

`public/js/settings.js` 的 `KEYS` 是唯一清单，**只增不改**。改了等于把老用户的设置悄悄清空。
别处**不许裸写 `localStorage`**（`lint-slop` 会报）。新键必须同时进 `PLAIN_KEYS`，
否则 `clearAll()` 清不掉它 —— 而用户只会以为"清空坏了"。

### 3.7 不许给 CSS 用 `@import`

`bump-version.py` 只扫 `public/**/*.html` 与 `*.js`，**`.css` 里的 `?v=` 不会被升版**。
样式表用 `<link>`，且顺序固定：`base.css` → `ui-kit.css`。

### 3.8 别的 AI 最容易踩的：CSS 花括号

**事故**：`base.css` 里 `.btn {` 写重了一行 →

```css
.btn {
  min-height: 40px;
.btn {                    /* ← 多这一行 */
  display: inline-flex; …
}
```

于是**从那一行往下的整份样式表都成了嵌套规则、全部失效**。控件高度、focus 环、
字体档位、窄卡、芯片——一条都没生效，而**浏览器不报任何错**。
为此在错误方向上改了好几轮（补选择器、调优先级），因为表现是"样式没写对"，
真因是"样式根本没被解析"。

**改完 CSS 一定要跑 `node tools/lint-slop.mjs`**（第 6b 条守括号平衡）。

### 3.9 不许改 `ENGINE_VER` 的语义

`public/js/engine.js` 里 `ENGINE_VER` 是**算法轴**，会被写进每一行数据；
页面版本是**另一根轴**。改了打分/参照/维度/聚合 → 必须改 `ENGINE_VER` 并重算缓存
（`tools/reconcile-cache.mjs --recompute-stale`），因为新旧数字不可比。
**纯重构（数值等价）不要动它**，用 `verify-engine` 的 45 条证明等价即可。

另外 `engine.js` 必须保持**纯计算**：不碰 DOM、不碰网络、不碰 fs。参照集由调用方传入。

### 3.10 不许把谱面文件传到服务端

核心链路（拖入 → 解析 → 出定数）**全程在用户浏览器里完成**，这是写进隐私政策
和首页的承诺。只有用户主动勾选时，才把**结构特征**（不含文件本身）写入共享缓存。

### 3.11 静态白名单不许放松

`server.mjs` 的 `PUBLIC_DIRS` 是白名单。这些必须永远拿不到内容：

```
/server.mjs   /lib/*   /write-secret.txt   /.env   /downloads/*
```

> ⚠ `.env` 在**生产**上可能被平台 WAF 直接拦成 **403**（不是 Node 的 404）。
> 判定标准是「没有内容返回」，403 与 404 都算通过；**不要把 403 当成泄漏**。
> 2026-10-17 实测：`/server.mjs` `/lib/*` `/write-secret.txt` 404，`/.env` 403（WAF 拦截页）。

`downloads/` 与 `public/` **故意分开**：`public/` 的语义是"白名单里的可以送"，
`downloads/` 的语义是"只准走 `/download/phira-huamei.exe` 这一条路由"。
别为了图省事把 `downloads` 加进 `PUBLIC_DIRS`。

部署后拿这 5 条打一遍，全绿才算发完。

### 3.12 不许跳过"部署后复验"

部署工具的 `verified: true` 只说明**容器起来了**，不说明你的改动生效了。
必须对**生产域名**再跑一遍关键检查：

```bash
curl -s https://phm.app.workbuddy.host/ | grep -o 'app-version" content="[^"]*"'   # 版本号对不对
node tools/smoke-page.mjs https://phm.app.workbuddy.host                            # 176/0
curl -s -o /dev/null -w "%{http_code}\n" https://phm.app.workbuddy.host/server.mjs  # 404
```

### 3.13 别删 `.workbuddy/`

项目记忆和任务数据在 `D:\自研AI 生成谱面\.workbuddy\`。它是**数据目录，不是缓存**。

---

## 4. 发版标准流程

```bash
# 1) 版本号（先问人：动第 1 位吗？其余按 §3.3 判）
python tools/bump-version.py V0.x.y.z

# 2) 三处记账（漏一处就是"改了看不到"或测试红）
#    · public/js/versions.js  RELEASES[0]  ← 用户向，写"他能感知到什么"
#    · CHANGELOG.md           表头第一行     ← 开发者向，写取舍和踩过的坑
#    · package.json           bump-version 已自动改

# 3) 若动过 exe：放 downloads/ 并重算元数据
cp ../phira-huamei/target/release/phira-main.exe downloads/phira-huamei.exe
node tools/gen-release.mjs

# 4) §2 的全套测试

# 5) 提交 + 推送（远程叫 phm）
git add -A && git commit
GIT_CONFIG_GLOBAL="C:/Users/30500/AppData/Local/Temp/phm-gc-fixed" git push phm HEAD:main
GIT_CONFIG_GLOBAL="C:/Users/30500/AppData/Local/Temp/phm-gc-fixed" git tag v0.x.y.z
GIT_CONFIG_GLOBAL=... git push phm v0.x.y.z

# 6) 部署（需**本轮**用户明确说"发布/上线"，上一轮的同意不算）

# 7) §3.12 复验
```

### 推 GitHub 的坑（本机特有）

`~/.gitconfig` 里有一条 `url.<proxy>.insteadOf = https://github.com/`，把 github.com
重写成只读代理 → push 必然失败。**正解是"过滤"不是"清空"**：

```bash
python - <<'EOF'
import os, re
src = os.path.join(os.path.expanduser('~'), '.gitconfig')
out = '\n'.join(l for l in open(src, encoding='utf-8', errors='replace').read().split('\n')
                if not re.match(r'\s*insteadof\s*=', l, re.I))
open(r'C:/Users/30500/AppData/Local/Temp/phm-gc-fixed', 'w', encoding='utf-8').write(out)
EOF
```

⚠ **路径必须写死成 Windows 绝对路径**。Git Bash 的 `$TEMP` = `/tmp`，Python 的
`os.environ['TEMP']` = `C:\Users\...\AppData\Local\Temp` —— 不是同一个目录。
文件不存在时 git 当"没有全局配置"，`schannelCheckRevoke=false` 一起丢，
报 `CRYPT_E_NO_REVOCATION_CHECK`（看着像证书问题，其实是路径错了）。

⚠ 那个临时文件**会被系统清理**。推之前先 `ls` 一下，不在就重建（几秒，别去查证书）。

❌ **错的做法**：`GIT_CONFIG_GLOBAL=/dev/null`（屏蔽太狠，把 `sslCAInfo` 也丢了）、
`git -c url.<proxy>.insteadOf=…`（`insteadOf` 是多值配置，`-c` 只追加不覆盖）。

---

## 5. 这个平台的几个"反直觉"

| 事实 | 影响 |
|---|---|
| **无状态托管**：每个请求可能落在新进程 | 进程内计数器 / 内存缓存**全不可靠**。限流必须落库（`hm_rate` 表 + `hm_rate_hit` RPC） |
| 平台**每个请求注入不同的 `X-Forwarded-For`** | 按 XFF 分桶的限流**永久不会触发**。只用 `req.socket.remoteAddress`，源码里禁止读 XFF（测试守着） |
| 匿名调用时 `auth.uid()` 返回**字符串 `'anon'`**，不是 NULL | 判断要写 `IS NOT NULL AND <> 'anon'`，只判 NULL 会放过匿名写 |
| 网关会拦 `/.cloud/*` | 那些路径**到不了**这个 Node 服务，别在那儿找 bug |
| 沙箱部署目录**不可写** | `writeFileSync` 失败会被 `catch{}` 吞掉。任何"状态落盘"都要先假设写不进去 |
| 免费邮箱验证码由平台提供 | `/.cloud/auth/v1/verification`，字段叫 `verification_code`，**不是** `code` |

---

## 6. 客户端（`phira-huamei`）单独注意

```bash
cd ../phira-huamei
cargo build --release --no-default-features --bin phira-main
```

- ⚠ **必须 `--no-default-features`**。带默认特性会多编一套 video（要下 FFmpeg 静态库），
  产物 43.5MB vs 36.8MB。
- ⚠ `-p phira` 只编 **lib**（产物是 dll），可执行文件在 **`-p phira-main`**。
- ⚠ 首次构建会由 `prpr-avc/build.rs` 去 GitHub Releases 下 FFmpeg 静态库，
  本机 schannel 吊销检查会把它打挂（`UnknownIssuer`）。正解：
  `curl --ssl-no-revoke` 手动取包 → 解到 `prpr-avc/static-lib/<target>/` → 写 `.version`。
  该目录已 gitignore。
- ⚠ 还要一个空的 `z.lib`：`build.rs` 无条件 `link-lib=z`，但 FFmpeg 静态库实际没引用
  zlib 符号，补个空占位库即可（MSVC `cl` + `lib` 造，命令前加 `MSYS_NO_PATHCONV=1`，
  否则 Git Bash 把 `/nologo` 当路径）。
- 改完客户端记得改 `phira/src/client.rs` 里的 `HUAMEI_CLIENT_VER`，并重跑
  `tools/gen-release.mjs` —— 下载页的版本号是从二进制里读的。

### 客户端账号流程（2026-10-17 起）

`设置 → huamei 账号` 的注册是：**邮箱 → 密码 → 验证码**。

- 服务端 `REQUIRE_EMAIL_CODE` **默认开**（`!== '0'` 才关）。
  关着 = 可以拿任意邮箱批量注册，只应作为"老客户端还没升级"的临时逃生口。
- **先发码、再问码**。顺序反过来，用户会盯着屏幕等一封还没寄出的邮件。
- 发码走**独立任务** `huamei_code_task`。塞进 `huamei_task` 会被"任务完成就当登录成功"
  的分支当成登录结束，弹一句「已登录」。
- **登录永远不带 code** —— 产品定的是「注册要码、登录只要密码」。

---

## 7. 还没做的事 / 已知债务

| 项 | 状态 |
|---|---|
| `app.html` 里约 300 行休眠代码（`pfRender` / `pfSearch` / `pfRecent` / `pfImport` / `phmRks` / `fitPlayerCurve`，面板已迁 `/user`） | 改玩家逻辑**只改 `/user` + `js/phira.js`**，别碰那几个 |
| 内联术语气泡（点一下就地出解释） | **没做**。现在只有页底折叠的术语表 |
| 服务端 `PHM_WRITE_SECRET` 轮换 | 要两步同时做（改库 + 改凭据），步骤见 `.env.example` |

---

## 8. 出事了怎么回滚

```bash
# 站点：回滚到上一个 tag，重新部署
git log --oneline -5 && git checkout v0.x.y.z -- . && # 或 git revert
# 然后照 §4 第 6、7 步

# 用户端"缺东西 / 空白"优先怀疑版本号，不是代码：
node tools/smoke-page.mjs https://phm.app.workbuddy.host
#   全新浏览器配置下正常 = 用户缓存问题 → 换版本号是最省事的解
```

**同名版本部署两次**造成的问题，**唯一的解就是换版本号**（URL 变了，旧副本自动绕过）。
别去教用户"强刷一下" —— `immutable` 的年代强刷也没用，而且那个坑我们已经埋掉了。
