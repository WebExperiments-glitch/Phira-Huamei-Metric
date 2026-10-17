# 版本记录 · P.H.M. Standard

> 这份文件是**版本号的唯一真源**。commit 标题里的版本号只是顺手写的备忘，
> 冲突时以本表为准。
>
> 规矩见 `docs/ARCHITECTURE.md`「版本策略」：四段式 `V{a}.{b}.{c}.{d}`，
> 第 4 位 = 纯前端小改、第 3 位 = UI/结构改动、第 2 位 = 后端/数据层改动，
> 第 1 位暂无规则（要动先问）。**每次发版必须打同名 tag**。

## 为什么会有这份文件

早先的版本号是「想起来才写」的，结果：有的 commit 写了版本、有的没写；
同一个版本跨了十几个 commit；`V0.8.2 → V0.9.0` 中间没有 0.8.3 直接跳过去；
版本号还一度写成三段（`V0.9.0`）。GitHub 上没有 tag，
所以从仓库页面根本看不出"现在是什么版本"。

现在：**版本号由 `tools/smoke-page.mjs` 的断言守着**（必须四段、各页一致、
样式表与模块的 `?v=` 必须同串），**发布时由 `tools/bump-version.py` 一处改全站**，
并且每次发布打一个 tag。

> 历史版本一律**补零成四段**再打 tag（`V0.4.0` → `v0.4.0.0`），
> 这样 Tags 页面读起来是一条干净的线。当时 commit 里写的三段记法保持原样不动
> —— 改写已推送的历史风险更大，没有收益。

## 版本表

