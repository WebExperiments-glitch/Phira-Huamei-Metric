# P.H.M. Standard — 开发文档

> **给接手的人**：这份文档的目标是让你**只看 3 个文件就能开始改代码**。
> 没时间的话，按顺序读：**本文件 → `ARCHITECTURE.md` → 你想改的那块源码**。
>
> ⚠ **动代码之前先读 [`HANDOVER.md`](HANDOVER.md)** —— 那份是「部署前必须做什么」和
> 「做了就出事的红线」清单，每一条后面都跟着一次真实事故。跳过它出的事，
> 那份文档里都提前写好了。

---

## 30 秒了解这是什么

一个 Phira / Phigros 谱面难度参考工具。用户拖入谱面包（`.pez` / `.zip`），
浏览器本地解析并算出「参考定数」，同时把**结构特征**贡献到共享缓存里，
让下一个人搜到同一张谱时不必再下载。

**三条必须记住的原则**（所有设计都围绕它们）：

1. **谱面文件永远不上传。** 解析全在浏览器内完成，上传的只有算出来的特征数字。
2. **落库的定数必须由服务端复算。** 客户端算的值只用来做一致性检查，
   永远不会直接写进数据库。
3. **网关不是安全边界。** 它和浏览器同权限、连 Referer 都能伪造，
   攻击者可以完全绕开它直连 REST。所以写权限必须**在数据库里**收回
   （表级 GRANT 已撤销，写路径只剩带凭据的 `SECURITY DEFINER` 函数）。

第 2、3 条合起来才是防投毒。详见 `SECURITY.md`。

---

## 目录地图（照着找就行）

