/* ============================================================
 * js/i18n/user.js —— 玩家成绩页词条（u.*）
 * ============================================================
 * ⚠ 术语不硬译：Phira / Phigros / RKS / ACC / B19 / P.H.M. / UID 保持原样。
 *    标称定数 = nominal constant；参考/结构定数 = reference constant；
 *    官谱标度 = official scale；档位 = tier；定数 = constant。
 * ⚠ 这里只放 /user 页专属文案；nav.* / c.* / pg.* / gloss.* / tier.*
 *    / cell.* / rks.note 是全站共用词条，直接复用，**不要在这里重复定义**。
 * ============================================================ */
export default {
  zh: {
    /* ── 查询区（静态）── */
    'u.title': '查玩家成绩',
    'u.sub': '输入 Phira 用户名或纯数字 UID。只读公开数据，<b>不需要密码，也不会替你登录</b>。',
    'u.q.ph': '用户名 或 UID（例如 168142）',
    'u.search': '查询',

    /* ── 查询过程 ── */
    'u.needname': '先填用户名或 UID',
    'u.loading': '查询中…（Phira API 是第三方，偶尔会慢）',
    'u.cands.found':
      '找到 <b>{n}</b> 个匹配 —— <b>请点选你自己那个</b>。'
      + '（同名/相似名很常见，这一步以前是自动选第一个，会导致看到别人的成绩）',
    'u.joined': '{d} 加入',
    'u.reading': '读取成绩中…',
    'u.err': '查询失败：{e}',
    'u.err.hint': '（Phira API 可能临时不可用）',

    /* ── 用户卡片 / 账号总览 ── */
    'u.rks.off': 'Phira 官方 RKS<br>（客户端界面不显示，API 里有）',
    'u.st.records': '总游玩次数',
    'u.st.records.n': '这是账号全部记录数',
    'u.st.records.non': '拿不到统计',
    'u.st.acc': '平均准度',
    'u.st.b19': '官方 B19 条数',
    'u.st.b19.none': '服务端未计算',
    'u.st.avail': '本次可用成绩',
    'u.st.avail.capped': '撞上接口硬上限',
    'u.fetch.at':
      '成绩数据拉取于 {t}（直接来自 Phira 公开 API，未经过本站缓存） · '
      + '<a href="#" id="refetch">重新拉取</a>',
    'u.fetch.date': '{m}月{d}日',
    'u.ok':
      '<b>账号检测正常。</b>这个号在 Phira 上有 <b>{n}</b> 条游玩记录。'
      + '下面如果显示的成绩很少，那是 <b>Phira 的接口限制</b>（只给最近 20 条），不是没查到你 —— '
      + '往页底看，那里能查<b>任意单张谱</b>的全部成绩。',
    'u.b19.note':
      '<b>官方 RKS 是 0，且 B19 只有 {n} 条 —— 这不是你的问题。</b><br>'
      + '实测抽样：多位<b>今天仍在游玩</b>的活跃玩家，bestPool 里最新的一条成绩全部停在 '
      + '<b>2023 ~ 2026-03</b>，而他们的单曲排行榜名次天天在更新。'
      + '⇒ <b>Phira 服务端的 RKS / B19 计算已经停摆</b>，2026 年之后注册的账号 bestPool 从开始就是空的。<br>'
      + '这不影响你的成绩本身（排行榜是实时的），只是那个总 RKS 数字不会动了。'
      + '所以本页另算一个 <b>P.H.M. RKS</b> 给你参考。',
    'u.b19.partial':
      '官方 bestPool 只有 <b>{n}</b> 条（标准是 19 + φ1）。'
      + 'Phira 的 B19 只收录<b>已上架</b>谱面，你打的多半没上架。',

    /* ── P.H.M. RKS ── */
    'u.pm.title': 'P.H.M. RKS（官方停更后的替代值）',
    'u.pm.fair': '按实际条数平均',
    'u.pm.fair.n': '样本少时更接近真实水平',
    'u.pm.off': '官方 ÷20 口径',
    'u.pm.off.n': '样本不足会被压低',
    'u.pm.count': '计入条数',
    'u.pm.nophi': '无 φ 位',
    'u.pm.src': '定数来源：<b>P.H.M. {a} 条</b> / Phira 标称 {b} 条',
    'u.pm.src.tail.pm': '（P.H.M. 的是用谱面实际结构算的，比谱师自报准）。',
    'u.pm.src.tail.nopm': '（还没算过 P.H.M. 定数 → 去「算定数」页拖入谱面包可逐张提升精度）。',
    'u.more': '… 共 {n} 条',

    /* ── 表格列名（跨区块共用）── */
    'u.col.acc': '准度',
    'u.col.const': '定数',
    'u.col.item': '计入的单曲 rks',
    'u.col.sr': '单曲 rks',
    'u.col.best.acc': '最好准度',
    'u.col.times': '次数',
    'u.col.recent': '最近',
    'u.col.time': '时间',
    'u.col.fc': '全连',
    'u.col.player': '玩家',
    'u.col.score': '分数',

    /* ── 最近游玩 + 数据飞轮 ── */
    'u.recent.title': '最近游玩（每谱取最好一次）',
    'u.recent.empty': '这个号没有可读的成绩记录（可能一直离线游玩，或成绩未上传）',
    'u.fw.btn': '全部进入数据飞轮',
    'u.fw.desc':
      '把这批成绩（谱名、等级、ACC、单曲 RKS、Phira UID）提交到公开数据集，'
      + '用于校准定数；都是 Phira 站内本来就公开的信息，不含密码或邮箱。',
    'u.miss.head': '<b>有些格子是空的，原因在这里：</b>',
    'u.miss.tier':
      '<li><b>档位显示「未标注」{n} 处</b> —— Phira 的难度档位是<b>自由文本</b>字段，'
      + '这几张谱的谱师没写成 EZ / HD / IN / AT / SP 的规范形式，所以识别不出来。'
      + '<b>不是数据缺失，是原始数据本身不规范</b>。</li>',
    'u.miss.acc':
      '<li><b>准度显示「无记录值」{n} 处</b> —— 这些是早期记录，'
      + 'Phira 只在记录里存了分数、没存准确率。</li>',
    'u.miss.const': '<li>标称定数显示「未填」= 谱师没在 Phira 上填那个数字（这一栏允许为空）。</li>',
    'u.capped':
      '<b>为什么只有 {n} 条？这不是查不到你。</b><br>'
      + 'Phira 的 <span class="mono">/record?player=</span> 接口<b>只返回最近 20 条</b>，'
      + '而且 <span class="mono">page</span> / <span class="mono">pageNum</span> 参数'
      + '<b>实际上被服务端忽略</b>（实测翻页返回的 20 条 id 完全相同）。这是 Phira 侧的限制，网页端绕不过去。<br>'
      + '<b>但按谱面查不受限制</b> —— 用下面的「查我在某张谱上的全部成绩」。'
      + '另外账号总游玩次数是准的（上面那个 <b>{m}</b>）。',

    /* ── 数据飞轮：提交 ── */
    'u.fw.novalid': '没有可提交的有效成绩（谱号或账号信息缺失）',
    'u.fw.confirm':
      '即将把 {n} 条成绩提交到公开数据集：\n\n'
      + '· 谱名、等级、标称定数\n'
      + '· 你的 ACC（该谱最好一次）与单曲 RKS\n'
      + '· Phira UID #{id} 与用户名「{name}」—— 用于区分不同玩家\n\n'
      + '这些都是 Phira 站内本来就公开的信息，不含密码或邮箱。\n'
      + '数据会汇总用于校准定数公式。继续吗？',
    'u.fw.cancel': '已取消，没有提交任何数据',
    'u.fw.submitting': '正在提交 {n} 条…（服务端校验中）',
    'u.fw.ok': '✅ 已写入 {n} 条成绩，感谢你帮定数公式变准！',
    'u.fw.again': '再提交一次',
    'u.fw.err': '提交失败：{e}',
    'u.fw.neterr': '网络异常',
    'u.fw.nowrite': '服务端未写入任何行',

    /* ── 按谱面查 ── */
    'u.cq.title': '按谱面查 · 可翻页',
    'u.cq.sub':
      'Phira 的成绩接口只给<b>最近 20 条</b>。但按<b>谱面</b>查不受这个限制 —— '
      + '这是唯一能翻页看成绩的路径。',
    'u.cq.cid.ph': '谱面 chart_id（纯数字）',
    'u.cq.mode.mine': '我在这张谱上的全部成绩',
    'u.cq.mode.all': '这张谱的全服记录（可翻页）',
    'u.cq.needid': '填一个纯数字的 chart_id',
    'u.cq.needuser': '先在上面查一个账号（这一栏需要知道你是谁）',
    'u.cq.loading': '查询中…',
    'u.chart.title.p': '（《{name}》）',
    'u.chart.titled': '：《{name}》{level}',
    'u.const.src': ' · 定数 {lv}（{src}）',
    'u.sr.inline': ' · 单曲 rks <b>{v}</b>',
    'u.mine.none': '这个号在 <b>#{id}</b> 上没有记录{title}。',
    'u.mine.ok': '共 <b>{n}</b> 次游玩{title} · 最好准度 <b>{acc}</b>{const}{sr}',
    'u.mine.note':
      '这个接口（<span class="mono">/record?player=&amp;chart=</span>）<b>不受 20 条限制</b>，'
      + '所以这里是全部 {n} 条，不用翻页。',
    'u.chart.head': '《{name}》{level}',
    'u.all.none': '#{id} 上没有公开记录{title}。',
    'u.all.count': '全服共 <b>{n}</b> 条记录',
    'u.all.accs':
      '<br><span class="dim2">本页准度：最高 <b>{hi}</b> · 最低 <b>{lo}</b> · 按分数降序</span>',
    'u.you': '你',
    'u.all.note':
      '只有当页 {n} 条样本。记录按分数降序 —— '
      + '前几页是硬核玩家，越往后越接近大众水平。<b>这一栏是唯一能翻页看全服的入口。</b>',

    /* ── 页脚 ── */
    'u.foot.src':
      '数据来源：<b>Phira 公开 API</b>（<span class="mono">api.phira.cn</span>）· '
      + '只读 · 不登录 · 不收集任何个人信息。',
    'u.foot.note': '本页不缓存玩家数据：每次查询都直接向 Phira 请求，关闭页面即无痕。',
  },

  en: {
    /* ── lookup ── */
    'u.title': 'Look up a player',
    'u.sub': 'Enter a Phira username or a numeric UID. Read-only public data — <b>no password needed, and we never sign in for you</b>.',
    'u.q.ph': 'Username or UID (e.g. 168142)',
    'u.search': 'Search',

    /* ── lookup flow ── */
    'u.needname': 'Enter a username or UID first',
    'u.loading': 'Searching… (the Phira API is third-party and is occasionally slow)',
    'u.cands.found':
      'Found <b>{n}</b> matches — <b>pick the one that is you</b>. '
      + '(Duplicate and similar names are common; this step used to auto-pick the first match, showing you someone else\u2019s scores)',
    'u.joined': 'joined {d}',
    'u.reading': 'Loading scores…',
    'u.err': 'Lookup failed: {e}',
    'u.err.hint': ' (the Phira API may be temporarily unavailable)',

    /* ── user card / account overview ── */
    'u.rks.off': 'Phira official RKS<br>(not shown in the client, but present in the API)',
    'u.st.records': 'Total plays',
    'u.st.records.n': 'every record on the account',
    'u.st.records.non': 'stats unavailable',
    'u.st.acc': 'Mean ACC',
    'u.st.b19': 'Official B19 entries',
    'u.st.b19.none': 'not computed server-side',
    'u.st.avail': 'Scores available now',
    'u.st.avail.capped': 'hit the API hard cap',
    'u.fetch.at':
      'Scores fetched at {t} (straight from the Phira public API, no site-side cache) · '
      + '<a href="#" id="refetch">Fetch again</a>',
    'u.fetch.date': '{m}/{d}',
    'u.ok':
      '<b>Account detected fine.</b> This account has <b>{n}</b> play records on Phira. '
      + 'If the scores below look sparse, that is a <b>Phira API limit</b> (only the 20 most recent) and not a failure to find you — '
      + 'scroll down: that section can pull every score for <b>any single chart</b>.',
    'u.b19.note':
      '<b>The official RKS reads 0 and B19 has just {n} entries — that is not on you.</b><br>'
      + 'Sampled in practice: several active players <b>still playing today</b> have their newest bestPool entry frozen at '
      + '<b>2023 – 2026-03</b>, while their per-chart leaderboard ranks update daily. '
      + '⇒ <b>Phira\u2019s server-side RKS / B19 computation has stalled</b>, and accounts registered after 2026 started with an empty bestPool.<br>'
      + 'This does not touch your scores themselves (leaderboards are live) — it is only that total RKS number that no longer moves. '
      + 'So this page computes a <b>P.H.M. RKS</b> for you to go by.',
    'u.b19.partial':
      'The official bestPool holds only <b>{n}</b> entries (the standard is 19 + a φ slot). '
      + 'Phira\u2019s B19 only counts <b>published</b> charts, and most of what you played probably is not published.',

    /* ── P.H.M. RKS ── */
    'u.pm.title': 'P.H.M. RKS (the substitute once the official one stalled)',
    'u.pm.fair': 'Averaged over actual entries',
    'u.pm.fair.n': 'Closer to your real level with a small sample',
    'u.pm.off': 'Official ÷20 basis',
    'u.pm.off.n': 'Undercounted when the sample is short',
    'u.pm.count': 'Entries counted',
    'u.pm.nophi': 'no φ slot',
    'u.pm.src': 'Constants from: <b>{a} P.H.M. entries</b> / {b} Phira nominal',
    'u.pm.src.tail.pm': ' (the P.H.M. ones are derived from the chart\u2019s actual structure, more reliable than the charter\u2019s self-report).',
    'u.pm.src.tail.nopm': ' (no P.H.M. constant computed yet → open the Analyze page and drop the chart pack in to sharpen them one by one).',
    'u.more': '… {n} total',

    /* ── table column labels (shared across sections) ── */
    'u.col.acc': 'ACC',
    'u.col.const': 'Constant',
    'u.col.item': 'Counted chart rks',
    'u.col.sr': 'Chart rks',
    'u.col.best.acc': 'Best ACC',
    'u.col.times': 'Plays',
    'u.col.recent': 'Last',
    'u.col.time': 'Time',
    'u.col.fc': 'Full combo',
    'u.col.player': 'Player',
    'u.col.score': 'Score',

    /* ── recent plays + data flywheel ── */
    'u.recent.title': 'Recent plays (best per chart)',
    'u.recent.empty': 'No readable score records for this account (they may always play offline, or scores were never uploaded)',
    'u.fw.btn': 'Send all to the data flywheel',
    'u.fw.desc':
      'Submit this batch of scores (chart name, tier, ACC, chart RKS, Phira UID) to the public dataset '
      + 'to calibrate constants — all of it is already public on Phira, with no password or email.',
    'u.miss.head': '<b>Some cells are blank — here is why:</b>',
    'u.miss.tier':
      '<li><b>Tier reads "Unmarked" in {n} places</b> — Phira\u2019s difficulty tier is a <b>free-text</b> field, '
      + 'and the charters of these charts did not write it in the canonical EZ / HD / IN / AT / SP form, so it cannot be recognized. '
      + '<b>This is not missing data; the source data itself is non-standard</b>.</li>',
    'u.miss.acc':
      '<li><b>ACC reads "no value" in {n} places</b> — these are early records; '
      + 'Phira stored only a score and no accuracy.</li>',
    'u.miss.const': '<li>The nominal constant reads "not set" = the charter never filled that number in on Phira (the field is allowed to be blank).</li>',
    'u.capped':
      '<b>Why only {n} records? It is not that we failed to find you.</b><br>'
      + 'Phira\u2019s <span class="mono">/record?player=</span> endpoint <b>returns only the 20 most recent</b>, '
      + 'and the <span class="mono">page</span> / <span class="mono">pageNum</span> parameters are '
      + '<b>effectively ignored server-side</b> (in practice, paging hands back the very same 20 ids). This is a Phira-side limit and the web cannot get around it.<br>'
      + '<b>But querying by chart has no limit</b> — use "all my scores on this chart" below. '
      + 'The account\u2019s total play count is accurate, though (that <b>{m}</b> above).',

    /* ── data flywheel: submit ── */
    'u.fw.novalid': 'No valid scores to submit (chart id or account info missing)',
    'u.fw.confirm':
      'About to submit {n} scores to the public dataset:\n\n'
      + '· chart name, tier, nominal constant\n'
      + '· your ACC (best on each chart) and chart RKS\n'
      + '· Phira UID #{id} and username "{name}" — to tell players apart\n\n'
      + 'All of this is already public on Phira, with no password or email.\n'
      + 'The data is pooled to calibrate the constant formula. Continue?',
    'u.fw.cancel': 'Cancelled — nothing was submitted',
    'u.fw.submitting': 'Submitting {n}… (validating server-side)',
    'u.fw.ok': '✅ Wrote {n} scores — thanks for helping the constant formula get sharper!',
    'u.fw.again': 'Submit again',
    'u.fw.err': 'Submit failed: {e}',
    'u.fw.neterr': 'network error',
    'u.fw.nowrite': 'the server wrote no rows',

    /* ── query by chart ── */
    'u.cq.title': 'Query by chart · paged',
    'u.cq.sub':
      'Phira\u2019s score endpoint only hands back your <b>20 most recent</b>. Querying by <b>chart</b> has no such limit — '
      + 'it is the only way to page through scores.',
    'u.cq.cid.ph': 'Chart chart_id (numeric)',
    'u.cq.mode.mine': 'All my scores on this chart',
    'u.cq.mode.all': 'Server-wide records for this chart (paged)',
    'u.cq.needid': 'Enter a numeric chart_id',
    'u.cq.needuser': 'Look up an account above first (this field needs to know who you are)',
    'u.cq.loading': 'Searching…',
    'u.chart.title.p': ' ("{name}")',
    'u.chart.titled': ': "{name}" {level}',
    'u.const.src': ' · constant {lv} ({src})',
    'u.sr.inline': ' · chart rks <b>{v}</b>',
    'u.mine.none': 'This account has no record on <b>#{id}</b>{title}.',
    'u.mine.ok': '<b>{n}</b> plays{title} · best ACC <b>{acc}</b>{const}{sr}',
    'u.mine.note':
      'This endpoint (<span class="mono">/record?player=&amp;chart=</span>) <b>has no 20-record limit</b>, '
      + 'so all {n} are here — no paging needed.',
    'u.chart.head': '"{name}" {level}',
    'u.all.none': 'No public records on #{id}{title}.',
    'u.all.count': '<b>{n}</b> records server-wide',
    'u.all.accs':
      '<br><span class="dim2">ACC on this page: high <b>{hi}</b> · low <b>{lo}</b> · sorted by score descending</span>',
    'u.you': 'You',
    'u.all.note':
      'Only the {n} samples on this page. Records are sorted by score descending — '
      + 'the first pages are hardcore players and it drifts toward the average as you go. <b>This is the only place you can page through server-wide records.</b>',

    /* ── footer ── */
    'u.foot.src':
      'Source: <b>Phira public API</b> (<span class="mono">api.phira.cn</span>) · '
      + 'read-only · no sign-in · no personal data collected.',
    'u.foot.note': 'Nothing is cached here: every lookup hits Phira directly, and closing the page leaves no trace.',
  },
};
