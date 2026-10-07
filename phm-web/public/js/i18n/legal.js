/* ============================================================
 * js/i18n/legal.js —— 法务页词条（隐私政策 pv. / 用户协议 tm. / 外壳 lg.）
 * ============================================================
 * 【覆盖哪些页面】
 *   public/privacy.html —— 前缀 pv.
 *   public/terms.html   —— 前缀 tm.
 *   两页共用的页面外壳（返回链接、文档互链、法务效力声明、页脚品牌行）—— 前缀 lg.
 *
 * ⚠ 术语不硬译：Phira / Phigros / P.H.M. Standard / GPL-3.0 / TeamFlos /
 *   robots.txt / WorkBuddy / jsDelivr 保持原样。
 *   定标：本服务→this Service；谱面→chart；谱面包→chart pack；定数→constant；
 *         结构特征→structural features；假名化→pseudonymisation；
 *         共享缓存→shared cache；开发者测试版→developer beta。
 * ⚠ 法律文本逐段对照翻译：条款的意思、限定语、免责范围一律不软化、不摘要。
 * ============================================================ */
export default {
  zh: {
    /* ══ 页面外壳（privacy / terms 共用）══ */
    'lg.back': '← 返回 P.H.M. Standard',
    'lg.nav.privacy': '隐私政策',
    'lg.nav.terms': '用户协议',
    'lg.auth': '本协议以简体中文版本为准；英文译本仅供参考。',
    'lg.foot.brand': 'P.H.M. Standard · 开发者测试版 · GPL-3.0',

    /* ══════════════════════════════════════════════════════════
     * 隐私政策（pv.）—— public/privacy.html
     * ══════════════════════════════════════════════════════════ */
    'pv.h1': '<b>P.H.M.</b> Standard 隐私政策',
    'pv.meta': '版本 v1.1 · 生效日期 2026-10-07 · 适用站点 <code>phm.app.workbuddy.host</code>',
    'pv.lead':
      '<b>一句话概括：</b>你的<b>谱面文件永远不会离开你的设备</b>；只有当你查询 '
      + '<b>你自己确认过的 Phira 账号</b>时，才会把成绩数据（Phira UID、用户名、谱面名、定数、ACC、单曲 RKS）'
      + '自动上传，用于校准定数参考。<mark>这可以在<a href="/settings">设置</a>里一键关闭</mark>，'
      + '关闭后不会上传任何贡献内容。',

    'pv.h2.1': '1. 我们收集什么',
    'pv.h3.1.1': '1.1 你主动拖入的谱面文件 —— 文件本身不收集',
    'pv.p.1.1.a':
      '谱面解析（ZIP 解压、谱面结构分析、特征提取、定数计算）<b>全部在你的浏览器内完成</b>。'
      + '谱面文件本身<b>不会上传、不会留存、不会离开你的设备</b>。',
    'pv.p.1.1.b':
      '在你允许自动上传的前提下，会离开设备的只有<b>由该谱面计算出的结构特征</b>，它们不含谱面内容本身：',
    'pv.li.1.1.1': '谱面名与标称定数',
    'pv.li.1.1.2': '物量、每秒音符数（NPS）、长条占比、纵连均值、线速峰值',
    'pv.li.1.1.3': '计算得到的参考定数与负荷分（PS）',
    'pv.p.1.1.c':
      '这条路径<b>不需要登录</b>，也<b>不需要你点按钮</b> —— 拖入谱面时自动完成贡献。'
      + '但它受<a href="/settings">设置</a>里那个开关统一控制：<b>关闭自动上传后，拖入谱面不会产生任何上传。</b>',

    'pv.h3.1.2': '1.2 查询 Phira 账号时的成绩数据 —— 仅对本人账号，且可关闭',
    'pv.p.1.2.a': '当你在页面里输入 Phira 用户名或 UID 并查询时：',
    'pv.li.1.2.1':
      '<b>首次遇到某个 UID</b>：会问你一次「这是你自己的账号吗」—— '
      + '答「是」才把它记为本人账号；答「否」则只查看、不上传',
    'pv.li.1.2.2': '对<b>已确认的本人账号</b>：自动上传成绩数据（见下表）',
    'pv.p.1.2.b':
      '<b>为什么要多问一句：</b>本工具<b>无法验证 Phira 账号的所有权</b>（Phira 未提供第三方授权登录）。'
      + '如果不加确认，任何访问者都能把某个公开玩家的成绩复制进数据集，那样所有统计都会失真 —— '
      + '所以只对你自己声明过的账号自动上传。',
    'pv.t.1.2.h1': '收集项',
    'pv.t.1.2.h2': '说明',
    'pv.t.1.2.a1': 'Phira UID 与用户名',
    'pv.t.1.2.b1': '用于区分不同玩家，避免同一份成绩被重复计数',
    'pv.t.1.2.a2': '谱面名、标称定数',
    'pv.t.1.2.b2': '用于关联成绩与谱面',
    'pv.t.1.2.a3': '你的 ACC、单曲 RKS',
    'pv.t.1.2.b3': '用于分析「同一标称定数下玩家实际表现的分布」',
    'pv.t.1.2.a4': '一个随机假名标识 <code>client_id</code>',
    'pv.t.1.2.b4':
      '用于区分不同来源的贡献。<b>这是假名化标识、不是匿名</b> —— '
      + '同一浏览器贡献的多条数据可以被关联起来。我们不会把它与你的真实身份绑定，'
      + '但请知悉它并非不可关联。',
    'pv.p.1.2.c':
      '<b>不会收集</b>：密码、邮箱、Phira 账号的登录凭据或任何操作权限。查询只读 Phira 的公开数据接口'
      + '（<code>api.phira.cn</code>），<b>不要求也不接受你的 Phira 密码</b>。',

    'pv.h3.1.3': '1.3 本地存储（仅存在你自己的浏览器里）',
    'pv.p.1.3.a': '以下信息只存在你浏览器的 <code>localStorage</code> 里，不会自动上传：',
    'pv.li.1.3.1': '你输入过的 Phira 用户名 / UID（用于下次自动填充）',
    'pv.li.1.3.2': '自动上传开关的状态、首次告知的确认状态',
    'pv.li.1.3.3': '一个随机生成的 <code>client_id</code>（8 位随机串，用于区分匿名打卡来源）',
    'pv.li.1.3.4': 'P.H.M. 账号的登录会话（若你注册了邮箱账号）',

    'pv.h3.1.4': '1.4 账号系统（可选）',
    'pv.p.1.4.a':
      '只有你主动注册时才涉及。使用邮箱 + 密码，用于：登录、绑定 Phira 账号、查看与修改你自己的资料。'
      + '账号相关的数据（邮箱、密码哈希）由 WorkBuddy 云服务的认证模块存储，'
      + '我们<b>无法读取你的明文密码</b>。',

    'pv.h2.2': '2. 收集来做什么',
    'pv.li.2.1':
      '<b>校准定数参考</b>：统计同一标称定数下玩家 ACC 的分布，识别标称与实际难度的偏离',
    'pv.li.2.2': '<b>共享定数缓存</b>：让其他人搜到同一张谱时不必重复下载与计算',
    'pv.li.2.3': '<b>展示聚合统计</b>：如「成绩数据 N 条」「定数缓存 N 张」这类总数',
    'pv.p.2.a': '我们不将这些数据用于广告、画像，或向第三方出售。',

    'pv.h2.3': '3. 对外可见性',
    'pv.p.3.a':
      '<b>其他人看不到你的 UID 或用户名。</b>成绩明细表（<code>phm_scores</code>）已<b>撤销匿名读取权限</b>。'
      + '外部只能通过两个聚合接口取数，且它们<b>只返回统计量</b>：',
    'pv.li.3.1': '<code>phm_plays(谱面名)</code> → 该谱的<b>条数 / 平均 / 中位 / 最低 / 最高 ACC</b>',
    'pv.li.3.2': '<code>phm_stats()</code> → 全局总数（账号数、活跃数、成绩总数等）',
    'pv.p.3.b': '两者都不返回任何一条具体的个人记录。',

    'pv.h2.4': '4. 存储与安全',
    'pv.li.4.1': '数据存储在 <b>WorkBuddy 云服务</b>（中国大陆境内）的 PostgreSQL 数据库中',
    'pv.li.4.2': '谱面文件不上传，因此不存在谱面内容的存储风险',
    'pv.li.4.3': '写入必须经过本站服务端网关的字段校验与速率限制',
    'pv.li.4.4':
      '<b>我们不保证绝对安全</b> —— 任何网络服务都存在被攻击的可能。请不要上传任何敏感信息',
    'pv.p.4.a':
      '更完整的技术细节（信任边界、已修复与已知的局限）见仓库中的 '
      + '<code>docs/SECURITY.md</code>。',

    'pv.h2.5': '5. 你的权利',
    'pv.t.5.h1': '权利',
    'pv.t.5.h2': '怎么做',
    'pv.t.5.a1': '关闭上传',
    'pv.t.5.b1':
      '<a href="/settings">设置</a> → 关闭「自动上传」。<b>立即生效</b>，'
      + '之后不再上传谱面结构特征与成绩数据',
    'pv.t.5.a2': '撤回首次同意',
    'pv.t.5.b2': '<a href="/settings">设置</a> → 撤回确认。下次上传前会重新征求你的同意',
    'pv.t.5.a3': '清空本地数据',
    'pv.t.5.b3': '<a href="/settings#storage">设置 · 本机存储</a> → 一键清空（不影响服务器数据）',
    'pv.t.5.a4': '只查看、不贡献',
    'pv.t.5.b4': '查询 Phira 账号时回答「不是我的账号」，即只查看、不上传',
    'pv.t.5.a5': '删除已上传的数据',
    'pv.t.5.b5': '见下方「如何安全地联系我们」',
    'pv.t.5.a6': '导出你的数据',
    'pv.t.5.b6': '同上，可申请导出',
    'pv.t.5.a7': '注销账号',
    'pv.t.5.b7': '同上（当前版本尚未提供自助注销入口，需人工处理）',

    'pv.h3.sc': '如何安全地联系我们（请不要在公开 Issue 里写隐私信息）',
    'pv.p.5.a':
      '本站的公开协作区（GitHub Issues）是<b>任何人都能看到的</b>。为了请求删除数据而在那里贴出你的 '
      + 'Phira UID 或邮箱，等于把你的隐私标识公开 —— 这正是我们要避免的。请改用下面任一方式：',
    'pv.li.5.1':
      '<b>GitHub 私密安全报告</b>（推荐，仅仓库维护者可见）：<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/security/advisories/new" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/security/advisories/new</a>',
    'pv.li.5.2':
      '若该入口不可用，可先在公开 Issue 里<b>只说「需要删除我的数据」</b>，'
      + '等维护者回复后再通过私密渠道交换标识信息',
    'pv.p.5.b':
      '我们收到请求后会删除对应记录，并在完成后回复确认。处理时间为收到请求后的 7 个工作日内。',

    'pv.h2.6': '6. 未成年人',
    'pv.p.6.a': '本工具面向音游玩家群体，<b>可能存在未满 14 周岁的使用者</b>。',
    'pv.p.6.b':
      '如果你是未满 14 周岁的未成年人，请<b>在监护人的陪同下阅读本政策，并取得监护人的同意后</b>'
      + '再使用登录与数据上传功能。若监护人不同意，请关闭自动上传或不要登录 Phira。',
    'pv.p.6.c': '监护人如发现未成年人未经同意上传了信息，可通过上述私密渠道联系我们删除。',

    'pv.h2.7': '7. 第三方服务',
    'pv.t.7.h1': '服务',
    'pv.t.7.h2': '用途',
    'pv.t.7.h3': '你的数据',
    'pv.t.7.a1': 'Phira 公开 API（api.phira.cn）',
    'pv.t.7.b1': '查询谱面与玩家公开资料',
    'pv.t.7.c1': '仅发送你查询的用户名 / UID；服务端日志由 Phira 控制',
    'pv.t.7.a2': 'WorkBuddy 云服务',
    'pv.t.7.b2': '数据库、认证、静态托管',
    'pv.t.7.c2': '存储上述成绩数据与账号信息',
    'pv.t.7.a3': 'jsDelivr CDN',
    'pv.t.7.b3': '加载云 SDK 脚本',
    'pv.t.7.c3': '会看到你的 IP，属常规 CDN 行为；脚本已用 SRI 完整性校验钉死版本',

    'pv.h2.8': '8. 我们不做什么',
    'pv.li.8.1': '不使用 Cookie 做跨站追踪（本站在浏览器本地只使用 <code>localStorage</code>）',
    'pv.li.8.2': '不接入任何广告或数据分析 SDK',
    'pv.li.8.3': '不推断、不判定「谱师虚标」—— 本工具只给难度参考',
    'pv.li.8.4': '不向任何第三方出售或分享你的个人信息',

    'pv.h2.9': '9. 政策变更',
    'pv.p.9.a':
      '本政策如有更新，会修改页面顶部的版本号与生效日期。涉及收集范围扩大的变更，'
      + '会在站内显著位置提示，并重置「首次告知」状态以重新征求你的同意。',
    'pv.p.9.b': '本页 v1.1 相对 v1.0 为<b>排版改版</b>：收集范围、用途与你的权利均无变化。',

    'pv.h2.10': '10. 联系方式',
    'pv.p.10.a':
      '隐私相关问题、数据删除请求、投诉与建议：<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',
    'pv.p.10.b':
      '项目源码（GPL-3.0）见<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">同一仓库</a>。',

    'pv.foot.note': '本工具不判定「虚标」，只提供可审计的难度参考。Phira 官方定数自身标注噪声约 2.80 级。',
    'pv.foot.docs':
      '相关文档：<a href="/terms">用户协议</a> · <a href="/settings">设置</a> · <a href="/">返回首页</a>',

    /* ══════════════════════════════════════════════════════════
     * 用户协议（tm.）—— public/terms.html
     * ══════════════════════════════════════════════════════════ */
    'tm.h1': '<b>P.H.M.</b> Standard 用户协议',
    'tm.meta': '版本 v1.0 · 生效日期 2026-10-07 · 适用站点 <code>phm.app.workbuddy.host</code>',
    'tm.lead':
      '欢迎使用 P.H.M. Standard。在使用本服务前，请你仔细阅读并理解本协议的全部内容，'
      + '<mark>特别是以加粗方式标识的条款</mark>。你访问本站或使用任一功能，即表示你已阅读并同意本协议。'
      + '如果你不同意其中任何内容，请停止使用本服务。',

    'tm.h2.1': '1. 服务说明',
    'tm.h3.1.1': '1.1 本服务是什么',
    'tm.p.1.1.a':
      'P.H.M. Standard（下称「本服务」）是一个免费的 Phira / Phigros <b>谱面难度参考工具</b>。'
      + '它在你自己的浏览器里解析谱面包、提取结构特征，并参照公开的谱面数据给出一个 '
      + '<b>可追溯的难度参考值</b>。本服务同时把计算结果汇总成共享缓存，让其他人查询同一张谱时不必重复计算。',
    'tm.h3.1.2': '1.2 开发者测试版',
    'tm.p.1.2.a':
      '本服务目前是<b>开发者测试版</b>，功能、算法、界面与数据都可能随时调整。'
      + '定数算法发生过换代（引擎版本号会记录在每一条数据上），换代会让新旧数值不可直接比较。'
      + '<b>请不要把本服务的输出用于任何需要稳定性的场合。</b>',
    'tm.h3.1.3': '1.3 与 Phira、Phigros 的关系',
    'tm.p.1.3.a':
      '本服务是<b>第三方非官方工具</b>，与 Phira 开发团队（TeamFlos）、Phigros 及其发行方'
      + '<b>没有任何隶属、合作或代理关系</b>。本服务的名称中出现「P.H.M.」仅为项目自称，'
      + '不代表任何官方标准。',
    'tm.p.1.3.b':
      '本服务通过 Phira 的<b>公开 API</b>（<code>api.phira.cn</code>）只读查询公开数据，'
      + '不修改 Phira 上的任何内容，也不要求你提供 Phira 账号凭据。',

    'tm.h2.2': '2. 你的使用',
    'tm.h3.2.1': '2.1 你可以做的',
    'tm.li.2.1.1': '自由使用本服务查询、计算、导出分享图，无需注册',
    'tm.li.2.1.2': '基于本服务的开源代码自行搭建、修改（受第 5 条许可约束）',
    'tm.li.2.1.3': '在<a href="/settings">设置</a>里随时关闭数据上传',
    'tm.h3.2.2': '2.2 你不应该做的',
    'tm.li.2.2.1':
      '<b>批量、自动化地抓取本服务的接口</b>（<code>/api/</code> 路径已在 robots.txt 中禁止抓取）。'
      + '其中部分路径在未命中缓存时需要下载完整谱面包并运行引擎，属全站最昂贵的操作',
    'tm.li.2.2.2':
      '<b>把他人账号的成绩假冒为自己的贡献</b>。本服务只对用户明确声明过的账号自动上传成绩，'
      + '冒用会直接污染难度统计',
    'tm.li.2.2.3':
      '<b>提交伪造的谱面结构特征</b>以影响共享定数缓存。服务端会用同一份引擎复算并比对，'
      + '伪造值不会被入库',
    'tm.li.2.2.4': '对本站进行攻击、探测、拒绝服务，或试图绕过写入权限控制',
    'tm.li.2.2.5': '将本服务用于任何违反中华人民共和国法律法规的用途',
    'tm.p.2.2.a': '出现上述行为时，我们可能限制相关来源的访问或清除其贡献的数据。',

    'tm.h2.3': '3. 你贡献的内容',
    'tm.h3.3.1': '3.1 上传的是什么',
    'tm.p.3.1.a':
      '关于上传的具体字段、触发时机与关闭方式，见<a href="/privacy">隐私政策</a>。'
      + '核心是两条：<b>谱面文件本身永不上传</b>；成绩数据<b>只在你明确声明过的本人账号上</b>自动上传。',
    'tm.h3.3.2': '3.2 关于贡献数据的许可',
    'tm.p.3.2.a':
      '你同意将上述<b>结构特征与成绩数据</b>用于：改进定数算法、生成聚合统计、向其他用户展示共享定数缓存。'
      + '这些数据<b>不包含</b>你的谱面文件、密码或邮箱。',
    'tm.p.3.2.b':
      '聚合结果（如某张谱的难度参考值）可能被本服务及任何访问者自由查看与引用。'
      + '<b>若你不希望贡献，请在<a href="/settings">设置</a>里关闭上传</b>或撤回首次同意 —— 关闭后功能照常使用。',

    'tm.h2.4': '4. 难度参考的效力（重要）',
    'tm.h3.4.1': '4.1 参考值不是官方认定',
    'tm.p.4.1.a':
      '本服务输出的定数、负荷分（PS）等数值<b>是我们用结构特征算出的参考值，不是 Phira 官方认定值</b>。',
    'tm.p.4.1.b':
      'Phira 上的「标称定数」由谱师人工填写，本身带有相当大的标注噪声'
      + '（实测同曲同物量的相邻难度标注差中位约 2.80 级）。'
      + '本服务<b>不会、也无法</b>把参考值与标称值的差异解释为「谁标错了」。',
    'tm.h3.4.2': '4.2 我们不判定「虚标」',
    'tm.p.4.2.a':
      '<b>本服务不判定任何谱面存在「虚标」「欺诈」或「故意标错」。</b>'
      + '在官方定数自身的标注噪声水平下，没有任何工具能仅凭结构区分「标注有偏差」和「按惯例如此标注」。'
      + '本服务只提供可审计的参考信息，判断与评价属于使用者自己。',
    'tm.h3.4.3': '4.3 不保证准确，也不保证连续可用',
    'tm.p.4.3.a':
      '本服务按「现状」提供，<b>不对准确性、完整性、时效性或适用于特定目的作出任何保证</b>。'
      + '参照集、引擎与上游接口都可能变化；上游 Phira 接口存在已知限制'
      + '（例如某玩家的成绩接口只返回最近 20 条），这些会直接影响结果的完整度，'
      + '我们会在界面上如实标注，但无法消除。',

    'tm.h2.5': '5. 知识产权',
    'tm.li.5.1':
      '本服务的<b>源代码</b>以 <b>GPL-3.0</b> 许可发布，见 '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">项目仓库</a>',
    'tm.li.5.2':
      '<b>Phira 及其相关名称、标识、谱面数据</b>的权利归其各自所有者。'
      + '本服务仅在公开接口允许的范围内使用这些数据',
    'tm.li.5.3': '你通过本服务导出的分享图片可以自由使用与传播',
    'tm.li.5.4': '本服务的名称与标识在未获许可时，不应被用于暗示官方背书或合作',

    'tm.h2.6': '6. 第三方服务',
    'tm.p.6.a': '本服务依赖以下第三方，它们各自的行为由其自身条款约束，我们无法控制：',
    'tm.t.6.h1': '服务',
    'tm.t.6.h2': '作用',
    'tm.t.6.a1': 'Phira 公开 API',
    'tm.t.6.b1': '谱面与玩家公开数据来源',
    'tm.t.6.a2': 'WorkBuddy 云服务',
    'tm.t.6.b2': '数据库、认证、静态托管',
    'tm.t.6.a3': 'jsDelivr CDN',
    'tm.t.6.b3': '分发云 SDK 脚本（已用 SRI 完整性校验钉死版本）',
    'tm.p.6.b': '本服务可能包含指向第三方站点的链接。我们不为这些站点的内容或做法负责。',

    'tm.h2.7': '7. 服务变更与终止',
    'tm.p.7.a':
      '本服务为个人开发者提供的免费服务，<b>我们不承诺永久提供</b>。'
      + '我们可能随时修改、暂停或终止全部或部分功能，也可能清空共享缓存。'
      + '在可行的情况下，重大变更会在站内公告。',
    'tm.p.7.b':
      '若本服务终止，我们会尽力在此前允许你导出所需数据；但因为本服务不保存你的谱面文件，'
      + '更不存在「数据被带走」的问题。',

    'tm.h2.8': '8. 责任限制',
    'tm.p.8.a':
      '在适用法律允许的最大范围内，<b>你因使用或无法使用本服务所产生的任何直接或间接损失，'
      + '我们不承担责任</b>。这包括但不限于：依赖本服务的难度参考而做出的判断、'
      + '因上游接口变化导致的结果偏差、因服务中断导致的不便。',
    'tm.p.8.b': '请把本服务定位为<b>参考工具</b>，而不是权威裁判。',

    'tm.h2.9': '9. 未成年人',
    'tm.p.9.a':
      '若你未满 14 周岁，请在监护人陪同下阅读本协议，并在取得监护人同意后'
      + '使用登录与数据上传功能。详见<a href="/privacy">隐私政策</a>第 6 条。',

    'tm.h2.10': '10. 协议的变更',
    'tm.p.10.a':
      '本协议如有更新，会修改页面顶部的版本号与生效日期。'
      + '若变更涉及你义务的实质增加，我们会在站内显著位置提示。'
      + '<b>变更后继续使用本服务，即视为接受变更后的协议。</b>',

    'tm.h2.11': '11. 联系方式',
    'tm.p.11.a':
      '对本协议的疑问、投诉或建议：<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',
    'tm.p.11.b':
      '涉及个人数据删除等隐私请求，请<b>不要</b>发在公开 Issue 里，'
      + '改用<a href="/privacy">隐私政策</a>「如何安全地联系我们」一节中的私密渠道。',

    'tm.foot.note': '本服务为第三方非官方工具，与 Phira、Phigros 及其开发团队无隶属关系。',
    'tm.foot.docs':
      '相关文档：<a href="/privacy">隐私政策</a> · <a href="/settings">设置</a> · <a href="/">返回首页</a>',
  },

  en: {
    /* ══ page shell (shared by privacy / terms) ══ */
    'lg.back': '← Back to P.H.M. Standard',
    'lg.nav.privacy': 'Privacy Policy',
    'lg.nav.terms': 'Terms of Service',
    'lg.auth': 'The Simplified Chinese version of this document is authoritative; the English translation is provided for convenience only.',
    'lg.foot.brand': 'P.H.M. Standard · developer beta · GPL-3.0',

    /* ══════════════════════════════════════════════════════════
     * Privacy Policy (pv.) — public/privacy.html
     * ══════════════════════════════════════════════════════════ */
    'pv.h1': '<b>P.H.M.</b> Standard Privacy Policy',
    'pv.meta': 'Version v1.1 · Effective 2026-10-07 · Applies to <code>phm.app.workbuddy.host</code>',
    'pv.lead':
      '<b>In one sentence:</b> your <b>chart files never leave your device</b>; only when you look up '
      + '<b>a Phira account you have confirmed as your own</b> is score data (Phira UID, username, chart '
      + 'name, constant, ACC, per-chart RKS) uploaded automatically, to calibrate the constant reference. '
      + '<mark>This can be switched off with one click in <a href="/settings">Settings</a></mark>; '
      + 'once off, no contribution of any kind is uploaded.',

    'pv.h2.1': '1. What we collect',
    'pv.h3.1.1': '1.1 Chart files you drag in yourself — the file itself is not collected',
    'pv.p.1.1.a':
      'Chart parsing (ZIP extraction, structural analysis of the chart, feature extraction, constant '
      + 'computation) <b>all happens inside your browser</b>. The chart file itself is <b>never uploaded, '
      + 'never retained and never leaves your device</b>.',
    'pv.p.1.1.b':
      'Provided you allow automatic upload, the only thing that leaves your device is <b>the structural '
      + 'features computed from that chart</b>, which do not contain the chart content itself:',
    'pv.li.1.1.1': 'Chart name and nominal constant',
    'pv.li.1.1.2': 'Note count, notes per second (NPS), hold-note share, mean jack, peak line speed',
    'pv.li.1.1.3': 'The computed reference constant and load score (PS)',
    'pv.p.1.1.c':
      'This path <b>requires no sign-in</b> and <b>no button press</b> — the contribution is made '
      + 'automatically when you drag a chart in. It is governed by the single switch in '
      + '<a href="/settings">Settings</a>: <b>once automatic upload is off, dragging a chart in produces '
      + 'no upload at all.</b>',

    'pv.h3.1.2': '1.2 Score data when you look up a Phira account — your own account only, and switchable off',
    'pv.p.1.2.a': 'When you type a Phira username or UID into the page and run a lookup:',
    'pv.li.1.2.1':
      '<b>The first time a given UID appears</b>: you are asked once, "Is this your own account?" — '
      + 'only a "yes" records it as your account; a "no" means view only, no upload',
    'pv.li.1.2.2': 'For <b>an account you have confirmed as your own</b>: score data is uploaded automatically (see the table below)',
    'pv.p.1.2.b':
      '<b>Why the extra question:</b> this tool <b>cannot verify ownership of a Phira account</b> '
      + '(Phira offers no third-party authorised sign-in). Without confirmation, any visitor could copy a '
      + 'public player\u2019s scores into the dataset, and every statistic would be skewed — so uploads '
      + 'happen automatically only for accounts you have declared as your own.',
    'pv.t.1.2.h1': 'Item collected',
    'pv.t.1.2.h2': 'Purpose',
    'pv.t.1.2.a1': 'Phira UID and username',
    'pv.t.1.2.b1': 'To distinguish between players and to avoid counting the same score twice',
    'pv.t.1.2.a2': 'Chart name, nominal constant',
    'pv.t.1.2.b2': 'To link a score to its chart',
    'pv.t.1.2.a3': 'Your ACC, per-chart RKS',
    'pv.t.1.2.b3': 'To analyse how players\u2019 actual performance is distributed at the same nominal constant',
    'pv.t.1.2.a4': 'A random pseudonymous identifier, <code>client_id</code>',
    'pv.t.1.2.b4':
      'To distinguish contributions from different sources. <b>This is a pseudonymous identifier, not '
      + 'anonymity</b> — several contributions from the same browser can be linked together. We do not '
      + 'bind it to your real identity, but be aware that it is not unlinkable.',
    'pv.p.1.2.c':
      '<b>Not collected</b>: passwords, email addresses, Phira account credentials or any operating '
      + 'rights. Lookups only read Phira\u2019s public data endpoint (<code>api.phira.cn</code>); '
      + '<b>your Phira password is neither requested nor accepted</b>.',

    'pv.h3.1.3': '1.3 Local storage (kept only in your own browser)',
    'pv.p.1.3.a': 'The following is kept only in your browser\u2019s <code>localStorage</code> and is never uploaded automatically:',
    'pv.li.1.3.1': 'Phira usernames / UIDs you have entered (to prefill them next time)',
    'pv.li.1.3.2': 'The state of the automatic-upload switch and of the first-run notice confirmation',
    'pv.li.1.3.3': 'A randomly generated <code>client_id</code> (an 8-character random string used to distinguish the source of an anonymous check-in)',
    'pv.li.1.3.4': 'The sign-in session for a P.H.M. account (if you registered one with an email address)',

    'pv.h3.1.4': '1.4 Account system (optional)',
    'pv.p.1.4.a':
      'This applies only if you register voluntarily. It uses an email address and a password, for signing '
      + 'in, linking a Phira account, and viewing and editing your own profile. Account-related data '
      + '(email address and password hash) is stored by the authentication module of the WorkBuddy cloud '
      + 'service; we <b>cannot read your password in plaintext</b>.',

    'pv.h2.2': '2. What we use it for',
    'pv.li.2.1':
      '<b>Calibrating the constant reference</b>: to measure how players\u2019 ACC is distributed at the '
      + 'same nominal constant, and to identify where the nominal value departs from actual difficulty',
    'pv.li.2.2':
      '<b>The shared constant cache</b>: so that others who look up the same chart need not download and compute it again',
    'pv.li.2.3':
      '<b>Displaying aggregate statistics</b>: totals such as "N score records" or "N cached constants"',
    'pv.p.2.a': 'We do not use this data for advertising or profiling, nor do we sell it to third parties.',

    'pv.h2.3': '3. External visibility',
    'pv.p.3.a':
      '<b>No one else can see your UID or username.</b> Anonymous read access to the score detail table '
      + '(<code>phm_scores</code>) has been <b>revoked</b>. Externally, data is reachable only through two '
      + 'aggregate endpoints, and they <b>return statistics only</b>:',
    'pv.li.3.1': '<code>phm_plays(chart name)</code> → the chart\u2019s <b>count / mean / median / minimum / maximum ACC</b>',
    'pv.li.3.2': '<code>phm_stats()</code> → global totals (accounts, active users, total scores and so on)',
    'pv.p.3.b': 'Neither returns any individual personal record.',

    'pv.h2.4': '4. Storage and security',
    'pv.li.4.1': 'Data is stored in a PostgreSQL database on the <b>WorkBuddy cloud service</b> (within mainland China)',
    'pv.li.4.2': 'Chart files are not uploaded, so there is no storage risk for chart content',
    'pv.li.4.3': 'Writes must pass field validation and rate limiting at this site\u2019s server-side gateway',
    'pv.li.4.4':
      '<b>We do not guarantee absolute security</b> — any network service can be attacked. '
      + 'Please do not upload any sensitive information',
    'pv.p.4.a':
      'More complete technical detail (trust boundaries, fixes made and known limitations) is in '
      + '<code>docs/SECURITY.md</code> in the repository.',

    'pv.h2.5': '5. Your rights',
    'pv.t.5.h1': 'Right',
    'pv.t.5.h2': 'How to exercise it',
    'pv.t.5.a1': 'Turn uploads off',
    'pv.t.5.b1':
      '<a href="/settings">Settings</a> → switch off "Automatic upload". This takes effect '
      + '<b>immediately</b>; after that, no chart structural features or score data are uploaded',
    'pv.t.5.a2': 'Withdraw first consent',
    'pv.t.5.b2': '<a href="/settings">Settings</a> → withdraw confirmation. Consent will be requested again before the next upload',
    'pv.t.5.a3': 'Clear local data',
    'pv.t.5.b3': '<a href="/settings#storage">Settings · Local storage</a> → clear all with one click (server data is unaffected)',
    'pv.t.5.a4': 'View without contributing',
    'pv.t.5.b4': 'When looking up a Phira account, answer "not my account" — view only, no upload',
    'pv.t.5.a5': 'Delete data already uploaded',
    'pv.t.5.b5': 'See "How to contact us safely" below',
    'pv.t.5.a6': 'Export your data',
    'pv.t.5.b6': 'As above; an export can be requested',
    'pv.t.5.a7': 'Delete your account',
    'pv.t.5.b7': 'As above (the current version offers no self-service deletion, so it is handled manually)',

    'pv.h3.sc': 'How to contact us safely (please do not post private information in a public Issue)',
    'pv.p.5.a':
      'This site\u2019s public collaboration area (GitHub Issues) is <b>visible to anyone</b>. Posting your '
      + 'Phira UID or email address there in order to request deletion would amount to publishing your '
      + 'privacy identifiers — precisely what we want to avoid. Please use either of the following instead:',
    'pv.li.5.1':
      '<b>A private GitHub security advisory</b> (recommended; visible only to repository maintainers):<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/security/advisories/new" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/security/advisories/new</a>',
    'pv.li.5.2':
      'If that entry point is unavailable, you may first post in a public Issue <b>stating only that you '
      + 'need your data deleted</b>, then exchange identifying information through a private channel once a '
      + 'maintainer replies',
    'pv.p.5.b':
      'On receiving a request we will delete the corresponding records and reply to confirm once done. '
      + 'Processing takes place within 7 working days of receiving the request.',

    'pv.h2.6': '6. Minors',
    'pv.p.6.a': 'This tool is aimed at rhythm-game players, <b>who may include users under 14 years of age</b>.',
    'pv.p.6.b':
      'If you are a minor under 14, please <b>read this policy together with your guardian and obtain '
      + 'their consent</b> before using sign-in and data upload. If your guardian does not consent, please '
      + 'switch off automatic upload or refrain from signing in to Phira.',
    'pv.p.6.c':
      'If a guardian finds that a minor has uploaded information without consent, they may contact us '
      + 'through the private channel above to have it deleted.',

    'pv.h2.7': '7. Third-party services',
    'pv.t.7.h1': 'Service',
    'pv.t.7.h2': 'Purpose',
    'pv.t.7.h3': 'Your data',
    'pv.t.7.a1': 'Phira public API (api.phira.cn)',
    'pv.t.7.b1': 'Looking up public chart and player profiles',
    'pv.t.7.c1': 'Only the username / UID you look up is sent; server logs are controlled by Phira',
    'pv.t.7.a2': 'WorkBuddy cloud service',
    'pv.t.7.b2': 'Database, authentication, static hosting',
    'pv.t.7.c2': 'Stores the score data and account information described above',
    'pv.t.7.a3': 'jsDelivr CDN',
    'pv.t.7.b3': 'Loading the cloud SDK script',
    'pv.t.7.c3': 'It sees your IP, which is normal CDN behaviour; the script version is pinned by SRI integrity checking',

    'pv.h2.8': '8. What we do not do',
    'pv.li.8.1': 'We do not use cookies for cross-site tracking (this site uses only <code>localStorage</code> in the browser)',
    'pv.li.8.2': 'We include no advertising or analytics SDKs',
    'pv.li.8.3': 'We do not infer or judge "charter inflation" — this tool provides a difficulty reference only',
    'pv.li.8.4': 'We do not sell or share your personal information with any third party',

    'pv.h2.9': '9. Changes to this policy',
    'pv.p.9.a':
      'If this policy is updated, the version number and effective date at the top of the page are '
      + 'revised. A change that widens the scope of collection is announced prominently on the site, and '
      + 'the "first-run notice" state is reset so that your consent is sought again.',
    'pv.p.9.b': 'Version v1.1 of this page is a <b>typographic revision</b> of v1.0: the scope of collection, the purposes and your rights are unchanged.',

    'pv.h2.10': '10. Contact',
    'pv.p.10.a':
      'Privacy questions, data deletion requests, complaints and suggestions:<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',
    'pv.p.10.b':
      'The project source (GPL-3.0) is in <a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">the same repository</a>.',

    'pv.foot.note':
      'This tool does not judge "inflation"; it provides an auditable difficulty reference only. '
      + 'Phira\u2019s own nominal constants carry labelling noise of about 2.80 levels.',
    'pv.foot.docs':
      'Related documents: <a href="/terms">Terms of Service</a> · <a href="/settings">Settings</a> · <a href="/">Back to home</a>',

    /* ══════════════════════════════════════════════════════════
     * Terms of Service (tm.) — public/terms.html
     * ══════════════════════════════════════════════════════════ */
    'tm.h1': '<b>P.H.M.</b> Standard Terms of Service',
    'tm.meta': 'Version v1.0 · Effective 2026-10-07 · Applies to <code>phm.app.workbuddy.host</code>',
    'tm.lead':
      'Welcome to P.H.M. Standard. Before using this Service, please read and understand this agreement '
      + 'in full, <mark>especially the clauses shown in bold</mark>. By visiting this site or using any of '
      + 'its features you confirm that you have read and accept this agreement. If you do not agree with '
      + 'any part of it, please stop using the Service.',

    'tm.h2.1': '1. Description of the Service',
    'tm.h3.1.1': '1.1 What this Service is',
    'tm.p.1.1.a':
      'P.H.M. Standard (the "Service") is a free <b>chart difficulty reference tool</b> for Phira / '
      + 'Phigros. It parses chart packs and extracts structural features inside your own browser, and '
      + 'against public chart data produces a <b>traceable difficulty reference value</b>. The Service also '
      + 'aggregates the computed results into a shared cache, so that others looking up the same chart need '
      + 'not recompute it.',
    'tm.h3.1.2': '1.2 Developer beta',
    'tm.p.1.2.a':
      'The Service is currently a <b>developer beta</b>: its features, algorithms, interface and data may '
      + 'change at any time. The constant algorithm has been replaced across generations (the engine '
      + 'version number is recorded on every record), and a generation change makes old and new values '
      + 'directly incomparable. <b>Do not rely on this Service\u2019s output in any setting that requires '
      + 'stability.</b>',
    'tm.h3.1.3': '1.3 Relationship to Phira and Phigros',
    'tm.p.1.3.a':
      'The Service is a <b>third-party, unofficial tool</b> with <b>no affiliation, partnership or agency '
      + 'relationship</b> with the Phira development team (TeamFlos), Phigros or its publisher. The '
      + '"P.H.M." in the Service\u2019s name is merely the project\u2019s own designation and does not '
      + 'denote any official standard.',
    'tm.p.1.3.b':
      'The Service reads public data through Phira\u2019s <b>public API</b> (<code>api.phira.cn</code>) on '
      + 'a read-only basis; it does not modify anything on Phira and does not ask you for Phira account '
      + 'credentials.',

    'tm.h2.2': '2. Your use',
    'tm.h3.2.1': '2.1 What you may do',
    'tm.li.2.1.1': 'Use the Service freely to look up charts, compute, and export share images, with no registration required',
    'tm.li.2.1.2': 'Build and modify your own instance from the Service\u2019s open-source code (subject to the licence in clause 5)',
    'tm.li.2.1.3': 'Switch off data upload at any time in <a href="/settings">Settings</a>',
    'tm.h3.2.2': '2.2 What you must not do',
    'tm.li.2.2.1':
      '<b>Scrape the Service\u2019s endpoints in bulk or automatically</b> (the <code>/api/</code> path is '
      + 'disallowed in robots.txt). Some of those routes, on a cache miss, must download a complete chart '
      + 'pack and run the engine — the most expensive operation on the whole site',
    'tm.li.2.2.2':
      '<b>Pass off another account\u2019s scores as your own contribution</b>. The Service uploads scores '
      + 'automatically only for accounts a user has explicitly declared; impersonation directly '
      + 'contaminates the difficulty statistics',
    'tm.li.2.2.3':
      '<b>Submit fabricated chart structural features</b> to influence the shared constant cache. The '
      + 'server recomputes with the same engine and compares; fabricated values are not written to the '
      + 'database',
    'tm.li.2.2.4': 'Attack, probe or deny service to this site, or attempt to bypass write permission controls',
    'tm.li.2.2.5': 'Use the Service for any purpose that violates the laws and regulations of the People\u2019s Republic of China',
    'tm.p.2.2.a': 'Where such conduct occurs, we may restrict access from the source concerned or remove the data it contributed.',

    'tm.h2.3': '3. Content you contribute',
    'tm.h3.3.1': '3.1 What is uploaded',
    'tm.p.3.1.a':
      'For the exact fields uploaded, when uploads are triggered and how to switch them off, see the '
      + '<a href="/privacy">Privacy Policy</a>. Two points matter most: <b>the chart file itself is never '
      + 'uploaded</b>, and score data is uploaded automatically <b>only for an account you have explicitly '
      + 'declared as your own</b>.',
    'tm.h3.3.2': '3.2 Licence for contributed data',
    'tm.p.3.2.a':
      'You agree that the <b>structural features and score data</b> described above may be used to improve '
      + 'the constant algorithm, to produce aggregate statistics, and to show the shared constant cache to '
      + 'other users. This data <b>does not include</b> your chart files, your password or your email address.',
    'tm.p.3.2.b':
      'Aggregate results (such as a chart\u2019s difficulty reference value) may be viewed and cited freely '
      + 'by the Service and by any visitor. <b>If you do not wish to contribute, switch uploads off in '
      + '<a href="/settings">Settings</a></b> or withdraw your first consent — the features remain fully '
      + 'usable afterwards.',

    'tm.h2.4': '4. The standing of the difficulty reference (important)',
    'tm.h3.4.1': '4.1 The reference value is not an official determination',
    'tm.p.4.1.a':
      'The constant, load score (PS) and similar values the Service outputs <b>are reference values we '
      + 'compute from structural features, not values determined by Phira</b>.',
    'tm.p.4.1.b':
      'A "nominal constant" on Phira is entered by hand by the charter and carries considerable labelling '
      + 'noise of its own (measured across the same song and note count, adjacent difficulty labels differ '
      + 'by a median of about 2.80 levels). The Service <b>will not and cannot</b> construe a gap between '
      + 'the reference value and the nominal value as anyone having "labelled it wrong".',
    'tm.h3.4.2': '4.2 We do not judge "inflation"',
    'tm.p.4.2.a':
      '<b>The Service does not find any chart to be "inflated", "fraudulent" or "deliberately '
      + 'mislabelled".</b> At the level of labelling noise inherent in official constants, no tool can '
      + 'distinguish, from structure alone, between "a label that is off" and "a label that follows '
      + 'convention". The Service provides auditable reference information only; the judgement and the '
      + 'assessment are the user\u2019s own.',
    'tm.h3.4.3': '4.3 No warranty of accuracy or of continuous availability',
    'tm.p.4.3.a':
      'The Service is provided "as is", <b>with no warranty of accuracy, completeness, timeliness or '
      + 'fitness for a particular purpose</b>. The reference set, the engine and upstream endpoints may '
      + 'all change; the upstream Phira API has known limits (for example, a player\u2019s score endpoint '
      + 'returns only the 20 most recent records). These directly affect how complete a result is; we label '
      + 'them truthfully in the interface but cannot remove them.',

    'tm.h2.5': '5. Intellectual property',
    'tm.li.5.1':
      'The Service\u2019s <b>source code</b> is released under the <b>GPL-3.0</b> licence; see the '
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric" target="_blank" rel="noopener">project repository</a>',
    'tm.li.5.2':
      'Rights in <b>Phira and its related names, marks and chart data</b> belong to their respective '
      + 'owners. The Service uses this data only within the scope the public API permits',
    'tm.li.5.3': 'Share images you export through the Service may be used and redistributed freely',
    'tm.li.5.4': 'The Service\u2019s name and marks must not, without permission, be used to imply official endorsement or partnership',

    'tm.h2.6': '6. Third-party services',
    'tm.p.6.a': 'The Service relies on the following third parties; their conduct is governed by their own terms and is beyond our control:',
    'tm.t.6.h1': 'Service',
    'tm.t.6.h2': 'Role',
    'tm.t.6.a1': 'Phira public API',
    'tm.t.6.b1': 'Source of public chart and player data',
    'tm.t.6.a2': 'WorkBuddy cloud service',
    'tm.t.6.b2': 'Database, authentication, static hosting',
    'tm.t.6.a3': 'jsDelivr CDN',
    'tm.t.6.b3': 'Distribution of the cloud SDK script (version pinned by SRI integrity checking)',
    'tm.p.6.b': 'The Service may contain links to third-party sites. We are not responsible for their content or practices.',

    'tm.h2.7': '7. Changes to and termination of the Service',
    'tm.p.7.a':
      'The Service is a free service provided by an individual developer; <b>we do not undertake to '
      + 'provide it permanently</b>. We may modify, suspend or terminate all or part of its features at any '
      + 'time, and may also empty the shared cache. Where feasible, significant changes are announced on the site.',
    'tm.p.7.b':
      'If the Service is terminated, we will do our best to let you export the data you need beforehand; '
      + 'but since the Service does not keep your chart files, there is no "data being taken away" problem '
      + 'in the first place.',

    'tm.h2.8': '8. Limitation of liability',
    'tm.p.8.a':
      'To the maximum extent permitted by applicable law, <b>we are not liable for any direct or indirect '
      + 'loss you suffer from using or being unable to use the Service</b>. This includes, without '
      + 'limitation: decisions made in reliance on the Service\u2019s difficulty reference, deviations in '
      + 'results caused by changes to upstream endpoints, and inconvenience caused by service interruptions.',
    'tm.p.8.b': 'Please treat the Service as a <b>reference tool</b>, not an authoritative arbiter.',

    'tm.h2.9': '9. Minors',
    'tm.p.9.a':
      'If you are under 14, please read this agreement together with your guardian and use sign-in and '
      + 'data upload only with your guardian\u2019s consent. See clause 6 of the '
      + '<a href="/privacy">Privacy Policy</a> for details.',

    'tm.h2.10': '10. Changes to this agreement',
    'tm.p.10.a':
      'If this agreement is updated, the version number and effective date at the top of the page are '
      + 'revised. If a change materially increases your obligations, we will announce it prominently on the '
      + 'site. <b>Continuing to use the Service after a change constitutes acceptance of the revised '
      + 'agreement.</b>',

    'tm.h2.11': '11. Contact',
    'tm.p.11.a':
      'Questions, complaints or suggestions about this agreement:<br>'
      + '<a href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues" target="_blank" rel="noopener">'
      + 'github.com/WebExperiments-glitch/Phira-Huamei-Metric/issues</a>',
    'tm.p.11.b':
      'For privacy requests such as deletion of personal data, please <b>do not</b> post in a public '
      + 'Issue; use the private channel described in the "How to contact us safely" section of the '
      + '<a href="/privacy">Privacy Policy</a> instead.',

    'tm.foot.note': 'This Service is a third-party, unofficial tool with no affiliation to Phira, Phigros or their development teams.',
    'tm.foot.docs':
      'Related documents: <a href="/privacy">Privacy Policy</a> · <a href="/settings">Settings</a> · <a href="/">Back to home</a>',
  },
};
