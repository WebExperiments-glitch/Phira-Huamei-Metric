/* ============================================================
 * js/i18n/common.js —— 全站共用词条（导航 / 通用动作 / 主题语言）
 * ============================================================
 * 【字典分片的规矩】
 *   一个页面一个文件，**中英写在同一个文件里**（zh / en 紧挨着）。
 *   为什么不按语言拆成 zh.js / en.js：那样改一个词要开两个文件、
 *   两处对齐，迟早漂移；而且新页面要在两个文件里各找一次位置。
 *
 *   新增页面时：在 js/i18n/ 下加一个文件，然后在 js/i18n.js 的
 *   FRAGMENTS 数组里登记一行 —— 不登记就等于没翻，lint 会拦（规则 8）。
 * ============================================================ */
export default {
  zh: {
    /* ── 导航 ── */
    'nav.home': '首页',
    'nav.app': '算定数',
    'nav.charter': '谱师',
    'nav.user': '玩家',
    'nav.data': '数据',
    'nav.settings': '设置',

    /* ── 通用动作 ── */
    'c.clear': '清除',
    'c.reset': '重置',
    'c.login': '登录',
    'c.logout': '退出登录',
    'c.loading': '读取中…',
    'c.none': '（没有）',
    'c.chart': '曲名',
    'c.charter': '谱师',
    'c.tier': '档',

    /* ── 主题 / 语言（设置页也复用）── */
    'set.theme': '外观主题',
    'set.theme.desc': '跟随系统时，系统切换深浅色会立即生效。',
    'set.theme.auto': '跟随系统',
    'set.theme.dark': '深色',
    'set.theme.light': '浅色',
    'set.lang': '界面语言',
    'set.lang.desc': '默认跟随浏览器；手动选择后会固定下来。',

    /* ── 页脚语言开关（显示"另一种语言"的名字，所以两种语言里都一样）── */
    'foot.lang': 'English',
    'foot.lang.back': '中文',
    'foot.version': '版本 {v}（开发者测试版）',

    /* ── 数据缺失的展示（ui.js 的 tierBadge / accCell / constCell）──
       原则：**能确定原因就说原因**，尽量不用孤零零的 ? 或 —。 */
    'tier.unmarked': '未标注',
    'tier.unmarked.tip': 'Phira 的难度档位是自由文本，这一栏没写成 EZ/HD/IN/AT/SP 的规范形式',
    'cell.acc.none': '无记录值',
    'cell.acc.none.tip': 'Phira 这条记录里没有准确率字段（通常是旧记录）',
    'cell.const.none': '未填',
    'cell.const.none.tip': '谱师没有填标称定数（Phira 上这一栏可以为空）',
    'cell.const.odd.tip': '这个值明显超出正常范围，多半是玩梗或填错了',

    /* ── 分页器（ui.js 的 pagerHTML）── */
    'pg.page': '第 <b>{n}</b> 页',
    'pg.range': '第 <b>{a}–{b}</b> 条 · 共 <b>{c}</b> 条 · 第 <b>{p}</b>/{q} 页',
    'pg.prev': '上一页',
    'pg.next': '下一页',
    'pg.per': '每页 {n} 条',

    /* ── 页脚法务链接（设置页 / 首页共用）── */
    'foot.privacy': '隐私政策',
    'foot.terms': '用户协议',

    /* ── 术语表（ui.js 的 glossaryHTML，被 /app、/charter、/user 共用）── */
    'gloss.summary': '术语看不懂？点开这里（{n} 条）',
    'gloss.consensus.t': '社区共识（主结果）',
    'gloss.consensus.d': '把你这张谱的结构特征，拿去和 <b>Phira 上 9,508 张社区谱</b>里最相近的 20 张比，看它们被标成多少定数。这是<b>谱师实际定价的共识</b>，最贴近你在 Phira 里看到的数字。',
    'gloss.official.t': '官谱标度',
    'gloss.official.d': '同一套算法，但参照集换成 <b>1,037 张 Phigros 官方谱</b>。这是与官方一致的<b>绝对</b>标度。两个标度会差 2~3 级是正常的 —— 因为社区谱和官谱<b>结构分布本来就不同</b>（社区谱定数中位 15.1，官谱 10.6）。',
    'gloss.range.t': '不确定范围',
    'gloss.range.d': '那 20 张参照谱的定数<b>最小值到最大值</b>。范围窄 = 参照集里有和你几乎一样的谱，结论硬；范围宽 = 没有紧密对应物，中点只能当粗略参照。',
    'gloss.ps.t': 'PS 负荷',
    'gloss.ps.d': '本工具自己的负荷标度（0–20），由密度 / 结构 / 协调 / 持续四组加权合成。<b>和上面两个定数不同标度</b>，不要混着比。',
    'gloss.nominal.t': '标称定数',
    'gloss.nominal.d': 'Phira 上谱师自己填的那个难度数字（你在游戏里看到的那个）。它是<b>人工填写</b>，不是测量值 —— 实测同曲同物量的相邻难度标注差中位就有 2.80 级。',
    'gloss.rks.t': 'RKS',
    'gloss.rks.d': 'Phira 的水平分。官方算法是「前 19 首单曲水平 + 1 个满分位，除以 20」。⚠️ <b>Phira 服务端的 RKS/B19 计算已经停摆</b>（实测抽样多位活跃玩家，bestPool 最新成绩全停在 2023 ~ 2026-03），所以官方那个数常年不动。本站在官方停更后<b>按同一公式自算一个替代值</b>，并标注它是替代值。',
    'gloss.b19.t': 'B19',
    'gloss.b19.d': '「Best 19」的简称 —— 官方取你最好的 19 个单曲成绩来算总 RKS。同上，这个链路已经停更。',
    'gloss.p99.t': 'p99 / 加权密度',
    'gloss.p99.d': '把谱面按时间切成小段，算出每一秒的「有效物量」，p99 就是<b>只有最难的那 1% 时间能超过</b>的值。用来看「最密集的地方有多密」，比平均密度更能反映难度。',
    'gloss.cross.t': '交叉手',
    'gloss.cross.d': '同一只手需要连续跨过另一只手去击打的频率。Phira 里用相邻两键的横向位移来判断。',

    /* ── RKS 自算说明（ui.js 的 rksNote()，只有 /user 用）── */
    'rks.note': '公式与 Phigros 官方一致（<span class="mono">((acc−55)/45)² × 定数</span>，前 19 条 + φ 位 ÷ 20）。<b>它不是官方 RKS 的复现</b>：官方 RKS/B19 计算在 Phira 服务端已经停摆（见下方说明），而本值只能基于我们拿得到的成绩，因此通常<b>偏低</b>。',
  },

  en: {
    /* ── nav ── */
    'nav.home': 'Home',
    'nav.app': 'Analyze',
    'nav.charter': 'Charters',
    'nav.user': 'Players',
    'nav.data': 'Data',
    'nav.settings': 'Settings',

    /* ── common ── */
    'c.clear': 'Clear',
    'c.reset': 'Reset',
    'c.login': 'Sign in',
    'c.logout': 'Sign out',
    'c.loading': 'Loading…',
    'c.none': '(none)',
    'c.chart': 'Chart',
    'c.charter': 'Charter',
    'c.tier': 'Tier',

    /* ── theme / language ── */
    'set.theme': 'Appearance',
    'set.theme.desc': 'On "System", the theme follows your OS setting instantly.',
    'set.theme.auto': 'System',
    'set.theme.dark': 'Dark',
    'set.theme.light': 'Light',
    'set.lang': 'Language',
    'set.lang.desc': 'Follows your browser by default; pinning it here overrides that.',

    /* ── footer language switch ── */
    'foot.lang': 'English',
    'foot.lang.back': '中文',
    'foot.version': 'Version {v} (developer beta)',

    /* ── missing-data display ── */
    'tier.unmarked': 'Unmarked',
    'tier.unmarked.tip': 'Difficulty tiers on Phira are free text and this one is not written in the canonical EZ/HD/IN/AT/SP form',
    'cell.acc.none': 'no value',
    'cell.acc.none.tip': 'This Phira record carries no accuracy field (usually an old record)',
    'cell.const.none': 'not set',
    'cell.const.none.tip': 'The charter left the nominal constant blank (allowed on Phira)',
    'cell.const.odd.tip': 'Clearly outside the normal range — most likely a joke value or a typo',

    /* ── pager ── */
    'pg.page': 'Page <b>{n}</b>',
    'pg.range': '<b>{a}–{b}</b> of <b>{c}</b> · page <b>{p}</b>/{q}',
    'pg.prev': 'Previous page',
    'pg.next': 'Next page',
    'pg.per': '{n} per page',

    /* ── footer legal links ── */
    'foot.privacy': 'Privacy Policy',
    'foot.terms': 'Terms of Service',

    /* ── glossary ── */
    'gloss.summary': 'Unfamiliar with the jargon? Expand ({n})',
    'gloss.consensus.t': 'Community consensus (main result)',
    'gloss.consensus.d': 'Your chart\u2019s structural features are compared against the 20 closest charts among <b>9,508 community charts on Phira</b>, and their declared constants are read off. This is <b>how charters actually price a chart</b> — the closest thing to the number you see inside Phira.',
    'gloss.official.t': 'Official scale',
    'gloss.official.d': 'The same algorithm with the reference set swapped for <b>1,037 official Phigros charts</b>. This is the <b>absolute</b> scale, consistent with the game. A 2–3 level gap between the two scales is normal — community and official charts simply have <b>different structural distributions</b> (median constant 15.1 vs 10.6).',
    'gloss.range.t': 'Uncertainty range',
    'gloss.range.d': 'The <b>minimum to maximum</b> constant across those 20 reference charts. Narrow = the reference set contains near-identical charts, so the midpoint is solid. Wide = nothing closely comparable, so the midpoint is only a rough guide.',
    'gloss.ps.t': 'PS load',
    'gloss.ps.d': 'This tool\u2019s own load scale (0–20), a weighted blend of density / structure / coordination / sustain. <b>It is a different scale from the two constants above</b> — do not compare them directly.',
    'gloss.nominal.t': 'Nominal constant',
    'gloss.nominal.d': 'The difficulty number the charter typed into Phira — the one you see in game. It is <b>hand-entered</b>, not measured: among charts with the same song and note count, adjacent difficulty labels differ by a median of 2.80.',
    'gloss.rks.t': 'RKS',
    'gloss.rks.d': 'Phira\u2019s skill rating. The official formula is "top 19 chart ratings plus one perfect slot, divided by 20". ⚠️ <b>Phira\u2019s server-side RKS/B19 computation has stalled</b> (sampling several active players, every bestPool entry stops somewhere between 2023 and 2026-03), so the official number never moves. This site <b>recomputes a substitute with the same formula</b> and labels it as such.',
    'gloss.b19.t': 'B19',
    'gloss.b19.d': 'Short for "Best 19" — the official rating takes your 19 best chart scores. As above, that pipeline has also stalled.',
    'gloss.p99.t': 'p99 / weighted density',
    'gloss.p99.d': 'The chart is sliced into short time windows and each second\u2019s "effective note count" is computed; p99 is the value <b>only the hardest 1% of time exceeds</b>. It shows how dense the densest parts get, which says more about difficulty than average density.',
    'gloss.cross.t': 'Cross-hand',
    'gloss.cross.d': 'How often one hand must reach across the other to hit the next note. On Phira this is inferred from the lateral distance between adjacent notes.',

    /* ── self-computed RKS note ── */
    'rks.note': 'The formula matches the official Phigros one (<span class="mono">((acc−55)/45)² × constant</span>, top 19 plus a φ slot, divided by 20). <b>It is not a reproduction of the official RKS</b>: Phira\u2019s server-side RKS/B19 computation has stalled (see below), and this value can only be based on the scores we can reach, so it usually reads <b>low</b>.',
  },
};
