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
