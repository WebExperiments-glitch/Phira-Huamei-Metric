/* ============================================================
 * js/i18n/home.js —— 首页 + 404 页词条（home.* / nf.*）
 * ============================================================ */
export default {
  zh: {
    'home.h1': '给 Phira 谱面一个<b>可审计</b>的难度参考',
    'home.sub': '拖入谱面包，浏览器里算出它的结构定数 —— <b>两个标度都告诉你</b>，<br>连同这个数字有多准。<b>谱面文件不会上传</b>，也不需要登录。',
    'home.cta1': '开始算定数',
    'home.cta2': '查谱师作品',
    'home.tile1.t': '算定数',
    'home.tile1.d': '拖入 .pez / .zip 谱面包，或按曲名点「算」。给出双标度定数与不确定范围。',
    'home.tile1.a': '进入工作台',
    'home.tile2.t': '查谱师',
    'home.tile2.d': '输入谱师名，列出他的全部作品、档位分布，以及每张谱的 P.H.M. 定数。',
    'home.tile2.a': '按谱师浏览',
    'home.tile3.t': '查玩家',
    'home.tile3.d': '输入用户名或 UID，看成绩、自算 RKS、最近游玩，并能查任意单谱的全部成绩。',
    'home.tile3.a': '查询成绩',

    /* ── 「为什么是两个数字」 ── */
    'home.why.t': '为什么是两个数字',
    'home.why.sub': '同一个谱面结构，在两份参照集上会得到两个值 —— 这不是"其中一个算错了"，而是两把不同的尺子。',
    'home.dc.com.k': '社区共识',
    'home.dc.com.n': '9,508 张 Phira 社区谱里最相近的 20 张<br>→ 站内谱师实际定价的共识',
    'home.dc.off.k': '官谱标度',
    'home.dc.off.n': '换成 1,037 张 Phigros 官谱<br>→ 与官方一致的绝对标度',
    'home.why.n1':
      '<b>为什么必须印两个：</b>官谱和社区谱<b>结构分布本来就不同</b> —— '
      + '社区谱定数中位 <b>15.1</b>，官谱 <b>10.6</b>；社区谱的长条占比只有官谱的 1/3、拖键是 5 倍。'
      + '只印一个数字，社区谱师就会看到「我的 IN 14 被算成 11.6」那样对不上的结果。'
      + '<b>把差距印出来，争议就变成了信息。</b>',
    'home.why.n2':
      '每个数都带<b>不确定范围</b>（那 20 张参照谱的定数跨度）。跨度大 = 这张谱的结构在参照集里'
      + '没有紧密对应物，中点不该被当成结论 —— 所以卡片上会直接标出来。<br>'
      + '实测（1,367 张留出社区谱）：<b>|偏差| 均值 0.820 · p90 1.40 · ≤1.0 命中 84.2%</b>。',

    /* ── 站点数据 ── */
    'home.stats.t': '站点数据',
    'home.stats.cache': '定数缓存',
    'home.stats.com': '社区参照',
    'home.stats.off': '官谱参照',
    'home.stats.scores': '成绩记录',
    'home.stats.live': '缓存由所有人共同贡献 · 实时',
    'home.stats.down': '统计接口暂时不可用（不影响使用）',

    /* ── 页脚：本工具的边界 ── */
    'home.bounds.title': '本工具的边界（点开看）',
    'home.bounds.b1':
      '<b>不判定「虚标」。</b>官方定数本身是人工标注，'
      + '同曲同物量的相邻难度定数差中位就有 <b>2.80 级</b>。在这个噪声水平下，'
      + '没有任何工具能仅凭结构区分「谱师标错」和「官方也会这么标」——'
      + '<b>声称能区分就是造假</b>。',
    'home.bounds.b2':
      '<b>社区共识不是客观真值。</b>它是 Phira 上谱师声明定数的共识，'
      + '反映的是"站内同类谱被判成多少"，不是绝对难度。官谱标度那一栏才是与官方可比的绝对标度。',
    'home.bounds.b3':
      '<b>隐私。</b>核心链路（拖入谱面 → 解析 → 出定数）全程在本机浏览器内完成，'
      + '<b>谱面文件永不上传</b>。只有你在打卡区主动勾选时，才会把算出的结构特征'
      + '（不含谱面文件本身）写入共享缓存。详见<a href="/privacy">隐私政策</a>。',

    /* ── 404 页 ── */
    'nf.title': '这个页面不存在',
    'nf.desc': '地址可能打错了，或者这个页面已经被移除。',
    'nf.home': '← 回首页',
    'nf.tips.intro': '<b>想查谱面定数？</b>首页有两种方式，都不需要注册：',
    'nf.tips.li1': '用顶部<b>搜索</b>框按曲名找，点「算」直接出定数（约 2–5 秒）；',
    'nf.tips.li2': '或把 Phira <b>谱面包</b>（<code>.pez</code> / 含 <code>chart.json</code> 的 zip）'
      + '拖进首页虚线框，纯本机解析，<b>文件不会上传</b>。',
  },
  en: {
    'home.h1': 'An <b>auditable</b> difficulty reference for Phira charts',
    'home.sub': 'Drop a chart pack in and the structural constant is computed in your browser — <b>both scales</b>,<br>plus how tight that number is. <b>Nothing is uploaded</b>, and no sign-in is needed.',
    'home.cta1': 'Analyze a chart',
    'home.cta2': 'Browse charters',
    'home.tile1.t': 'Analyze',
    'home.tile1.d': 'Drop a .pez / .zip chart pack, or hit "Analyze" next to a search result. Gives both scales and an uncertainty range.',
    'home.tile1.a': 'Open the workbench',
    'home.tile2.t': 'Charters',
    'home.tile2.d': 'Enter a charter name to list every chart they made, the difficulty spread, and each chart\u2019s P.H.M. constant.',
    'home.tile2.a': 'Browse by charter',
    'home.tile3.t': 'Players',
    'home.tile3.d': 'Enter a username or UID to see scores, a self-computed RKS, recent plays, and any single chart\u2019s full record.',
    'home.tile3.a': 'Look up scores',

    /* ── "Why two numbers" ── */
    'home.why.t': 'Why two numbers',
    'home.why.sub': 'The same chart structure yields two values against two reference sets — not because one of them is wrong, but because they are two different rulers.',
    'home.dc.com.k': 'Community consensus',
    'home.dc.com.n': 'The 20 closest charts among 9,508 Phira community charts<br>→ what charters on the site actually price it at',
    'home.dc.off.k': 'Official scale',
    'home.dc.off.n': 'Against 1,037 official Phigros charts<br>→ an absolute scale consistent with the game',
    'home.why.n1':
      '<b>Why both have to be printed:</b> official and community charts have <b>genuinely different '
      + 'structural distributions</b> — the median community constant is <b>15.1</b> against <b>10.6</b> '
      + 'for official charts; community charts use a third as many holds as official ones and five times '
      + 'as many drags. Print one number and community charters see a mismatch like "my IN 14 came out '
      + 'as 11.6". <b>Print the gap and the disagreement turns into information.</b>',
    'home.why.n2':
      'Every number carries an <b>uncertainty range</b> (the spread of constants across those 20 '
      + 'reference charts). A wide spread means this chart\u2019s structure has no close counterpart in '
      + 'the reference set, so the midpoint should not be read as a verdict — which is why the card '
      + 'shows the range outright.<br>Measured on 1,367 held-out community charts: <b>mean |error| 0.820 · '
      + 'p90 1.40 · 84.2% within 1.0</b>.',

    /* ── Site data ── */
    'home.stats.t': 'Site data',
    'home.stats.cache': 'Cached constants',
    'home.stats.com': 'Community ref',
    'home.stats.off': 'Official ref',
    'home.stats.scores': 'Score records',
    'home.stats.live': 'Cache built by everyone · live',
    'home.stats.down': 'Stats endpoint is down for now (nothing breaks)',

    /* ── Footer: what this tool does not do ── */
    'home.bounds.title': 'What this tool does not do (expand)',
    'home.bounds.b1':
      '<b>It does not call out a "fake" constant.</b> Official constants are hand-labelled, and among '
      + 'charts with the same song and note count, adjacent difficulty labels differ by a median of '
      + '<b>2.80 levels</b>. At that noise level no tool can tell "the charter labelled it wrong" from '
      + '"the game itself would label it this way" on structure alone — <b>anyone claiming otherwise is '
      + 'lying</b>.',
    'home.bounds.b2':
      '<b>Community consensus is not objective truth.</b> It is the consensus on the constants charters '
      + 'declared on Phira; it says "what similar charts on the site get labelled", not absolute '
      + 'difficulty. The official-scale column is the absolute scale comparable to the game.',
    'home.bounds.b3':
      '<b>Privacy.</b> The core path (drop a chart pack → parse → constants) runs entirely in your '
      + 'browser, and <b>chart files are never uploaded</b>. Only when you tick the box yourself are the '
      + 'computed structural features (not the chart file itself) written to the shared cache. '
      + 'See the <a href="/privacy">privacy policy</a>.',

    /* ── 404 page ── */
    'nf.title': 'This page doesn\u2019t exist',
    'nf.desc': 'The address may be mistyped, or the page has been removed.',
    'nf.home': '← Back home',
    'nf.tips.intro': '<b>Looking for a chart constant?</b> The home page has two ways, neither needing an account:',
    'nf.tips.li1': 'search by song name in the <b>search</b> box at the top and hit "Analyze" for the constant (about 2–5 seconds);',
    'nf.tips.li2': 'or drag a Phira <b>chart pack</b> (<code>.pez</code> / a zip containing <code>chart.json</code>) '
      + 'into the dashed box on the home page — parsed entirely on your machine, <b>nothing is uploaded</b>.',
  },
};