| 版本 | 日期 | commit | 内容 |
|---|---|---|---|
| `V0.17.4.0` | 2026-10-18 | 本次 | **回到旧图风格**：全 Tap、一次一个、13 个分散 x、单判定线；去掉 Hold/Flick/Drag、装饰线、move/rotate/alpha 动效。节奏按 onset 时间，稀疏处只补整拍/半拍。目标物量 2K：EZ 2.0 / HD 2.6 / IN 3.6 / AT 4.0 NPS。旧 .pez 必须重新生成。 |
| `V0.17.3.0` | 2026-10-18 | 本次 | **2K 改为 2 指分散谱**。① 误解修正：2K 不是两条固定轨道，而是两根手指可打、音符 x 分散在整屏。② 位置改为 ±540 范围内 12 个分散 x，左右手交替；同一时刻最多 1 note，不再出和弦。③ 保留 onset→拍网格吸附。④ 旧 .pez 必须重新生成。 |
| `V0.17.2.1` | 2026-10-17 | 本次 | **2K 轨道拉开**：LANES[2] 从 [-225,225] 改为 [-450,450]，两条键位更明显；避免“只有单一键位”的视觉。旧 .pez 需重新生成。 |
| `V0.17.2.0` | 2026-10-17 | 本次 | **节奏吸附 + 2K 轨平衡**。① onset 候选先按检测拍网格吸附（EZ 1/4、HD/IN 1/8、AT 1/16 拍），不再直接写原始频谱峰值时间。② 2K 左右轨由左右手交替产生，内部生成统计约 50/50，避免单键观感。③ 旧 .pez 需要重新生成；页面版本 V0.17.2.0 用于强制刷新缓存。 |
| `V0.17.1.0` | 2026-10-17 | 本次 | **固定 2K**。① 所有难度预设 lanes=2，移除 4K/6K/7K。② 2K 目标 NPS：EZ 2.0 / HD 2.6 / IN 3.6 / AT 4.0；同轨间隔/和弦上限同步收紧。③ 系统判档阈值与密度解耦：potential <4.2 EZ / <5.6 HD / <7.0 IN / ≥7.0 AT，再按档生成 2K 密度。④ 当前手被 Hold/间隔挡住时允许换手，减少 2K 漏音。 |
| `V0.17.0.0` | 2026-10-17 | 本次 | **系统判定难度 + 频谱重心选轨**。① 新增 `detectDifficulty(analysis)`：按 onsetRate、段落能量、频谱重心、踩音强度、BPM 估算潜力 NPS，映射到最接近的 EZ/HD/IN/AT；页面移除难度按钮，只显示系统判定与依据。② 参考 BMS-Generator 的规则写谱：audio-analysis 增加逐帧频谱重心，排谱按重心选轨（亮→右、暗→左），补位也用最近轨道。③ 副歌不生成 Hold，IN/AT 降低 Hold 权重、限制最长拍数，减少「满屏长条」。 |
| `V0.16.0.3` | 2026-10-17 | 本次 | **按真实谱面统计重做规则**。① 统计 `data/community.jsonl` 9,684 张 Phira 谱面：Tap 55–62% / Drag 22–35% / Hold 9–13% / Flick 5–8%，中位 NPS 4–12、判定线 24–30。② 规则改为真实类型权重与目标 NPS（EZ 3.6 / HD 5.2 / IN 7.8 / AT 11），新增 7K 轨道、按拍网格补位（同拍最多 maxChord）、Hold 区间避让与最终结构修复。③ 主判定线增加 moveX/moveY/rotate/alpha 段落事件，并加 3 条装饰线。④ 修复校验器把普通 note 误判为 Hold 重叠的问题。 |
| `V0.16.0.2` | 2026-10-17 | 本次 | **Phira 导入修复**：`META.offset` 之前写入浮点秒（如 0.3947392290249433），RPE 要求 i32 毫秒，导致「JSON 解析失败 / expected i32」。现固定为整数 0（谱面时间已按音频绝对拍点生成，不需要额外偏移）；单测 28 条。 |
| `V0.16.0.1` | 2026-10-17 | 本次 | **自动写谱校验修复**。① `validateChart` 使用音频难度预设（EZ/HD/IN/AT）的 minGap/maxChord，不再把 IN/AT 误按 HD 的 0.5 拍判失败。② 生成 ID 改为 `slug_短哈希_难度`，中文曲名不会被清成纯数字。③ 实测真实 MP3（120.2 BPM / 2:08）四难度全部 0 违规并生成 .pez/.zip。 |
| `V0.16.0.0` | 2026-10-17 | 本次 | **导入 MP3 自动写谱**。① 新增 `public/js/audio-analysis.js`：浏览器 `decodeAudioData` → 单声道 22050Hz → 短时傅里叶 → 谱通量 onset → 自相关 BPM → 拍相位 → 峰值踩音 → RMS 分段；输出 BPM/时长/拍点/踩音点/段落。② 重写 `/rulechart` 页：拖入 MP3，自动显示提取结果；移除手填 BPM/时长/密度/轨道/种子；难度改为 **EZ / HD / IN / AT**。③ 新增 `buildChartFromAnalysis`：用真实踩音点/拍点/段落能量排谱，规则校验通过才允许下载。④ 下载提供 `.pez`、`.zip`（同一 ZIP：info.txt + chart JSON + 音频 + 封面）与单独 JSON。⑤ 单测 27 条（含自动 BPM/踩音提取、自动排谱、可复现）；check 17 项。 |
| `V0.15.0.0` | 2026-10-17 | 本次 | **规则写谱**。① 新增 `/rulechart` 页与 `public/js/rulechart.js`（零依赖，浏览器/Node 通用）：BPM/时长/难度/轨道/密度/种子 → RPE v160 chart + `.pez`（info.txt + chart JSON + audio + background）；内置 5 档规则、2K/4K/6K、音符类型/和弦/轨道最小间隔；无音频时生成 22050Hz click WAV；封面为 stdlib PNG；ZIP 用 store 方式纯 JS 打包。② 新增 `tools/rulechart.mjs` CLI 与 `tools/test-rulechart.mjs` 20 条单测（含规则校验）；check 17 项。③ 导航新增「写谱」，i18n 中英；smoke 239 条。④ 新增 `phm/audio2pez` 二次修改版（上游 MIT）：`--from-points` 接踩音模型，points 模式去掉 librosa 硬依赖、封面改 stdlib PNG、无音频自动 click 音轨、移除 Gradio。⑤ 版本 V0.15.0.0。 |
| `V0.14.0.0` | 2026-10-17 | 本次 | **API Key 权限模型 + OpenAPI 单一契约**。① 新增 `db/api-v2.sql`（`hm_api_key_meta` 表 + `hm_api_key_meta_set` / `hm_api_key_lookup` / `hm_api_key_list` / `hm_api_usage_key_summary`）；旧 Key 无 meta 行时默认全部 scope、永不过期。② `/api/v1/keys` 创建支持 `scopes[]` 与 `expires_in_days`；PATCH 可改权限/到期；新增 `POST /keys/{id}/rotate`；缺少 scope 返回 403 `insufficient_scope`，过期返回 401 `expired_api_key`。③ `GET /usage` 对 API Key 增加 `key_usage`（今日/7日/30日 + 按接口）。④ 新增 `api/openapi.json` 单一契约，`/api/v1/openapi.json` 原样返回；`tools/lint-openapi.mjs` 81 条结构/路径/operationId/scope 校验，CI 变为 16 项。⑤ 开放平台创建 Key 支持权限勾选与到期选择，列表显示权限/到期，新增轮换按钮。⚠ 部署前需先执行 v2 迁移；未迁移时服务会回退为「全部权限、永不过期」并在创建时提示。 |
| `V0.13.2.2` | 2026-10-17 | 本次 | **部署对账 + Key 诊断**。① 新增公开 `GET /api/v1/meta`（api/service/engine/build time），OpenAPI 同步；服务端版本从 package.json 读取，用于识别「静态页面新、server.mjs 旧」的部署错位。② 单文件客户端启动/保存 Key 时读 `/meta`，在连接状态里显示服务端版本。③ 401 不再一律说「Key 无效/已吊销」：区分 `account_token_invalid`（服务端 API 版本过旧）、`invalid_api_key`（复制少字符/吊销/环境不一致，提示对照掩码或新建）、其他 401 显示 code。 |
| `V0.13.2.1` | 2026-10-17 | 本次 | **吊销 Key 从列表消失 + 创建 Key 弹窗**。① `GET /api/v1/keys` 与平台页列表都过滤 `revoked_at`，删除后立即消失；「有效 Key」计数同步。② 创建 Key 由页内嵌块改为模态弹窗：一次性明文 + 复制 + 安全提示，关闭后不可再查；顶部 toast「API key 已创建」。③ 删除成功 toast「API key 已删除」。 |
| `V0.13.2.0` | 2026-10-17 | 本次 | **API 开放平台入口**。① 顶栏新增 `/platform`（中英 i18n：API 开放平台 / API Platform），位置在「设置」与「下载」之间。② 新页面 `platform.html`：左侧「用量信息 / API keys / 接口文档 / 单文件客户端 / 返回站点」；默认落在用量信息（今日 / 7 天 / 30 天 / 有效 Key + 按接口分布条形图 + 免费额度）；API keys 视图复用 Key 创建/改名/吊销与一次性明文展示。③ 未登录显示平台介绍 + 登录入口；登录后显示账号与真实用量。④ `/developer` 保留为旧链接别名，文档/客户端/页脚链接统一指向 `/platform`。⑤ smoke 增加该页、导航入口断言 7→8；i18n 新增 `nav.platform` 中英两条。 |
| `V0.13.1.0` | 2026-10-17 | 本次 | **单文件 API 客户端**。① 新增 `public/phm-api.html`：零依赖单 HTML，内联样式/JS；填 `sk-` API Key 后调用 `/api/v1/charts/{id}` 与 `/api/v1/analyses`，展示双标度、标称、PS、物量、引擎与原始 JSON；Key/API 地址存 localStorage，支持最近查询、主题切换、用量读取。② 自带「下载本文件」（fetch 当前文件生成 Blob；file:// 下回退 outerHTML）与 Windows 客户端入口；`/download` 页新增单文件客户端卡片。③ 路由 `/phm-api`、白名单、smoke 新增该页。 |
| `V0.13.0.0` | 2026-10-17 | 本次 | **开发者 API v1 + 控制台**。① 新表 `hm_api_keys` / `hm_api_usage` + 8 个 SECURITY DEFINER RPC（创建/查询/列表/改名/吊销/touch/用量写入/汇总），RLS 开、无直连。② Key 格式 `sk-<32 hex>`，库里只存 sha256 哈希 + 掩码；每账号最多 100 个有效 Key，支持改名与吊销。③ `/api/v1/*`：`GET /charts/{id}`（读缓存）、`POST /analyses`（服务端复核并写缓存）、`GET /usage`、`GET/POST /keys`、`PATCH/DELETE /keys/{id}`、`GET /openapi.json`；CORS + OpenAI 风格错误体。④ 配额：匿名 100 次/小时；Key 1000 次/小时、分析 200 次/天；超限 429 / 限流器故障 503。⑤ 新页面 `/developers`（快速开始/认证/接口/错误码/限流/更新日志）与 `/developer`（登录后 Key 管理 + 用量卡片）；复用 `base.css` + `ui-kit.css`，新增 `css/api.css`。⑥ 测试：API Key 8 条、API 端到端 15 条（匿名/无效 key/创建/列表/读写/用量/改名/吊销/CORS）、smoke 增加两个新页面。 |
| `V0.12.1.1` | 2026-10-17 | 本次 | **隐私政策与自建账号对齐（合规修复）**。① `privacy.html` + `i18n/legal.js`（中英）同步重写：原文「不会收集密码、邮箱」与「账号数据由 WorkBuddy 认证模块存储」在 V0.10.0.0 自建 `hm_accounts` 之后已不准确 —— 改为：邮箱 + 密码只在主动注册 P.H.M. / huamei 账号时处理；网页端账号仍走平台认证，huamei 账号由本站服务端处理，明文只在 HTTPS 请求内进入内存、随即 **scrypt 哈希**存入 WorkBuddy 云 PostgreSQL 的 `hm_accounts`（只存邮箱 / 盐 / 哈希，不写日志）。② 注销路径写清：网页端账号可自助删除站内资料；huamei 账号可邮件申请删除 `hm_accounts` 行；平台侧登录邮箱需另行申请。③ §7 对外提供清单补「邮箱验证码发送 / 密码哈希」；政策版本 v1.1 → **v1.3**，生效日期 2026-10-17，新增 v1.3 变更说明。④ 无新增收集范围。 |
| `V0.12.1.0` | 2026-10-17 | 本次 | **白帽复测后的写面加固（认证 + 成本面）**。① **`/api/contribute` 原先无认证**：任意 chart_id 都会让服务端下载 ≤60MB 谱面并同步跑引擎。复算机制保证了数据正确（提交 777.77 落库仍是引擎算出的 13.94），但成本面完全敞开。新增**服务端签发的 5 分钟 HMAC 贡献凭证**（`lib/contribute-ticket.mjs`）：客户端先用 chart_id 换票（换票只查 Phira 元数据、**不下载谱面**，并与 `/api/analyze` 共用限流），`/api/contribute` **先验签/过期/IP/chart_id 覆盖、再读 body**；无票/假票一律 401。② **chart_id 白名单**：换票前用 `chartInfo()` 确认该谱真实存在且带 `file` 字段，随便塞 id 触发下载的路径关闭。③ **错误信息泛化**：不再回显 `{rows:[]}` 等请求结构（白帽就是靠这句推断出批量格式的）。④ 路由拆到 `lib/contribute-routes.mjs`（换票/验票/复核写库），`server.mjs` 回到 860 行（lint-slop 900 上限）。⑤ 客户端 `public/app.html` 贡献前先换票；旧缓存页面会收到 401 并提示刷新。⑥ 测试：`test-api-routes` 17→**22**（无票/假票/换票参数/结构泄露 5 条）、新增 `test-contribute-ticket` **11/0**、`lint-docs` **79/0**。⑦ 审计副作用：4 条**真实复算**记录落库（total 656→660、withDiff 536→540），落库值是服务端计算结果、不是伪造值；清理需走 MCP SQL（清理语句见 `SECURITY.md` 的贡献加固一节）。 |
| `V0.12.0.0` | 2026-10-17 | 本次 | **两项收尾：注册要邮箱验证码 + 霞鹜文楷字体档位**。① **`REQUIRE_EMAIL_CODE` 默认翻到"开"**：原先默认关，因为唯一注册入口是 Windows 客户端而它不带 `code` 字段；关着等于**可以拿任意邮箱批量注册**（白帽报告第 4 条）。现在写成 `process.env.REQUIRE_EMAIL_CODE !== '0'` —— **没配环境变量时落在安全的一侧**，只有显式 `=0` 才关（过渡期逃生口）。② **客户端跟上验证码**：`huamei::send_code()` 新接口 + `HuameiStage::WaitCode`（邮箱→密码→**验证码**），注册时**先发码再问码**（顺序反了用户会盯着屏幕等一封还没寄出的邮件）；填错只重弹输入框、不退回流程起点；发码用独立任务 `huamei_code_task` —— 塞进 `huamei_task` 会被当成"登录/注册结束"而弹「已登录」。验证码类错误码全部翻成人话（`code_required`/`code_wrong`/`code_expired`/`code_used`/`code_too_many`/`send_failed`…）。客户端 `0.8.2-huamei.13`。③ **新增「楷体标题」档位**：霞鹜文楷 Regular 14.9MB → **63KB 子集**（`tools/subset-display-font.py` 改成一套脚本产出 serif/kai 两套，共用 `display-chars.txt`）；文楷只有 Regular，标题 CSS 是 600，所以 `[data-font="kai"]` 显式 `font-synthesis-weight:none`，否则浏览器算法伪造粗体会把笔锋糊掉。④ **修「字体/字号只在设置页生效」**：那段引导脚本原先只写在 `settings.html` 的 `<head>` 里，其余 9 页从不读 `phm_font`/`phm_size` → 一切换页面就回默认。现在每页 `<head>` 都有（404 自包含页除外）。⑤ 构建环境：`cargo check` 会重新触发 prpr-avc 的 FFmpeg 下载并因 schannel 吊销检查失败；用 `curl --ssl-no-revoke` 手动取包放进 `prpr-avc/static-lib/<target>/` 并补 `.version`，再按 README 用 `--no-default-features` 构建（带默认特性会多编一套 video，产物 43.5MB vs 36.8MB）。`z.lib` 是 `build.rs` 无条件链接但 FFmpeg 静态库实际没用到的符号位，补一个空占位库即可 |
| `V0.11.2.0` | 2026-10-17 | 本次 | **评审收尾（B 版式 / 首页接力 / 顶栏 GitHub）+ 修掉一处静默的全局 CSS 故障**。① **修 `base.css` 花括号不平衡**：`.btn {` 被写重了一行（`min-height:40px;` 后面又开了一个同名块），于是**第 368 行往下的整份样式表都成了 `.btn` 的嵌套规则**，全部失效 —— 控件高度、focus 环、字体/字号档位、窄卡、芯片一条都没生效，而浏览器不报错。这是 `V0.11.0.4` 那批「UI 规整」没看到效果的真因。`lint-slop` 新增第 6b 条规则守括号平衡（含注释/字符串跳过）。② **样式表拆分**：控件与组件整段移到 `public/css/ui-kit.css`（base.css 703 → 523 行，回到 700 行上限内），10 个页面在 base.css 之后引它。③ **首页接力**：hero 下加虚线投放区，拖入 `.pez` 不再「松手→点按钮→再拖一次」，而是暂存进 IndexedDB（Blob 进不了 sessionStorage）后跳 `/app?drop=1`，由 `/app` 取出即删、直接开算；交接失败静默退回老路，失败不阻塞主流程。页面任意位置误拖文件也会被接住。④ **表单卡收窄到 720px 居中**（谱师/玩家页），「为什么要两步」收进 `<details>`，空出的位置放**可点的例子**与**最近查过**（新 `KEYS.recent` 单键存 JSON，仍走 `settings.js` 这一层）。⑤ **顶栏加 GitHub 入口**（原先散在各页中段/页脚），smoke 的导航探活改为只探站内链接（外链在这个 fetch 里必然 ERR，不代表链接坏了）。⑥ 新增 `tools/test-ui-flows.mjs` **18/0** —— 真浏览器里拖文件、验结果卡渲染、验芯片，专治「176 条冒烟断言抓不到渲染层崩溃」；同时清掉 8 条僵尸词条、把 `6thPecJam`（实测查无此人）换成核对过的 `Mivik` |
| `V0.11.1.1` | 2026-10-17 | `8cf6b94` | 结果卡的**刻度尺**加细刻度（每格 1 个定数点）+ 两标度间虚线 + 中间直接标差値（Δ0.5）；统一同一页面的三个叫法为「算定数」 |
| `V0.11.1.0` | 2026-10-17 | `e1741bf` | 设置页新增**「标题字体」**（思源宋体 / 全黑体）与**「字号」**（小/中/大三档）两组开关；实现为 `:root[data-font]` / `[data-size]` 只覆盖令牌，不改具体选择器 |
| `V0.11.0.8` | 2026-10-17 | `d2f57a4` | 删掉算定数页重复的「我的成绩 / 找谱师」入口条（与顶栏重复） |
| `V0.11.0.7` | 2026-10-17 | `ef92517` | **紧急**：结果卡 `card()` 里引用已删除的 `rows` → `ReferenceError`，拖谱面完全没反应。删除孤儿行修复 |
| `V0.11.0.6` | 2026-10-17 | `cdb1bf8` | 补 `.btn.primary` 选择器 —— 标记用的是 `class="btn primary"` 两个类，此前写的 `.btn-primary` 匹配不到，两个主操作按钮一直没上色 |
| `V0.11.0.5` | 2026-10-17 | `a9764b5` | 删掉页脚里的开发笔记（把「9 维 log1p 特征 / 双参照 k-NN / 源码文件」这类实现说明改成用户能懂的一句话） |
| `V0.11.0.4` | 2026-10-17 | `d205fcd` | UI 规整第 1 批：表单控件与按钮同高同圆角、明确聚焦态、说明段统一口径、字阶收成 5 级、警告 callout（⚠ 当时**实际未生效**，真因见 V0.11.2.0 ①） |
| `V0.11.0.3` | 2026-10-17 | `fefe8f8` | 邮箱验证码改为 `REQUIRE_EMAIL_CODE` 开关、**默认关闭** —— 唯一的注册入口是 Windows 客户端，它还没带 `code` 字段，硬开等于把注册打死 |
| `V0.11.0.2` | 2026-10-17 | `c2c9790` | **紧急**：`ANALYZE_INFLIGHT is not defined` —— 下沉限流配置时把两个并发常量一起删了，每一次 `/api/analyze` 都打死 Node 进程。补常量 + 新增 `tools/test-api-routes.mjs`（打完 14 条路由再验进程还活着） |
| `V0.11.0.1` | 2026-10-17 | 本次 | **限流重做的收尾（累计 4 次部署压在一个版本号里，这里补记）**。① **限流在生产真生效**：原实现把计数写进不可写的 `server-store.json`（`storeSave` 的 `catch{}` 吞掉失败）→ 每次请求从空计数开始；后改为进程内计数，又发现**无状态托管每个请求落在新进程上**→ 新建 `hm_rate` 表 + `hm_rate_hit` RPC（SECURITY DEFINER + 写入凭据，RLS 开、不给 anon 直连权限），进程内降级为预筛 + DB 不可用时的兜底。② **限流键「身份优先 / IP 兜底」**：`id:<sub>`（自签 JWT，伪造不了）> `ip:<真实对端>`（仅当非网关/内网时才用）> `g:<scope>` 全局桶。**彻底不采信 XFF**（客户端可控 + 平台处理不保证），源码里禁止出现读该头的代码（测试守着）。`isSharedPeer()` 认出 `127./::1/10./192.168./172.16~31` → per-IP 键丢弃；**共享对端时全局桶必须用严格档（20 而非 120）** —— 这条是实测抓出来的 6 倍放宽。`/api/hm/play` 加第二道身份闸（按 sub 60/分，只按 sub 不挂全局键，避免重复扣）。③ **fail-closed / fail-open 分流**：写入+登录库不通时回 **503**（不是 429 —— 服务端故障和你发太快是两回事），只读 fail-open。④ `/api/scores` 必填 `['chart_name','acc']`、单次 500→20 行；`/api/phira` 改路径白名单；`/api/contribute` 并发 ≤2；`phm_touch` 加 anon 拦截（本平台匿名 `auth.uid()` 返回字符串 `'anon'` 而非 NULL）；`app.html` 内联 esc 补 `'`。⑤ 429 补 `Retry-After`/`RateLimit-*` 标准头。⑥ 过闸下沉到 `lib/ratelimit.mjs` 的 `makeGate()`，`server.mjs` 回到 886 行。单测 `tools/test-ratelimit.mjs` **80/0**（含跨进程 DB 计数、fail-closed/fail-open、共享对端严格档、禁读 XFF 四条防回归断言）|
| `V0.11.0.0` | 2026-10-16 | 本次 | **安全加固（授权白帽测试驱动）**。① **修掉限流失效**：原 `rateOk` 把计数写进 `server-store.json`，而 `storeSave` 是 `try{writeFileSync}catch{}` —— 线上沙箱部署目录不可写，失败被吞，于是每次请求都从空计数开始，30/分/IP **一次都没触发过**（白帽实测 70 连发全 200）。改为进程内计数（新增 `lib/ratelimit.mjs`），配额/过闸句柄/429 标准头集中一处。② **登录注册三重限流**：per-IP 5/分 + per-邮箱 3/分 + 全局 20/分。per-邮箱那维是对付 XFF 伪造的关键（白帽实测换 XFF 绕得开 per-IP，绕不开 per-邮箱）。③ **`/api/scores` 补校验**：必填从 `['chart_name']` 改成 `['chart_name','acc']`，堵住「只填曲名就能落库」（白帽灌了 3 行垃圾：`SECURITY_PROBE`/`123`/120×`A`，已清理）；单次行数 500 → 20。④ **`/api/phira` 改路径白名单**：原先 `/api/phira/*` 一律透传，等于把出口 IP 白送（上游零限流），现在只放行 `/chart` `/record/best/` `/record/recent` `/terms/` `/music`。⑤ **`/api/contribute` 加并发上限**（≤2）：每行都会让服务端下载 ≤60MB 并**同步**跑引擎，同步跑会卡住整个事件循环。⑥ **`phm_touch` 加 anon 拦截**：本平台对匿名调用把 `auth.uid()` 返回成字符串 `'anon'`（不是 NULL），而 `owner_id` 默认就是它且 NOT NULL → 行写得进去（白帽刷出一行 ghost，首页计数虚高）。改用 `SELECT … WHERE auth.uid() IS NOT NULL AND auth.uid() <> 'anon'`。⑦ **app.html 内联 esc 补 `'`**：原 `/[&<>"]/` 漏单引号，与 ui.js 的五字符版不一致（脆弱模式，当前无实际注入点）。⑧ 429 补 `Retry-After`/`RateLimit-*` 标准头（RFC 6585 + IETF 草案）。单测新增 `tools/test-ratelimit.mjs` **52/0**（含滑动窗口非固定窗口、并发不丢计数、返回值非布尔防 `if(!obj)` 三类针对历史故障的断言）|
| `V0.10.0.0` | 2026-10-12 | 本次 | **自建账号系统**。平台侧堵死了免验证码注册（SDK 原话：`signUp requires a verificationToken ... the provider rejects username+password-only signup`），所以账号收到自己手里：注册只要邮箱+密码，之后只输密码。新增 `hm_accounts` 表（RLS 开、不给任何角色直连权限）+ 两个 SECURITY DEFINER RPC（`hm_account_lookup` / `hm_account_create`）+ `POST /api/hm/register` `/api/hm/login`；`lib/hm-accounts.mjs` 负责 scrypt 哈希与 HS256 自签 JWT（密钥三路：`PHM_TOKEN_SECRET` → `.env` → 从 WRITE_SECRET 派生）。**顺带修掉「身份可伪造」**：以前服务端验不了平台 HS256 签名，`subFromJwt` 只能解析；现在自签能验签，`hmWhoami` 按 ①自签(验签) → ②云端 `user/me` → ③旧的不验签兜底 排序，且**自称是我们的却验不过 → 当场拒绝**（不许掉到兜底）。登录失败统一回 `bad_credentials`，不区分账号不存在/密码错（否则就是账号枚举器）。下载页换成新 exe（`0.8.2-huamei.12`）。单测 `test-hm-accounts.mjs` 44/0（含篡改 payload / 伪造 iss / alg=none 三种攻击）|
| `V0.9.6.0` | 2026-10-11 | 本次 | **成绩落库修复 + 下载页**。① 修掉 `/api/hm/play` 的 `score_mismatch` 误拒：服务端拿 `perfect+good` 反推 `max_combo`，中途断连的真实成绩必然算高（实测那局 159 音符/631855 分，老算法给 721164，差 89309 → 409）→ 改用客户端上报的 `max_combo`；`score`/`accuracy` 与判定明细不一致时**降级为告警**（写服务端日志 + 回传响应体，客户端落进 `data/huamei-login.log`），不再丢掉真实成绩。② 把身份/成绩校验拆到 `lib/hm.mjs`（新增 36 条单测）、把新加的下载路由拆到 `lib/download.mjs`，`server.mjs` 回到 900 行以内。③ 新增 **`/download` 下载页**：导航第 7 个入口，自托管 Windows 客户端（流式 + Range 断点续传 + ETag + SHA-256），`downloads/` 与 `public/` 分离（前者只走这一条路由，不在静态白名单里）；元数据由 `tools/gen-release.mjs` 从二进制实算，禁止手写。客户端 `HUAMEI_CLIENT_VER` → `0.8.2-huamei.10` |
| `V0.9.5.1` | 2026-10-11 | 本次 | **法务三件 + 自助注销**。隐私政策 §7 改成「个人信息对外提供清单」（PIPL 第23条：接收方/联系方式/目的/方式/信息种类）；§5 注销行如实分出「能自助删的」与「删不掉的」；§10 新增投诉举报邮箱（承诺 15 个工作日）。设置页新增**「注销账号」**——数据库补 `DELETE` 策略（`GRANT` + `CREATE POLICY`，两道门）；云服务 auth 文档明确不删除用户，所以登录邮箱需另行申请，政策里如实写明。顺带清掉结果卡重排留下的 3 条僵尸词条 |

