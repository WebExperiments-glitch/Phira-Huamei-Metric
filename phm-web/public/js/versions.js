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
import { ARCHIVE } from './versions-archive.js?v=V0.22.4.0';

export const RELEASES = [
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
