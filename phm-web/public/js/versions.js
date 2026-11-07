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
import { ARCHIVE } from './versions-archive.js?v=V0.27.1.0';

export const RELEASES = [
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