> ### ⚠ `V0.9.5.1` 续改（2026-10-11，同日，**版本号未变**）
>
> 用户明确要求保持 `V0.9.5.1`。这一批是 **huamei 数据飞轮的服务端两条 API**，
> 前端产物**零变化**（没有改任何 HTML/CSS/JS，`?v=` 串不动），所以页面缓存不受影响：
>
> - `GET /api/phira/*` —— 取谱代理。只放行 GET/HEAD，**剥掉入站 `Authorization`**
>   （那是用户的 huamei token，不能转给第三方）。
> - `POST /api/hm/play` —— 逐音符成绩接收。身份来自用户自己的 huamei token
>   （调云端 `user/me` 换 `sub`）；**服务端重算 accuracy/score** 对账（公式见
>   Phira `prpr/src/judge.rs:215`）；写入只经 `hm_put_play()`（SECURITY DEFINER + 写入凭据）。
> - 新表 `public.hm_plays` + RPC `hm_put_play`，RLS 已开，anon **无**直连读写权限。
>
> ⚠ **同名版本部署两次**正是 `V0.9.5.0` 那次「页面下半部分整块空白」的成因。
> 现在 HTML 走 `no-cache`、`?v=` 资源走 `must-revalidate` + ETag，所以这次是安全的；
> 但**下次动到前端产物时必须换版本号**。
>
> 契约文档：`docs/规范/数据飞轮契约.md`
| `V0.9.5.0` | 2026-10-11 | 本次 | **修「页面下半部分整块空白」**（同名版本号部署两次 → 浏览器攥着 `immutable` 的旧模块不放，模块链断、脚本全不执行）。换版本号让旧副本失效 + `server.mjs` 去掉 `immutable`、改 `max-age=3600, must-revalidate`、新增 **ETag/304**；smoke 加三条缓存策略断言 |
| `V0.9.4.0` | 2026-10-11 | 本次 | **设计评审落地（三批合并）+ `/version` 版本历史页**。第 1 批：强调色从「琥珀 + 蓝」统一为单一琥珀（链接改深棕 + 下划线）；标题换自托管**思源宋体子集**（11.2MB → 83KB）；正文行高 1.65→1.75、长段落限宽、`lang="zh-Hans"`；卡片层次；破折号排版；修页脚「· ·」。第 2 批：**统一容器**（1120px 全站唯一，`app.html` 里私有的 880px 覆盖一并清掉）、法务页接入站点令牌（原来自成一套设计系统、蓝链接）、数字千分位 `fmtInt`、缩写大写、日文栈。第 3 批：**结果卡重排**（双标度并列、区间轴标两端 + 两个标度同轴、PS 四维迷你条、13 行长表分组、长警告改提示框）、顶栏毛玻璃 .88 + 底线、焦点环 2px、触控目标 40px、`prefers-reduced-motion`、`text-wrap` |
| `V0.9.3.0` | 2026-10-11 | （并入 0.9.4.0） | 新增 **`/version` 版本历史页**（面向用户，只列能感知的变化）+ 设置页「关于」入口 + 页脚版本号可点。数据源 `public/js/versions.js`，smoke 有断言守着「最新一条 = app-version」 |
| `V0.9.2.1` | 2026-10-11 | `8889f0c` | **暖炭配色改版**：中性阶梯整体移到暖侧、与琥珀主色同温层（深浅两套全部重算，38 对配色过 WCAG AA）。顺带统一拖拽区强调色、把不确定范围画成条、次要说明收进折叠、四类图标统一为线性 SVG。新增 `tools/check-contrast.mjs`（配色对比度校验） |
| `V0.9.2.0` | 2026-10-11 | `a4fb5f3` | 修一批 P0：拖谱贡献整条写不进去（必填字段认错）、批量读定数被 8KB 截断、写接口限流从未生效、畸形 URL 能打死进程、`analyze` 并发闸门存在竞态；补 SSRF 白名单与解压体积上限；**修「谱师页整页空白」**（模块 URL 版本化 + 静态文案恢复中文兜底） |
| `V0.9.1.0` | 2026-10-07 | `eac190d` | 全站中英双语（字典按页面分片，8 片 755 条）；谱师搜索改为按账号 id 精确取作品（`/chart?uploader=`）；主题切换与页脚版本号的修复 |
| `V0.9.0.0` | 2026-10-07 | `fe7032d` | 修主题切换真 bug；删冗余英文页；建「屎山考核」静态检查 |
| `V0.8.2.0` | 2026-10-07 | `af0bd9d` | 恢复被误删的「全部进入数据飞轮」入口 |
| `V0.8.1.0` | 2026-10-07 | `3db70e8` | 堵住第三方接口的缓存缺口（「没有从 API 下载最新数据」） |
| `V0.8.0.0` | 2026-10-07 | `06ad95b` | 双主题 + 中英双语；修掉「两个模块实例」导致状态分裂的 bug |
| `V0.7.0.0` | 2026-10-07 | `0f8f94e` | 视觉体系：确立单一主色 + 正式文档页 + 界面文案瘦身 |
| `V0.6.0.0` | 2026-10-07 | `8387798` | 设置独立成页 `/settings`；清 429 行休眠代码 |
| `V0.5.1.0` | 2026-10-07 | `9279ebf` | 密码策略加固：下限 6→10 位，拦纯数字 / 纯小写 |
| `V0.5.0.0` | 2026-10-07 | `4d66b4f` | 聚合换代：修「咋都是 15.0」+ 小白可用性 |
| `V0.4.2.0` | 2026-10-07 | `0b805ea` | 全站真分页；新增数据管理页 |
| `V0.4.1.0` | 2026-10-07 | `cb20f96` | 站点拆分：`/app` `/user` `/charter`；修成绩检测 |
| `V0.4.0.0` | 2026-10-07 | `3c82a77` | 引擎换代：社区参照 8 维 k-NN + 双标度输出 |
| `V0.3.3` 及更早 | ≤ 2026-10-07 | — | **未打 tag**。当时的 commit 没有稳定地记版本号，无法可靠地确定每个版本的落点 —— 与其猜，不如明确标出「这段没有版本边界」 |

