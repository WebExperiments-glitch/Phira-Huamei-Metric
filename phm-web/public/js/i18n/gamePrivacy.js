/* ============================================================
 * js/i18n/gamePrivacy.js —— 客户端（游戏）隐私政策 + 儿童协议
 * ============================================================
 * 【覆盖哪些页面】
 *   public/privacy-game.html             —— gp.  游戏隐私政策
 *   public/privacy-game-children.html    —— gc.  儿童隐私协议
 *
 * 【与 legal.js 的分工】
 *   legal.js 是**网页端**（拖谱面进浏览器那套）的隐私政策；
 *   这里是**客户端**的隐私政策。两者采集面完全不同，混在一起会写错披露。
 *
 * 【为什么拆成两个文件】
 *   屎山考核有 900 行上限。叙述型条款与表格型清单合起来必然超，
 *   按「条款」与「清单」拆开：改叙述动这里，加字段动 gamePrivacyList.js。
 *
 * ⚠ 术语不硬译：Phira / huamei / IDFA / IDFV / UDID / MAC / scrypt / SHA-256 /
 *   HTTPS / Neon / WorkBuddy / ap-southeast-1 / telemetry_enabled / hm_plays /
 *   motion.log / panic.log 保持原样。
 * ⚠ 法律文本逐段对照翻译：限定语、免责范围、已知缺陷一律不软化、不摘要。
 * ============================================================ */