```
phm-web/
├── server.mjs                 ← 后端入口：路由 / 静态托管 / 限流装配
├── write-secret.txt           ← ★ 写入凭据（唯一能写缓存的东西；**已 gitignore，绝不入库**）
├── package.json               ← 只声明 start 脚本，无第三方依赖
├── .env.example               ← 环境变量模板（真值放 .env；说明见 SECURITY.md）
├── downloads/                 ← 客户端 exe 本体；**不在 PUBLIC_DIRS**，只走 /download/phira-huamei.exe
│
├── lib/                       ← 后端横切件（server.mjs 只做装配）
│   ├── cloud.mjs              ← 云数据库访问层：地址 / publishableKey / 写入凭据 / dbFetch
│   ├── review.mjs             ← ★ 服务端复核：下载谱面 + 复算 + 与提交值比对
│   ├── refstore.mjs           ← ★ 服务端读社区参照集（引擎保持纯计算，不认识 fs）
│   ├── hm.mjs                 ← huamei 身份 + 成绩校验（计分真源 phiraScore）
│   ├── hm-accounts.mjs        ← 自建账号：scrypt 哈希 + 服务端自签 HS256 JWT + 验证码
│   ├── hm-code-routes.mjs     ← 邮箱验证码路由（注册 / 重置密码；**登录不需要码**）
│   ├── ratelimit.mjs          ← 限流：进程内预筛 + DB hm_rate_hit 权威计数
│   ├── contribute-ticket.mjs  ← /api/contribute 的 HMAC 贡献凭证（签 / 验）
│   ├── contribute-routes.mjs  ← 换票路由 + 验票 + 服务端复核后落库
│   ├── api-keys.mjs           ← API Key 生成 / sha256 哈希 / 掩码（sk-…）
│   └── download.mjs           ← 下载端点：流式 + Range + ETag
│
├── public/                    ← 静态资源根目录（只有这里的内容会被送出）
│   ├── index.html             ← 落地页 /（定位、双标度、入口）
│   ├── app.html               ← 工作台 /app（拖入 + 搜索 + 定数 + 分享卡）
│   ├── rulechart.html         ← 规则写谱 /rulechart（RPE v160 → .pez，本地生成）
│   ├── charter.html           ← 谱师页 /charter（某谱师的全部作品）
│   ├── user.html              ← 玩家页 /user（成绩 / RKS / 逐谱成绩）
│   ├── data.html              ← 数据管理 /data（全库分页浏览、排序、过滤）
│   ├── settings.html          ← 设置 /settings（上传偏好 / 账号 / Phira / 本机存储 / 主题字体）
│   ├── version.html           ← 版本历史 /version（面向用户；数据源 js/versions.js）
│   ├── download.html          ← 下载页 /download（Windows 客户端）
│   ├── developers.html        ← 开发者文档 /developers（API v1）
│   ├── platform.html          ← API 开放平台 /platform（默认用量 + Key 管理）
│   ├── privacy.html / terms.html ← 法务页（不带版本 meta，也不是 ES module 页面）
│   ├── 404.html               ← 错误页（服务端对未命中路径下发它，状态码仍是 404）
│   ├── robots.txt / sitemap.xml
│   ├── og.png                 ← 分享卡片 1200×630（由 tools/make-og.mjs 生成）
│   ├── data/
│   │   └── ref-com.json       ← 社区参照集 9,508 张（生成物，由 gen-ref.mjs 产出，懒加载）
│   ├── fonts/
│   │   ├── display-serif.woff2 ← 思源宋体子集（默认标题）
│   │   └── display-kai.woff2   ← 霞鹜文楷子集（设置里的「楷体标题」）
│   ├── css/
│   │   ├── base.css           ← 底座：令牌 / reset / 排版 / 布局骨架 / 导航 / 卡片 / 表格
│   │   ├── ui-kit.css         ← 组件：控件 / 按钮 / callout / 芯片 / 字体与字号档位
│   │   ├── motion.css         ← 动效层：入场揭示 / 悬停抬升 / 进度条 / 噪点 / 跨页转场
│   │   ├── docs.css           ← 法务长文版式（privacy / terms）
│   │   └── api.css            ← 开发者文档 / API 开放平台版式
│   └── js/
│       ├── engine.js          ← ★★ 引擎：浏览器与 Node 共用的唯一真源（纯计算）
│       ├── audio-analysis.js  ← ★ 浏览器音频提取：BPM / 拍点 / 踩音点 / 段落
│       ├── phira.js           ← ★ Phira API 客户端（接口陷阱清单写在文件头）
│       ├── ui.js              ← 导航 / 格式化 / 缓存读取 / P.H.M. RKS
│       ├── motion.js          ← ★ 动效运行时（零依赖；减弱动效时整份不执行）
│       ├── settings.js        ← ★★ 用户设置的**唯一真源**：键名 / 默认值 / 读写 / 清理
│       ├── handoff.js         ← 首页 → /app 的 IndexedDB 文件接力
│       ├── i18n.js + i18n/    ← 双语：10 个页面分片，中英写在同一个文件
│       ├── ref-official.js    ← 官谱参照 1,037 张（生成物，由 gen-ref.mjs 产出）
│       ├── release.js         ← 下载页元数据（生成物，由 gen-release.mjs 从 exe 实算）
│       ├── versions.js        ← 用户向版本历史（与 CHANGELOG.md 分工不同）。近两个版本在这里，更早的拼自 versions-archive.js
│       ├── versions-archive.js ← 版本历史的旧条目。拆开的原因：versions.js 只增不减，每次发版都会顶到 900 行上限
│       └── sharecard.js       ← 谱面体检卡导出（横版 1200×630 / 竖版 1080×1920）
│
├── tools/                     ← 生成物 / 测试 / 校验 / 发版脚本（30 个）
│   ├── gen-ref.mjs            ← ★★ 参照集的**唯一真源**（产出上面两个数据文件）
│   ├── gen-release.mjs        ← 从实际 exe 算大小 / sha256 / 客户端版本
│   ├── warm-cache.mjs         ← ★ 批量预热共享定数缓存（默认填金标集）
│   ├── reconcile-cache.mjs    ← ★ 缓存对账（--recompute-stale / --fix，退出码可挂 CI）
│   ├── verify-engine.mjs      ← ★ 引擎回归测试（45 条；--net 比对真实基线）
│   ├── smoke-page.mjs         ← ★ 冒烟（239 条：页面 / 版本号 / 缓存策略）
│   ├── verify-pages.mjs       ← ★★ 真浏览器驱动 UI（123 条，含双语覆盖）
│   ├── test-ui-flows.mjs      ← ★★ 真浏览器交互（24 条：拖文件 / 结果卡 / 字体跨页）
│   ├── test-api-routes.mjs    ← 打完接口 + 贡献凭证认证再验进程没死（48 条）
│   ├── test-ratelimit.mjs     ← 限流（80 条，含禁读 XFF 的防回归断言）
│   ├── golden-engine.mjs      ← 引擎数值金标（固定谱面 → 固定输出，防悄悄变数）
│   ├── check.mjs              ← ★ 一条命令跑完全部非浏览器检查（CI 同款）
│   ├── lint-openapi.mjs       ← ★★ OpenAPI 契约校验（零依赖，81 条）
│   ├── rulechart.mjs          ← ★ 规则写谱 CLI（BPM/难度 → RPE v160 .pez）
│   ├── test-rulechart.mjs     ← 规则写谱单测（28 条）
│   ├── review-gate.mjs        ← ★★ 静态审计：凭据 / 版本 / 白名单 / SQL（含**函数必须有 grant**）/ workflow
│   ├── preflight.mjs          ← ★★ **推送**闸门：review-gate + check（pre-push 钩子调）
│   ├── predeploy.mjs          ← ★★ **发布**闸门：版本/tag/工作区/生成物 + 去库里问「这些 RPC 真能用吗」；
│   │                             加 --prod 复验线上（关键路由 / 版本号 / 白名单 404 / 匿名 API）
│   ├── fuzz-http.mjs          ← ★★ 摧残测试（145 条）：畸形编码 / 超长 / 深嵌套 / 错动词×每个路由 /
│   │                             原始 socket。**判据不是状态码，是打完 /api/health 还通不通**
│   ├── test-resilience.mjs    ← 兜底层单测（9 条）：逼 guardRequest 走一遍同步抛 / reject / 迟抛
│   ├── test-hm-accounts.mjs / test-hm-validate.mjs ← 账号与成绩校验单测
│   ├── lint-slop.mjs          ← 屎山考核（必须 0，含 CSS 括号平衡）
│   ├── lint-i18n.mjs          ← 双语完整性（823 词条 / 805 引用）
│   ├── check-contrast.mjs     ← 配色对比度校验
│   ├── bump-version.py        ← 一次改全站版本号
│   ├── version-module-imports.py ← 给模块 import 补/换 ?v=
│   ├── subset-display-font.py ← 生成标题字体子集（serif / kai）
│   └── collect-display-chars.mjs ← 从渲染后 DOM 采标题用字
│
└── docs/
    ├── README.md              ← 你正在看的
    ├── ARCHITECTURE.md        ← 数据流、分层、设计取舍
    ├── DESIGN.md              ← ★ 设计系统与视觉立场（令牌全表 + 对比度实测 + 给 AI 的配色 brief）
    ├── DATA-MODEL.md          ← 表结构、RPC、权限（改数据库先看这个）
    ├── SECURITY.md            ← 信任边界、风险清单、已知限制
    ├── ENGINE-EXPERIMENT.md   ← ★ 引擎选型实验：为什么是 8 维 / 社区参照，以及所有被否掉的方案
    ├── HANDOVER.md            ← ★ 部署前必做 / 红线清单（动代码前先读）
    ├── RUNBOOK.md             ← ★ 出事时照着做：分诊 / 回滚 / 备份 / 密钥 / 巴士因子演练
    └── PROMOTION.md           ← 宣发手册（各平台差异、逐步操作、可复制文案）
```

