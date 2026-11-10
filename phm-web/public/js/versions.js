/* ============================================================
 * js/versions.js ——面向用户的版本历史（/version 页的数据源）
 * ============================================================
 * 【和 CHANGELOG.md 的分工——不要合并】
 *   CHANGELOG.md  → **开发者**看的：commit 哈希、内部取舍、为什么这么修。
 *   本文件        → **用户**看的：这次改动对他意味着什么。
 *   两者受众不同，硬从 CHANGELOG 生成会得到一份充满术语的用户页。
 *   所以是**两份**，但只维护一处「最新版本号」——
 *   tools/smoke-page.mjs 有一条断言：RELEASES[0].v 必须等于 app-version。
 *   升版本忘了改这里，测试会红。
 *
 * 【写这些条目的规矩】
 *   1. 用**用户能感知的现象**开头，不要用实现细节。
 *      ✅「修「点「算」有时算不出来」」
 *      ❌「修正 fetchChartFile 的重定向处理」
 *   2. 每条不超过两行，说清「改了什么」就够，不要写为什么。
 *   3. 中文在 zh、英文在 en，**同一条并排写**，别分成两个数组（会漂移）。
 *   4. 只有**用户能感知**的改动才写。纯内部重构、文档、lint 规则不写。
 * ============================================================ */

/* 较早的版本见 versions-archive.js —— 拆开是为了不让这个文件无限增长。 */
import { ARCHIVE } from './versions-archive.js?v=V0.30.0.2';

