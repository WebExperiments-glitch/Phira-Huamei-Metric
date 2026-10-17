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

export const RELEASES = [
  {
    v: 'V0.11.0.3', date: '2026-10-17',
    zh: [
      '<b>注册恢复正常</b>：上一版把「注册需要邮箱验证码」的服务端逻辑打开了，'
        + '但唯一的注册入口是 Windows 客户端，它还没带验证码字段 —— 于是注册直接失败。'
        + '现在验证码改成<b>开关控制、默认关闭</b>，注册回到原来的样子；'
        + '等客户端加上验证码再打开。',
      '<b>登录、谱面分析、下载都不受影响。</b>',
    ],
    en: [
      '<b>Registration works again</b>: the previous build turned on the server-side "registration '
        + 'needs an email code" rule, but the only registration entry point is the Windows client, '
        + 'which does not send a code yet - so signing up failed. The code requirement is now '
        + '<b>behind a switch, off by default</b>; it will be turned on once the client supports it.',
      '<b>Login, chart analysis and downloads are unaffected.</b>',
    ],
  },
  {
    v: 'V0.11.0.2', date: '2026-10-17',
    zh: [
      '<b>修复「谱面分析打不开」</b>：昨晚改限流时误删了两个并发控制用的常量，'
        + '而分析接口还在引用它们 —— 于是<b>每请求一次分析，服务进程就退出一次</b>。'
        + '已补回，并加了一套「把每个接口都打一遍、再确认服务还活着」的回归测试，'
        + '这类问题不会再无声无息地漏过去。',
      '⚠ <b>注册现在需要邮箱验证码</b>（登录仍然只要密码）。'
        + '但<b>网页端的注册表单还没做完</b> —— 在这个版本上注册会提示缺少验证码。'
        + '已经有账号的话不受影响。',
    ],
    en: [
      '<b>Fixed “chart analysis will not open”</b>: while reworking rate limiting last night I '
        + 'accidentally deleted two concurrency constants that the analysis endpoint still referenced — '
        + 'so <b>every analysis request killed the server process</b>. Restored, plus a regression test '
        + 'that hammers every endpoint and then checks the server is still alive.',
      '⚠ <b>Registration now requires an email code</b> (login still only needs a password). '
        + 'The <b>web registration form is not finished yet</b>, so signing up returns “code required” '
        + 'on this build. Existing accounts are unaffected.',
    ],
  },
  {
    v: 'V0.11.0.1', date: '2026-10-17',
    zh: [
      '<b>限流重做了一遍</b>：之前的限流在生产环境其实<b>一次都没生效过</b> —— '
        + '计数写在一个不可写的文件里，每次请求都从零开始数。现在计数放在云端数据库，'
        + '并且按「身份优先、IP 兜底」来分桶（IP 在网络代理后面本来就不可信）。<br>'
        + '实测：连续发 25 次超过 20 次/分的上限时，会稳定收到 429 并带一个'
        + '<code>Retry-After</code> 告诉你几秒后可以再试。',
      '<b>登录/注册加了按邮箱的限流</b>：每 IP 每分钟 5 次、每个<b>邮箱</b>每分钟 3 次、'
        + '全局每分钟 20 次。按邮箱那一维是关键 —— 否则换个网络环境就能对同一个账号'
        + '无限试密码。',
      '<b>成绩提交的校验收紧了</b>：一行成绩必须同时有曲名和准确度才会被接收，'
        + '单次最多 20 行（原来 500 行）。',
      '<b>取谱代理改成路径白名单</b>：只转发客户端真正用到的几个接口，'
        + '不再把上游整个 API 面暴露出去。',
      '数据库不可用时：<b>写入和登录会明确报 503「服不可用」</b>（而不是假装被限流），'
        + '只读页面照常工作。',
    ],
    en: [
      '<b>Rate limiting was rebuilt</b>: the previous version <b>never actually worked in '
        + 'production</b> — counters were written to a file that cannot be written to, so every '
        + 'request started counting from zero. Counters now live in the cloud database and are keyed '
        + 'by <b>identity first, IP second</b> (IPs are inherently unreliable behind proxies).<br>'
        + 'Measured: sending 25 requests past the 20/min limit reliably returns 429 with a '
        + '<code>Retry-After</code> telling you when to retry.',
      '<b>Per-email limits on login/register</b>: 5/min per IP, 3/min per <b>email</b>, '
        + '20/min globally. The per-email dimension matters — otherwise switching networks gives '
        + 'unlimited password guesses at one account.',
      '<b>Score submission validation tightened</b>: a row needs both a chart name and an accuracy, '
        + 'and a single request is capped at 20 rows (was 500).',
      '<b>The chart proxy is now a path allowlist</b>: only the endpoints the client actually uses '
        + 'are forwarded, instead of the whole upstream API surface.',
      'When the database is unreachable: <b>writes and logins return an explicit 503</b> '
        + '(instead of pretending to be rate-limited), while read-only pages keep working.',
    ],
  },
  {
    v: 'V0.11.0.0', date: '2026-10-16',
    zh: [
      '<b>安全加固</b>（由授权白帽测试驱动）：修掉「写入限流在生产环境完全失效」——'
        + '此前连发 70 次请求也不会被拦，因为限流计数写进了一个<b>不可写的文件</b>，'
        + '每次都从零开始数。现在改为进程内计数，并给所有超限响应加上标准的 '
        + '<code>Retry-After</code> 头。',
      '<b>登录/注册加上三重限流</b>：每个 IP 每分钟 5 次、每个<b>邮箱</b>每分钟 3 次、全局每分钟 20 次。'
        + '按邮箱限流是关键——否则换一个 IP 就能对同一个账号无限试密码。',
      '<b>成绩上传的校验补上了</b>：一行「成绩」现在必须同时有曲名和准确度才会被接受。'
        + '此前只填曲名就能写入，测试期间被灌进了 3 行垃圾数据（已清理）。'
        + '单次提交行数上限从 500 降到 20。',
      '<b>取谱代理改为路径白名单</b>：只放行客户端真正用到的几个前缀'
        + '（谱面元数据、自己的成绩、服务条款、音频），'
        + '不再是把上游整个 API 面透传出去。',
      '<b>谱面贡献加上并发上限</b>：每次贡献都会让服务端下载谱面并复算，'
        + '现在最多同时 2 个，超出会明确告知稍后重试。',
      '修复一个<b>潜在的跨站脚本风险</b>：内联的转义函数漏掉了单引号，'
        + '现已与主模块的版本完全一致。',
    ],
    en: [
      '<b>Security hardening</b> (driven by an authorised white-hat test): fixed "write rate limiting '
        + 'completely dead in production" — 70 consecutive requests used to pass unchecked because the '
        + 'counter was written to an <b>unwritable file</b>, so every request restarted from zero. '
        + 'Counters now live in-process, and every throttled response carries the standard '
        + '<code>Retry-After</code> header.',
      '<b>Three-way rate limiting on login/register</b>: 5/min per IP, 3/min per <b>email</b>, '
        + '20/min globally. The per-email dimension is the important one — otherwise rotating IPs '
        + 'gives unlimited password guesses against one account.',
      '<b>Score uploads are validated again</b>: a "score" row now needs both a chart name and an '
        + 'accuracy before it is accepted. Previously a chart name alone was enough, and three junk '
        + 'rows were written during testing (now cleaned up). Per-request row cap lowered from 500 to 20.',
      '<b>The chart proxy is now a path allowlist</b>: only the prefixes the client actually uses '
        + '(chart metadata, your own scores, terms of service, audio) are forwarded — no longer a '
        + 'pass-through to the whole upstream API.',
      '<b>Concurrency cap on chart contributions</b>: each contribution makes the server download and '
        + 'recompute a chart, so at most 2 run at once; extra requests are told to retry shortly.',
      'Fixed a <b>latent XSS risk</b>: the inline escaping function missed the single quote, and now '
        + 'matches the main module exactly.',
    ],
  },
  {
    v: 'V0.10.0.0', date: '2026-10-12',
    zh: [
      '账号改成<b>我们自己的</b>了。注册只要<b>邮箱 + 密码</b>，不再需要收验证码；'
        + '之后每次登录<b>只输密码</b>就行（邮箱会记住）。<br>'
        + '<b>不登录也完全能正常玩</b>，登录只为了一件事：把每局的逐音符判定传上来。',
      '新增<b>账号密码</b>存的是不可逆的哈希值，服务端看不到你的原密码；'
        + '登录用的凭证由本站自己签发并校验 —— 顺带补上了一个旧漏洞：'
        + '以前服务端<b>没法验证</b>登录凭证的真伪，理论上可以伪造身份。<br>'
        + '另外登录失败时不会告诉你「是邮箱没注册还是密码错了」—— 那等于给人一个'
        + '批量探测谁注册过的工具。',
      '客户端结算界面新增两行：<b>早/晚偏差条</b>（你是抢拍还是拖拍，'
        + '这个在准度上看不出来）和<b>失分构成</b>（丢的分里有多少来自判定、多少来自断连，'
        + '直接告诉你该练准度还是别断连）。',
      '修掉结算界面上那个<b>一直是 ±0ms</b> 的误差值 —— 它从来就没被算过，'
        + '只是写死了一个 0。现在是真的。',
    ],
    en: [
      'Accounts are now <b>ours</b>. Signing up needs only <b>an email and a password</b> — no verification code. '
        + 'After that, logging in takes <b>just your password</b> (the email is remembered).<br>'
        + '<b>You can play perfectly well without an account</b>; signing in does one thing only: upload the '
        + 'per-note judgements of each play.',
      'Passwords are stored only as an irreversible hash — the server never sees your password. Login tokens are '
        + 'issued and verified by this site, which also closes an old hole: the server previously <b>could not '
        + 'verify</b> login tokens, so identities were forgeable.<br>'
        + 'A failed login no longer tells you whether the email exists or the password was wrong — that would be a '
        + 'free tool for probing who has registered.',
      'The in-game result screen gains two rows: a <b>timing bias bar</b> (are you rushing or dragging? accuracy '
        + 'alone will not tell you) and a <b>loss breakdown</b> (how much of what you lost came from judgement '
        + 'versus from dropped combo — which tells you what to practise).',
      'Fixed the <b>±0ms</b> timing error on the result screen — it was never computed, just hardcoded to zero. '
        + 'It is real now.',
    ],
  },
  {
    v: 'V0.9.6.0', date: '2026-10-11',
    zh: [
      '新增<b>「下载」页</b>（顶栏最后一个入口）：Windows 客户端可以直接从本站下载，'
        + '同时给出文件大小、客户端版本和 SHA-256，方便你核对下载到的东西没被改过。',
      '修复「<b>打完一局成绩没记上</b>」：服务端复算分数时用错了连击数，'
        + '只要中途断过连就会被误判成「分数对不上」而整局丢弃。现在改用结算里真实的连击数。',
      '服务端遇到「分数与判定明细对不上」时<b>不再直接丢弃成绩</b>，'
        + '改为记入服务端日志并继续入库 —— 宁可留一条可疑数据，也不该弄丢真实成绩。',
    ],
    en: [
      'New <b>Download page</b> (last entry in the nav): grab the Windows client straight from this site, together '
        + 'with its file size, client version and SHA-256 so you can check nothing was altered on the way.',
      'Fixed "<b>a finished play did not get recorded</b>": the server recomputed your score using the wrong '
        + 'combo count, so any play that had dropped its combo was misjudged as a score mismatch and thrown away. '
        + 'It now uses the real max combo from the result.',
      'When the server sees a <b>score that does not match the judgement breakdown</b>, it no longer discards the '
        + 'play — it logs the discrepancy and stores the result anyway. A suspicious row beats a lost score.',
    ],
  },
  {
    v: 'V0.9.5.1', date: '2026-10-11',
    zh: [
      '<b>可以自助注销了</b>：设置 → 账号管理 → 「注销账号」，一键删除本站云端的资料'
        + '（Phira 绑定、显示名、访问计数）。<br>'
        + '⚠ 说清楚一件做不到的事：<b>登录邮箱本身删不掉</b> —— 它在平台的认证系统里，'
        + '本站没有删除权限。需要删邮箱请发邮件，我们会协助处理。',
      '隐私政策新增<b>「个人信息对外提供清单」</b>：把信息交给外部服务商的情形逐项列全，'
        + '写明接收方、联系方式、处理目的、处理方式、信息种类。',
      '新增<b>投诉举报渠道</b>：邮箱可直接联系我们，承诺 15 个工作日内答复。'
        + '涉及隐私的请求请用邮件，不要发在公开 Issue 里。',
    ],
    en: [
      '<b>You can delete your account yourself now</b>: Settings → Account → "Delete account" removes '
        + 'this site’s cloud data (Phira binding, display name, visit counter) in one click.<br>'
        + '⚠ And one thing we cannot do, stated plainly: <b>the login e-mail itself cannot be deleted</b> '
        + '— it lives in the platform’s authentication system and this site has no permission to remove it. '
        + 'E-mail us and we will help.',
      'The privacy policy gained a <b>personal-information disclosure list</b>: every case where your data reaches '
        + 'an external provider, with recipient, contact, purpose, method and data type.',
      'New <b>complaint channel</b>: e-mail us directly, with a 15-working-day reply commitment. '
        + 'Privacy-related requests should go by e-mail, never in a public Issue.',
    ],
  },
  {
    v: 'V0.9.5.0', date: '2026-10-11',
    zh: [
      '修「页面下半部分整块空白」：某些浏览器会攥着**上一次缓存的旧脚本**不放，'
        + '连强制刷新都不重新校验，于是脚本加载失败、页面剩下的部分不再渲染。'
        + '现在这类旧副本**最多一小时就会自己更新**，不用你手动清缓存。',
      '静态资源加了 ETag —— 更新检查变成一次轻量的「有没有变」，不再重下大文件。',
    ],
    en: [
      'Fixed "the bottom half of the page goes blank": some browsers hold on to a '
        + '<b>stale cached script</b> and will not revalidate it even on a hard reload, '
        + 'so the script fails to load and the rest of the page never renders. '
        + 'Stale copies now <b>update themselves within an hour</b> — no manual cache clearing.',
      'Static files now carry an ETag, so checking for updates is a cheap round-trip instead of re-downloading large files.',
    ],
  },
  {
    v: 'V0.9.4.0', date: '2026-10-11',
    zh: [
      '新增<b>版本历史</b>页（设置 → 关于 → 历史版本）：每个版本改了什么，一屏看完。页脚的版本号也可以直接点。',
      '<b>强调色统一</b>：此前链接、按钮、复选框是蓝色的，和琥珀主色打架；现在全站只有一种强调色。',
      '<b>标题换成思源宋体</b>（自托管子集，83KB）。衬线标题压在暖底色上更有书卷气；正文仍是系统字体，不额外下载。',
      '正文行高放宽到 1.75，长说明限宽 —— 中文一行几十个字读起来不累了。',
      '修「切页面时 logo 横向跳一下」：顶栏现在全站对齐。',
      '卡片加了极轻的浮起感，首页功能卡的标题也不再和说明糊在一起。',
      '修页脚偶发的「· · GPL-3.0」（那个位置本该显示版本号）。',
    ],
    en: [
      'New <b>version history</b> page (Settings → About → Version history): every release and what it changed, in one place. The footer version number links to it too.',
      '<b>One accent colour at last</b>: links, buttons and checkboxes used to be blue and fought with the amber; the site now has a single accent.',
      '<b>Headings moved to Noto Serif SC</b> (self-hosted subset, 83 KB). Serif headings sit better on the warm background; body text stays on system fonts with no extra download.',
      'Body line-height widened to 1.75 and long paragraphs capped in width — Chinese text is easier to scan now.',
      'Fixed the logo shifting sideways when moving between pages: the top bar is now aligned across the whole site.',
      'Cards picked up a very light lift, and the homepage card titles no longer blur into their descriptions.',
      'Fixed a stray "· · GPL-3.0" in the footer, where the version number should have been.',
    ],
  },
  {
    v: 'V0.9.2.1', date: '2026-10-11',
    zh: [
      '界面配色整体换成<b>暖调</b>：深色是暖炭、浅色是暖纸白，与琥珀主色同一色温。',
      '全部 38 组配色按 WCAG 重算了对比度：正文 ≥4.5、占位符 ≥3。'
        + '此前占位符只有 2.5、小标签 4.37，都偏低。',
      '拖拽区：说明收进折叠；去掉那条看着像"没加载完"的空灰条；图标统一成线性图标。',
      '「不确定范围」从一行小字改成一条<b>范围带</b> ——带宽就是结论的软硬，一眼可辨。',
    ],
    en: [
      'The whole palette moved to a <b>warm</b> temperature: warm charcoal in dark, warm paper in light — now in the same family as the amber accent.',
      'All 38 colour pairs were re-checked against WCAG: body text ≥4.5, placeholders ≥3. Placeholders used to sit at 2.5 and small labels at 4.37.',
      'Drop zone: the long explanation folds away, the empty grey strip that looked like a stalled load is gone, and the icons are now one consistent line style.',
      'The uncertainty range is drawn as a <b>band</b> instead of a line of small text — its width is the whole point, and now you can see it at a glance.',
    ],
  },
  {
    v: 'V0.9.2.0', date: '2026-10-11',
    zh: [
      '修「点「算」有时算不出来」：谱面文件会跳转到下载节点，程序没跟随这次跳转'
        + '——缓存里已有的谱正常，没有的一律失败。',
      '修「拖入谱面后共享缓存不增长」：贡献接口的必填字段认错了，每一行都被丢弃。',
      '修「谱师页整页空白」：浏览器缓存里的旧版脚本与新页面不兼容，导致整段脚本不执行。',
      '修「一批谱的参考定数全变成空」：批量读取的响应被截断在 8KB（约 19 张谱）。',
      '修「写接口的限流从未生效」；加固下载域名白名单、解压体积上限，'
        + '畸形链接不再能打断服务。',
    ],
    en: [
      'Fixed "Analyze sometimes fails": the chart file redirects to a download node and the follow-up request was not made — cached charts worked, new ones never did.',
      'Fixed "sharing a chart never grows the shared cache": the contribution endpoint required the wrong field, so every row was discarded.',
      'Fixed the charters page rendering blank: a stale cached script was incompatible with the new page, which stopped the whole script from running.',
      'Fixed "a batch of charts loses all its constants": the batch response was truncated at 8KB (about 19 charts).',
      'Fixed the write rate limit never firing; hardened the download host allowlist and the unpack size cap so malformed links can no longer take the service down.',
    ],
  },
  {
    v: 'V0.9.1.0', date: '2026-10-07',
    zh: [
      '全站<b>中英双语</b>（含隐私政策与用户协议）。',
      '谱师搜索重写：改成<b>按账号精确取作品</b>。此前是按名字比对「谱师」字段，'
        + '而那个字段是自由填写的（很多人写团队名），所以经常搜不到。',
      '修主题切换与页脚版本号在英文模式下不生效的问题。',
    ],
    en: [
      'The site is now fully <b>bilingual</b> (privacy policy and terms included).',
      'Charter search was rewritten to fetch a charter\u2019s works <b>by account</b>. It used to match the free-text "charter" field, which is often a team name — so searches frequently came up empty.',
      'Fixed the theme switch and the footer version number not applying in English mode.',
    ],
  },
  {
    v: 'V0.9.0.0', date: '2026-10-07',
    zh: ['修主题切换的真实缺陷。', '新增「屎山考核」静态检查，防止代码腐化。'],
    en: ['Fixed a real defect in theme switching.', 'Added a static "code rot" check.'],
  },
  {
    v: 'V0.8.2.0', date: '2026-10-07',
    zh: ['恢复被误删的「全部进入数据飞轮」入口。'],
    en: ['Restored the "submit everything to the data flywheel" entry point that had been deleted by mistake.'],
  },
  {
    v: 'V0.8.1.0', date: '2026-10-07',
    zh: ['修「总是拿不到最新数据」：堵住第三方接口的缓存缺口。'],
    en: ['Fixed "always getting stale data" by closing a caching gap on a third-party endpoint.'],
  },
  {
    v: 'V0.8.0.0', date: '2026-10-07',
    zh: ['新增<b>深/浅双主题</b>。', '修「切了语言但部分界面不跟着变」——那是同一模块被加载了两份。'],
    en: ['Added <b>light and dark themes</b>.', 'Fixed "switching language leaves part of the UI behind" — the same module was being loaded twice.'],
  },
  {
    v: 'V0.7.0.0', date: '2026-10-07',
    zh: ['确立视觉体系：<b>全站只用一种强调色</b>，层级靠亮度而不是色相。', '界面文案瘦身，新增正式文档页。'],
    en: ['Established the visual system: <b>a single accent colour site-wide</b>, hierarchy by luminance rather than hue.', 'Tightened the interface copy and added proper documentation pages.'],
  },
  {
    v: 'V0.6.0.0', date: '2026-10-07',
    zh: ['设置独立成页（<span class="mono">/settings</span>），并把散落各页的设置项收拢到一处。'],
    en: ['Settings became its own page (<span class="mono">/settings</span>), gathering the options that had been scattered across pages.'],
  },
  {
    v: 'V0.5.1.0', date: '2026-10-07',
    zh: ['密码策略加固：下限从 6 位提到 <b>10 位</b>，并拦掉纯数字、纯小写这类弱密码。'],
    en: ['Strengthened the password policy: minimum length raised from 6 to <b>10</b>, and all-digits or all-lowercase passwords are now rejected.'],
  },
  {
    v: 'V0.5.0.0', date: '2026-10-07',
    zh: ['修「怎么算都是 15.0」——换成参照集最近邻，不再用固定分箱。', '整体提升新用户可用性。'],
    en: ['Fixed "everything comes out as 15.0" by switching to nearest-neighbour over the reference set instead of fixed bins.', 'Improved overall usability for first-time visitors.'],
  },
  {
    v: 'V0.4.2.0', date: '2026-10-07',
    zh: ['全站真正分页，并新增数据管理页（全库浏览/排序/过滤）。'],
    en: ['Real pagination across the site, plus a new data page for browsing, sorting and filtering the whole cache.'],
  },
  {
    v: 'V0.4.1.0', date: '2026-10-07',
    zh: ['站点拆分：工作台 / 玩家 / 谱师各自独立成页。', '修「玩了很多但检测不到成绩」。'],
    en: ['Split the site into separate pages for the workbench, players and charters.', 'Fixed "I have plenty of plays but none are detected".'],
  },
  {
    v: 'V0.4.0.0', date: '2026-10-07',
    zh: ['引擎换代：引入社区参照集与 <b>双标度</b>输出（社区共识 + 官谱标度）。'],
    en: ['Engine upgrade: introduced the community reference set and <b>dual-scale</b> output (community consensus plus official scale).'],
  },
];