> **改前端请先看 `ARCHITECTURE.md` 的「站点结构」与「Phira 接口的硬限制」两节。**
> 后者记的是实测出来的接口边界（例如"成绩只能拿最近 20 条"），
> 不知道这些会写出必然不对劲的代码。

> **页面版本号在 9 个 HTML 里各写一份**（`index.html` / `app.html` / `charter.html` /
> `user.html` / `data.html` / `settings.html` / `version.html` / `download.html` / `404.html`
> 的 `<meta name="app-version">`）。`privacy.html` / `terms.html` 是法务静态页，
> 不带版本 meta，也不是 ES module 页面，所以不在清单里。
> **必须一起改** —— `smoke-page.mjs` 有一条「各页版本号一致」的断言守着它，漏改会被测试拦住。
> 页头标签、页脚、引擎与分享模块的缓存版本串都从它取。
>
> ⚠ `ENGINE_VER`（引擎模块里导出，当前 `com-trim15-v0.5.0`）是**另一根轴**：
> 它是算法版本，会作为 `engine_build` 写进数据行。**引擎一改就必须改它** ——
> 变了之后所有缓存都与新区间不可比，必须重算（`reconcile-cache.mjs --recompute-stale`）。
> 前端不再手写这个串，统一用 `ENGINE_VER`（曾经在 4 个地方各写一遍 `"5d-knn-v0.3.2"`）。
>
> 版本号也别在别处再写死（曾经 `<title>` / 页头 / 页脚 / README 四处各一份，改一处忘三处）。
> `public/404.html` 是唯一的例外 —— 它是纯静态错误页、不加载模块，所以自带一份。

