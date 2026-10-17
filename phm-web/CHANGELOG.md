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