export default {
  zh: {
    /* ══ 四页共用外壳 ══ */
    'gp.back': '← 返回更多',
    'gp.nav.privacy': '游戏隐私政策',
    'gp.nav.children': '儿童隐私',
    'gp.nav.collect': '收集清单',
    'gp.nav.third': '第三方共享',
    'gp.auth': '本政策以简体中文版本为准；英文译本仅供参考。',

    /* ══════════════════════════════════════════════════════════
     * 游戏隐私政策（gp.）—— privacy-game.html
     * ══════════════════════════════════════════════════════════ */
    'gp.h1': '<b>Phira</b> 话梅构建 · 隐私政策',
    'gp.meta': '版本 v1.0 · 生效日期 2026-11-16 · 适用客户端 Phira（话梅构建，0.8.2-huamei 系列）',
    'gp.lead':
      '<b>一句话概括：</b>本客户端会在每局结束时把<b>对局结算数据</b>上传到 <code>phm.app.workbuddy.host</code>，'
      + '用于研究谱面难度。其中包含<b>位置（城市级，约 1 公里精度）</b>与<b>陀螺仪摘要</b>，属于敏感个人信息。'
      + '这两项都可以在<b>设置 → 账号 → 上报游玩数据</b>一键关闭，关闭后不再上传任何对局数据。',

    'gp.h2.1': '1. 谁是处理者',
    'gp.t.1.a': '运营者',
    'gp.t.1.b': 'huamei',
    'gp.t.1.c': '联系方式',
    'gp.t.1.d': '数据处理地点',
    'gp.t.1.e': '新加坡（ap-southeast-1）的云数据库',
    'gp.t.1.f': '政策适用范围',
    'gp.t.1.g': '本客户端（话梅构建）。<b>不适用于</b> Phira 官方客户端',
    'gp.p.1.a':
      '本客户端是 Phira 的第三方构建，来自开源项目 TeamFlos/phira。我们与 Phira 官方（TeamFlos）'
      + '<b>没有隶属关系</b>，官方不接收、不处理本客户端上传的数据。',

    'gp.h2.2': '2. 我们收集什么',
    'gp.h3.2.1': '2.1 对局结算数据（每次打完一局上传一次）',
    'gp.th.item': '数据项',
    'gp.th.what': '具体内容',
    'gp.t.2.a1': '成绩',
    'gp.t.2.b1': '分数、准确率、最大连击、Perfect/Good/Bad/Miss 四项计数',
    'gp.t.2.a2': '谱面标识',
    'gp.t.2.b2': '谱面 ID、难度标签、物量、谱面内容摘要（SHA-256）',
    'gp.t.2.a3': '逐音符判定',
    'gp.t.2.b3': '每个音符的判定结果与击打偏移（早/晚多少毫秒）',
    'gp.t.2.a4': '手感特征',
    'gp.t.2.b4': '本局最大同时手指数',
    'gp.t.2.a5': '触控落点',
    'gp.t.2.b5': '8×8 网格的点击热度分布（64 个计数，归一化）',
    'gp.t.2.a6': '计时完整性',
    'gp.t.2.b6': '实际游玩耗时、谱面时长、二者比值、暂停次数、卡顿帧数',
    'gp.t.2.a7': '设备信息',
    'gp.t.2.b7': '系统版本、机型标识（如 iPhone15,2）、屏幕尺寸与像素比、实际渲染尺寸',
    'gp.t.2.a8': '位置',
    'gp.t.2.b8': '经纬度，<b>四舍五入到 2 位小数（约 1 公里）</b>',
    'gp.t.2.a9': '陀螺仪摘要',
    'gp.t.2.b9': '一局内角速度的均值、标准差、峰值三个数（不传原始采样）',
    'gp.t.2.a10': '游戏设置',
    'gp.t.2.b10': '谱速、Mod、是否键盘模式',
    'gp.t.2.a11': '版本信息',
    'gp.t.2.b11': '客户端版本、判定数据格式版本、结算时刻',
    'gp.p.2.a':
      '<b>位置的处理方式</b>：定位精度请求为 1000 米，拿到坐标后<b>在写入内存前</b>就四舍五入到 2 位小数，'
      + '原始精确坐标不会离开采集函数、不会落盘、不会上传。拒绝系统定位授权后，该字段为空，其余数据照常上报。',
    'gp.p.2.b':
      '<b>陀螺仪的处理方式</b>：只上传三个统计量。一局 3 分钟 60Hz 的原始采样约 1 万个点，我们不传、也不在本地保留。',
    'gp.h3.2.2': '2.2 明确不收集',
    'gp.p.2.c': '以下项目代码里没有任何采集路径，可对照源码核实：',
    'gp.li.2.1': '<b>设备唯一标识</b>：不取 IDFA、IDFV、UDID、MAC、序列号',
    'gp.li.2.2': '通讯录、相册、麦克风、摄像头',
    'gp.li.2.3': '<b>剪贴板</b>：不读取（仅在用户点「复制」时写入用户名或错误信息，从不读回内容上传）',
    'gp.li.2.4': '精确位置（原始 GPS 坐标）',
    'gp.li.2.5': '你的 Phira 账号密码（只读公开接口，不接收密码）',
    'gp.li.2.6': '游戏内聊天内容、好友列表',
    'gp.li.2.7': '广告标识符，也无任何广告 SDK',
    'gp.h3.2.3': '2.3 账号（可选）',
    'gp.p.2.d':
      '如果你在客户端里登录话梅账号（自建邮箱体系），我们会存邮箱、密码哈希（scrypt 加盐哈希，不存明文）'
      + '与一个随机内部标识。如果你只登录 Phira 账号，我们不存你的密码；仅在每次上报时把会话令牌转发给'
      + ' Phira 官方 /me 接口验证身份，从返回值里取 Phira UID 与用户名。令牌本身不落库。',
    'gp.p.2.e': '<b>未登录也会上报</b>，此时以匿名方式记录（无法关联到你个人）。',
    'gp.h3.2.4': '2.4 本地诊断日志',
    'gp.p.2.f':
      '为排查故障，客户端会在应用沙盒内写入 <code>motion.log</code>（陀螺仪采集诊断）与 '
      + '<code>panic.log</code>（崩溃记录），单个文件上限 256 KB 并轮转。'
      + '<b>这两个文件只存在你的设备上，不会自动上传。</b>你可以在「文件」App 的 '
      + '<code>我的 iPad → phira-hm</code> 目录下自行查看或删除。',

    'gp.h2.3': '3. 用来做什么',
    'gp.th.use': '用途',
    'gp.th.why': '具体说明',
    'gp.t.3.a1': '谱面难度研究',
    'gp.t.3.b1': '用大量玩家的真实表现反推谱面难度，替代主观标称定数',
    'gp.t.3.a2': '数据质量分析',
    'gp.t.3.b2': '判断哪些数据可信（如卡顿帧过多的一局会降权）',
    'gp.t.3.a3': '故障排查',
    'gp.t.3.b3': '定位采集失败（如某机型拿不到陀螺仪）',
    'gp.p.3.a':
      '我们不做的事：不做用户画像、不做广告推荐、不向你推送营销内容；不把你的数据卖给任何第三方；'
      + '不用你的数据做与谱面难度无关的分析。',

    'gp.h2.4': '4. 第三方共享',
    'gp.p.4.a': '完整清单见 <a href="/privacy-game/third-party">第三方共享个人信息清单</a>。摘要：',
    'gp.th.third': '第三方',
    'gp.th.share': '共享什么',
    'gp.th.purpose': '目的',
    'gp.t.4.a1': 'Phira 官方 API',
    'gp.t.4.b1': '仅在你登录 Phira 时转发会话令牌',
    'gp.t.4.c1': '验证身份、下载谱面',
    'gp.t.4.a2': '云托管与数据库',
    'gp.t.4.b2': '全部上报数据（存储）',
    'gp.t.4.c2': '数据存储',
    'gp.t.4.a3': '谱面 CDN',
    'gp.t.4.b3': '无个人数据',
    'gp.t.4.c3': '下载谱面文件',

    'gp.h2.5': '5. 保存多久',
    'gp.t.5.a1': '对局数据',
    'gp.t.5.b1': '长期保存用于难度研究（当前没有自动删除机制）',
    'gp.t.5.a2': '账号信息',
    'gp.t.5.b2': '至你注销账号为止',
    'gp.t.5.a3': '本地日志',
    'gp.t.5.b3': '仅在你的设备上，256 KB 轮转覆盖，我们无法访问',

    'gp.h2.6': '6. 你的权利',
    'gp.h3.6.1': '6.1 关闭数据上报（最直接的方式）',
    'gp.p.6.a':
      '<b>设置 → 账号 → 上报游玩数据</b>（代码里叫 <code>telemetry_enabled</code>）。'
      + '关闭后结算页不再发起上传，<b>不显示「上传中」</b>——这是刻意设计，让你能看出开关确实生效了。'
      + '开关放在账号页最上方、四份文档之前，就是为了让它更容易被找到。',
    'gp.p.6.b': '<b>该开关默认为开启。</b>我们正在评估改为首次启动时询问（见第 9 节）。',
    'gp.h3.6.2': '6.2 注销账号',
    'gp.p.6.c':
      '客户端内可注销话梅账号，会删除账号、档案与未使用的验证码。<b>注销不会删除</b>已经上报的对局数据'
      + '——这些数据在上报时就是匿名或仅带随机内部标识的，已无法回溯到你的邮箱。'
      + '如果你要求删除对局数据，请通过第 1 节联系方式提出，我们会按你的谱面 ID 与时间范围尽力定位'
      + '（若当时为匿名上报则技术上无法定位）。',
    'gp.h3.6.3': '6.3 其他权利',
    'gp.p.6.d':
      '依据《个人信息保护法》，你有权查阅、复制、更正、补充、删除你的个人信息，并可撤回同意。'
      + '请通过第 1 节联系方式提出，我们会在 15 个工作日内答复。',

    'gp.h2.7': '7. 位置与陀螺仪的特殊说明',
    'gp.p.7.a': '这两项在《个人信息保护法》下属敏感个人信息，单独说明。',
    'gp.h3.7.1': '位置',
    'gp.li.7.1': '目的：分析不同地区玩家的设备与网络状况',
    'gp.li.7.2': '精度：约 1 公里（四舍五入到 2 位小数）',
    'gp.li.7.3': '必要性：<b>非必要</b>，拒绝后游戏功能完全正常',
    'gp.li.7.4': '授权方式：iOS 系统弹窗（仅使用期间）',
    'gp.li.7.5': '撤回：iOS「设置 → 隐私与安全性 → 定位服务 → Phira」',
    'gp.h3.7.2': '陀螺仪',
    'gp.li.7.6': '目的：分析手抖程度与判定偏差的关系',
    'gp.li.7.7': '内容：仅三个统计量，不含原始采样',
    'gp.li.7.8': '必要性：<b>非必要</b>，拒绝后游戏功能完全正常',
    'gp.li.7.9': '撤回：随 6.1 节总开关一并关闭',

    'gp.h2.8': '8. 未成年人',
    'gp.p.8.a':
      '本客户端不面向 14 周岁以下儿童单独提供服务。若你是未成年人，请在监护人陪同下阅读本政策并使用。'
      + '专项说明见 <a href="/privacy-game/children">儿童隐私协议</a>。',

    'gp.h2.9': '9. 已知的待改进项（诚实披露）',
    'gp.p.9.a': '以下问题我们已知、尚未解决，写在政策里而不是藏起来：',
    'gp.li.9.1': '<b>上报开关默认开启</b>——位置属敏感个人信息，理想做法是首次启动时单独询问。当前为默认开启 + 可随时关闭，正在评估改造。',
    'gp.li.9.2': '<b>对局数据无删除机制</b>——见第 5 节。',
    'gp.li.9.3': '<b>无年龄门</b>——未做年龄验证，依赖监护人主动管理。',

    'gp.h2.10': '10. 政策变更',
    'gp.p.10.a': '政策更新时，我们会在本页面同步更新版本号与生效日期。涉及收集范围扩大的变更，会在客户端内显著提示。',
    'gp.foot': '本文档与客户端采集代码逐条对应。改动采集代码必须同步更新本页，否则构成虚假披露。',

    /* ══════════════════════════════════════════════════════════
     * 儿童隐私协议（gc.）—— privacy-game-children.html
     * ══════════════════════════════════════════════════════════ */
    'gc.h1': '儿童个人信息保护规则',
    'gc.meta': '版本 v1.0 · 生效日期 2026-11-16 · 适用：本客户端的 14 周岁以下用户',
    'gc.lead':
      '<b>一句话概括：</b>本客户端<b>不面向 14 周岁以下儿童单独提供服务</b>。'
      + '如果你是 14 周岁以下，请在父母或其他监护人陪同下阅读本规则，并在取得监护人同意后使用。',
    'gc.h2.1': '1. 我们收集儿童信息吗',
    'gc.p.1.a':
      '<b>会，但依赖于监护人的设备授权。</b>这一点必须说清，不能含糊：本客户端没有年龄验证，'
      + '也无法识别用户年龄。因此只要设备在使用，对局数据（含位置与陀螺仪摘要）就会按 '
      + '<a href="/privacy-game">游戏隐私政策</a> 所述的规则上报。',
    'gc.p.1.b': '我们不会因为你是儿童而收集更多信息，也不会收集少于成人——技术上无法区分，这是当前实现的真实边界。',
    'gc.h2.2': '2. 收集哪些信息',
    'gc.p.2.a': '与成人相同，逐项见 <a href="/privacy-game/collect">个人信息收集清单</a>。关键项：',
    'gc.th.item': '数据项',
    'gc.th.note': '儿童场景下的说明',
    'gc.t.2.a1': '逐音符判定',
    'gc.t.2.b1': '不含任何身份信息，仅记录音符判定结果',
    'gc.t.2.a2': '位置（约 1 公里）',
    'gc.t.2.b2': '<b>敏感</b>。监护人应明确决定是否允许系统定位授权',
    'gc.t.2.a3': '陀螺仪摘要',
    'gc.t.2.b3': '三个统计量，不传原始采样',
    'gc.t.2.a4': '设备型号',
    'gc.t.2.b4': '用于分析机型与判定的关系',
    'gc.p.2.b': '<b>不收集</b>：姓名、头像、生日、学校、住址、通讯录、相册、任何设备唯一标识。',
    'gc.h2.3': '3. 监护人如何阻止上报',
    'gc.h3.3.1': '方式一：关闭数据上报开关（推荐）',
    'gc.p.3.a': '<code>设置 → 账号 → 上报游玩数据</code> → 关闭。关闭后不发起任何上传，此设置立即生效，无需联网。',
    'gc.h3.3.2': '方式二：拒绝系统定位授权',
    'gc.p.3.b': '首次启动时 iOS 会弹出定位权限请求，选择「不允许」即可。之后可在 <code>iOS 设置 → 隐私与安全性 → 定位服务</code> 中随时撤销。',
    'gc.h3.3.3': '方式三：不使用本客户端',
    'gc.p.3.c': '本客户端为第三方构建，Phira 官方客户端不包含我们的数据上报逻辑。',
    'gc.h2.4': '4. 我们如何保护儿童信息',
    'gc.th.measure': '措施',
    'gc.th.how': '具体做法',
    'gc.t.4.a1': '最小化',
    'gc.t.4.b1': '不采集姓名、位置精确坐标、设备唯一标识',
    'gc.t.4.a2': '精度削减',
    'gc.t.4.b2': '位置四舍五入到约 1 公里',
    'gc.t.4.a3': '传输加密',
    'gc.t.4.b3': '全站 HTTPS',
    'gc.t.4.a4': '访问控制',
    'gc.t.4.b4': '数据库不开放公网匿名读取，仅服务端凭据可写',
    'gc.t.4.a5': '不做画像',
    'gc.t.4.b5': '不用儿童数据做任何推荐、广告或用户画像',
    'gc.p.4.a':
      '<b>诚实说明</b>：本客户端为个人开发者项目，不具备专门面向儿童的合规体系'
      + '（如专门的儿童数据隔离存储、独立的儿童数据删除通道）。如果你的孩子使用本客户端，'
      + '建议直接关闭数据上报开关。',
    'gc.h2.5': '5. 监护人的权利',
    'gc.p.5.a':
      '监护人可通过 <a href="/privacy-game">游戏隐私政策</a> 第 1 节的联系方式：询问我们是否持有某条数据、'
      + '要求删除（匿名数据无法定位，需提供谱面 ID 与大致时间）、要求停止处理。我们在 15 个工作日内答复。',
    'gc.h2.6': '6. 我们不做什么',
    'gc.li.6.1': '不向儿童推送任何营销内容',
    'gc.li.6.2': '不使用儿童数据做广告定向',
    'gc.li.6.3': '不将儿童数据提供给任何第三方用于其自身目的',
    'gc.li.6.4': '不基于儿童数据做出对其有重大影响的自动化决策',
    'gc.h2.7': '7. 已知不足（诚实披露）',
    'gc.li.7.1': '<b>无年龄门</b>：客户端不询问年龄，无法区分儿童与成人用户',
    'gc.li.7.2': '<b>开关默认开启</b>：监护人需主动关闭，而不是「默认不采集、主动开启」',
    'gc.li.7.3': '<b>无独立儿童数据删除通道</b>：与成人共用同一套流程',
    'gc.p.7.a': '这几项是我们当前能力的真实边界。在补齐之前，我们不建议 14 周岁以下用户在开启数据上报的状态下使用本客户端。',
  },
  en: {
    /* ══ Shared shell ══ */
    'gp.back': '← Back to More',
    'gp.nav.privacy': 'Game Privacy Policy',
    'gp.nav.children': "Children's Privacy",
    'gp.nav.collect': 'What We Collect',
    'gp.nav.third': 'Third-Party Sharing',
    'gp.auth': 'The Simplified Chinese version prevails; the English translation is for reference only.',

    /* ── Game privacy policy (gp.) ── */
    'gp.h1': '<b>Phira</b> Huamei Build · Privacy Policy',
    'gp.meta': 'Version v1.0 · Effective 2026-11-16 · Applies to Phira (Huamei build, 0.8.2-huamei series)',
    'gp.lead':
      '<b>In one sentence:</b> after each play, this client uploads <b>match result data</b> to '
      + '<code>phm.app.workbuddy.host</code> for chart difficulty research. This includes '
      + '<b>location (city level, about 1 km precision)</b> and <b>gyroscope summaries</b>, which are '
      + 'sensitive personal information. Both can be disabled with one switch at '
      + '<b>Settings → Account → Upload gameplay data</b>; once disabled, no match data is uploaded at all.',

    'gp.h2.1': '1. Who is the controller',
    'gp.t.1.a': 'Controller',
    'gp.t.1.b': 'huamei',
    'gp.t.1.c': 'Contact',
    'gp.t.1.d': 'Data location',
    'gp.t.1.e': 'Cloud database in Singapore (ap-southeast-1)',
    'gp.t.1.f': 'Scope',
    'gp.t.1.g': 'This client (Huamei build). <b>Does not apply</b> to the official Phira client',
    'gp.p.1.a':
      'This client is a third-party build of Phira, derived from the open-source project TeamFlos/phira. '
      + 'We have <b>no affiliation</b> with the Phira team (TeamFlos); they do not receive or process '
      + 'any data uploaded by this client.',

    'gp.h2.2': '2. What we collect',
    'gp.h3.2.1': '2.1 Match result data (uploaded once per play)',
    'gp.th.item': 'Item',
    'gp.th.what': 'Details',
    'gp.t.2.a1': 'Score',
    'gp.t.2.b1': 'Score, accuracy, max combo, counts of Perfect/Good/Bad/Miss',
    'gp.t.2.a2': 'Chart identity',
    'gp.t.2.b2': 'Chart ID, difficulty label, note count, chart content digest (SHA-256)',
    'gp.t.2.a3': 'Per-note judgements',
    'gp.t.2.b3': 'Judgement result and hit offset for each note (early/late in milliseconds)',
    'gp.t.2.a4': 'Hand feature',
    'gp.t.2.b4': 'Maximum simultaneous touch points in this play',
    'gp.t.2.a5': 'Touch positions',
    'gp.t.2.b5': '8×8 grid of tap heat distribution (64 normalised counts)',
    'gp.t.2.a6': 'Timing integrity',
    'gp.t.2.b6': 'Actual play time, chart duration, their ratio, pause count, stutter frames',
    'gp.t.2.a7': 'Device info',
    'gp.t.2.b7': 'OS version, model identifier (e.g. iPhone15,2), screen size and scale, actual render size',
    'gp.t.2.a8': 'Location',
    'gp.t.2.b8': 'Latitude and longitude, <b>rounded to 2 decimals (about 1 km)</b>',
    'gp.t.2.a9': 'Gyroscope summary',
    'gp.t.2.b9': 'Mean, standard deviation and peak of angular velocity (no raw samples)',
    'gp.t.2.a10': 'Game settings',
    'gp.t.2.b10': 'Chart speed, mods, keyboard mode flag',
    'gp.t.2.a11': 'Version info',
    'gp.t.2.b11': 'Client version, judgement format version, play timestamp',
    'gp.p.2.a':
      '<b>How location is handled:</b> we request 1000 m accuracy, and round the coordinate to 2 decimals '
      + '<b>before it is written to memory</b>. The precise coordinate never leaves the collection function, '
      + 'is never written to disk, and is never uploaded. If you deny the system location permission, '
      + 'the field stays empty and everything else is uploaded as usual.',
    'gp.p.2.b':
      '<b>How gyroscope data is handled:</b> only three statistics are uploaded. A 3-minute 60 Hz session '
      + 'is roughly 10,000 raw samples; we neither upload nor keep them.',
    'gp.h3.2.2': '2.2 What we explicitly do not collect',
    'gp.p.2.c': 'The following have no collection path in the code at all; you can verify against the source:',
    'gp.li.2.1': '<b>Device identifiers</b>: no IDFA, IDFV, UDID, MAC or serial number',
    'gp.li.2.2': 'Contacts, photo library, microphone, camera',
    'gp.li.2.3': '<b>Clipboard</b>: never read (we only write a username or error message when you tap "Copy", and never read it back for upload)',
    'gp.li.2.4': 'Precise location (raw GPS coordinates)',
    'gp.li.2.5': 'Your Phira password (we only read public endpoints and never accept passwords)',
    'gp.li.2.6': 'In-game chat content or friend list',
    'gp.li.2.7': 'Advertising identifiers; there is no ad SDK of any kind',
    'gp.h3.2.3': '2.3 Account (optional)',
    'gp.p.2.d':
      'If you sign in with a Huamei account (our own e-mail system), we store your e-mail, a password hash '
      + '(salted scrypt, never plaintext) and a random internal identifier. If you only sign in with a Phira '
      + 'account, we do not store your password; on each upload we forward the session token to the official '
      + 'Phira /me endpoint to verify identity, and take the Phira UID and username from the response. '
      + 'The token itself is never stored in the database.',
    'gp.p.2.e': '<b>Uploads also happen when you are not signed in</b>, recorded anonymously (not linkable to you).',
    'gp.h3.2.4': '2.4 Local diagnostic logs',
    'gp.p.2.f':
      'To help diagnose faults, the client writes <code>motion.log</code> (gyroscope diagnostics) and '
      + '<code>panic.log</code> (crash records) into the app sandbox, capped at 256 KB each with rotation. '
      + '<b>These files stay on your device and are never uploaded automatically.</b> You can view or delete '
      + 'them in the Files app under <code>On My iPad → phira-hm</code>.',

    'gp.h2.3': '3. What it is used for',
    'gp.th.use': 'Purpose',
    'gp.th.why': 'Details',
    'gp.t.3.a1': 'Chart difficulty research',
    'gp.t.3.b1': 'Infer chart difficulty from real player performance instead of subjective ratings',
    'gp.t.3.a2': 'Data quality analysis',
    'gp.t.3.b2': 'Decide which records are trustworthy (e.g. a play with many stutter frames is down-weighted)',
    'gp.t.3.a3': 'Troubleshooting',
    'gp.t.3.b3': 'Locate collection failures (e.g. a model that yields no gyroscope data)',
    'gp.p.3.a':
      'What we do not do: no user profiling, no ad targeting, no marketing messages; we never sell your data '
      + 'to any third party; we never use it for analysis unrelated to chart difficulty.',

    'gp.h2.4': '4. Third-party sharing',
    'gp.p.4.a': 'See the <a href="/privacy-game/third-party">third-party sharing list</a> for the full detail. Summary:',
    'gp.th.third': 'Third party',
    'gp.th.share': 'What is shared',
    'gp.th.purpose': 'Purpose',
    'gp.t.4.a1': 'Official Phira API',
    'gp.t.4.b1': 'Session token, only when you are signed in to Phira',
    'gp.t.4.c1': 'Identity verification, chart download',
    'gp.t.4.a2': 'Cloud hosting and database',
    'gp.t.4.b2': 'All uploaded data (storage)',
    'gp.t.4.c2': 'Data storage',
    'gp.t.4.a3': 'Chart CDN',
    'gp.t.4.b3': 'No personal data',
    'gp.t.4.c3': 'Chart file download',

    'gp.h2.5': '5. How long we keep it',
    'gp.t.5.a1': 'Match data',
    'gp.t.5.b1': 'Kept long-term for difficulty research (there is currently no automatic deletion)',
    'gp.t.5.a2': 'Account information',
    'gp.t.5.b2': 'Until you delete your account',
    'gp.t.5.a3': 'Local logs',
    'gp.t.5.b3': 'Only on your device, overwritten at 256 KB; we cannot access them',

    'gp.h2.6': '6. Your rights',
    'gp.h3.6.1': '6.1 Turn off data upload (the most direct way)',
    'gp.p.6.a':
      '<b>Settings → Account → Upload gameplay data</b> (internally <code>telemetry_enabled</code>). '
      + 'Once off, the result screen no longer starts an upload and <b>shows no "uploading" indicator</b> — '
      + 'that is deliberate, so you can see the switch really took effect. The switch sits at the very top of '
      + 'the account page, above the four documents, precisely so it is easy to find.',
    'gp.p.6.b': '<b>The switch defaults to on.</b> We are evaluating asking for consent on first launch (see section 9).',
    'gp.h3.6.2': '6.2 Deleting your account',
    'gp.p.6.c':
      'You can delete your Huamei account in the client, which removes the account, profile and unused '
      + 'verification codes. <b>Deletion does not remove</b> match data already uploaded — that data was '
      + 'anonymous or carried only a random internal identifier, so it can no longer be traced back to your '
      + 'e-mail. If you want match data removed, contact us via section 1 with the chart ID and time range; '
      + 'we will do our best to locate it (if it was uploaded anonymously, this is technically impossible).',
    'gp.h3.6.3': '6.3 Other rights',
    'gp.p.6.d':
      'Under the Personal Information Protection Law you may access, copy, correct, supplement and delete your '
      + 'personal information, and withdraw consent. Contact us via section 1; we reply within 15 working days.',

    'gp.h2.7': '7. Location and gyroscope in detail',
    'gp.p.7.a': 'Both are sensitive personal information under the Personal Information Protection Law, so they are described separately.',
    'gp.h3.7.1': 'Location',
    'gp.li.7.1': 'Purpose: analyse the device and network conditions of players in different regions',
    'gp.li.7.2': 'Precision: about 1 km (rounded to 2 decimals)',
    'gp.li.7.3': 'Necessity: <b>not required</b>; the game works fully if you decline',
    'gp.li.7.4': 'How it is authorised: iOS system prompt (while using the app)',
    'gp.li.7.5': 'How to withdraw: iOS Settings → Privacy & Security → Location Services → Phira',
    'gp.h3.7.2': 'Gyroscope',
    'gp.li.7.6': 'Purpose: analyse the relationship between hand tremor and judgement offset',
    'gp.li.7.7': 'Content: three statistics only, no raw samples',
    'gp.li.7.8': 'Necessity: <b>not required</b>; the game works fully if you decline',
    'gp.li.7.9': 'How to withdraw: turned off together with the master switch in 6.1',

    'gp.h2.8': '8. Minors',
    'gp.p.8.a':
      'This client is not offered to children under 14 on a standalone basis. If you are a minor, please read '
      + 'this policy with your guardian and use the client with their consent. See the '
      + '<a href="/privacy-game/children">Children\'s Privacy Policy</a> for details.',

    'gp.h2.9': '9. Known gaps (disclosed honestly)',
    'gp.p.9.a': 'The following issues are known and unresolved. We state them here rather than hide them:',
    'gp.li.9.1': '<b>The upload switch defaults to on</b> — location is sensitive personal information, so asking separately on first launch would be the right design. Currently it is on by default and can be turned off at any time; we are evaluating a change.',
    'gp.li.9.2': '<b>No deletion mechanism for match data</b> — see section 5.',
    'gp.li.9.3': '<b>No age gate</b> — there is no age verification; we rely on guardians to manage it.',

    'gp.h2.10': '10. Changes to this policy',
    'gp.p.10.a': 'When the policy changes we update the version and effective date on this page. Any change that widens the scope of collection will be prominently announced in the client.',
    'gp.foot': 'This document maps item by item to the client collection code. Changing the collection code requires updating this page, otherwise the disclosure becomes false.',

    /* ── Children's privacy (gc.) ── */
    'gc.h1': "Children's Personal Information Protection Rules",
    'gc.meta': 'Version v1.0 · Effective 2026-11-16 · Applies to users under 14 using this client',
    'gc.lead':
      '<b>In one sentence:</b> this client is <b>not offered to children under 14 on a standalone basis</b>. '
      + 'If you are under 14, please read these rules with your parent or guardian and use the client only '
      + 'with their consent.',
    'gc.h2.1': '1. Do we collect children\'s information?',
    'gc.p.1.a':
      '<b>Yes, subject to the device permissions granted by the guardian.</b> This must be stated plainly: the '
      + 'client has no age verification and cannot tell a user\'s age. So as long as the device is in use, match '
      + 'data (including location and gyroscope summaries) will be uploaded under the rules described in the '
      + '<a href="/privacy-game">Game Privacy Policy</a>.',
    'gc.p.1.b': 'We do not collect more because you are a child, nor less than from an adult — we cannot technically distinguish them. That is the real boundary of the current implementation.',
    'gc.h2.2': '2. What is collected',
    'gc.p.2.a': 'The same as for adults; see the <a href="/privacy-game/collect">collection list</a> item by item. Key items:',
    'gc.th.item': 'Item',
    'gc.th.note': 'Notes for children',
    'gc.t.2.a1': 'Per-note judgements',
    'gc.t.2.b1': 'No identity information; only note judgement results',
    'gc.t.2.a2': 'Location (about 1 km)',
    'gc.t.2.b2': '<b>Sensitive.</b> Guardians should decide explicitly whether to allow the system location permission',
    'gc.t.2.a3': 'Gyroscope summary',
    'gc.t.2.b3': 'Three statistics, no raw samples',
    'gc.t.2.a4': 'Device model',
    'gc.t.2.b4': 'Used to analyse the relationship between model and judgement',
    'gc.p.2.b': '<b>Not collected</b>: name, avatar, birthday, school, address, contacts, photo library, any device identifier.',
    'gc.h2.3': '3. How guardians can stop the upload',
    'gc.h3.3.1': 'Option 1: turn off the upload switch (recommended)',
    'gc.p.3.a': '<code>Settings → Account → Upload gameplay data</code> → off. No upload is started; the setting takes effect immediately and needs no network.',
    'gc.h3.3.2': 'Option 2: deny the system location permission',
    'gc.p.3.b': 'iOS asks for location permission on first launch; choose "Don\'t Allow". You can revoke it at any time in <code>iOS Settings → Privacy & Security → Location Services</code>.',
    'gc.h3.3.3': 'Option 3: do not use this client',
    'gc.p.3.c': 'This is a third-party build; the official Phira client does not contain our upload logic.',
    'gc.h2.4': '4. How we protect children\'s information',
    'gc.th.measure': 'Measure',
    'gc.th.how': 'How',
    'gc.t.4.a1': 'Minimisation',
    'gc.t.4.b1': 'No names, precise coordinates or device identifiers',
    'gc.t.4.a2': 'Precision reduction',
    'gc.t.4.b2': 'Location rounded to about 1 km',
    'gc.t.4.a3': 'Encryption in transit',
    'gc.t.4.b3': 'HTTPS across the site',
    'gc.t.4.a4': 'Access control',
    'gc.t.4.b4': 'The database has no anonymous public read access; only the server credential can write',
    'gc.t.4.a5': 'No profiling',
    'gc.t.4.b5': 'No recommendation, advertising or profiling using children\'s data',
    'gc.p.4.a':
      '<b>Honest note</b>: this client is an individual developer project and does not have a compliance regime '
      + 'built specifically for children (such as isolated storage for children\'s data or a dedicated deletion '
      + 'channel). If your child uses this client, we recommend simply turning the upload switch off.',
    'gc.h2.5': '5. Guardians\' rights',
    'gc.p.5.a':
      'Using the contact details in section 1 of the <a href="/privacy-game">Game Privacy Policy</a>, guardians may: '
      + 'ask whether we hold a given record, request deletion (anonymous data cannot be located; please provide the '
      + 'chart ID and approximate time), or ask us to stop processing. We reply within 15 working days.',
    'gc.h2.6': '6. What we do not do',
    'gc.li.6.1': 'We do not send children any marketing content',
    'gc.li.6.2': 'We do not use children\'s data for ad targeting',
    'gc.li.6.3': 'We do not give children\'s data to any third party for its own purposes',
    'gc.li.6.4': 'We do not make automated decisions with significant effects on children based on their data',
    'gc.h2.7': '7. Known gaps (disclosed honestly)',
    'gc.li.7.1': '<b>No age gate</b>: the client does not ask for age and cannot distinguish children from adults',
    'gc.li.7.2': '<b>The switch defaults to on</b>: guardians must turn it off, rather than it being off by default and turned on actively',
    'gc.li.7.3': '<b>No dedicated deletion channel for children\'s data</b>: the same process as for adults',
    'gc.p.7.a': 'These are the real boundaries of our current capability. Until they are addressed, we do not recommend that users under 14 use this client with data upload enabled.',
  },
};