**按任务找文件：**

| 我想改… | 看这个 |
|---|---|
| 难度算法 / 特征 / k-NN | `public/js/engine.js` |
| 页面交互 / 渲染 | `public/app.html`（**工作台主体**，找对应函数名）。⚠ 里面还有约 300 行**休眠代码**（玩家面板迁到 `/user` 后遗留），见 `ARCHITECTURE.md` 的已知技术债 |
| 分享卡片的版式 / 文案 | `public/js/sharecard.js` |
| 分享卡上的二维码 | `public/js/qr.js` —— 编码器是 `public/vendor/uqr.mjs`（MIT）。⚠ **模块边长必须整数**：`size/total` 得到小数再逐格 round，格子会在 3/4 像素间交替，看着正常但解码器认不出（实测 132px 的码 jsQR 完全解不开）。另外每模块至少 3–4px。 |
| `/app?chart=<id>` 深链 | `public/js/deeplink.js` —— 谱面文件由浏览器**直连** Phira CDN（CSP `connect-src` 已放行 `phira.5wyxi.com`）。⚠ 与首页接力互斥，否则会分析两遍。 |
| 自动写谱（MP3 → 提取 → RPE v160 .pez/.zip） | `public/js/audio-analysis.js` + `public/js/rulechart.js` —— 浏览器本地提取/排谱，页面 `/rulechart` |
| 自动写谱 · 时间轴（A） | `public/js/rhythm.js` —— 拍网格 / 相位精调 / **量化（含三连音）** / 乐句边界。⚠ 量化不是「吸到 1/4 网格」：层级 1·2·3·4·6，**故意不含 1/8** —— 三十二分太细，有了它任何位置都能被「对上」，容差就形同虚设。层级代价 `SUBDIV_COST_MS` 保证「简单读法优先」|
| 自动写谱 · 事件选择（B） | `public/js/salience.js` —— 给每个候选打**音乐显著性**（强度打底 × 拍位 × 声部，乘子结构不是加权求和），再按分数选到目标数量。⚠⚠ **绝不凭空造音符**：候选不够就少给，`shortfall` 如实上报。同一份文件还负责映射判定线（按「哪只手更空」分配，不是 i%2 机械交替）|
| 自动写谱 · 可玩性（C） | `public/js/playability.js` —— 独立审计器：时间冲突 / 同手过近 / 过密（按**时间窗**不按总数）/ 连续操作负担 / 异常长串 / 节奏可读性 / 目标难度偏差。error 折进 `violations`（不能下载），warn 折进 `warnings`（能下但提示）。⚠ **free 模式也查同手间隔** —— 以前 `if (!free)` 整条跳过，而 2 指自由分散恰恰最需要查 |
| 登录 / 注册 / 会话 / 档案 | `public/js/auth.js` —— **app / platform / settings 三处页面的唯一入口**（2026-10-20 起自建账号，不再有云 SDK）。⚠ 分三层：① 纯函数（邮箱规范化 `normalizeEmail`、密码策略 `pwProblem`、错误分类 `classifyAuthError`）可单测 ② `createAuth()` 工厂管状态机 + 节流 + 倒计时 ③ 调用方只按 `error.kind` 翻文案。⚠⚠ **token 走 `x-hm-token` 头，不是 `Authorization`** —— 托管网关会吃掉入站的 Authorization（`/api/hm/play` 上真实踩过：本机全绿、线上每步 401）。token 存在 localStorage 的 `phm_hm_token`，**不在 `settings.js` 的键名白名单里** —— 所以「清空设置」不会把人踢下线 |
| 账号服务端 | `lib/hm-accounts.mjs`（scrypt 哈希 + 自签 HS256 JWT + 真验签）· `lib/hm-code-routes.mjs`（注册/登录/发码/重置）· `lib/hm-profile-routes.mjs`（档案 / 绑定 / 注销）。⚠ 自签与平台 token 的差别是**能不能验签**：平台密钥在平台手里，服务端只能解析 `sub`，等于谁都能伪造；自签的密钥只在服务端 |
| 全局错误兜底 | `public/js/guard.js` —— `error` / `unhandledrejection` / 断网三类提示，右上角 toast。**原本全站只有 app.html 接了 rejection，其余 9 页静默无痕**。自包含页 `phm-api.html` 内联一份（改名 `_gcut` 避开重名） |
| 技能分（难在哪） | public/js/skills.js —— 把 feats 的 39 个特征重组为 stamina/dexterity/reading/precision 四技能。纯展示层：不改数值、不动 ENGINE_VER、不进 k-NN 的 REF_DIMS，所以不需要重算缓存。⚠ 只在「刚分析完」的响应里给 —— phm_charts 表没有 feats 字段，缓存行算不出来 |
| 谱面包 / 资源打包下载 | `public/js/chartfiles.js` + `public/js/chartfiles-core.mjs` —— 页面 `/packs`。**零中转**：服务器只代理 JSON 元数据，曲绘/音乐/chart 文件一律**浏览器直连 Phira CDN**，`.pez` 在浏览器本地用 `rulechart.js` 导出的 `zipStore` 打包。⚠ 纯函数层必须在 `public/js/` 不能放 `lib/` —— `lib/` 不在静态白名单里 |
| 接口路由 / 校验 / 限流 / 静态托管 | `server.mjs` |
| 曲绘为什么加载不出来 | `lib/chartassets.mjs` —— 上游 MIME 是 `application/octet-stream`，浏览器 **ORB** 会拒绝解码（`ERR_BLOCKED_BY_ORB`），所以展示用曲绘必须过我们的代理改 MIME。排查曲绘空白时先看这里，别再怀疑 CDN 挂了 |
| 数据库地址 / 写入凭据 / 读写封装 | `lib/cloud.mjs` |
| 服务端复核逻辑 | `lib/review.mjs` |
| 数据库表或权限 | `docs/DATA-MODEL.md` → 然后用 MCP 执行 SQL |
| **用户设置 / 上传开关 / 本地存储** | `public/js/settings.js` —— **键名只在那里定义一处**，页面里别再写 `localStorage.getItem("phm_…")` |
| 隐私相关文案 | `public/privacy.html` + `app.html` 页脚的设置面板 + `/settings` 页 |
| 要发帖子 / 写宣发文案 | `docs/PROMOTION.md` |