export const RELEASES = [
  {
    v: 'V0.30.0.2', date: '2026-11-10',
    zh: ['<b>修一个自己坑自己的 bug：中转下载会把自己判成"服务器过载"。</b> '
      + '传一个 8MB 的谱面包要 2 秒，这很正常，但那条耗时记录被算进了全站压力统计，'
      + '于是系统以为整个站点都在被打，把下载请求自己给拒了。',
      '<b>现在带宽类请求不参与压力计算。</b> 它们天然就慢，而且不碰数据库、不跑引擎 —— '
      + '用"计算拥塞"的尺子去量它们必然是误判。'],
    en: ['<b>Fixing a bug where the download proxy flagged itself as overloaded.</b> Moving an 8MB pack takes '
      + 'about 2 seconds, which is normal — but that duration fed into the site-wide pressure average, so the '
      + 'system concluded the whole site was under attack and rejected the download itself.',
      '<b>Bandwidth-bound requests no longer count toward pressure.</b> They are slow by nature and touch '
      + 'neither the database nor the engine — measuring them with a compute-congestion ruler is a guaranteed '
      + 'false positive.'],
  },
  {
    v: 'V0.30.0.1', date: '2026-11-10',
    zh: ['<b>「打包下载」从上线起就是坏的，现在修好了。</b> 点下去只会看到「所有文件都没取到」——'
      + '不是偶发，是每次都失败。',
      '<b>原因不在我们这边。</b> 谱面文件原来由浏览器直接从 Phira 的镜像下载，'
      + '而上游这个月改成了跳转到另一个 CDN 域名 —— 那个 CDN 的跨域响应缺了关键的一个头，'
      + '浏览器一律拒绝。我们改不了别人的服务器配置。',
      '<b>现在改由我们的服务器代取。</b> 浏览器仍会先试直连（万一上游哪天修好了，就自动恢复成零中转），'
      + '失败立刻转由服务器取回再转给你 —— 实测 8.5MB 的包 0.38 秒。'
      + '代价是会占一点我们的出口带宽，所以加了白名单、120MB 上限和 25 秒超时。'],
    en: ['<b>"Download as pack" has been broken since launch. It is fixed now.</b> Clicking it only ever said '
      + '"no files could be fetched" — not intermittently, every single time.',
      '<b>The cause was not on our side.</b> Chart files used to be fetched by the browser directly from '
      + 'Phira mirrored storage; upstream switched to redirecting to another CDN domain this month, and that '
      + 'CDN response is missing a critical cross-origin header. Browsers reject it outright. We cannot change '
      + 'someone else's server config.',
      '<b>Our server now fetches on your behalf.</b> The browser still tries the direct route first (so if '
      + 'upstream fixes it, we go back to zero proxying), then falls back to our server, which streams the file '
      + 'through — an 8.5MB pack in 0.38s in testing. It costs us some egress bandwidth, so it is restricted '
      + 'to an allowlist with a 120MB cap and a 25s timeout.'],
  },
  {
    v: 'V0.30.0.0', date: '2026-11-10',
    zh: ['<b>「更多」页之前根本没有导航栏。</b> 那页的容器 id 写成了 topbar，'
      + '而导航模块只认 nav —— 于是这个页面从上线起就没有顶部菜单，没人发现。'
      + '已修正，并顺手加了「← 返回首页」。',
      '<b>按钮按下现在有反馈了。</b> 之前全站只有 13 处颜色过渡、2 处形变，'
      + '按下去和没按一样。现在按下缩到 97%（约 1.2px），90 毫秒完成 —— '
      + '手感靠快不靠幅度大。可点击的卡片悬停会轻抬 2px。',
      '<b>切主题不再"整页闪一下"。</b> 改成从你点击的位置扩散一个圆，'
      + '420 毫秒盖满全屏。不支持该特性的浏览器、开了「减弱动效」的、'
      + '以及连点两次的情况，都自动退回瞬时切换。',
      '<b>代码结构拆了两处。</b> 前端 ui.js 从 533 行拆成 4 个模块（21 个页面的引用一行没改）；'
      + '后端的接口成本分档从「正则猜路径」改成一张表，新加接口忘了登记会被检查拦住。',
      '<b>本地检查从 82 秒降到 38 秒。</b> 82 项检查改成并发跑（默认 16 路），'
      + '输出各自缓冲不交错。'],
    en: ['<b>The "More" page had no navigation bar at all.</b> Its container id was topbar while the nav '
      + 'module only looks for nav — so the page shipped without a top menu and nobody noticed. Fixed, '
      + 'plus a "back to home" link.',
      '<b>Buttons now respond to being pressed.</b> Before there were only 13 colour transitions and 2 '
      + 'transforms site-wide; pressing a button did nothing. Now it scales to 97% (about 1.2px) in 90ms — '
      + 'feel comes from speed, not amplitude. Clickable cards lift 2px on hover.',
      '<b>Theme switching no longer flashes the whole page.</b> A circle now expands from where you clicked, '
      + 'covering the screen in 420ms. Unsupported browsers, reduced-motion users and double-clicks all fall '
      + 'back to an instant switch.',
      '<b>Two pieces of structure were untangled.</b> Frontend: ui.js went from 533 lines to 4 modules with '
      + 'zero changes to the 21 pages importing it. Backend: endpoint cost tiers moved from regex guessing to '
      + 'an explicit table — adding an endpoint without registering it now fails a check.',
      '<b>Local checks went from 82s to 38s</b> by running 82 steps concurrently (16 lanes by default) with '
      + 'buffered output.'],
  },
  {
    v: 'V0.29.0.5', date: '2026-11-09',
    zh: ['<b>管理台不再把已吊销的密钥列出来。</b> 之前 6 条里只有 2 条是活的，'
      + '剩下 4 条是历史记录，看着像还在用、其实打过去只会 401。现在只显示有效的。',
      '<b>新增「端点调用」页：按接口看调用次数、错误数、p50 与最大耗时。</b> '
      + '谁能看出「哪个接口在被用、哪个在报错、哪个慢」，不用再靠猜。',
      '<b>它只统计带 Key 的调用，匿名不记。</b> 这不是偷懒：无状态部署下每次请求都写一次库，'
      + '真被打了等于给数据库再加一层负担。匿名的健康度交给状态页那 7 条探针，两边分工。'],
    en: ['<b>The console no longer lists revoked keys.</b> Previously 6 rows showed up with only 2 alive; '
      + 'the other 4 were history that looked active but returned 401. Only live keys now.',
      '<b>New "endpoint calls" tab: per-route call counts, errors, p50 and max latency.</b> '
      + 'You can see which endpoint is used, which is failing and which is slow without guessing.',
      '<b>It counts keyed calls only; anonymous traffic is not logged.</b> Not laziness: with stateless '
      + 'deployment every request would mean a database write, adding load exactly when being attacked. '
      + 'Anonymous health is covered by the seven status-page probes instead.'],
  },
  {
    v: 'V0.29.0.4', date: '2026-11-09',
    zh: ['<b>二级密码之前存在服务器的文件里 —— 每次部署都会把它覆盖掉。</b> '
      + '所以你设完之后再刷新，服务端会告诉你"还没设置"。这不是你操作错了，是存错了地方。'
      + '现在改存数据库，部署多少次都不会丢。',
      '<b>现在可以改密码了，但必须给旧密码。</b> 之前只有一级密码就能覆盖，'
      + '那意味着运维能单独把你的锁换掉 —— 二级密码等于不存在。'
      + '现在改密码要验旧密码，运维只有一级密码，改不了。',
      '<b>忘记旧密码没有自助通道。</b> 只能由运维在数据库里清空后重设，'
      + '而这件事会在操作记录里留下痕迹 —— 这是刻意的取舍：能救你，但不可能悄悄做。'],
    en: ['<b>The second-level password was stored in a file on the server — and every deploy overwrote it.</b> '
      + 'So after setting it, a refresh would report "not set yet". That was not your mistake; it was stored '
      + 'in the wrong place. It now lives in the database and survives any number of deploys.',
      '<b>You can change it now, but the current password is required.</b> Previously the first-level password '
      + 'alone could overwrite it — meaning operations could replace your only lock, making the second factor '
      + 'meaningless. Changing it now verifies the old one, and operations does not have it.',
      '<b>There is no self-service reset if you forget it.</b> Only operations can clear and re-set it in the '
      + 'database, and that leaves a trace. That is a deliberate trade-off: recoverable, but never silently.'],
  },
  {
    v: 'V0.29.0.3', date: '2026-11-09',
    zh: ['<b>这一版只做一件事：把版本历史补全并写详细。</b> '
      + 'V0.29.0.0 和 V0.29.0.1 的用户向说明之前没写进页面数据源（一次脚本写入失败，被当成了成功），'
      + '所以 /version 一直停在 V0.28.0.3 —— 你看到的就是这个。',
      '<b>以后每条更新都按「为什么、动了什么、对你意味着什么」写。</b> '
      + '不再只写「修了某某」，而是说清楚它原本错在哪、为什么错、以及你作为使用者会不会感觉到变化。',
      '<b>另外顺手确认了一遍：</b>7 条监控现在全部正常，两份状态页通报已发布'
      + '（一份讲监控探针与鉴权不同步，一份讲监控配置过脆 + 换密钥留了空档）。'],
    en: ['<b>This release does one thing: complete the version history and write it properly.</b> '
      + 'The user-facing notes for V0.29.0.0 and V0.29.0.1 never made it into the page data source '
      + '(a script write failed and I treated it as success), so /version was stuck at V0.28.0.3.',
      '<b>From now on every entry answers three questions:</b> why it was wrong, what changed, and what it '
      + 'means for you — not just "fixed something".',
      '<b>Also re-checked:</b> all seven monitors are green, and two status-page reports are published '
      + '(one on monitors falling out of sync with auth, one on brittle monitor settings plus a key rotation gap).'],
  },
  {
    v: 'V0.29.0.2', date: '2026-11-09',
    zh: ['<b>补 /version 页的版本历史。</b> 上一版把用户向说明写进了 CHANGELOG，却漏了页面数据源 —— '
      + '内部记录和对外页面是两份，只改一份就会「开发者知道、用户看不到」。',
      '<b>教训：改完必须验证。</b> 这次不是脚本报错，而是脚本静默失败（Python 语法错误后我当成成功）。'
      + '以后改 `versions.js` 一定验证 `RELEASES[0].v` 真的变了。'],
    en: ['<b>Filling in the missing version history.</b> The previous release updated the internal changelog '
      + 'but not the page data source — two separate files, and touching only one means developers know while '
      + 'users see nothing.',
      '<b>Lesson: verify after writing.</b> The script did not fail loudly; it failed silently. '
      + 'Any change to `versions.js` now gets checked for `RELEASES[0].v` actually moving.'],
  },
  {
    v: 'V0.29.0.1', date: '2026-11-09',
    zh: ['<b>状态页红了一下午，原因是我们自己的监控配置太脆。</b> '
      + '「谱师作品」「玩家资料」这两个接口要去上游 Phira 取数据，而上游本身就要 1.5~3.4 秒、还忽快忽慢。'
      + '监控原来的超时是 30 秒、而且<b>只要失败一次就判红</b> —— 一次网络抖动就够。'
      + '现在改成 45 秒超时 + 连续失败 3 次才算故障。',
      '<b>换密钥时留了 15 分钟空档，7 条监控一起 401。</b> 这是操作失误：应该先上新的、确认生效，再撤旧的。'
      + '空档期内所有监控都在用一把已吊销的钥匙。',
      '<b>还清掉一处真实泄漏。</b> 一把监控用的密钥被写进了测试文件，而这个仓库是公开的。'
      + '已吊销、已换成假值 —— 那把钥匙现在打过来只会得到 401。'],
    en: ['<b>The status page was red all afternoon, and the cause was our own brittle monitoring config.</b> '
      + 'Two endpoints call upstream Phira, which itself takes 1.5–3.4s and is jittery. The monitors were set '
      + 'to a 30s timeout and <b>a single failure counted as down</b> — one network hiccup was enough. '
      + 'Now 45s with three consecutive failures required.',
      '<b>We left a 15-minute gap while rotating keys, so all seven monitors returned 401 at once.</b> '
      + 'That was an operational mistake: add the new key and confirm it works before revoking the old one.',
      '<b>One real leak was cleaned up.</b> A monitoring key had been written into a test file, and this '
      + 'repository is public. It has been revoked and replaced with a dummy — that key now only gets 401.'],
  },
  {
    v: 'V0.29.0.0', date: '2026-11-09',
    zh: ['<b>API 的防护补完了，而且匿名没被砍。</b> 现在分三档：匿名只读、持 Key、带签名/证明；'
      + '管理员另走一条独立通道。被收紧的只有一件事 —— 匿名不能再触发谱面重算，'
      + '因为那条路原来等于一个免费算力放大器（下载谱面 + 跑引擎，并发槽只有 2）。',
      '<b>多了管理台，还有两道锁。</b> <code>/admin</code> 用一级密码登录看全量密钥与调用量，'
      + '但改档位、批申请这些写操作要再输一次只有站长知道的二级密码 —— '
      + '一级密码运维也知道，只靠它等于运维一个人能改所有人的额度。',
      '<b>多了压力感知：真被打了，会先牺牲昂贵的接口。</b> 本地数据类的接口（元信息、引擎权重、'
      + '行为数据、探针）永远不放弃，因为它们不碰数据库，是「服务还活着」的最后证据；'
      + '打上游和跑引擎的接口最先让路。牺牲顺序是 匿名 → 持 Key → 签名/管理员。',
      '<b>还有一个不开验证码的真人判定。</b> 只怀疑「装作浏览器」的请求：'
      + '声称是 Chrome 却不送客户端提示头、平台字段和 UA 自相矛盾、或者用导航模式调 API。'
      + 'curl、脚本、监控这些<b>明说自己不是浏览器的，一分不扣</b>。'
      + '可疑的请求不直接拒绝，只要求做一次几毫秒的算术题。'],
    en: ['<b>The API guards are complete — and anonymous access was not removed.</b> Three tiers now: '
      + 'anonymous read-only, keyed, and signed; admins get a separate channel. The only thing anonymous '
      + 'users lost is the ability to trigger a recompute, which was effectively a free compute amplifier.',
      '<b>There is an admin console now, behind two locks.</b> <code>/admin</code> signs in with the first '
      + 'password to view keys and usage; changing tiers or approving requests needs a second password only '
      + 'the site owner knows — operations knows the first one, so relying on it alone would mean ops can '
      + 'change the quota of every key single-handedly.',
      '<b>Load shedding landed: under pressure, expensive endpoints give way first.</b> Endpoints served from '
      + 'local data (metadata, engine weights, behaviour data, the probe) are never shed, because they do not '
      + 'touch the database and are the last proof that the service is alive. Upstream calls and recomputes '
      + 'yield first. Order: anonymous → keyed → signed/admin.',
      '<b>A captcha-free human check.</b> It only suspects requests that <i>pretend to be a browser</i>: '
      + 'claiming Chrome without client hints, a platform field contradicting the user agent, or navigating '
      + 'to an API endpoint. curl, scripts and monitors openly identify as non-browsers and <b>lose no points '
      + 'at all</b>. Suspicious requests are not rejected — they only have to solve a few milliseconds of '
      + 'arithmetic.'],
  },
  {
    v: 'V0.28.0.3', date: '2026-11-09',
    zh: ['<b>PoW 挑战误伤了状态页监控。</b> 今天「全库统计」「玩家资料」各有几次 428 —— '
      + '那是防滥用挑战。触发条件写的是「请求间隔过于均匀」，可**定时监控本来就是均匀的**，'
      + '间隔精确 600 秒。这条启发式在低频语境下是错的。',
      '<b>修法不是关掉 PoW，而是给它加频率门槛。</b> 中位间隔超过 5 秒的流量不再做均匀性判定：'
      + '监控、定时任务、正常轮询都不该被拦；真正的滥用要么高频，要么被「10 次/15 秒」的密度信号抓住。'
      + '另加了一条回归单测，防止这个洞再被踩一次。'],
    en: ['<b>The proof-of-work challenge was hitting our own status monitors.</b> Two monitors returned 428 '
      + 'several times today. The trigger was "requests too evenly spaced" — but **a scheduled monitor is '
      + 'evenly spaced by definition**, exactly 600 seconds apart. That heuristic is simply wrong at low rates.',
      '<b>The fix is not disabling PoW, but giving it a frequency gate.</b> Above a median gap of 5 seconds, '
      + 'even spacing no longer counts as abuse: monitors, cron jobs and ordinary polling are not what we '
      + 'want to block. Real abuse is either high-frequency or caught by the 10-requests-in-15-seconds '
      + 'density signal. A regression test now covers it.'],
  },
  {
    v: 'V0.28.0.2', date: '2026-11-09',
    zh: ['<b>「分析谱面」那条监控红了一整夜，但不是服务挂了。</b> 昨晚把匿名的分析请求收口成 403，'
      + '而状态页那条监控是匿名发的 —— 它测的东西已经不存在了。',
      '<b>修法不是把监控删掉，而是给它一个真正能探的东西。</b> 新增 <code>/api/v1/analyses/probe</code>：'
      + '公开、免 Key、免限流，检查数据库、引擎权重、缓存谱面，不下载谱面也不跑引擎。',
      '<b>顺手把监控频率从 5 分钟降到 10 分钟。</b> 匿名配额只有每小时 100 次，'
      + '7 条监控 5 分钟一次就要 84 次 —— 几乎打满，真实用户一来就得排队。'],
    en: ['<b>The "analysis" monitor was red all night — but nothing was down.</b> Anonymous analysis '
      + 'calls started returning 403 last night, and that monitor probes anonymously: it was measuring '
      + 'something that no longer exists.',
      '<b>The fix is not deleting the monitor, but giving it something real to probe.</b> New endpoint '
      + '<code>/api/v1/analyses/probe</code>: public, keyless and rate-limit-free — it checks the database, '
      + 'the engine weights and the cache, without downloading or running anything.',
      '<b>Monitor frequency also went from 5 minutes to 10.</b> The anonymous quota is 100/hour; seven '
      + 'monitors at 5-minute intervals already use 84 of them, leaving real users to queue.'],
  },
  {
    v: 'V0.28.0.1', date: '2026-11-09',
    zh: ['<b>玩家实测难度换了一版数据：样本 86 倍。</b> 反推用到的成绩从 15.8 万条扩到 1,357 万条，'
      + '覆盖 1,700 → 9,230 张谱。同一批 4,532 张谱上，与谱师声明定数的相关性从 0.697 升到 <b>0.725</b>。',
      '<b>整体数字反而降了（0.675），这不是退步。</b> 新覆盖的 4,698 张多是稀疏谱（相关性 0.625），'
      + '把总数拉低了。分层看：10–29 人、30–99 人、≥100 人三个档位，新版全部比旧版更准。'
      + '这句话也写进了数据文件的 note 里，免得以后有人只看一个数就下结论。'],
    en: ['<b>Player-derived difficulty got a new dataset: 86× the samples.</b> The fit now uses 13.57M records '
      + 'instead of 158K, covering 9,230 charts instead of 1,700. On the same 4,532 charts, agreement with '
      + 'declared constants rose from 0.697 to <b>0.725</b>.',
      '<b>The overall number went down (0.675) — that is not a regression.</b> The 4,698 newly covered charts '
      + 'are mostly sparse (agreement 0.625) and drag the aggregate down. Split by sample size — 10–29, 30–99, '
      + '≥100 players — the new version wins in every bucket. That caveat is written into the dataset note too.'],
  },
  {
    v: 'V0.28.0.0', date: '2026-11-08',
    zh: ['<b>登录终于成了一个正经页面。</b> 以前它藏在谱面工作台的一个折叠面板里，'
      + '导航上一个入口都没有 —— 找不到就等于没有。现在有独立的 <code>/login</code>：'
      + '左边一团会被人手拨开的琥珀色粒子，右边表单分两步走，先收邮箱再收密码。',
      '<b>那团粒子是 Live2D 的位置。</b> 看板娘还在做，先用粒子占住 —— '
      + '鼠标扫过去，粒子会弹开。颜色跟着主题走。',
      '<b>API 加了防护，但匿名没被砍。</b> 读接口照旧给匿名用，'
      + '只是匿名不能再触发谱面重算；带签名或 DPoP 证明的请求配额更高、还能防重放。'],
    en: ['<b>Signing in is a real page now.</b> It used to hide in a collapsible panel on the '
      + 'chart workbench, with no entry anywhere in the nav — if nobody can find it, it does not exist. '
      + 'Now there is a standalone <code>/login</code>: amber particles on the left you can push around '
      + 'with your cursor, and a two-step form on the right (email first, password second).',
      '<b>Those particles are where the Live2D mascot will live.</b> It is still being built, '
      + 'so particles hold the place for now — sweep the cursor through and they scatter.',
      '<b>The API gained guards, but anonymous access stayed.</b> Read endpoints are still open to '
      + 'everyone; what anonymous users lost is the ability to trigger a recompute. '
      + 'Signed or DPoP-proved requests get higher quotas and replay protection.'],
  },
  {
    v: 'V0.27.2.3', date: '2026-11-08',
    zh: ['<b>API v1.3：把站内本来就看得到的数据，变成可查询、可限流、可审计的接口。</b> '
      + '新增玩家实测难度、社区参照集、引擎权重、版本历史、状态、事件、标称差共 8 个只读端点，'
      + 'scope 从 3 个扩到 7 个；开发者文档与 OpenAPI 契约同步覆盖全部 20 个端点。',
      '<b>给第三方一个连通性探测口。</b> <code>/api/v1/health</code> 公开免 Key，'
      + '逐项回 database / 上游 / 本地数据 / 自监控的可用性与耗时；全通 200，有依赖不可达 503。',
      '<b>状态页的四个栏目在站内也能直接点了。</b> 维护计划、历史故障、联系我们、RSS 订阅摊成五个入口。'],
    en: ['<b>API v1.3 turns data you could already see on the site into queryable, rate-limited, auditable endpoints.</b> '
      + 'Eight read-only endpoints (player-derived difficulty, community reference, engine artifacts, version history, '
      + 'status, incidents, discrepancy), with scopes expanded from 3 to 7 and OpenAPI covering all 20 paths.',
      '<b>A connectivity probe for third parties.</b> <code>/api/v1/health</code> is public and reports '
      + 'per-dependency availability and latency: 200 when all clear, 503 when a dependency is unreachable.',
      '<b>All four status-page sections are now linked from the site.</b> Maintenance, previous incidents, '
      + 'get in touch and RSS get their own entries.'],
  },
  {
    v: 'V0.27.2.2', date: '2026-11-08',
    zh: ['<b>上一版没修好，这次才是对的。</b> 网关把 Host 和 x-forwarded-host 一起改写了，'
      + '所以"拿请求头当基准"根本行不通——改成公开域名白名单。',
      '<b>自检接口现在会告诉你它收到了什么。</b> host / x-forwarded-host / origin / referer '
      + '四个字段直出，遇到 403 不用再靠猜。'],
    en: ['<b>The previous patch was not enough.</b> The gateway rewrites both Host and '
      + 'x-forwarded-host, so comparing against request headers can never match; '
      + 'the check is now an allowlist of public hostnames.',
      '<b>The diagnostics endpoint now reports what it actually received</b> — host, '
      + 'x-forwarded-host, origin, referer. No more guessing why a request got 403.'],
  },
  {
    v: 'V0.27.2.1', date: '2026-11-08',
    zh: ['<b>修一个上线两天没人发现的静默故障：看板娘一直没画出来。</b> '
      + '同源校验拿的是被网关改写过的 Host，公开域名只在 x-forwarded-host 里，'
      + '两边永远对不上 —— 于是所有请求都 403，canvas 不画、控制台也无报错。',
      '<b>单文件客户端的 Key 之前会被网关悄悄盖掉。</b> '
      + 'Authorization 头被网关写入自己的值，你的 Key 失效但界面照常，'
      + '表现为静默降级成匿名配额。改用 x-phm-key，并加了自检按钮。'],
    en: ['<b>Fixes a silent failure that went unnoticed for two days: the mascot never rendered.</b> '
      + 'The same-origin check compared against a Host the gateway rewrites, while the public '
      + 'hostname lives only in x-forwarded-host — so every request returned 403, no canvas, no error.',
      '<b>The single-file client had its key silently overwritten by the gateway.</b> '
      + 'Authorization is replaced upstream, so requests quietly fell back to the anonymous quota. '
      + 'Switched to x-phm-key and added a self-check button.'],
  },
  {
    v: 'V0.27.2.0', date: '2026-11-08',
    zh: ['<b>站点有看板娘了，但你不会在首页看见她。</b> 她叫汐里，只在两处出现：'
      + '找不到页面的时候（404）、以及搜不到东西的时候（空状态）。工具站不该挂一个常驻小人挡操作。',
      '<b>图不再是"一张图"。</b> 成品被切成 6×6 块、每块单独签名、由浏览器在 canvas 上拼回来——'
      + '右键"另存为"拿不到东西，抓到单块也只有 1/36。',
      '<b>每张图里都藏了一个 ID。</b> 水印写进频域，能扛住 JPEG 重压和裁剪；'
      + '但扛不住 AI 重绘——这是这类技术的天花板，不吹。'],
    en: ['<b>The site has a mascot now — and you will not meet her on the home page.</b> Her name is Xili. '
      + 'She appears in exactly two places: 404s and empty states. A tool site should not park a character '
      + 'over the controls.',
      '<b>The art is no longer "an image".</b> It is cut into a 6×6 grid, each tile signed separately, '
      + 'reassembled on a canvas in the browser — "save image as" gets you nothing, and a single tile is 1/36.',
      '<b>Every image carries an embedded ID.</b> The watermark lives in the frequency domain and survives '
      + 'heavy JPEG compression and cropping; it does not survive AI redrawing — that is the ceiling of this '
      + 'technique, and we will not pretend otherwise.'],
  },
  {
    v: 'V0.27.1.0', date: '2026-11-07',
    zh: ['<b>导航收成了 9 项。</b> 原来一行平铺 13 个入口，谁也扫不完 —— 现在主路径只留「谱面」和「创作」，'
      + '其余按用途收进新的「更多」页（谱面 / 创作 / 数据与开发 / 系统 四组卡片）。',
      '<b>状态页开始记「事件」了。</b> 以前只有可用率百分比 —— 看到 62% 只能猜「是不是我赶上倒霉」。'
      + '现在会写清楚是<b>性能下降 / 部分中断 / 完全中断</b>、影响哪个组件、什么时候恢复的。',
      '<b>修了一个自己造成的故障：</b>自检探针每 60 秒打两个查库接口，每小时 120 次超过了 100 次的配额，'
      + '于是后六分之一的探测全被限流拒掉 —— 状态页上显示成「接口只有 62% 可用」。降到 5 分钟一次后恢复正常。'],
    en: ['<b>The navigation is down to 9 items.</b> Thirteen links in one row is more than anyone scans — '
      + 'the main path now keeps only charts and creation, and everything else moved into a new “More” page '
      + 'grouped into charts / creation / data & developers / system.',
      '<b>The status page now records incidents.</b> It used to show only an uptime percentage — seeing 62% '
      + 'left you guessing whether you were just unlucky. It now states whether a component is '
      + '<b>degraded, partially down or fully down</b>, what was affected, and when it recovered.',
      '<b>Fixed a self-inflicted outage:</b> the self-check probed two database-backed endpoints every 60 seconds — '
      + '120 calls per hour against a quota of 100, so the last sixth was always rate-limited and showed up as '
      + '“the API is only 62% available”. Dropping those two to once every five minutes fixed it.'],
  },
  {
    v: 'V0.27.0.0', date: '2026-11-05',
    zh: ['<b>默认的数更准了，所有人都受益。</b> 这次看的不再只是单个音符的动作，而是「一小段音符摊开多大」——'
      + '手要跨多远、这条路径绕不绕。短谱（谱面很短的那种）准度从 0.71 提到 0.76，长谱也没落下。',
      '<b>尝试过但没用的：</b>曲率、走位折返、左右手交替、同押组合 —— 测下来全都没帮上忙。'
      + '真正有用的是最朴素的「跨度」，不是花哨的手法。',
      '<b>「精确计算」也升级了</b>，长谱尤其明显。但短谱两条路撞在同一面墙上（0.761 vs 0.764），说明短谱缺的是信息，不是模型不够大。'],
    en: ['<b>The default number is more accurate now, for everyone.</b> It no longer looks only at single-note motion, '
      + 'but at <i>how far a short run of notes spreads out</i> &mdash; how far the hand travels, and whether the path doubles back. '
      + 'Short charts went from 0.71 to 0.76, with no loss on long ones.',
      '<b>Tried and discarded:</b> curvature, direction reversals, left/right alternation, chord patterns &mdash; none of them helped. '
      + 'What works is the plain question of extent, not fancy technique.',
      '<b>"Compute precisely" was upgraded too</b>, most visibly on long charts. On short charts both paths hit the same wall '
      + '(0.761 vs 0.764), which says short charts are missing information, not model capacity.'],
  },
  {
    v: 'V0.26.0.0', date: '2026-11-05',
    zh: ['<b>多了一个「精确计算」按钮。</b> 平时的数还是秒出（几毫秒）；点它，会用一个更大的模型再算一遍，'
      + '慢一点（半秒内），但更准 —— 对玩家实际打出来的难度，准度从 0.80 提到 0.83。'
      + '<b>为什么不做成默认：</b>这 0.03 的差距折算到定数只有 0.03 分，比你自己打同一张谱两次的手感差异还小。'
      + '默认档快 5 倍，就该留在默认。'],
    en: ['<b>There is a new "compute precisely" button.</b> The usual number still appears instantly (a few milliseconds); '
      + 'tap the button and a larger model runs a second pass &mdash; slower (under half a second), but more accurate: '
      + 'agreement with how hard players actually find a chart goes from 0.80 to 0.83. '
      + '<b>Why it is not the default:</b> those 0.03 points are about 0.03 levels, smaller than the difference you feel '
      + 'playing the same chart twice. The default is 5&times; faster and belongs where it is.'],
  },
  {
    v: 'V0.25.0.0', date: '2026-11-04',
    zh: ['<b>功能都回来了。</b> 账号、成绩、数据浏览、谱师页、设置、状态、开放平台、客户端下载 —— 之前被撤掉的那些页面重新上线，导航也补回完整的一份。',
      '<b>数字统一了。</b> 之前同一张谱，拖进工作台是一个数、从搜索页点开是另一个数（差 1.5 级）。现在两条路走同一个模型，并加了一道自动比对：两边算出来差超过 0.05 级就发不出去。'],
    en: ['<b>The features are back.</b> Accounts, scores, data browsing, charter pages, settings, status, the open platform and the client download &mdash; the pages that had been retired are live again, with the full navigation restored.',
      '<b>One number everywhere.</b> The same chart used to give one value when dropped into the workbench and a different one from the search page (1.5 levels apart). Both paths now use the same model, with an automatic check that blocks a release if they differ by more than 0.05 levels.'],
  },
  {
    v: 'V0.24.0.1', date: '2026-11-04',
    zh: ['<b>修一句会误导人的话。</b> 上一个版本把定数换成了新算法，但卡片上还写着「社区共识 · 9508 张里最相近的 20 张」——'
      + '于是出现「数字 14.7，下面列的 5 张全是 15.3 以上」这种自相矛盾的画面。现在标签改成「模型估计」，并注明它不是近邻平均。'],
    en: ['<b>Fixed a misleading label.</b> The previous release switched to the new model, but the card still said '
      + '"community consensus &middot; 20 nearest of 9,508 charts" &mdash; so the number read 14.7 while all five nearest '
      + 'charts below it were 15.3 or higher. The label now reads "model estimate" and states it is not a neighbour average.'],
  },
  {
    v: 'V0.24.0.0', date: '2026-11-04',
    zh: ['<b>定数终于换了新算法。</b> 以前页面上那个数，其实一直用的是「找相似谱面取平均」的老办法 ——'
      + '更早一次改版的接线断了，新的模型从没真正跑起来过。现在换成了看<b>「这个谱要你手怎么动」</b>：'
      + '音符之间要移多远、移多快、三个音连起来的角度有多别扭、同时要按几个键。'
      + '对玩家实际打出来的难度，准确度从 0.75 提到 <b>0.80</b>。',
      '<b>数字更稳了。</b> 顺带加了道自检：每次发版都会拿 5 张已知答案的谱面重算一遍，'
      + '算出来差超过 0.05 级就直接拦下 —— 这种错以前不会报错，只会悄悄偏掉。'],
    en: ['<b>The difficulty estimate now uses a new model.</b> The number on the page had been coming from '
      + 'the old "find similar charts and average them" method &mdash; a wiring break meant the newer model '
      + 'never actually ran. It now looks at <b>how your hands have to move</b>: how far and how fast between '
      + 'notes, how awkward the angle through three notes is, how many keys at once. Agreement with how hard '
      + 'players actually find a chart went from 0.75 to <b>0.80</b>.',
      '<b>More trustworthy numbers.</b> Every release now re-runs five charts with known answers; '
      + 'if the output drifts by more than 0.05 levels the build fails. That kind of error used to pass silently.'],
  },
  {
    v: 'V0.23.0.1', date: '2026-11-02',
    zh: ['<b>修顶栏点进去是「已下线」的问题。</b> 上一个版本把导航砍到 5 项，其中三项'
      + '（定数库、谱师、设置）在现在这个只做分析的版本里已经关停了 —— 点进去只会看到'
      + '「这里不再运营」。现在只保留真正能打开的四个：首页、算定数、标称 vs 实测、规则写谱。'],
    en: ['<b>Fixed dead links in the top bar.</b> The previous version trimmed navigation to five items, '
      + 'but three of them (library, charters, settings) are shut down in this analysis-only build &mdash; '
      + 'clicking them just said "no longer available". Only the four that actually open remain: '
      + 'home, analyse, declared vs measured, rule-based writing.'],
  },
  {
    v: 'V0.23.0.0', date: '2026-11-02',
    zh: ['<b>新增「标称 vs 实测」。</b> 谱面上的定数是谱师自己填的。这一页拿它和玩家实际打出来的难度对照 —— '
      + '3,689 张谱里，<b>近三成的标注和真实体验差了一档以上</b>，还有 12% 差了一档半。'
      + '挑歌之前先看一眼，能少踩几次「看标 7 级结果打不动」的坑。',
      '<b>顶栏瘦了一圈。</b> 从 14 项减到 5 项：首页、算定数、定数库、谱师、设置。'
      + '被收起来的功能（规则写谱、AI 写谱、谱面渲染、谱包、玩家页等）<b>页面都还在</b>，'
      + '老链接照常能打开，只是不再占着顶栏 —— 每天要看的东西不超过五个。'],
    en: ['<b>New: Declared vs Measured.</b> The difficulty on a chart is whatever its author typed. '
      + 'This page puts it next to how hard players actually find it &mdash; across 3,689 charts, '
      + '<b>nearly a third are off by a full level or more</b>, and 12% by a level and a half. '
      + 'Worth a look before you pick a chart.',
      '<b>A shorter top bar.</b> Down from 14 entries to 5: home, analyse, library, charters, settings. '
      + 'The rest of the features (rule-based writing, AI writing, rendering, packs, player pages) '
      + '<b>are all still there</b> and old links still work &mdash; they just no longer crowd the top bar.'],
  },
  {
    v: 'V0.22.5.0', date: '2026-10-31',
    zh: ['<b>写谱功能可以单独关掉了。</b> 它是实验性的，以前一旦出问题只能停整个站点。现在有一道开关：关掉之后与写谱相关的接口直接回「当前部署未启用」，其它页面照常使用。默认是开着的，行为和以前一样。',
      '<b>规则写谱页不再被 AI 面板拖死。</b> 那个面板以前是页面一打开就加载，只要它有一行代码出错，整页就白屏 —— 一个辅助功能把主功能拖下水。现在改成用到时才加载：它坏了只影响它自己，「音频转谱」照常可用。'],
    en: ['<b>Chart writing can be switched off on its own.</b> It is experimental, and until now the only way out of a problem was taking the whole site down. There is now a switch: turn it off and the writing endpoints answer &quot;not enabled in this deployment&quot; while everything else keeps working. It is on by default, so nothing changes for you.',
      '<b>The rule-based chart page no longer dies with the AI panel.</b> That panel used to load as soon as the page opened, so a single bad line blanked the whole page &mdash; a helper taking down the main feature. It now loads only when you use it, so a failure stays contained and audio-to-chart still works.'],
  },
  {
    v: 'V0.22.4.0', date: '2026-10-25',
    zh: ['<b>AI 写谱跑通了，但先当试验品。</b> 你说「给我做张谱」，它会读音频、建多条判定线、铺音符、写判定线动画，最后给你一个能导进 Phira 的 zip。这条路是你在真机上一次次打回来才修对的：导出字段缺、音频编码不对、只有一条线所以是 1D。质量还不稳 —— 同一段音频两次结果可能差很远，当草稿用。',
      '<b>三个「看着成功、其实用不了」的坑</b>：导出的谱面缺 visibleTime，Phira 直接拒收；那个叫 .mp3 的文件其实是 AAC，解码器不认；一张谱只有一条判定线，怎么移动都是一条横线。'],
    en: ['<b>AI chart writing works now &mdash; treat it as experimental.</b> Say &quot;write me a chart&quot; and it reads the audio, builds several judge lines, lays notes, animates the line, and hands you a zip Phira can import. It only got here because your real-device tests kept rejecting it.',
      '<b>Three traps where everything looked fine but nothing worked</b>: exported charts were missing visibleTime so Phira refused them; the file named .mp3 was really AAC and the decoder said no; and a chart with one judge line is a straight line no matter how you move it.'],
  },
  {
    v: 'V0.22.2.2', date: '2026-10-24',
    zh: ['<b>三个数变成一句判断</b>：谱面页原本并排摆着「社区共识 / 官谱标度 / 玩家实测」，'
      + '谁也不解释谁。现在给出结论——三个数一致就是「没有争议」；引擎高出 0.8 以上是'
      + '「看着难，其实能打」；玩家实测高出 0.8 以上是「看着简单，手感坑」。'
      + '这个判断只有我们能做，因为只有我们做了三个独立测量。',
      '<b>玩家实测覆盖翻倍</b>：从 1,700 张扩到 4,532 张谱面。它不看谱面文件，'
      + '只看 5 万名玩家打这张谱时的时间偏差——和引擎算的数方法完全独立。'
      + '把玩家随机劈成两半各算一遍，两次结果一致度 0.949，说明这把尺子本身很稳。',
      '<b>RKS 列出明细</b>：用户页不再只给一个估算数字，而是列出构成它的 20 张谱。'
      + '官方 B19 停更后，新账号这是唯一能看到的成绩结构。'],
    en: ['<b>Three numbers become one verdict.</b> Chart pages used to show "community / official / '
      + 'measured" side by side without explaining anything. Now there is a conclusion: agreement '
      + 'means uncontroversial; engine 0.8+ higher means "looks scary, plays fine"; measured 0.8+ '
      + 'higher means "looks simple, plays nasty". Only possible because we take three independent '
      + 'measurements.',
      '<b>Measured difficulty now covers twice as many charts</b> — 1,700 to 4,532. It ignores the '
      + 'chart file entirely and looks only at how accurately 50,000 players actually hit it. Split '
      + 'the players in half and the two independent results agree at 0.949.',
      '<b>RKS now lists its sources.</b> The profile page shows the 20 charts behind the estimate '
      + 'instead of a single number.'],
  },

  {
    v: 'V0.22.3.0', date: '2026-10-24',
    zh: ['<b>官方 RKS 停了七个月，我们补一个估算</b>：Phira 的 B19 计算从 2026-03 起没有更新，'
      + '新账号的 RKS 一直是 0。现在 /user 页会在官方数值下面补一行「估算 X.XX（近期 N 张谱）」——'
      + '用你最近打过的谱，按官方同一套公式算。',
      '<b>还有个数叫「玩家实测」</b>：谱面页新增一项，不看谱面本身，只看大家打它时的时间偏差，'
      + '反推这张谱实际有多难。和引擎算的那个数方法完全独立，可以互相印证。'],
    en: ['<b>Phira stopped updating RKS seven months ago, so we estimate it.</b> B19 has been frozen '
      + 'since March 2026; new accounts always show 0. The profile page now adds an estimate below '
      + 'the official number, computed from your recent plays with the same formula.',
      '<b>A new figure called "measured"</b>: chart pages now show how hard a chart is according to '
      + 'how accurately players actually hit it — independent of the chart file itself.'],
  },

  {
    v: 'V0.22.0.0', date: '2026-10-23',
    zh: ['<b>引擎看得更全了</b>：以前只用 8 个维度去比对参照谱，其实引擎一早就算出 37 个，'
      + '剩下的没被用上。现在全部用上，同档判断从 80.2% 提到 81.8%。',
      '<b>说明</b>：这次提升是有限的（中位误差 0.487→0.470）。真正的瓶颈是「谱师声明的定数」'
      + '本身带主观噪声，不是算法不够复杂 —— 我们试过换成梯度提升树，反而更差。'],
    en: ['<b>The engine now sees more.</b> It was comparing against reference charts using only 8 '
      + 'dimensions — it had been computing 37 all along. All 37 are now in play; same-tier accuracy '
      + 'goes from 80.2% to 81.8%.',
      '<b>An honest note</b>: the gain is modest (median error 0.487 → 0.470). The real ceiling is that '
      + 'declared chart difficulties are subjective, not that the algorithm is too simple — we tried '
      + 'gradient-boosted trees and they were worse.'],
  },

  {
    v: 'V0.21.5.0', date: '2026-10-22',
    zh: ['<b>界面开始「动」起来了</b>：新增一层克制的动效（进入、悬停、列表逐渐显现），'
      + '并且尊重系统的「减少动态效果」设置。',
      '<b>删掉了那条公告横幅</b> —— 站点已经恢复，那句话说"本站已停止运行"已经不成立。'
      + '被关掉的功能现在会说"在当前部署中未启用"，不再说"网站死了"。'],
    en: ['<b>The interface moves now</b> — a restrained motion layer (enter, hover, staggered lists) '
      + 'that respects the system "reduce motion" setting.',
      '<b>The shutdown banner is gone.</b> The site is back, so "this site has been shut down" '
      + 'was no longer true. Disabled features now say "not enabled in this deployment" instead.'],
  },

  {
    v: 'V0.21.4.0', date: '2026-10-21',
    zh: ['<b>本站收敛为静态的谱面分析工具</b>：账号、成绩、数据管理、状态页与开放 API 全部撤回，'
      + '只保留<b>不依赖数据库</b>的三件事 —— 谱面分析、规则写谱、谱面包。'
      + '被撤的地址会回 <code>410 Gone</code> 并指路。'],
    en: ['<b>This site is now a static chart-analysis tool</b>: accounts, scores, data management, '
      + 'status page and the public API are all withdrawn. Only the three features that never needed '
      + 'a database remain — chart analysis, rule charting, chart packs. Withdrawn URLs return '
      + '<code>410 Gone</code> with a pointer to what still works.'],
  },

  {
    v: 'V0.21.3.1', date: '2026-10-21',
    zh: ['<b>补上许可证的入口</b>：字体与开源库的许可声明现在真的能从站点上点到了，'
      + '之前只在仓库里躺着，浏览器拿不到。<b>协作署名补回</b> —— 之前连着几条提交弄丢过，'
      + '现在由钩子自动补，不会再丢。'],
    en: ['<b>License notices are now reachable from the site</b>: the font and library '
      + 'license texts used to sit in the repo only; they now link from the version page. '
      + '<b>Co-authorship restored</b> — it went missing for a few commits; a hook now adds it automatically.'],
  },

  {
    v: 'V0.21.3.0', date: '2026-10-20',
    zh: ['<b>服务更不容易挂了</b>：以前一次意外错误就能让整站下线（真的发生过三次），现在单个请求出错只影响那一个请求。'
      + '<b>账号绑定 / 注销 / 状态页 30 天视图已全部打通</b>（数据库权限补齐，实测跑通），并且<b>状态页终于进导航了</b>——之前它其实一直存在，只是没人找得到。'],
    en: ['<b>Much harder to knock over</b>: one unexpected error used to take the whole site down '
      + '(it happened three times); now a bad request only affects that request. Account linking, '
      + 'deletion and the 30-day status history now all work end to end.'],
  },

].concat(ARCHIVE);

/* ⚠ 版本历史必须**从新到旧**，`smoke-page.mjs` 有一条断言守着。
   但手写顺序迟早错位 —— 上游就把 `V0.22.3.0` 排在了 `V0.22.2.2` 后面
   （2026-10-25 CI 的 audit 当场抓到）。这里统一排序，别靠人工维护。 */
const verKey = (v) => String(v).replace(/^V/, '').split('.').map((n) => Number(n) || 0);
const RELEASES_SORTED = RELEASES
  .map((r, i) => ({ r, i, k: verKey(r.v) }))
  .sort((a, b) => {
    for (let n = 0; n < 4; n++) {
      const d = (b.k[n] || 0) - (a.k[n] || 0);
      if (d) return d;
    }
    return a.i - b.i;            /* 同版本保持原始先后，排序要稳定 */
  })
  .map((x) => x.r);
RELEASES.length = 0;
RELEASES.push(...RELEASES_SORTED);
