/* ============================================================
 * js/i18n/charter.js —— 谱师页词条（ch.*）
 * ============================================================
 * ⚠ 术语不硬译：charter / Phira / P.H.M. / RKS 保持原样。
 * ============================================================ */
export default {
  zh: {
    'ch.title': '查谱师作品',
    'ch.sub':
      '先按名字找到他的 Phira 账号，再用账号 <b>id</b> 精确列出他上传的全部谱面。'
      + '<br>为什么要两步：Phira 的「谱师」字段是<b>自由文本</b> —— 有人写自己的名字，'
      + '有人写团队名，还有人写别人的名字；而搜索接口会同时匹配曲名、谱师和<b>谱面说明</b>，'
      + '所以直接搜名字会混进一堆本来不相干的谱。用账号 id 取作品则是一条精确查询。',
    'ch.q.ph': '谱师名或 UID（例如 平方秒和立方吨 / 6thPecJam / 257272）',
    'ch.lookup': '查找',

    'ch.cands.title': '候选账号',
    'ch.cands.note': '名字按相似度排序，不是替你决定 —— 点一个看他的作品。',
    'ch.cands.none': '没有账号名包含「{n}」的人。',
    'ch.cands.try': '试试更短的词（去掉后缀、只取前两三个字），或者你手里有 UID 就直接填 UID。',
    'ch.cands.uid': 'UID',
    'ch.cands.fans': '关注者',
    'ch.cands.charts': '上传 {n} 张',
    'ch.cands.picked': '当前查看',

    'ch.works.title': '上传的谱面',
    'ch.works.loading': '正在读取他上传的谱面…',
    'ch.works.empty': '这个账号名下没有上传过任何谱面。',
    'ch.works.empty.hint':
      '常见原因有两种：① 谱面是别的账号（团队号 / 代传）上传的，他只把名字写在「谱师」字段里 —— '
      + '看下面的兜底搜索；② 你搜到的不是本体，而是同名仿号（中文近形字很坑，'
      + '「和 / 与」「·」这类差别会让搜索完全走向不同的账号）。',
    'ch.works.empty.try': '试试这些更短的词：',
    'ch.works.partial': '只读到前 {n} 张，还有更多没读完。',
    'ch.works.done': '读取完整',
    'ch.works.partialmark': '尚未读完',

    'ch.sum.works': '作品数',
    'ch.sum.avg': '标称均值',
    'ch.sum.pm': 'P.H.M. 均值',
    'ch.sum.max': '最高标称',
    'ch.sum.nd': '{n} 张有标称',
    'ch.sum.npm': '{n} 张已算',
    'ch.sum.node': '按已读到的部分统计',

    'ch.sort.diff': '标称定数 ↓',
    'ch.sort.pm': 'P.H.M. 定数 ↓',
    'ch.sort.name': '曲名 A→Z',
    'ch.sort.level': '档位',
    'ch.filter.all': '全部档位',
    'ch.listtitle': '作品列表（{n} 张）',
    'ch.list.empty': '这个筛选下没有作品',
    'ch.tbl.nominal': '标称',
    'ch.tbl.pm': 'P.H.M. 定数',
    'ch.tbl.official': '官谱标度',
    'ch.tbl.notes': '物量',
    'ch.pm.none': '未算',
    'ch.uncalc': '还有 <b>{n}</b> 张在这个筛选下没算过 P.H.M. 定数。',
    'ch.uncalc.link': '去算定数',
    'ch.uncalc.tail': '页拖入谱面包，或点「算」让服务端下载计算。',

    'ch.fb.title': '兜底 · 按谱师字段搜',
    'ch.fb.desc':
      'Phira 的 <span class="mono">/chart?search=</span> 会同时匹配<b>曲名、谱师字段、谱面说明</b>。'
      + '下面按命中来源分成三档，别把它们混起来看。',
    'ch.fb.exact': '谱师字段 <b>完全等于</b>「{n}」',
    'ch.fb.fuzzy': '谱师字段 <b>包含</b>「{n}」',
    'ch.fb.mentioned': '只在<b>谱面说明</b>里提到了「{n}」',
    'ch.fb.mentioned.desc':
      '这一档<b>不是他的作品</b>：谱师另有其人，只是说明里写了感谢名单、合作方之类。'
      + '搜索名字时最容易被这些结果误导，所以单独放在最后。',
    'ch.fb.more': '继续搜 ›',
    'ch.fb.scanned': '已搜 {a}/{b} 页（共 {c} 条搜索结果）',
    'ch.fb.none': '谱师字段里没有包含「{n}」的谱面。',
    'ch.fb.running': '按谱师字段搜索中…',
    'ch.fb.notrun': '按谱师字段搜索',

    'ch.err': '查询失败：{e}',
    'ch.err.hint': '（Phira API 可能临时不可用，稍后重试）',
    'ch.needname': '先填谱师名或 UID',

    'ch.foot.src': '数据来源：<b>Phira 公开 API</b> + 本站共享定数缓存。',
    'ch.foot.note':
      '用 <span class="mono">/chart?uploader=&#123;id&#125;</span> 取作品是<b>服务端精确过滤</b>，'
      + '比翻搜索结果可靠得多。兜底那一栏保留的是老口径，专门用来处理'
      + '「谱面是别人代传、谱师字段才写了他」这类情况。',
  },

  en: {
    'ch.title': 'Find a charter\u2019s charts',
    'ch.sub':
      'First find their Phira <b>account</b> by name, then list every chart they uploaded '
      + 'by account <b>id</b>.<br>Why two steps: the "charter" field on Phira is <b>free text</b> — '
      + 'some write their own name, some a team name, some someone else\u2019s. And the search '
      + 'endpoint matches chart name, charter and <b>description</b> at once, so searching a name '
      + 'drags in charts that have nothing to do with them. Filtering by account id is exact.',
    'ch.q.ph': 'Charter name or UID (e.g. SqrtSecond / 6thPecJam / 257272)',
    'ch.lookup': 'Look up',

    'ch.cands.title': 'Matching accounts',
    'ch.cands.note': 'Sorted by name similarity — not a decision on your behalf. Click one to see their charts.',
    'ch.cands.none': 'No account name contains "{n}".',
    'ch.cands.try': 'Try a shorter term (drop the suffix, keep the first two or three characters), or paste a UID if you have one.',
    'ch.cands.uid': 'UID',
    'ch.cands.fans': 'Followers',
    'ch.cands.charts': '{n} uploaded',
    'ch.cands.picked': 'Viewing',

    'ch.works.title': 'Uploaded charts',
    'ch.works.loading': 'Loading their charts…',
    'ch.works.empty': 'This account has not uploaded any chart.',
    'ch.works.empty.hint':
      'There are two usual reasons: (1) the chart was uploaded by another account (a team '
      + 'account, or someone uploading on their behalf) and they only appear in the "charter" '
      + 'field — see the fallback search below; or (2) you matched a namesake rather than the '
      + 'real account (lookalike CJK characters are treacherous: "和" vs "与" or a stray "·" '
      + 'sends you to a completely different account).',
    'ch.works.empty.try': 'Try one of these shorter terms:',
    'ch.works.partial': 'Only the first {n} were read; more remain.',
    'ch.works.done': 'Fully loaded',
    'ch.works.partialmark': 'partially loaded',

    'ch.sum.works': 'Charts',
    'ch.sum.avg': 'Mean nominal',
    'ch.sum.pm': 'Mean P.H.M.',
    'ch.sum.max': 'Highest nominal',
    'ch.sum.nd': '{n} with a nominal',
    'ch.sum.npm': '{n} computed',
    'ch.sum.node': 'Based on what has been read so far',

    'ch.sort.diff': 'Nominal ↓',
    'ch.sort.pm': 'P.H.M. constant ↓',
    'ch.sort.name': 'Chart A→Z',
    'ch.sort.level': 'Tier',
    'ch.filter.all': 'All tiers',
    'ch.listtitle': 'Charts ({n})',
    'ch.list.empty': 'Nothing matches this filter',
    'ch.tbl.nominal': 'Nominal',
    'ch.tbl.pm': 'P.H.M. constant',
    'ch.tbl.official': 'Official scale',
    'ch.tbl.notes': 'Notes',
    'ch.pm.none': 'not computed',
    'ch.uncalc': '<b>{n}</b> charts in this filter have no P.H.M. constant yet.',
    'ch.uncalc.link': 'Open the workbench',
    'ch.uncalc.tail': ' and drop the chart pack in, or hit "Analyze" to let the server fetch and compute it.',

    'ch.fb.title': 'Fallback · search the charter field',
    'ch.fb.desc':
      'Phira\u2019s <span class="mono">/chart?search=</span> matches <b>chart name, charter field '
      + 'and description</b> simultaneously. Results below are split by which field matched — '
      + 'do not read them as one list.',
    'ch.fb.exact': 'Charter field <b>exactly</b> "{n}"',
    'ch.fb.fuzzy': 'Charter field <b>contains</b> "{n}"',
    'ch.fb.mentioned': 'Only mentioned in the <b>description</b> of "{n}"',
    'ch.fb.mentioned.desc':
      'This group is <b>not their work</b>: the charter is someone else, and the name appears '
      + 'in a thank-you list or credits. These are the results most likely to mislead when you '
      + 'search a name, so they are kept last and separate.',
    'ch.fb.more': 'Keep scanning ›',
    'ch.fb.scanned': 'Scanned {a}/{b} pages ({c} search results)',
    'ch.fb.none': 'No chart has "{n}" in its charter field.',
    'ch.fb.running': 'Scanning the charter field…',
    'ch.fb.notrun': 'Search the charter field',

    'ch.err': 'Lookup failed: {e}',
    'ch.err.hint': ' (the Phira API may be temporarily unavailable — try again shortly)',
    'ch.needname': 'Enter a charter name or UID first',

    'ch.foot.src': 'Source: <b>Phira public API</b> plus this site\u2019s shared constant cache.',
    'ch.foot.note':
      '<span class="mono">/chart?uploader=&#123;id&#125;</span> is a <b>server-side exact filter</b> '
      + 'and far more reliable than paging through search results. The fallback column keeps the '
      + 'old approach for cases where a chart was uploaded by someone else and only the charter '
      + 'field carries their name.',
  },
};