---

## 批量预热共享缓存

```bash
cd phm-web
node tools/warm-cache.mjs --dry-run          # 先看计划，不下载
node tools/warm-cache.mjs --limit 600        # 填金标集（Ranked + Special，约 631 张）
node tools/warm-cache.mjs --types 0          # 只填 Ranked
```

**为什么需要它**：页面的价值取决于「搜任何一张谱都能出定数」。空库时来的人
看到「定数缓存 15 张」就走了 —— 所以推广前先把库填起来。

**选哪批**：默认填 **金标集**（`type=0` Ranked 581 张 + `type=1` Special 50 张）。
这批是计入 rks 的谱，正是玩家会在意定数的那些，比按创建时间乱抓一批有用得多。

**凭什么可信**：脚本直接复用服务端的复核链路 `lib/review.mjs → recompute()`，
没有任何客户端数值参与。落库仍走受凭据保护的 `phm_put_chart()`。

**断点续跑**：每次开始先拉一遍已有的 `chart_id`，已缓存的直接跳过。中断了重跑即可。

⚠ 约 7 GB 流量、20~40 分钟。刻意做成**串行** —— 并发下载对 Phira 不礼貌，
而且 `analyzeChart` 是同步计算，并发也压不出吞吐。

---

## 分享与传播

四个平台的**链接可点性完全不同**，这决定了打法：

