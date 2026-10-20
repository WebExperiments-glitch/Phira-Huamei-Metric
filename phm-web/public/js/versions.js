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
    v: 'V0.21.3.0', date: '2026-10-20',
    zh: ['<b>服务更不容易挂了</b>：以前一次意外错误就能让整站下线（真的发生过三次），现在单个请求出错只影响那一个请求。'
      + '<b>账号绑定 / 注销 / 状态页 30 天视图已全部打通</b>（数据库权限补齐，实测跑通）。'],
    en: ['<b>Much harder to knock over</b>: one unexpected error used to take the whole site down '
      + '(it happened three times); now a bad request only affects that request. Account linking, '
      + 'deletion and the 30-day status history now all work end to end.'],
  },

  {
    v: 'V0.21.2.0', date: '2026-10-20',
    zh: ['登录/注册<b>换成本站自己的账号系统</b>。好处是三件：'
      + '<b>不再依赖第三方 CDN</b>（首页更快、少一个外部来源）、'
      + '<b>注销账号是真删除</b>（账号、绑定、访问计数一起清掉，以前只能删资料、邮箱要另发邮件申请）、'
      + '以及<b>登录状态更稳</b>（断网时提示"读不到状态"而不是误报"未登录"）。',
      '⚠ 已有账号<b>需要重新注册一次</b>（密码自定）—— '
      + '旧的平台账号本站无法读取；但<b>贡献过的成绩不受影响</b>（它们本来就不挂在账号上）。'],
    en: ['Sign-in and sign-up now run on <b>our own account system</b>. Three things change: '
      + '<b>no third-party CDN</b> (faster first paint, one less external source), '
      + '<b>deleting an account really deletes it</b> (account, Phira link and visit count together — '
      + 'before, only site data could be removed and the e-mail needed a separate request), '
      + 'and <b>sign-in state is more reliable</b> (a network hiccup now says "cannot read state" '
      + 'instead of wrongly claiming "signed out").',
      '⚠ Existing accounts <b>need to register once more</b> (pick your password) — '
      + 'the old platform account cannot be read from here. '
      + '<b>Scores you contributed are unaffected</b> (they were never tied to an account).'],
  },

  {
    v: 'V0.21.1.3', date: '2026-10-20',
    zh: ['自动写谱<b>节奏准了</b>：每个音都落在能打的拍子上（含<b>三连音</b>），'
      + '而且<b>不会再为了凑密度造音符</b> —— 歌里有多少音乐事件就出多少音。',
      '新增<b>谱面详情页</b>：每首歌都有一个可分享的链接，搜索引擎也能找到；'
      + '分享卡上多了<b>二维码</b>（手机扫码直达）；导航多了<b>全局搜索</b>；'
      + '状态页多了<b>按小时的可用色条</b>。'],
    en: ['<b>Auto-charting now stays on the beat</b>: every note snaps to a playable subdivision '
      + '(including <b>triplets</b>), and it <b>no longer invents notes to hit a density target</b>.',
      'New <b>chart detail pages</b>: every chart has a shareable, indexable URL. '
      + 'Share cards now carry a <b>QR code</b>, the nav has <b>global search</b>, '
      + 'and the status page gained an <b>hourly availability strip</b>.'],
  },

  {
    v: 'V0.21.1.2', date: '2026-10-19',
    zh: ['自动写谱的<b>节奏准了</b>：每个音都会被吸到能打的拍子上（含<b>三连音</b>），'
      + '而不是检测到哪就放在哪。另外<b>不会再为了凑密度造音符</b>——'
      + '歌里有多少音乐事件就出多少音，凑不够会直接告诉你差多少。'],
    en: ['<b>Auto-charting now stays on the beat</b>: every note snaps to a playable subdivision '
      + '(including <b>triplets</b>) instead of landing wherever the detector fired. '
      + 'It also <b>no longer invents notes to hit a density target</b> — if the song has fewer '
      + 'musical events, it says so.'],
  },

  {
    v: 'V0.21.1.1', date: '2026-10-19',
    zh: ['玩家页新增<b>「导出成绩卡」</b>：把你的成绩做成一张可以直接发群里的图，'
      + '上面同时印着 <b>P.H.M. RKS</b>（用我们的定数重算）和 Phira 官方 RKS，'
      + '并说明为什么两者会不一样。'],
    en: ['The player page can now <b>export a player card</b> — an image you can drop '
      + 'straight into a group chat. It shows <b>P.H.M. RKS</b> (recomputed with our constants) '
      + 'next to the official Phira RKS, and explains why the two differ.'],
  },

  {
    v: 'V0.21.1.0', date: '2026-10-19',
    zh: ['新增<b>谱面包</b>页：浏览 Phira 谱面库，把任意谱面连曲绘 / 音乐 / 谱面文件'
      + '一起<b>在浏览器里</b>打成 .pez 包下载，也可以只下单个文件。'
      + '曲绘现在能正常显示了（之前全是音符占位图）。'],
    en: ['New <b>chart packs</b> page: browse the Phira library and download any chart as a .pez'
      + ' with its illustration, audio and chart file — packed <b>in your browser</b>,'
      + ' or grab single files. Illustrations now actually load (they used to be placeholder notes).'],
  },

  {
    v: 'V0.21.0.0', date: '2026-10-18',
    zh: ['结果卡新增<b>「难在哪」</b>：耐力 / 灵活度 / 读谱 / 精度四项，'
      + '直接回答「这首是手速难还是读谱难」。'
      + '它不改动定数本身——同一张谱面的<b>定数一个字都不变</b>。'],
    en: ['Results now include a <b>"where it is hard"</b> breakdown: stamina / dexterity / reading / precision. '
      + 'It does not change the difficulty number — the score for a given chart is bit-for-bit unchanged.'],
  },
  {
    v: 'V0.20.4.2', date: '2026-10-18',
    zh: ['首页<b>对普通玩家友好</b>了：第一屏放一个搜索框，歌名 / 谱师 / UID 直接搜，不用先搞懂谱面文件。另外全站加了<b>错误提示</b>：页面出问题时会说出来，不再是静默无反应。'],
    en: ['The homepage is now <b>friendlier to regular players</b>: a search box up front for songs / charters / UIDs, no need to understand chart files first. Also added <b>error reporting across the site</b> — when something breaks, it says so instead of failing silently.'],
  },
  {
    v: 'V0.20.4.1', date: '2026-10-18',
    zh: ['<b>修「每次都要重新登录」</b>：云 SDK 与页面主逻辑都是 defer 加载，CDN 一慢就会先跑完页面脚本，导致登录态恢复被静默跳过。现在统一等 SDK 就绪，并把「系统没连上」与「你没登录」分开提示。<b>另：记住登录邮箱</b>，下次打开自动填好（只存邮箱，密码与 token 均不落盘）。'],
    en: ['<b>Fixed "I have to sign in every time"</b>: the cloud SDK and the page both load deferred, so a slow CDN let the page script finish first and session recovery was silently skipped. Now it waits for the SDK, and "the service is unreachable" is reported separately from "you are signed out". <b>Also remembers your sign-in email</b> and pre-fills it next time (email only — no password or token is ever stored here).'],
  },
  {
    v: 'V0.20.4.0', date: '2026-10-18',
    zh: ['<b>API 文档大幅升级</b>，端点从 9 个扩到 13 个：新增 <b>列出谱面</b>（分页/搜索/排序）、<b>全库统计</b>、<b>谱师作品</b>、<b>玩家资料</b>。文档页新增<b>在线 Playground</b> —— 填 Key 直接打真实请求，不用配环境就知道接口通不通。'],
    en: ['<b>API docs, upgraded</b> — endpoints go from 9 to 13: chart listing (paged/searchable/sortable), database statistics, charts by charter, and player profiles. The docs page gains a live <b>Playground</b>: paste a key, hit a real endpoint, no setup.'],
  },
  {
    v: 'V0.20.3.4', date: '2026-10-18',
    zh: ['<b>API 鉴权第二轮</b>：上一版修好 <code>Authorization</code> 被网关改写后，实测发现 <code>x-api-key</code> 也被网关当成<b>它自己的</b>鉴权头消费掉，Key 根本送不到服务端（假 Key 也返回 200）。新增私有头 <b><code>x-phm-key</code></b> 作为首选通道；并新增 <a href="/api/v1/meta?diag=1">诊断口</a>，只回各头的长度，用来判断是「头没穿透」还是「Key 不对」。'],
    en: ['<b>API auth, round two</b>: after fixing the gateway-injected <code>Authorization</code>, testing showed <code>x-api-key</code> is also swallowed by the gateway as its <b>own</b> auth header, so the key never reached the server (a fake key still returned 200). Added a private <b><code>x-phm-key</code></b> header as the preferred channel, plus a <a href="/api/v1/meta?diag=1">diagnostic endpoint</a> that reports only header lengths, to tell "header did not pass through" from "wrong key".'],
  },
  {
    v: 'V0.20.3.3', date: '2026-10-18',
    zh: ['<b>修 API 鉴权被网关污染</b>：本站前面的网关会在转发时写入它自己的 <code>Authorization</code> 头，导致匿名请求与带 Key 的请求<b>一起被误判成 invalid_api_key</b>（线上 API 实际不可用）。现在优先读 <code>x-api-key</code>，<code>Authorization</code> 只认 <code>sk-</code> 前缀。开发者文档同步改为推荐 <code>x-api-key</code>。'],
    en: ['<b>Fixed API auth being poisoned by the gateway</b>: the gateway in front of this site injects its own <code>Authorization</code> header, so both anonymous requests and requests with a valid key were <b>rejected with invalid_api_key</b> (the live API was effectively down). We now read <code>x-api-key</code> first, and only accept an <code>sk-</code> prefixed value from <code>Authorization</code>. Developer docs now recommend <code>x-api-key</code>.'],
  },
  {
    v: 'V0.20.3.2', date: '2026-10-18',
    zh: ['在写谱页顶部加醒目免责声明：<b>这是随便写的，可能有非常严重的 Bug</b>；生成结果不保证节奏/可玩性/格式正确，请先在 Phira 验证，不要用于正式谱面或比赛。'],
    en: ['Added a prominent warning at the top of the charting page: <b>this is written casually and may contain very serious bugs</b>; results are not guaranteed, verify in Phira first, and do not use for formal charts or contests.'],
  },
  {
    v: 'V0.20.3.1', date: '2026-10-18',
    zh: ['单判定线 X=-300、Y=200 保持不变；音符仍保留左右手分散 x（±405/±202.5），不会全挤在线上。'],
    en: ['Single judge line stays at X=-300, Y=200; notes keep left/right spread x values (±405/±202.5) instead of collapsing onto one point.'],
  },
  {
    v: 'V0.20.3.0', date: '2026-10-18',
    zh: ['改为<b>单条判定线</b>，位置固定在 <b>X=-300、Y=200</b>；所有音符 positionX=0 挂在这条线上，仍是一次一个、Tap/Drag、无 Hold。'],
    en: ['Now a <b>single judge line</b> fixed at <b>X=-300, Y=200</b>; every note has positionX=0 on that line, still one note at a time, Tap/Drag, no Holds.'],
  },
  {
    v: 'V0.20.2.0', date: '2026-10-18',
    zh: ['可玩性修复：左右手各占半屏交替落点，不再全屏随机；去掉 Hold 长条，只留 Tap/Drag，避免长条与蓝键重叠。'],
    en: ['Playability fix: left/right hands alternate within their own half-screen zones instead of random full-screen jumps; Holds removed, only Tap/Drag, so long bars no longer overlap taps.'],
  },
  {
    v: 'V0.20.1.2', date: '2026-10-18',
    zh: ['修复系统难度未生效：页面分析完成后重新调用 detectDifficulty 并显示判定；生成不再 fallback HD。长音频分析实测约 2.6 秒。'],
    en: ['Fixed system difficulty not taking effect: after analysis the page calls detectDifficulty and shows the result; generation no longer falls back to HD. Long-track analysis is ~2.6s.'],
  },
  {
    v: 'V0.20.1.1', date: '2026-10-18',
    zh: ['修页面卡在“解码并分析中”：MIT 节拍库的 worker 不能阻塞分析主链路，已移出；页面只用本地 FFT 分析（参考曲 189s 实测约 0.5s）。库仍保留在 vendor。'],
    en: ['Fixed the page hanging at “decoding/analysing”: the MIT beat-detector worker was blocking the main analysis path; it is now off the critical path. Local FFT analysis is ~0.5s for a 189s reference track; the library remains vendored.'],
  },
  {
    v: 'V0.20.1.0', date: '2026-10-18',
    zh: ['离线 AI 分轨管线跑通：<b>Demucs 4.1.0 (MIT)</b> 拆 drums/no_drums，再接鼓/钢琴 onset 与规则谱，输出 .pez。新增 <code>tools/ai-chart.mjs</code> 与 <code>tools/install-demucs.ps1</code>；模型不进网页包，只在本地跑。'],
    en: ['Offline AI stem pipeline works: <b>Demucs 4.1.0 (MIT)</b> splits drums/no_drums, then drum/piano onsets feed the rule engine and produce .pez. Added <code>tools/ai-chart.mjs</code> and <code>tools/install-demucs.ps1</code>; models are local-only.'],
  },
  {
    v: 'V0.20.0.0', date: '2026-10-18',
    zh: ['改为 <b>2 指自由分散</b>：x 在 ±540 内连续分布，不再固定 2/5 条轨道；一次一个 note。项目内安装 MIT <b>web-audio-beat-detector 8.2.39</b>（vendor 内已 bundle），浏览器 BPM 交叉校验；鼓/钢琴点仍分开显示。'],
    en: ['Now <b>two-finger free spread</b>: x is continuous within ±540, no fixed 2/5 lanes; one note at a time. Bundled MIT <b>web-audio-beat-detector 8.2.39</b> in vendor for browser BPM cross-check; drum/piano counts remain separate.'],
  },
  {
    v: 'V0.19.1.0', date: '2026-10-18',
    zh: ['严格锁死 <b>2K</b>：只保留 ±405 两条轨道，不再出现 5 个 x / 4K+ 观感。新增 MIT 节拍/鼓钢琴分离调研文档（web-audio-beat-detector、Demucs、Spleeter、Open-Unmix、Omnizart）。'],
    en: ['Strictly <b>2K</b>: only the ±405 two lanes, no more 5-x / 4K+ look. Added MIT audio research doc (web-audio-beat-detector, Demucs, Spleeter, Open-Unmix, Omnizart).'],
  },
  {
    v: 'V0.19.0.0', date: '2026-10-18',
    zh: ['补上真正的音频特征：<b>鼓点 / 钢琴点分离</b>（低频 kick、高频噪声+谱平坦度→鼓；中频谐波→钢琴），页面显示两组点数；排谱优先用钢琴点。BPM 改为 60–200 网格搜索 + 半拍/IOI 修正，参考曲从错误的 152 修正到 190。'],
    en: ['Real audio features: <b>drum / piano onset separation</b> (low-frequency kick + high-frequency noise/flatness for drums; mid harmonics for piano), both counts shown; charting prefers piano onsets. BPM now uses 60–200 grid search + half-beat/IOI correction; the reference track is 190 instead of the previous wrong 152.'],
  },
  {
    v: 'V0.18.0.0', date: '2026-10-18',
    zh: ['按你给的两个参考 ZIP 反推：Pont des souvenirs 的 charter 就是 <b>RuleEngine</b>。引擎改为 <b>1 条判定线、5 个 x、无和弦、1/4 拍网格</b>；类型 Tap 74% / Hold 11.5% / Drag 14.5% / Flick 0%；IN 密度对齐参考（约 893 notes / 4.87 NPS）。'],
    en: ['Rebuilt from your two reference ZIPs. The Pont des souvenirs charter is literally <b>RuleEngine</b>. Engine now uses <b>1 judge line, 5 x positions, no chords, 1/4-beat grid</b>; type mix Tap 74% / Hold 11.5% / Drag 14.5% / Flick 0%; IN density matches the reference (~893 notes / 4.87 NPS).'],
  },
  {
    v: 'V0.17.4.0', date: '2026-10-18',
    zh: ['规则引擎退回你那张旧图的做法：<b>全 Tap、一次一个、x 全屏分散、单判定线</b>。去掉 Hold/Flick/Drag 混排、装饰线和段落动效；节奏用 onset/整拍补位。'],
    en: ['Rule engine reverted to the old-reference style: <b>all Tap, one note at a time, x spread across the screen, one judge line</b>. Removed mixed Hold/Flick/Drag, decorative lines, and section animation.'],
  },
  {
    v: 'V0.17.3.0', date: '2026-10-18',
    zh: ['2K 改为<b>2 指可打、音符整屏分散</b>：x 在 ±540 范围内取 12 个分散位置，左右手交替，同一时刻最多 1 个 note；不再固定两条轨道。'],
    en: ['2K now means <b>two-finger playable with notes spread across the screen</b>: 12 x positions across ±540, alternating hands, at most one note at a time; no fixed two-lane layout.'],
  },
  {
    v: 'V0.17.2.1', date: '2026-10-17',
    zh: ['2K 两条轨道从 ±225 拉开到 <b>±450</b>，避免视觉上挤成“单键位”。'],
    en: ['2K lanes moved from ±225 to <b>±450</b> so they no longer look like a single key.'],
  },
  {
    v: 'V0.17.2.0', date: '2026-10-17',
    zh: ['修节奏：onset 先吸附到检测拍网格（EZ 1/4、HD/IN 1/8、AT 1/16 拍）再排谱，不再直接拿原始频谱峰值落 note。2K 左右轨保持交替，避免看起来只有单键。'],
    en: ['Rhythm fix: onsets are snapped to the detected beat grid (EZ 1/4, HD/IN 1/8, AT 1/16 beat) before charting instead of using raw spectral peaks. 2K left/right lanes stay alternated.'],
  },
  {
    v: 'V0.17.1.0', date: '2026-10-17',
    zh: ['自动写谱固定为 <b>2K</b>（左右两条轨道），不再出现 4K/6K/7K。2K 目标 NPS 调整为 EZ 2.0 / HD 2.6 / IN 3.6 / AT 4.0；系统判档阈值与密度解耦。'],
    en: ['Auto charting is now fixed to <b>2K</b> (two lanes); no 4K/6K/7K. 2K target NPS is EZ 2.0 / HD 2.6 / IN 3.6 / AT 4.0; difficulty thresholds are decoupled from density.'],
  },
  {
    v: 'V0.17.0.0', date: '2026-10-17',
    zh: [
      '自动写谱现在<b>由系统判定难度</b>，用户不能再手选 EZ/HD/IN/AT。系统按踩音密度、能量、频谱重心、BPM 与力度估算潜力 NPS，再映射到最接近的难度。',
      '页面会显示判定结果和依据；生成后仍可下载 <b>.pez</b> / <b>.zip</b>。',
      '参考 BMS-Generator 的规则写谱方法，加入<b>频谱重心选轨</b>：亮的声音偏右、暗的偏左。',
    ],
    en: [
      'Auto charting now <b>decides the difficulty itself</b>; users can no longer pick EZ/HD/IN/AT. Onset density, energy, spectral centroid, BPM, and strength estimate a potential NPS, then map to the closest tier.',
      'The page shows the decision and its evidence; .pez / .zip downloads are unchanged.',
      'Borrowed from BMS-Generator: <b>centroid-based lane assignment</b> (brighter sounds move right, darker left).',
    ],
  },
  {
    v: 'V0.16.0.3', date: '2026-10-17',
    zh: [
      '自动写谱按 <b>9,684 张真实 Phira 谱面</b>重做规则：Tap / Drag / Hold / Flick 比例、目标 NPS、'
        + '7K 轨道、主判定线动效 + 3 条装饰线。',
      'EZ/HD/IN/AT 目标 NPS 分别约 3.6 / 5.2 / 7.8 / 11；补位按拍网格与真实间隔，不再随机撒点。',
    ],
    en: [
      'Rule charting rebuilt from <b>9,684 real Phira charts</b>: note-type ratios, target NPS, 7K lanes, '
        + 'main judge-line movement + 3 decorative lines.',
      'EZ/HD/IN/AT target roughly 3.6 / 5.2 / 7.8 / 11 NPS; fill follows the beat grid and real spacing instead of random notes.',
    ],
  },
  {
    v: 'V0.16.0.2', date: '2026-10-17',
    zh: ['修复 Phira 导入报错：chart 的 <code>META.offset</code> 改为整数 0（之前是浮点秒，RPE 要求 i32 毫秒）。'],
    en: ['Fixed the Phira import error: chart <code>META.offset</code> is now integer 0 (it was a float; RPE expects i32 milliseconds).'],
  },
  {
    v: 'V0.16.0.1', date: '2026-10-17',
    zh: ['修复自动写谱的规则校验：IN/AT 按各自最小间隔校验（不再误用 HD 的 0.5 拍）；生成文件 ID 带短哈希，避免中文名被清空。'],
    en: ['Fixed rule validation for auto charting: IN/AT use their own minimum gap (no longer HD\'s 0.5 beat); generated file IDs include a short hash.'],
  },
  {
    v: 'V0.16.0.0', date: '2026-10-17',
    zh: [
      '写谱页改为<b>导入 MP3，自动提取</b>：BPM、时长、拍点、踩音点、段落能量全部自动分析，不再手填 BPM/时长/密度。',
      '难度改为 Phigros 式 <b>EZ / HD / IN / AT</b>；生成后提供 <b>.pez</b>（本身就是 ZIP）和 <b>.zip</b> 下载，另可单独下载 chart JSON。',
      '音频在浏览器本地解码分析，<b>不上传</b>；规则校验不通过会禁止下载。',
    ],
    en: [
      'The charting page now takes an <b>MP3 and extracts everything automatically</b>: BPM, duration, beats, onsets, '
        + 'and section energy. No manual BPM/duration/density fields.',
      'Difficulties are now <b>EZ / HD / IN / AT</b>; download <b>.pez</b> (itself a ZIP) or <b>.zip</b>, plus the chart JSON.',
      'Audio is decoded and analysed locally in the browser and <b>never uploaded</b>; downloads are blocked if rule validation fails.',
    ],
  },
  {
    v: 'V0.15.0.0', date: '2026-10-17',
    zh: [
      '新增 <b>规则写谱</b>页：按 BPM / 时长 / 难度 / 轨道 / 密度生成 RPE v160 谱面，直接下载 <code>.pez</code>，'
        + '可直接导入 Phira；全程本地，音频与谱面不上传。',
      '内置 5 档难度、2K/4K/6K、随机种子；没上传音频时会生成节拍 click 音轨方便试谱。',
      '同步提供 <b>audio2pez 二次修改版</b>（<code>phm/audio2pez</code>）：<code>--from-points</code> 接踩音模型，'
        + 'points 模式不再强依赖 librosa。',
    ],
    en: [
      'New <b>rule-based charting</b> page: generate RPE v160 charts from BPM / duration / difficulty / lanes / density '
        + 'and download a <code>.pez</code> for Phira. Everything runs locally; audio and charts are never uploaded.',
      'Five difficulties, 2K/4K/6K, reproducible seeds; a click track is generated when no audio is provided.',
      'Also ships a <b>patched audio2pez fork</b> (<code>phm/audio2pez</code>) with <code>--from-points</code> for '
        + 'beat-detection models and no hard librosa dependency in points mode.',
    ],
  },
  {
    v: 'V0.14.0.0', date: '2026-10-17',
    zh: [
      'API Key 现在支持<b>权限（scopes）</b>：查询 / 分析 / 用量可分开授权；可设 <b>30 / 90 / 365 天</b>或永不过期；'
        + '支持<b>轮换</b>（新建同权限 Key 并立即吊销旧 Key）。',
      '开放平台可按 Key 查看用量；缺少权限返回 403，过期返回 401。',
      '新增 <b>OpenAPI 单一契约</b>（<code>/api/v1/openapi.json</code>）与 81 条自动校验，接口文档和实现不再各写一份。',
    ],
    en: [
      'API keys now support <b>scopes</b> (charts / analyses / usage), <b>30/90/365-day expiry</b> or never, '
        + 'and <b>rotation</b> (new key with the same scopes, old one revoked immediately).',
      'The platform shows per-key usage; missing scopes return 403 and expired keys return 401.',
      'New <b>single OpenAPI contract</b> (<code>/api/v1/openapi.json</code>) with 81 automated checks.',
    ],
  },
  {
    v: 'V0.13.2.2', date: '2026-10-17',
    zh: [
      '单文件客户端现在会显示<b>服务端版本</b>（<code>/api/v1/meta</code>），并在 Key 被拒时给出可操作的诊断：'
        + '区分「复制少字符 / 已吊销 / 环境不一致」和「服务端 API 版本过旧」。',
      '服务端新增公开的 <code>/api/v1/meta</code>，返回 API、服务端构建版本与引擎版本；部署错位可以一眼看出来。',
    ],
    en: [
      'The single-file client now shows the <b>server build version</b> (via <code>/api/v1/meta</code>) and gives '
        + 'actionable diagnostics when a key is rejected: truncated key, revoked key, environment mismatch, '
        + 'or a stale server build.',
      'New public <code>/api/v1/meta</code> returns API, service build, and engine versions, making deployment '
        + 'mismatches visible at a glance.',
    ],
  },
  {
    v: 'V0.13.2.1', date: '2026-10-17',
    zh: [
      'API keys 列表现在<b>只显示有效 Key</b>：删除（吊销）后立即从列表消失，不再显示「已吊销」行。',
      '创建 Key 改为<b>弹窗</b>：一次性显示明文和复制按钮，关闭后无法再次查看；顶部会提示「API key 已创建」。',
    ],
    en: [
      'The API keys list now shows <b>active keys only</b>: a revoked key disappears immediately instead of '
        + 'remaining as a "revoked" row.',
      'Creating a key now opens a <b>dialog</b> that shows the secret once with a copy button; after closing it '
        + 'cannot be viewed again. A toast confirms "API key created".',
    ],
  },
  {
    v: 'V0.13.2.0', date: '2026-10-17',
    zh: [
      '导航新增 <b>API 开放平台</b>。点进去先看到<b>用量信息</b>（今日 / 7 天 / 30 天 / 有效 Key），'
        + '左侧可切到 <b>API keys</b> 创建和管理 Key；接口文档与单文件客户端也在同一处。',
      '未登录也能看平台介绍和免费额度；登录站点账号后才会显示真实用量。旧链接 <code>/developer</code> 仍可打开。',
    ],
    en: [
      'New <b>API Platform</b> in the nav. It opens on <b>usage</b> (today / 7 days / 30 days / active keys); '
        + 'the sidebar switches to <b>API keys</b>, with docs and the single-file client in one place.',
      'Logged-out visitors see the platform intro and free quotas; sign in with the site account to see real usage. '
        + 'The old <code>/developer</code> link still works.',
    ],
  },
  {
    v: 'V0.13.1.0', date: '2026-10-17',
    zh: [
      '新增<b>单文件 API 客户端</b>：下载一个 HTML，双击打开、填 API Key 就能查询 / 分析谱面。'
        + '零依赖，页面里也自带「下载本文件」和 Windows 客户端入口。',
      '下载页新增了单文件客户端的入口；API 文档在 <a href="/developers">/developers</a>，'
        + 'Key 在 <a href="/platform">开放平台</a> 免费创建。',
    ],
    en: [
      'New <b>single-file API client</b>: download one HTML file, open it, paste an API key, and query or '
        + 'analyse charts. Zero dependencies; it also contains its own download and the Windows client link.',
      'The download page now links it; docs live at <a href="/developers">/developers</a> and keys are free '
        + 'in the <a href="/platform">console</a>.',
    ],
  },
  {
    v: 'V0.13.0.0', date: '2026-10-17',
    zh: [
      '<b>开发者 API v1 上线</b>：可以按 chart_id 查询定数、提交分析（结果自动进共享缓存），'
        + '并在开放平台管理 API Key、查看调用量。文档在 <a href="/developers">/developers</a>。',
      '免费：不登录 <b>100 次/小时</b>；API Key <b>1000 次/小时</b>，分析 <b>200 次/天</b>。'
        + '每个账号最多 100 个 Key，可随时删除（吊销）。',
      'v1 只接受 chart_id，<b>不上传谱面文件</b>——隐私承诺不变。',
    ],
    en: [
      '<b>Developer API v1 is live</b>: look up a chart by chart_id, submit an analysis (the result is '
        + 'cached for everyone), and manage API keys plus usage in the console. Docs at <a href="/developers">/developers</a>.',
      'Free: <b>100 requests/hour</b> anonymously; <b>1000/hour</b> with an API key, and <b>200 analyses/day</b>. '
        + 'Up to 100 keys per account, revocable at any time.',
      'v1 accepts chart_id only and <b>never uploads chart files</b> — the privacy promise is unchanged.',
    ],
  },
  {
    v: 'V0.12.1.1', date: '2026-10-17',
    zh: [
      '隐私政策更新到 <b>v1.3</b>：写清楚账号的邮箱与密码<b>只以 scrypt 哈希</b>保存、'
        + '明文不落日志，以及 huamei 账号怎么申请注销。<b>没有新增数据收集</b>。',
    ],
    en: [
      'Privacy policy updated to <b>v1.3</b>: it now states that account email and password are stored '
        + '<b>only as a scrypt hash</b>, that plaintext is never logged, and how to request deletion of '
        + 'a huamei account. <b>No new data is collected.</b>',
    ],
  },
  {
    v: 'V0.12.1.0', date: '2026-10-17',
    zh: [
      '加固了「拖入谱面后贡献定数」这条链路：提交前先向服务端换一张短期凭证，'
        + '防止伪造请求消耗服务器。正常使用无感知；若页面提示刷新，刷新一次即可。',
      '相关接口的报错不再暴露请求格式（安全加固，无感）。',
    ],
    en: [
      'Hardened the "contribute a chart after dropping it" path: the page now gets a short-lived '
        + 'server ticket before submitting, so forged requests cannot burn server resources. '
        + 'Nothing changes in normal use; if a page asks you to refresh, refresh once.',
      'API error messages no longer reveal the request format (security hardening, no visible change).',
    ],
  },
  {
    v: 'V0.12.0.0', date: '2026-10-17',
    zh: [
      '注册现在要<b>邮箱验证码</b>了：填完邮箱和密码，系统会先发一封带数字的邮件，'
        + '把数字填进去才算注册成功。目的是堵住「拿别人邮箱批量注册」。'
        + '<b>登录仍然只输密码</b>，没有变麻烦。',
      '设置页的标题字体多了<b>楷体</b>一档（霞鹜文楷）。子集只有 63KB，'
        + '不选这一档就完全不会下载。',
      '修：「标题字体 / 字号」这两个开关以前<b>只在设置页生效</b> —— '
        + '切到别的页面刷新一下就变回默认了。现在全站都跟着你的选择。',
      'Windows 客户端同步更新（0.8.2-huamei.13）：注册流程会先发码再让你填。',
    ],
    en: [
      'Registration now needs an <b>email code</b>: after the email and password, a message with a '
        + 'number arrives and the account is only created once you type it in. This closes the '
        + '"register with someone else\u2019s mailbox in bulk" hole. <b>Signing in still only asks for '
        + 'the password</b> — nothing got harder there.',
      'The heading typeface setting has a third option: <b>Kai</b> (LXGW WenKai). The subset is 63KB '
        + 'and downloads only if you pick it.',
      'Fixed: "Heading typeface" and "Text size" used to <b>apply on the settings page only</b> — '
        + 'any other page went back to the defaults after a reload. They now follow your choice site-wide.',
      'Windows client updated too (0.8.2-huamei.13): registration sends the code first, then asks for it.',
    ],
  },
  {
    v: 'V0.11.2.0', date: '2026-10-17',
    zh: [
      '首页现在能<b>直接把谱面拖进来</b>：拖到那块虚线上松手，会带着文件跳到算定数页自己开始算 —— '
        + '不用「松手 → 点按钮 → 再拖一次」。文件照样不出浏览器。',
      '查谱师 / 查玩家两页的输入框收窄居中（原来拉满一整行），底下一整段「为什么要两步」收进折叠，'
        + '空出来的地方放了<b>可以点的例子</b>和<b>你最近查过的人</b>。',
      '顶栏右侧加了 <b>GitHub</b> 入口。',
      '修：全站按钮和输入框的高度、圆角、聚焦高亮<b>一直没生效</b>（样式表里有一处写重了，'
        + '把它后面所有规则都吞掉了）。现在按钮、输入框、下拉框是齐的。',
    ],
    en: [
      'The home page now accepts a <b>dropped chart pack</b>: let go on the dashed strip and it carries the '
        + 'file to the analyser and starts on its own — no more "let go, click the button, drag it again". '
        + 'The file still never leaves your browser.',
      'The charter and player pages have a narrower, centred input card, the long "why two steps" paragraph '
        + 'is folded away, and the freed space holds <b>clickable examples</b> plus <b>your recent lookups</b>.',
      'A <b>GitHub</b> link now sits on the right of the top bar.',
      'Fixed: button and input heights, radii and focus rings <b>were never applying</b> — a duplicated line '
        + 'in the stylesheet swallowed every rule after it. Buttons, inputs and selects now line up.',
    ],
  },
  {
    v: 'V0.11.1.1', date: '2026-10-17',
    zh: [
      '结果里的那把<b>刻度尺</b>现在真的像一把尺子：底下加了细刻度线（每格 1 个定数点），'
        + '两个标度之间用虚线连起来，<b>中间直接标出差值</b>（Δ0.5）。'
        + '以前要看一行文字才知道「社区共识 15.6」和「官谱标度 16.1」差多少，现在看尺子就行。',
      '同时把站里同一个页面的三个叫法统一了：首页按钮「开始算定数」、首页卡片「进入工作台」、'
        + '顶栏「算定数」—— 现在一律叫<b>算定数</b>。',
    ],
    en: [
      'The <b>ruler</b> in the result now behaves like a ruler: fine tick marks underneath (one per chart '
        + 'constant), a dotted connector between the two scales, and <b>the difference labelled right in '
        + 'the middle</b> (Δ0.5). You used to need a sentence to know how far "community 15.6" sits from '
        + '"official 16.1"; now you can just look at the ruler.',
      'Also unified three names for the same page: the home button said "Start analysing", the home card '
        + 'said "Open the workbench", the nav said "Analyze" — all three now read <b>Analyze</b>.',
    ],
  },
  {
    v: 'V0.11.1.0', date: '2026-10-17',
    zh: [
      '设置 → 外观与语言里新增两项：<b>标题字体</b>（宋体标题 / 全黑体）和<b>字号</b>（小 / 中 / 大）。'
        + '正文始终用系统黑体，切换只影响标题与比例 —— 选了会记住，刷新和换页都保持。',
      '<b>不会闪一下</b>：和主题一样在 <code>&lt;head&gt;</code> 里同步应用，'
        + '所以打开页面时不会先看到默认字体再跳变。',
      '霞鹜文楷这一档暂时没做 —— 全量中文单字重就是 10MB 级，会直接把首屏拖死。'
        + '要先像标题字体那样做子集（现在那套是 11.2MB → 83KB）才能加。',
    ],
    en: [
      'Settings → Appearance now has <b>heading typeface</b> (serif / all-sans) and '
        + '<b>text size</b> (small / medium / large). Body text always stays on the system sans stack; '
        + 'the setting is remembered across reloads and pages.',
      '<b>No flash of default styling</b>: like the theme, it is applied synchronously in '
        + '<code>&lt;head&gt;</code>, so you never see the default font and then a jump.',
      'The LXGW WenKai option is not included yet — a full Chinese weight is on the order of 10 MB and '
        + 'would wreck first paint. It needs subsetting first, the same way the heading font is '
        + '11.2 MB → 83 KB today.',
    ],
  },
  {
    v: 'V0.11.0.8', date: '2026-10-17',
    zh: [
      '<b>去掉了一处重复入口</b>：算定数页在拖放区下面还有一行「我的成绩」「找谱师」，'
        + '而顶栏本来就有「球员」「谱师」两项 —— 同一页两个地方进同一个页面，'
        + '中间还夹着各自的说明，读者分不清哪句属于谁。这两个重复入口已删除。',
      '「登录」和 GitHub 保留（顶栏没有这两项）。',
    ],
    en: [
      '<b>Removed a duplicated set of entry points</b>: below the drop zone the analysis page also '
        + 'offered "My scores" and "Find charters", while the top nav already has "Players" and '
        + '"Charters" — two ways into the same pages on one screen, with their captions interleaved. '
        + 'Those duplicates are gone.',
      '"Sign in" and GitHub stay, since the top nav does not carry them.',
    ],
  },
  {
    v: 'V0.11.0.7', date: '2026-10-17',
    zh: [
      '<b>修复「拖入谱面后算不出定数」</b>。结果卡的渲染函数里残留了一行对已删除变量的引用，'
        + '于是<b>每算一次就抛一次错，整张结果卡渲染不出来</b> —— 表现就是拖进去没反应。'
        + '已删掉那行孤儿代码。',
      '这类问题的共性是「重构时删了变量、忘了删引用」。今天已经因此出过两次事故，'
        + '两次都是同一个动作。',
    ],
    en: [
      '<b>Fixed "dropping a chart produces no result"</b>. The result-card renderer still referenced '
        + 'a variable that a refactor had removed, so <b>every analysis threw and the whole card '
        + 'failed to render</b> — which looks like nothing happens when you drop a file. The orphan '
        + 'reference is gone.',
      'The common thread is "a refactor deleted a variable but left a reference behind". '
        + 'That has now caused two outages in one day.',
    ],
  },
  {
    v: 'V0.11.0.6', date: '2026-10-17',
    zh: [
      '<b>两个最关键的按钮终于像按钮了</b>：首页「开始算定数」和下载页「下载 Windows 版」'
        + '此前只是带下划线的文字链，而下载是全站最重要的一步。'
        + '现在是实心琥珀按钮。（上一版补了按钮样式，但选择器漏了这两个元素用的写法，'
        + '所以没吃到样式 —— 这次补上了。）',
    ],
    en: [
      '<b>The two most important actions finally look like buttons</b>: "Start" on the home page '
        + 'and "Download for Windows" were plain underlined links, even though downloading is the '
        + 'single most important step on the site. They are solid amber buttons now. (The previous '
        + 'build added button styles but its selector missed the markup these two use.)',
    ],
  },
  {
    v: 'V0.11.0.5', date: '2026-10-17',
    zh: [
      '<b>界面里不再出现开发笔记</b>。页脚原来写着「线上引擎：8 维 log1p 特征（NPS / 有效 NPS / '
        + '物量 / 加权密度 p99 / 音符间隔 / …）+ 双参照 k-NN」，还挂着「源码 '
        + 'phm-web/public/index.html」—— 这些是给自己看的，用户用不到。'
        + '现在只留一句人话：「用 9,508 张社区谱和 1,037 张官谱做双参照，算出可复核的定数」。'
        + '想看实现细节的点「PS 是什么？」，或去版本历史页。',
    ],
    en: [
      '<b>Development notes no longer leak into the interface.</b> The footer used to list the '
        + 'engine internals ("8-dim log1p features ... dual-reference k-NN") and a link to the '
        + 'source file. Those were notes to self. It now reads: "Computed against 9,508 community '
        + 'charts and 1,037 official charts as dual references." Implementation details live under '
        + '"What is PS?" and on the version history page.',
    ],
  },
  {
    v: 'V0.11.0.4', date: '2026-10-17',
    zh: [
      '<b>输入框和按钮终于有了统一样式</b>。此前谱师页、玩家页的输入框是浏览器默认外观'
        + '（灰边框、约 20px 高），按钮约 39px —— 两者不等高、没间距，占位提示还被截断。'
        + '现在统一成 40px 高、圆角 10px，和按钮同高、间距 8px，聚焦时有一圈琥珀描边。',
      '说明文字统一成一个口径（14px、行高 1.7）。此前卡片外的说明比卡片里的正文'
        + '更大更黑，读起来像是漏了样式 —— 现在和正文一致。',
      '字号从五六档收成五档（14 / 16 / 20 / 28 / 40），'
        + '并新增一种「提示块」（左侧琥珀竖线），留给「样本量还小，仅供参考」这类'
        + '真正需要被看到的信息 —— 它以前是页面里最小最淡的字。',
    ],
    en: [
      '<b>Inputs and buttons finally have a consistent style.</b> The charter and player pages '
        + 'previously used raw browser controls (grey border, ~20px tall) next to ~39px buttons — '
        + 'unequal heights, no spacing, and truncated placeholders. Both are now 40px tall with an '
        + '10px radius, 8px apart, and gain an amber ring on focus.',
      'Explanatory text now follows one scale (14px, 1.7 line-height). Previously text outside cards '
        + 'was larger and darker than body text inside them, which read like a missing stylesheet.',
      'The type scale is consolidated from five or six ad-hoc sizes down to five (14 / 16 / 20 / 28 / 40), '
        + 'plus a new "callout" block (amber rule on the left) reserved for notes that genuinely need '
        + 'attention — such as the small-sample caveat, previously the smallest and faintest text on the page.',
    ],
  },
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
