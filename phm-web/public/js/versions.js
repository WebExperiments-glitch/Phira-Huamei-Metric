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
import { ARCHIVE } from './versions-archive.js?v=V0.21.3.1';

export const RELEASES = [
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