| 平台 | 链接直达 | 卡片预览 | 打法 |
|---|---|---|---|
| QQ 频道 / 群 | 可点，但陌生域名易被折叠 | og 卡片 | 先图文建信任，链接放简介 |
| 抖音 | **基本不可点** | 无 | 画面自带域名，引导搜索 |
| B站 | 简介可点（有风控） | 动态可点 | 视频 / 专栏打长尾 |
| X | 可点 + 大图卡片 | og 大图 | 唯一能直接发链接的，用英文页 |

**所以核心资产是同一张图**：`public/js/sharecard.js` 让用户算完一张谱就能导出
「谱面体检卡」—— 横版 `1200×630`（QQ / B站 / X）、竖版 `1080×1920`（抖音 / 小红书）。
卡上自带曲名、数字和域名，观众照着搜就能进来。

> 竖版刻意**底部留 ~250px 空白** —— 那是抖音播放页 UI 压着的地方，写东西会被挡住。
> 曲名在竖版里折两行（抖音上曲名被截一半，这张图就白做了）。

英文页 `en.html` 是**独立实现**（只做拖入 / 搜索 / 分享三件事），
不加载云 SDK —— 只读展示没必要引入整个账号体系。它用 `/api/charts?ids=` 批量读缓存。

---

## 跑起来（本地）

```bash
cd phm-web
node server.mjs          # 默认 3000 端口
# 或指定端口
PORT=8080 node server.mjs
```

打开 <http://localhost:3000> 即可。

**注意**：云服务相关功能（账号、缓存读写）**只在注册的发布域名上工作**，
localhost 上会被服务端的 Origin 校验拒绝 —— 这是设计如此，不是 bug。
本地开发主要验证：解析、计算、UI 渲染。

**部署**：用 `sites` 能力发布 `phm-web/` 目录即可（这是一个 Node HTTP 服务）。

---

## 改代码前必须知道的三件事

### 1. 引擎必须保持"纯计算"

`public/js/engine.js` **同时被浏览器和 Node 服务端加载**。

> **它不能碰 DOM、localStorage、网络请求、文件系统。**

只能：`ArrayBuffer` 进 → 特征对象出。

**为什么**：服务端要靠它复算来验证客户端提交的定数（防投毒）。
一旦引擎里引入了浏览器专有 API，服务端就跑不起来，防投毒失效。

**加功能前先自问：这段代码在 Node 里能跑吗？**

### 1.5 支持哪些谱面格式（选文件靠**内容嗅探**，不靠后缀名）

| 格式 | 形态 | 怎么认出来 |
|---|---|---|
| **RPE**（Re:PhiEdit，社区主流） | JSON，顶层有 `judgeLineList` | 内容以 `{` 开头且含 `judgeLineList` |
| **PGR**（Phigros 官谱） | JSON，判定线里带 `notesAbove/Below` | 同上，走 `loadChart` 的另一条分支 |
| **PEC**（PhiEditer，行式文本） | 第 1 行整数、第 2 行 `bp …` | `isPecText()` |
| **PBC** | 二进制，经 prpr-pbc 编译 | ❌ 暂不支持 |

⚠ **绝对不要改成按后缀名选文件。** Phira 上确实存在
「文件名叫 `.json`、内容其实是 PEC」的包（Re:PhiEdit 的「导出为旧 PEC 格式」就是这样）。
按后缀名选会让这些谱直接判成「包里没有谱面文件」—— 实测金标集 631 张里
**131 张（20.8%）** 因此算不出来，补上 PEC 后**全部通过**。