### 没升版本号的 commit（如实记录）

这些 commit 改了东西但没动版本号，所以它们没有对应的 tag：

- `33cdb86` 设置页改版（左栏分栏布局）+ Phira 接口家族补测
- `6ab9cf5` 文档校准：修 11 处会把接手者带错的地方（零算法改动）
- `fb14a32` 全站对账后补齐 4 处遗漏
- `b9e3ff9` / `e310702` 宣发手册与渠道说明（纯文档）

> 按现在的规矩，**任何改动都要落一个版本号**（哪怕只是第 4 位 +1），
> 所以上面这种"改了但没版本"的情况不会再出现。

## 发版流程

```bash
# 1) 本地测试全绿
node tools/gen-ref.mjs --check
node tools/verify-engine.mjs
PORT=5199 node server.mjs &
node tools/smoke-page.mjs   http://127.0.0.1:5199
node tools/verify-pages.mjs http://127.0.0.1:5199
node tools/lint-slop.mjs
node tools/lint-i18n.mjs
node tools/check-contrast.mjs     # 只有配色改动时才需要，但它很便宜

# 2) 升版本（一处改全站：9 个页面的 meta + 所有 ?v= + package.json）
python tools/bump-version.py V0.9.3.0

# 3) 两份都更新：这份 CHANGELOG（开发者向）+ public/js/versions.js（用户向）
#    ⚠ versions.js 的 RELEASES[0].v 必须等于新版本号，smoke 会查

# 4) 提交、打 tag、推送、部署
git commit -am "... V0.9.2.0 → V0.9.3.0"
git tag v0.9.3.0
git push phm HEAD:main --tags
```

> ⚠ 改版本号**之前先问用户**落哪一档 —— 性质由用户判定。
