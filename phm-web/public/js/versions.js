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
import { ARCHIVE } from './versions-archive.js?v=V0.22.2.1';

export const RELEASES = [
  {
    v: 'V0.22.1.0', date: '2026-10-24',
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