新增格式时只需要做一件事：把它归一成
`{notes, real, dur, bpm, nlines, ev}`，然后交给 `reportFromChart()`，
特征提取与打分完全复用。

### 2. 改完引擎一定要真实执行一次

历史上出过这样的事故：编辑时把 `=>` 的 `>` 吃掉了，变成 `en=({...})` ——
这是**合法语法**（把对象赋值给变量），`node --check` 和新 Function 都检查不出来，
但运行时会抛 `ReferenceError`，导致线上**所有谱面解析失败**。

**所以**：任何解析相关改动，都要跑回归测试：

```bash
cd phm-web
node tools/verify-engine.mjs          # 离线合成用例，秒级，不联网
node tools/verify-engine.mjs --net    # 额外拉真实谱面比对基线值
```

退出码非 0 表示挂了 —— 可以直接接进 CI 或 pre-commit。

**`--net` 为什么关键**：它拿的是**服务端已复核入库**的期望值（Pandemic 16.6、
Quon 1125 音符 / 108 Hold 等）。这些基线一挂，说明线上所有已缓存定数都失效了，
必须重新跑 `warm-cache`。

**语法检查 ≠ 功能验证。**

### 3. 前端是 `type="module"`，不是全局脚本

`app.html` 里的主逻辑是 ES module。它通过顶部这几行把引擎摊到全局：

```js
import * as __ENGINE from "/js/engine.js";
Object.assign(globalThis, __ENGINE);
```

所以下面的代码可以**继续直接写** `zipParse(...)` / `analyzeChart(...)`。
**但注意**：module 里定义的函数**不再是 window 属性**，
如果哪天要加内联事件（`onclick="..."`），那是坏的 —— 请继续用事件委托。

---

## 关键流程速查

### 拖入谱面（主路径）

```
用户拖入 .pez
  → handleFiles()            [app.html]
  → analyzeChart()           [engine.js]  本地解析，文件不出浏览器
  → 渲染卡片（参考定数 / PS / 特征）
  → 若开关开启：contributeChart() 逐张串行
       → 按谱名精确匹配 Phira chart_id
       → POST /api/contribute {chart_id, 特征}
            → server 复核（下载谱面 + 复算 + 比对）
            → 写入**服务端算出的值**
```

### 查询 Phira 账号

```
输入用户名/UID
  → pfFindUser() → pfSearch()        [user.html · js/phira.js]
       （⚠ app.html 里有一份同名休眠副本，别改那里）
  → 取 B19 / 最近成绩 + 谱面信息（并发池 5）
  → 若是本人确认过的账号 → 自动导入成绩
```

### 修改数据库

数据库没有迁移文件，结构变更通过 MCP 工具执行 SQL 完成。
**改之前先读 `docs/DATA-MODEL.md`**，改完之后**同步更新那份文档** ——
文档和实际结构不一致是这个项目最容易犯的错。

---

## 常见坑（都踩过）

| 现象 | 原因 |
|---|---|
| 部署报 `service did not become reachable` | 沙箱偶发故障，**先本地 `node server.mjs` 复现**，本地正常就直接重试 |
| Windows 上 `pkill -f` 杀不掉 node | Git Bash 的 pkill 对 Windows 进程无效，用 PowerShell 按 CommandLine 匹配 |
| 本地打开页面但云功能报错 | 正常现象，见上文"跑起来" |
| 改了 `engine.js` 线上没生效 | 浏览器缓存了模块，硬刷新；并确认 `<meta name="app-version">` 已更新（版本串是各模块的 cache-buster） |
| 服务端复核失败写不进库 | 看响应里的 `note` 字段，通常是图谱名匹配不上或下载超时 |
| **刚改完文件跑测试，报的却是改之前的错** | `server.mjs` 的 gzip 缓存**按 mtime 失效**。同一秒内连续写同一个文件，mtime 可能没变 → 服务端仍在发旧内容。**改完等一下再跑测试**，或直接重启本地服务 |

---

## 想深入了解

- **为什么这么设计** → `ARCHITECTURE.md`
- **谁能读写什么** → `DATA-MODEL.md`
- **信任边界在哪、还有什么没解决** → `SECURITY.md`
