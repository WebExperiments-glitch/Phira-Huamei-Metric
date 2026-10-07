/* ============================================================
 * js/i18n/app.js —— 分析工作台词条（app.*）
 * ============================================================
 * 对应页面：public/app.html（拖入谱面包 → 双标度定数参考）。
 * ⚠ 术语不硬译：Phira / Phigros / RKS / ACC / B19 / P.H.M. / .pez / .zip /
 *   p99 / k-NN 保持原样。
 * ⚠ 本页动态内容占多数：JS 渲染的文案一律走 t()，并在 onLangChange 里重绘。
 * ============================================================ */
export default {
  zh: {
    /* ── 页头：标语 + 顶部搜索 ── */
    'app.head.slogan':
      '拖入谱面包 → 得到<b>双标度定数参考</b>（社区共识 + 官谱标度）。<br>'
      + '<b>无需登录 · 谱面文件不会上传</b> · 解析全在你的浏览器里完成。',
    'app.head.search.ph': '搜谱面：曲名 / 谱师',
    'app.head.search.btn': '搜索',
    'app.head.search.title': '搜索 Phira 谱面',

    /* ── P.H.M. 账号面板 ── */
    'app.auth.title': 'P.H.M. 账号',
    'app.auth.collapse': '收起',
    'app.auth.guest.desc':
      '登录后可以<b>绑定 Phira 账号</b>、留下属于你的记录。不登录也能用全部功能'
      + '（拖谱面、搜谱面、算 RKS）。<br>'
      + '<span style="color:var(--fg3)">Web 端仅支持<b>邮箱</b>登录（手机短信登录只在小程序里提供）。</span>',
    'app.auth.tab.login': '登录',
    'app.auth.tab.signup': '注册',
    'app.auth.tab.reset': '找回密码',

    'app.auth.email': '邮箱',
    'app.auth.pw': '密码',
    'app.auth.pw.set': '设置密码',
    'app.auth.pw.new': '新密码',
    'app.auth.pw.ph': '至少 10 位，建议字母+数字',
    'app.auth.pw.login.ph': '你的密码',
    'app.auth.code': '邮箱验证码',
    'app.auth.code.ph': '收到的数字',
    'app.auth.send': '获取验证码',
    'app.auth.submit.login': '登录',
    'app.auth.submit.signup': '注册',
    'app.auth.submit.reset': '重置密码',

    'app.auth.signout': '退出登录',
    'app.auth.chpw': '修改密码',
    'app.auth.chpw.go': '确认修改',
    'app.auth.old': '当前密码',
    'app.auth.new': '新密码',
    'app.auth.meta': '{email} · 账号 ID {id}',

    'app.auth.loggedin': '已登录',
    'app.auth.loggedin.email': '已登录：{email}',
    'app.auth.err.email': '请先填一个正确的邮箱',
    'app.auth.sending': '正在发送验证码…',
    'app.auth.send.fail': '发送失败：{e}',
    'app.auth.send.ok': '验证码已发到 {email}，去收件箱看看（含垃圾箱）',
    'app.auth.need.email': '请填邮箱',
    'app.auth.working': '处理中…',
    'app.auth.login.fail': '登录失败：邮箱或密码不对',
    'app.auth.need.send': '请先点「获取验证码」',
    'app.auth.need.code': '请填邮箱里收到的验证码',
    'app.auth.verify.fail': '验证失败：{e}',
    'app.auth.existing': '该邮箱已注册，已直接为你登录',
    'app.auth.reset.sent': '重置验证码已发送 —— 填验证码和新密码，再点一次「重置密码」',
    'app.auth.reset.needcode': '请填收到的重置验证码',
    'app.auth.reset.fail': '重置失败：{e}',
    'app.auth.reset.done': '密码已重置，已为你登录',
    'app.auth.fail': '失败：{e}',
    'app.auth.err.retry': '请稍后再试',
    'app.auth.chpw.need': '请填当前密码和新密码',
    'app.auth.chpw.fail': '修改失败：{e}',
    'app.auth.chpw.badold': '当前密码不对',
    'app.auth.chpw.ok': '密码已修改',
    'app.auth.code.wrong': '验证码不对或已过期',
    'app.auth.code.wrong2': '验证码不对',

    'app.auth.bind.bound': '已绑定 Phira：<b>{name}</b> #{uid}',
    'app.auth.bind.unbind': '解除绑定',
    'app.auth.bind.found': '还没绑定。刚查到的 Phira 账号：<b>{name}</b> #{uid}',
    'app.auth.bind.go': '绑定这个 Phira 账号',
    'app.auth.bind.none':
      '还没有绑定 Phira 账号。<br>先去<b>「玩家」</b>页查一次你自己的账号（输用户名或 UID），再回来绑定。',
    'app.auth.bind.needlogin': '请先登录',
    'app.auth.bind.needlookup': '先去「玩家」页查一次你自己的 Phira 账号，再回来绑定',
    'app.auth.bind.fail': '绑定失败：{e}',
    'app.auth.bind.done': '已绑定 Phira：<b>{name}</b> #{uid}',
    'app.auth.unbind.fail': '解绑失败：{e}',
    'app.auth.unbind.done': '已解除 Phira 绑定',
    'app.auth.signout.done': '已退出登录',

    /* ── 密码强度（只在「设置新密码」时用）── */
    'app.pw.short': '密码至少 10 位（6 位密码离线破解只要几分钟）',
    'app.pw.digits': '纯数字密码太弱 —— 建议字母 + 数字混着来',
    'app.pw.lower': '纯小写字母还是偏弱 —— 加个数字或大写字母吧',

    /* ── 拖入区 ── */
    'app.drop.big': '把 Phira 谱面包拖到这里',
    'app.drop.or': '或点击选择文件 · 支持 .pez / .zip · 可一次多个',
    'app.drop.what':
      '<b>谱面包是什么？</b>就是 Phira 里下载的谱面文件（<code>.pez</code>），'
      + '或者解压后含 <code>chart.json</code> 的 <code>.zip</code>。'
      + '在 Phira 的谱面详情里点下载，或从别人分享的网盘拿到 —— '
      + '<b>拖进来就会自动解析，文件不会上传</b>。<br>'
      + '懒得下载？直接用上面的<b>搜索</b>框按曲名找，点「算」即可。',

    /* ── 第二层入口（morebar）── */
    'app.more.user': '我的成绩',
    'app.more.user.title': '读取 Phira 公开资料与成绩（只读，不需要也不接受密码）',
    'app.more.user.hint': 'B19 / 单曲 RKS / 最近游玩 · 现在有独立页面了',
    'app.more.charter': '找谱师',
    'app.more.charter.title': '查某位谱师的全部作品',
    'app.more.charter.hint': '按谱师看作品与定数',
    'app.more.auth.title': 'P.H.M. 账号（可选）：登录后可绑定 Phira、留下自己的记录',
    'app.more.auth.hint': '可选',
    'app.more.gh.title': 'GitHub 仓库 · Phira-Huamei-Metric',

    /* ── 页脚 ── */
    'app.foot.engine':
      '线上引擎：<b>8 维 log1p 特征</b>（NPS / 有效 NPS / 物量 / 加权密度 p99 / '
      + '音符间隔 / 高密度均值 / 密集度 / 交叉手） + 双参照 k-NN（<b>9,508 张社区谱</b> '
      + '为主结果，1,037 张官谱为对照标度）',
    'app.foot.ver': '版本 {v}（开发者测试版，正式版会重新计算）',
    'app.foot.source': '源码',
    'app.foot.details': 'PS 是什么？本工具的边界与隐私（点开看）',
    'app.foot.d1':
      '<b>三个数不是一回事，别混用</b>：<br>'
      + '· <b>参考定数（社区共识）</b>—— 9,508 张 Phira 社区谱里结构最相近的 20 张，'
      + '它们的定数中位。这是<b>谱师实际定价的共识</b>，也是最贴近你在 Phira 上看到的那个数字。<br>'
      + '· <b>官谱标度</b>—— 同样算法，但参照集换成 1,037 张 Phigros 官谱，是与官方一致的绝对标度。<br>'
      + '· <b>PS</b> —— 本工具自己的负荷标度（0–20），衡量操作与读取负荷，<b>与上面两个都不同标度</b>。',
    'app.foot.d2':
      '<b>两个标度差得多，说明什么？</b>官谱与社区谱<b>结构分布本来就不同</b>'
      + '（社区谱定数中位 15.1，官谱 10.6；社区谱的长条占比只有官谱的 1/3、拖键是 5 倍）。'
      + '所以同一张谱在两个标度上差 2~3 级是正常的 —— 那是<b>两个尺子的差异，不是某个尺子算错了</b>。'
      + '只印一个数字才会出问题：「我的 IN 14 被算成 11.6」就是这么来的。',
    'app.foot.d3':
      '<b>PS</b> 由四个负荷组加权合成：'
      + '<span class="mono">PS = 20 × (0.40·密度 + 0.30·结构 + 0.15·协调 + 0.15·持续)</span>，'
      + '每个维度经饱和函数归一，每一分都能追溯到卡片上的明细。',
    'app.foot.d4':
      '<b>PS 与官方定数无关</b> —— 官方定数是人工标注（实测标注噪声约 2.80 级），'
      + '两者不构成互相验证。<b>本工具不判定「虚标」</b>：在这个噪声水平下，'
      + '没有任何工具能仅凭结构区分「谱师标错」和「官方也会这么标」。',
    'app.foot.d5':
      '<b>参考定数</b>是 20 张最相似参照谱的<b>定数中位</b>，不是拟合出来的预测值 —— '
      + '逐张可以点开看名字，拿回 Phira 自己核对。它在参照集里没有紧密对应物时会偏移，'
      + '所以卡片上同时给出<b>不确定范围</b>（这 20 张的定数跨度）与<b>平均邻居距离</b>，'
      + '跨度大就说明结论软。<br>'
      + '留出验证（1,367 张社区谱，参照集 8,141 张）：<b>|偏差| 均值 0.820 · ≤1.0 命中 84.2%</b>，'
      + '旧版（官谱 4 维）是 1.187 / 67.0%。',
    'app.foot.d6':
      '<b>隐私 · 什么会上传</b>（统一受页面底部「⚙ 设置」的开关控制）：<br>'
      + '· <b>算 RKS</b>：本机计算。勾选「匿名上传」才写 曲名 / 定数 / ACC 三项 '
      + '—— 准确说是<b>假名化</b>贡献（带一个随机 client_id），不是严格匿名。<br>'
      + '· <b>查询 Phira 账号</b>：只对<b>你确认过的本人账号</b>自动上传成绩（含 Phira UID 与用户名，'
      + 'Phira 站内本来就公开）。首次遇到某个 UID 会先问一次「这是你的账号吗」。<br>'
      + '· <b>拖入谱面</b>：只有<b>谱面结构特征</b>进入共享定数缓存，<b>谱面文件本身不会上传</b>。<br>'
      + '<b>关闭底部开关后，以上三条都不会发生</b>（页面仍会请求聚合统计数字用于显示统计条，不含个人信息）。',
    'app.foot.d7':
      '连 Phira 只读公开资料（RKS、最好成绩），<b>不需要也不接受密码</b>；'
      + '输入过的用户名 / UID 只存在你浏览器本地（localStorage）用于下次自动填充，不会随请求发出。',
    'app.foot.set': '⚙ 快速设置',
    'app.foot.setall': '全部设置 →',
    'app.foot.setdlg.label':
      '登录 Phira 后<b>自动上传</b>成绩数据 —— 用于校准定数参考',
    'app.foot.setdlg.note':
      '关闭后<b>不会上传任何贡献内容</b>（谱面结构特征、成绩数据）—— '
      + '拖谱面、算 RKS、搜谱面全部照常。<br>'
      + '<span style="color:var(--fg3)">页面仍会请求本站的聚合统计数字用于显示统计条，不含任何个人信息。</span><br>'
      + '上传内容：Phira UID 与用户名、谱面名、定数、ACC、单曲 RKS。<b>不会上传</b>密码 / 邮箱 / 谱面文件本身。<br>'
      + '只对<b>你确认过的本人账号</b>自动上传成绩（查询时会问一次）。对外的统计只有聚合数字，'
      + '其他人看不到你的 UID 或用户名。',

    /* ── 通用错误 / 状态 ── */
    'app.ver.beta': '{v} · 开发者测试版',
    'app.msg.parsing': '解析中…',
    'app.err.toobig': '文件过大：{mb} MB，超过 {max} MB 上限（已跳过，避免打爆页面内存）',
    'app.err.none': '没有可解析的谱面',
    'app.err.script': '⚠ 脚本错误：{e} —— 部分功能可能不可用，刷新可恢复',
    'app.err.async': '⚠ 异步错误：{e}',
    'app.err.netperm': '网络或权限问题',
    'app.err.unknown': '未知',
    'app.err.net': '网络异常',
    'app.err.phira.api': 'Phira API 不可用',
    'app.err.op': '操作失败：{e}',
    'app.err.timeout': '请求超时（{s}s）',

    /* ── 共享缓存贡献 ── */
    'app.contrib.many': '多',
    'app.contrib.ambiguous':
      'ℹ 《{name}》已在本机分析完成，但 Phira 上有 <b>{n}</b> 个同名谱面（不同难度）—— '
      + '<b>无法确定是哪一个，未写入共享缓存</b>。<br>'
      + '<span style="color:var(--fg3)">写错会把别的难度的定数记到它头上，所以宁可空着。</span>',
    'app.contrib.ok':
      '✅ 《{name}》的结构定数已存入<b>共享定数缓存</b> —— '
      + '下一个人搜到这张谱直接就能看到，不用再下载。<br>'
      + '<span style="color:var(--fg3)">只写入谱面结构特征（密度/长条/物量等），'
      + '你的谱面文件本身没有上传。可在页面底部「⚙ 设置」里关闭。</span>',

    /* ── 下载 ── */
    'app.dl.nofile': '这张谱面没有可下载的文件（可能已下架）',
    'app.dl.badurl': '谱面文件地址异常（非 http/https），已拦截',
    'app.dl.downloading':
      '正在下载《{name}》 —— 下完后把 zip <b>拖到下面的虚线框</b>，'
      + '本页会自动算出定数，并顺带存进共享缓存。',
    'app.dl.title': '下载谱面包 zip',
    'app.dl.short': '下载',

    /* ── 结果卡片 ── */
    'app.res.g.density': '密度负荷',
    'app.res.g.pattern': '结构负荷',
    'app.res.g.coord': '协调负荷',
    'app.res.g.stamina': '持续负荷',
    'app.res.basis.com': '社区共识',
    'app.res.basis.off': '官谱标度',
    'app.res.desc.com': 'Phira 社区谱',
    'app.res.desc.off': 'Phigros 官谱',
    'app.res.u': '{basis} · {desc} {pool} 张中结构最相近 {n} 张',
    'app.res.u.span': '不确定范围 <b>{lo}–{hi}</b>',
    'app.res.off.note': '与 Phigros 官方同一标度（{n} 张官谱）',
    'app.res.off.hi': '　·　社区共识比它高 {d}',
    'app.res.off.lo': '　·　社区共识比它低 {d}',
    'app.res.vague':
      '⚠ 这 {n} 张参照谱的定数横跨 <b>{lo}–{hi}</b>（相差 {span}）—— 说明这张谱的结构'
      + '在{desc}里<b>没有紧密对应物</b>，中点只能当粗略参照。<br>'
      + '<b>这种时候该看什么：</b>'
      + '① 看它更靠近范围的两端哪一头（说明它偏向同类里偏难还是偏易的那批）；'
      + '② 点开下面的「最相近 5 张」自己核对名字 —— 如果你觉得哪张根本不像，那这个数就不该信；'
      + '③ 换一个标度看另一栏（社区共识与官谱标度往往一宽一窄）。',
    'app.res.share.label': '分享这张谱',
    'app.res.share.wide': '横版图 · QQ / B站 / X',
    'app.res.share.tall': '竖版图 · 抖音',
    'app.res.near': '{desc}参照（最相近 5 张）',
    'app.res.th.const': '定数',
    'app.res.psline':
      'PS 负荷标度 <b>{total}</b> / 20（密度 {d} · 结构 {p} · 协调 {c} · 持续 {s}）'
      + '—— 衡量操作与读取负荷，与官方定数无关',
    'app.res.punch.title': '算单曲 RKS',
    'app.res.punch.opt': '（可选：匿名贡献数据）',
    'app.res.punch.desc':
      '填你这把的<b>准度 ACC</b>（成绩页右上角的 %），'
      + '立刻算出这张图的<b>单曲 RKS</b> —— <b>全部在本机计算</b>。',
    'app.res.punch.ph': '如 96.50',
    'app.res.punch.go': '算 RKS',
    'app.res.punch.label':
      '顺便<b>匿名上传</b>这条成绩，帮我们校准定数（只存曲名、定数、ACC 三项，'
      + '不含账号 / 昵称 / 分数记录）。<b>不勾也能照常算 RKS。</b>',
    'app.res.r.notes': '真实物量',
    'app.res.r.notes.fake': '（含假键 {n}）',
    'app.res.r.dur': '时长',
    'app.res.r.bpm': 'BPM',
    'app.res.r.lines': '判定线',
    'app.res.r.density': '总密度',
    'app.res.r.eff': '有效密度 均值/峰值',
    'app.res.r.strain': '加权密度 p50 / p99',
    'app.res.r.iv': '音符间隔 中位',
    'app.res.r.hold': '长条占比',
    'app.res.r.stair': '纵连峰值',
    'app.res.r.cross': '交叉手',
    'app.res.r.multi': '三押以上',
    'app.res.r.multi.v': '{n} 次',
    'app.res.r.charter': '谱师',

    /* ── 分享图导出 ── */
    'app.sh.noconst': '这张谱还没有定数，先点左边的「算」',
    'app.sh.saved': '✅ 分享图已保存（{mode}）。图上带着域名 —— 别人照着搜就能找到本站。',
    'app.sh.fail': '导出分享图失败：{e}',
    'app.sh.unparsed': '这张谱没解析成功，导不出分享图',
    'app.sh.working': '生成中…',
    'app.sh.mode.wide': '横版',
    'app.sh.mode.tall': '竖版',

    /* ── 设置面板开关 ── */
    'app.set.auto.on':
      '✅ 已开启自动上传 —— 查询<b>你确认过的本人账号</b>时，会自动贡献成绩数据帮定数变准。',
    'app.set.auto.off':
      '已关闭自动上传 —— 之后<b>不会上传任何贡献内容</b>（谱面结构特征 / 成绩数据）。拖谱面、算 RKS 照常。',

    /* ── 单曲 RKS ── */
    'app.punch.on': '已开启匿名上传 —— 之后每次算 RKS 会顺便上传这条成绩。',
    'app.punch.off': '已关闭上传 —— 只在本机计算，什么都不会发出。',
    'app.punch.preview': '单曲 RKS 预览 ≈ <b>{r}</b>',
    'app.punch.lowacc': '　<span style="color:var(--red)">ACC&lt;70 不计入 RKS</span>',
    'app.punch.needacc': '⚠ 请填准度 ACC（0–100 的数字，如 96.50，成绩页右上角那个 %）',
    'app.punch.result': '单曲 RKS ≈ <b>{r}</b>（ACC {acc}{ref}）',
    'app.punch.ref': '，参考定数 {c}',
    'app.punch.noupload': '（未勾选上传 —— 本条只在你本机计算，没有发出任何数据）',
    'app.punch.nocloud': '云服务未连上，这条没能上传（RKS 已在本机算出）',
    'app.punch.uploading': '正在匿名上传…',
    'app.punch.uploaded': '已匿名上传，感谢帮我们校准定数',
    'app.punch.upfail': '上传失败：{e}',
    'app.punch.ratelimited': '服务器繁忙（限流），稍后再试',
    'app.err.serverwrite': '服务端未写入',

    /* ── 数据飞轮计数 ── */
    'app.count.some': '数据飞轮：已收到 <b>{n}</b> 条成绩数据 —— 每一条都在帮定数公式变准',
    'app.count.zero': '数据飞轮已就绪 —— 还没有人贡献数据；拖入谱面 → 拉到底部填 ACC，你就是第一条',

    /* ── 谱面搜索 ── */
    'app.srch.needkw': '先填搜索关键词（曲名或谱师）',
    'app.srch.searching': '正在搜索「{q}」…',
    'app.srch.none': '没搜到「{q}」—— 换个关键词，或把谱面包<b>拖到下面的虚线框</b>用本页引擎直接分析',
    'app.srch.fail':
      '搜索失败：{e}<br>Phira 搜索接口偶尔超时或限流，已自动重试过一次。'
      + '可以再点一次「搜索」；或者点下面的虚线框选本地谱面包 —— <b>本机解析不联网也能出定数</b>。',
    'app.srch.found': '找到 <b>{n}</b> 张',
    'app.srch.filtered': '（已滤掉名称不含「{q}」的结果）',
    'app.srch.hint': '点「算」= 服务端下载这张谱并计算，直接出定数（约 2-5 秒）',
    'app.srch.ranked': '上架',
    'app.srch.unranked': '未上架',
    'app.srch.cachedconst': 'P.H.M. 结构定数（来自共享缓存）',
    'app.srch.sh.wide': '横',
    'app.srch.sh.tall': '竖',
    'app.srch.sh.wide.title': '导出横版分享图（QQ / B站 / X）',
    'app.srch.sh.tall.title': '导出竖版分享图（抖音 / 小红书）',
    'app.srch.calc': '算',
    'app.srch.calc.title': '由服务端下载这张谱并计算定数（约 2-5 秒）',
    'app.srch.dl.title': '手动下载谱面包（下完拖到下面虚线框，用本机引擎算）',
    'app.srch.foot':
      '「算」由<b>服务端</b>完成：浏览器拿不到谱面文件（Phira 的文件 CDN 没开放跨域），'
      + '但服务端不受这个限制，而且用的是与本页面<b>完全相同的那份引擎</b>。'
      + '算完直接存进共享缓存，别人再搜同一张就秒出。<br>'
      + '也可以点 <b>下载</b> 手动下载，把 zip 拖到下面的虚线框 —— '
      + '那才是<b>本机计算</b>路径（谱面文件不会上传）。',

    /* ── 一键算定数 / 下载计算 ── */
    'app.calc.doing': '算…',
    'app.calc.waiting': '正在让服务端下载这张谱并计算定数…（通常 2-5 秒）',
    'app.calc.done': '✅ 《{name}》 → P.H.M. 定数 <b>{rc}</b>',
    'app.calc.ps': ' · PS 负荷 {v}',
    'app.calc.cached': ' ·（来自共享缓存）',
    'app.calc.nowrite': ' · 由服务端计算（⚠ 但这次没能写进共享缓存）',
    'app.calc.written': ' · 由服务端计算并已存入共享缓存',
    'app.calc.fail':
      '算定数失败：{e}<br>可以改用右边的 <b>下载</b> 手动下载，'
      + '再把 zip 拖到下面虚线框用本机引擎算。',
    'app.chart.anon': '谱面',
    'app.chart.id': '谱面 #{id}',
    'app.calc.nochartfile': '⚠ 《{name}》没有可下载的文件（可能已下架）',
    'app.calc.dling': '下载中…',
    'app.calc.dling2': '正在下载《{name}》…',
    'app.calc.toobig': '谱面包过大（{mb} MB，超过 {max} MB 上限），已跳过',
    'app.calc.toobig2': '谱面包过大，已跳过',
    'app.calc.dled': '已下载 {mb} MB，正在解析…',
    'app.calc.parsefail': '解析失败（非 RPE / PGR 格式）',
    'app.calc.badid': '谱号异常',
    'app.calc.writefail': '⚠ 定数已算出，但共享缓存写入未成功',
    'app.calc.writefail2': '⚠ 定数已算出，但共享缓存写入失败：{e}',
    'app.calc.done2': '✅ 《{name}》 → P.H.M. 定数 <b>{rc}</b>',
    'app.calc.apnote': '（AP 时单曲 rks 就等于这个数）',
    'app.calc.stored': ' · 已存入共享缓存',
    'app.calc.corsfail':
      '⚠ <b>浏览器无法直接读取谱面文件</b> —— Phira 的文件 CDN'
      + '（<span class="mono">phira-cdn.5wyxi.com</span>）没有开放跨域，'
      + '这是 Phira 服务端的限制，网页端绕不过去。<br>'
      + '请点表格里的 <b>下载</b> 拿到《{name}》的 zip，'
      + '然后<b>拖到下面那个虚线框</b> —— 本页引擎会立刻算出 P.H.M. 定数（同一条流水线）。'
      + '<br><span style="color:var(--fg3)">技术细节：{e}</span>',

    /* ── 玩家成绩统计（卡片内）── */
    'app.playstat':
      '<b>{n}</b> 条玩家成绩（来自数据飞轮）· 平均 ACC <b>{avg}%</b> · 中位 {med}% · 范围 {min}%~{max}%',
    'app.playstat.oc': ' · 库中定数 {v}',

    /* ── 公开统计条 ── */
    'app.stats.head': '本站公开数据：',
    'app.stats.profiles': '账号 <b>{n}</b> 个',
    'app.stats.active': '7 日活跃 <b>{n}</b>',
    'app.stats.bound': '已绑定 Phira <b>{n}</b>',
    'app.stats.scores': '成绩数据 <b>{n}</b> 条',
    'app.stats.charts': '定数缓存 <b>{n}</b> 张',
    'app.stats.thin':
      '<br>⚠ 样本量还小（成绩 {n} 条）：'
      + '<b>玩家表现统计（平均 / 中位）波动大，仅供参考</b>。多导入几条成绩就是在帮它变准。',

    /* ── 首次上传前的告知（confirm 弹窗）── */
    'app.notice.body':
      'P.H.M. 会在下面两种情况下自动上传数据，用于校准难度参考：\n\n'
      + '  · 你查询 Phira 账号并已声明为本人 → 上传成绩\n'
      + '    （你的 UID 与用户名、谱面名、标称定数、你的 ACC 与单曲 RKS）\n'
      + '  · 你拖入谱面 → 上传该谱面的结构特征（一串算出来的数字）\n\n'
      + '不会上传：\n'
      + '  - 密码、邮箱、账号权限\n'
      + '  - 谱面文件本身（解析全部在你本机完成）\n\n'
      + '用途：统计各谱的实际难度分布、改进定数参考。对外的只有聚合数字，\n'
      + '      其他人看不到你的 UID 或用户名。\n'
      + '不想上传：选「取消」，自动上传会被关掉，功能照常用。\n'
      + '      之后也可以随时在「设置」页重新打开。\n\n'
      + '详见《隐私政策》。是否同意？',
  },

  en: {
    /* ── header: slogan + top search ── */
    'app.head.slogan':
      'Drop a chart pack in → get <b>both difficulty scales</b> (community consensus + official scale).<br>'
      + '<b>No sign-in · chart files are never uploaded</b> · parsing runs entirely in your browser.',
    'app.head.search.ph': 'Search charts: song / charter',
    'app.head.search.btn': 'Search',
    'app.head.search.title': 'Search Phira charts',

    /* ── P.H.M. account panel ── */
    'app.auth.title': 'P.H.M. account',
    'app.auth.collapse': 'Collapse',
    'app.auth.guest.desc':
      'Signing in lets you <b>link a Phira account</b> and keep your own records. Every feature works '
      + 'signed out too (drop a chart, search charts, compute RKS).<br>'
      + '<span style="color:var(--fg3)">The web build supports <b>email</b> sign-in only '
      + '(SMS login is available in the mini-program).</span>',
    'app.auth.tab.login': 'Sign in',
    'app.auth.tab.signup': 'Sign up',
    'app.auth.tab.reset': 'Reset password',

    'app.auth.email': 'Email',
    'app.auth.pw': 'Password',
    'app.auth.pw.set': 'Set a password',
    'app.auth.pw.new': 'New password',
    'app.auth.pw.ph': 'At least 10 characters; letters + digits recommended',
    'app.auth.pw.login.ph': 'Your password',
    'app.auth.code': 'Email code',
    'app.auth.code.ph': 'The digits you received',
    'app.auth.send': 'Send code',
    'app.auth.submit.login': 'Sign in',
    'app.auth.submit.signup': 'Sign up',
    'app.auth.submit.reset': 'Reset password',

    'app.auth.signout': 'Sign out',
    'app.auth.chpw': 'Change password',
    'app.auth.chpw.go': 'Confirm change',
    'app.auth.old': 'Current password',
    'app.auth.new': 'New password',
    'app.auth.meta': '{email} · account ID {id}',

    'app.auth.loggedin': 'Signed in',
    'app.auth.loggedin.email': 'Signed in: {email}',
    'app.auth.err.email': 'Enter a valid email first',
    'app.auth.sending': 'Sending the code…',
    'app.auth.send.fail': 'Send failed: {e}',
    'app.auth.send.ok': 'Code sent to {email} — check your inbox (and spam)',
    'app.auth.need.email': 'Enter your email',
    'app.auth.working': 'Working…',
    'app.auth.login.fail': 'Sign-in failed: wrong email or password',
    'app.auth.need.send': 'Hit "Send code" first',
    'app.auth.need.code': 'Enter the code from your inbox',
    'app.auth.verify.fail': 'Verification failed: {e}',
    'app.auth.existing': 'That email is already registered — signed you straight in',
    'app.auth.reset.sent': 'Reset code sent — enter the code and a new password, then hit "Reset password" again',
    'app.auth.reset.needcode': 'Enter the reset code you received',
    'app.auth.reset.fail': 'Reset failed: {e}',
    'app.auth.reset.done': 'Password reset — you are signed in',
    'app.auth.fail': 'Failed: {e}',
    'app.auth.err.retry': 'Try again in a moment',
    'app.auth.chpw.need': 'Enter your current and new password',
    'app.auth.chpw.fail': 'Change failed: {e}',
    'app.auth.chpw.badold': 'current password is wrong',
    'app.auth.chpw.ok': 'Password changed',
    'app.auth.code.wrong': 'the code is wrong or expired',
    'app.auth.code.wrong2': 'the code is wrong',

    'app.auth.bind.bound': 'Phira linked: <b>{name}</b> #{uid}',
    'app.auth.bind.unbind': 'Unlink',
    'app.auth.bind.found': 'Not linked yet. Just looked up: <b>{name}</b> #{uid}',
    'app.auth.bind.go': 'Link this Phira account',
    'app.auth.bind.none':
      'No Phira account linked yet.<br>Look up your own account on the <b>Players</b> page first '
      + '(by username or UID), then come back to link it.',
    'app.auth.bind.needlogin': 'Sign in first',
    'app.auth.bind.needlookup': 'Look up your own Phira account on the Players page first, then come back to link it',
    'app.auth.bind.fail': 'Link failed: {e}',
    'app.auth.bind.done': 'Phira linked: <b>{name}</b> #{uid}',
    'app.auth.unbind.fail': 'Unlink failed: {e}',
    'app.auth.unbind.done': 'Phira unlinked',
    'app.auth.signout.done': 'Signed out',

    /* ── password strength (only when setting a new password) ── */
    'app.pw.short': 'Password must be at least 10 characters (a 6-char password falls to offline cracking in minutes)',
    'app.pw.digits': 'All-digits is too weak — mix letters with digits',
    'app.pw.lower': 'All-lowercase is still weak — add a digit or an uppercase letter',

    /* ── drop zone ── */
    'app.drop.big': 'Drop a Phira chart pack here',
    'app.drop.or': 'or click to pick files · .pez / .zip · multiple at once',
    'app.drop.what':
      '<b>What is a chart pack?</b> It is the chart file you download from Phira (<code>.pez</code>), '
      + 'or a <code>.zip</code> that unpacks to one containing <code>chart.json</code>. '
      + 'Grab it from a chart\u2019s detail page on Phira, or from a share link someone posted — '
      + '<b>drop it in and it parses automatically, nothing is uploaded</b>.<br>'
      + 'Too lazy to download? Just use the <b>search</b> box above by song name and hit "Analyze".',

    /* ── second-tier entry points (morebar) ── */
    'app.more.user': 'My scores',
    'app.more.user.title': 'Read Phira\u2019s public profile and scores (read-only; a password is neither needed nor accepted)',
    'app.more.user.hint': 'B19 / per-chart RKS / recent plays · now its own page',
    'app.more.charter': 'Find a charter',
    'app.more.charter.title': 'See every chart by a charter',
    'app.more.charter.hint': 'Browse a charter\u2019s charts and constants',
    'app.more.auth.title': 'P.H.M. account (optional): sign in to link Phira and keep your records',
    'app.more.auth.hint': 'optional',
    'app.more.gh.title': 'GitHub repository · Phira-Huamei-Metric',

    /* ── footer ── */
    'app.foot.engine':
      'Live engine: <b>8-dim log1p features</b> (NPS / effective NPS / note count / weighted density p99 / '
      + 'note interval / peak-density mean / density / cross-hand) + dual-reference k-NN '
      + '(<b>9,508 community charts</b> as the main result, 1,037 official charts as the comparison scale)',
    'app.foot.ver': 'Version {v} (developer beta; the release build will recompute everything)',
    'app.foot.source': 'Source',
    'app.foot.details': 'What is PS? This tool\u2019s limits and privacy (expand)',
    'app.foot.d1':
      '<b>These three numbers are not the same — do not mix them up</b>:<br>'
      + '· <b>Reference constant (community consensus)</b> — the median declared constant of the 20 '
      + 'structurally closest charts among 9,508 Phira community charts. This is <b>how charters actually '
      + 'price a chart</b>, and the closest thing to the number you see on Phira.<br>'
      + '· <b>Official scale</b> — the same algorithm with the reference set swapped for 1,037 official '
      + 'Phigros charts; the absolute scale consistent with the game.<br>'
      + '· <b>PS</b> — this tool\u2019s own load scale (0–20), measuring execution and reading load, '
      + '<b>a different scale from both of the above</b>.',
    'app.foot.d2':
      '<b>The two scales differ a lot — what does that mean?</b> Official and community charts have '
      + '<b>genuinely different structural distributions</b> (median constant 15.1 vs 10.6; community charts '
      + 'devote only a third as much to holds and five times as much to drags). So a 2–3 level gap for the same '
      + 'chart is normal — that is <b>two different rulers, not one ruler miscalculating</b>. Printing a single '
      + 'number is what causes trouble: "my IN 14 got scored 11.6" comes from exactly that.',
    'app.foot.d3':
      '<b>PS</b> is a weighted blend of four load groups: '
      + '<span class="mono">PS = 20 × (0.40·density + 0.30·structure + 0.15·coordination + 0.15·sustain)</span>. '
      + 'Each dimension is normalised through a saturation curve, and every point traces back to the '
      + 'breakdown on the card.',
    'app.foot.d4':
      '<b>PS is unrelated to the official constant</b> — the official constant is a human label (measured '
      + 'labelling noise around 2.80 levels), so the two do not cross-validate. <b>This tool does not rule on '
      + '"fake labels"</b>: at that noise level no tool can tell "the charter mislabelled" from "the official '
      + 'would label it this way too" by structure alone.',
    'app.foot.d5':
      'The <b>reference constant</b> is the <b>median declared constant</b> of the 20 most similar reference '
      + 'charts, not a fitted prediction — you can open each one by name and check it back on Phira. It drifts '
      + 'when the reference set has no close match, so the card also shows the <b>uncertainty range</b> '
      + '(the spread across those 20) and the <b>mean neighbour distance</b>; a wide spread means the number is soft.<br>'
      + 'Hold-out validation (1,367 community charts, reference set of 8,141): <b>mean |error| 0.820 · 84.2% within 1.0</b>; '
      + 'the old version (4-dim official reference) was 1.187 / 67.0%.',
    'app.foot.d6':
      '<b>Privacy · what gets uploaded</b> (all of it governed by the switch in the Settings panel at the page bottom):<br>'
      + '· <b>Compute RKS</b>: runs locally. Only if you tick "upload anonymously" do we write '
      + 'chart name / constant / ACC — strictly speaking a <b>pseudonymised</b> contribution (carrying a random '
      + 'client_id), not strict anonymity.<br>'
      + '· <b>Look up a Phira account</b>: scores are auto-uploaded only for <b>accounts you confirmed as your own</b> '
      + '(with the Phira UID and username, both already public on Phira). The first time a UID appears we ask '
      + '"is this your account?".<br>'
      + '· <b>Drop a chart</b>: only the <b>chart\u2019s structural features</b> enter the shared constant cache; '
      + '<b>the chart file itself is never uploaded</b>.<br>'
      + '<b>Turn the bottom switch off and none of the above happens</b> (the page still requests aggregate totals '
      + 'to draw the stats bar; those carry no personal information).',
    'app.foot.d7':
      'Phira is accessed read-only for public data (RKS, best scores); <b>a password is neither needed nor accepted</b>. '
      + 'Any username / UID you enter is kept only in your browser\u2019s local storage (localStorage) for next-time '
      + 'autofill and is never sent with requests.',
    'app.foot.set': '⚙ Quick settings',
    'app.foot.setall': 'All settings →',
    'app.foot.setdlg.label':
      'Auto-upload scores after checking Phira — used to calibrate the difficulty reference',
    'app.foot.setdlg.note':
      'When off, <b>no contribution is uploaded</b> (chart structural features, score data) — dropping charts, '
      + 'computing RKS and searching charts all keep working.<br>'
      + '<span style="color:var(--fg3)">The page still requests this site\u2019s aggregate totals to draw the stats bar; '
      + 'those contain no personal information.</span><br>'
      + 'What gets uploaded: Phira UID and username, chart name, constant, ACC, per-chart RKS. It does <b>not</b> '
      + 'upload your password / email / the chart file itself.<br>'
      + 'Scores are auto-uploaded only for <b>accounts you confirmed as your own</b> (we ask once on lookup). '
      + 'Public stats are aggregates only — nobody can see your UID or username.',

    /* ── generic errors / status ── */
    'app.ver.beta': '{v} · developer beta',
    'app.msg.parsing': 'Parsing…',
    'app.err.toobig': 'File too large: {mb} MB, over the {max} MB limit (skipped to keep the tab from blowing up)',
    'app.err.none': 'No chart could be parsed',
    'app.err.script': '⚠ Script error: {e} — some features may be unavailable; refresh to recover',
    'app.err.async': '⚠ Async error: {e}',
    'app.err.netperm': 'network or permission problem',
    'app.err.unknown': 'unknown',
    'app.err.net': 'network error',
    'app.err.phira.api': 'Phira API is unavailable',
    'app.err.op': 'Action failed: {e}',
    'app.err.timeout': 'Request timed out ({s}s)',

    /* ── shared-cache contribution ── */
    'app.contrib.many': 'several',
    'app.contrib.ambiguous':
      '\u2139 "{name}" was analysed locally, but Phira has <b>{n}</b> charts under the same name '
      + '(different difficulties) — <b>cannot tell which one it is, so nothing was written to the shared cache</b>.<br>'
      + '<span style="color:var(--fg3)">Writing the wrong one would pin another difficulty\u2019s constant on it, '
      + 'so we leave it blank.</span>',
    'app.contrib.ok':
      '\u2705 The structural constant for "{name}" was saved to the <b>shared constant cache</b> — '
      + 'the next person who searches this chart sees it instantly, no download needed.<br>'
      + '<span style="color:var(--fg3)">Only structural features (density / holds / note count) go in; '
      + 'your chart file itself is not uploaded. Turn it off under "⚙ Settings" at the page bottom.</span>',

    /* ── download ── */
    'app.dl.nofile': 'This chart has no downloadable file (maybe it was taken down)',
    'app.dl.badurl': 'Chart file URL looks wrong (not http/https); blocked',
    'app.dl.downloading':
      'Downloading "{name}" — once it is done, <b>drag the zip into the dashed box below</b>; '
      + 'this page then computes the constant and stashes it in the shared cache.',
    'app.dl.title': 'Download the chart pack zip',
    'app.dl.short': 'Download',

    /* ── result card ── */
    'app.res.g.density': 'Density load',
    'app.res.g.pattern': 'Structure load',
    'app.res.g.coord': 'Coordination load',
    'app.res.g.stamina': 'Sustain load',
    'app.res.basis.com': 'Community consensus',
    'app.res.basis.off': 'Official scale',
    'app.res.desc.com': 'Phira community charts',
    'app.res.desc.off': 'Phigros official charts',
    'app.res.u': '{basis} · {desc} — the {n} structurally closest of {pool}',
    'app.res.u.span': 'uncertainty range <b>{lo}–{hi}</b>',
    'app.res.off.note': 'same scale as official Phigros ({n} official charts)',
    'app.res.off.hi': ' · community consensus sits {d} above it',
    'app.res.off.lo': ' · community consensus sits {d} below it',
    'app.res.vague':
      '⚠ These {n} reference charts span <b>{lo}–{hi}</b> (a gap of {span}) — meaning this chart has '
      + '<b>no close match</b> in {desc}, so the midpoint is only a rough guide.<br>'
      + '<b>What to look at instead:</b> '
      + '(1) which end of the range it leans toward (whether it is on the harder or easier side of its kind); '
      + '(2) open the "5 closest" table below and check the names yourself — if any of them looks nothing like it, '
      + 'don\u2019t trust the number; '
      + '(3) read the other column for the other scale (community consensus and the official scale usually run '
      + 'one wide and one narrow).',
    'app.res.share.label': 'Share this chart',
    'app.res.share.wide': 'Landscape · QQ / Bilibili / X',
    'app.res.share.tall': 'Portrait · Douyin',
    'app.res.near': '{desc} reference (5 closest)',
    'app.res.th.const': 'Constant',
    'app.res.psline':
      'PS load scale <b>{total}</b> / 20 (density {d} · structure {p} · coordination {c} · sustain {s}) '
      + '— measures execution and reading load, unrelated to the official constant',
    'app.res.punch.title': 'Per-chart RKS',
    'app.res.punch.opt': ' (optional: contribute anonymously)',
    'app.res.punch.desc':
      'Enter this run\u2019s <b>accuracy (ACC)</b> — the % in the top-right of your score page — '
      + 'and the <b>per-chart RKS</b> is computed at once, <b>entirely on your device</b>.',
    'app.res.punch.ph': 'e.g. 96.50',
    'app.res.punch.go': 'Compute RKS',
    'app.res.punch.label':
      'Also <b>upload this score anonymously</b> to help calibrate constants (chart name, constant and ACC only — '
      + 'no account / nickname / score record). <b>RKS computes fine without ticking it.</b>',
    'app.res.r.notes': 'Real notes',
    'app.res.r.notes.fake': ' (incl. {n} fake)',
    'app.res.r.dur': 'Length',
    'app.res.r.bpm': 'BPM',
    'app.res.r.lines': 'Judgement lines',
    'app.res.r.density': 'Overall density',
    'app.res.r.eff': 'Effective density avg/peak',
    'app.res.r.strain': 'Weighted density p50 / p99',
    'app.res.r.iv': 'Note interval (median)',
    'app.res.r.hold': 'Hold ratio',
    'app.res.r.stair': 'Stair peak',
    'app.res.r.cross': 'Cross-hand',
    'app.res.r.multi': 'Three-plus chords',
    'app.res.r.multi.v': '{n} events',
    'app.res.r.charter': 'Charter',

    /* ── share-card export ── */
    'app.sh.noconst': 'This chart has no constant yet — hit "Analyze" on the left first',
    'app.sh.saved': '\u2705 Share card saved ({mode}). It carries the domain — others can find the site just by searching it.',
    'app.sh.fail': 'Share-card export failed: {e}',
    'app.sh.unparsed': 'This chart did not parse, so there is no share card to export',
    'app.sh.working': 'Generating…',
    'app.sh.mode.wide': 'landscape',
    'app.sh.mode.tall': 'portrait',

    /* ── settings-panel toggles ── */
    'app.set.auto.on':
      '\u2705 Auto-upload on — when you look up <b>an account you confirmed as your own</b>, its scores are contributed to make constants more accurate.',
    'app.set.auto.off':
      'Auto-upload off — from now on <b>nothing is uploaded</b> (chart structural features / score data). Dropping charts and computing RKS still work.',

    /* ── per-chart RKS ── */
    'app.punch.on': 'Anonymous upload on — every RKS computation will also upload this score.',
    'app.punch.off': 'Upload off — computed locally only; nothing is sent.',
    'app.punch.preview': 'Per-chart RKS preview ≈ <b>{r}</b>',
    'app.punch.lowacc': '　<span style="color:var(--red)">ACC&lt;70 does not count toward RKS</span>',
    'app.punch.needacc': '⚠ Enter the accuracy (ACC): a number 0–100, e.g. 96.50 — the % in the top-right of your score page',
    'app.punch.result': 'Per-chart RKS ≈ <b>{r}</b> (ACC {acc}{ref})',
    'app.punch.ref': ', reference constant {c}',
    'app.punch.noupload': '(upload not ticked — this run was computed on your device only; nothing was sent)',
    'app.punch.nocloud': 'Cloud service is not connected, so this could not be uploaded (RKS was computed locally)',
    'app.punch.uploading': 'Uploading anonymously…',
    'app.punch.uploaded': 'Uploaded anonymously — thanks for helping calibrate constants',
    'app.punch.upfail': 'Upload failed: {e}',
    'app.punch.ratelimited': 'Server busy (rate-limited), try again later',
    'app.err.serverwrite': 'the server did not write it',

    /* ── data-flywheel counter ── */
    'app.count.some': 'Data flywheel: <b>{n}</b> score records received — every one makes the constant formula sharper',
    'app.count.zero': 'Data flywheel ready — nobody has contributed yet; drop a chart → scroll down, enter ACC, and you are the first',

    /* ── chart search ── */
    'app.srch.needkw': 'Enter a search term first (song or charter)',
    'app.srch.searching': 'Searching "{q}"…',
    'app.srch.none': 'Nothing for "{q}" — try another term, or <b>drag a chart pack into the dashed box below</b> to analyze it with this page\u2019s engine',
    'app.srch.fail':
      'Search failed: {e}<br>The Phira search endpoint times out or rate-limits now and then; we already retried once. '
      + 'Click "Search" again, or use the dashed box below to pick a local chart pack — '
      + '<b>local parsing needs no network to produce a constant</b>.',
    'app.srch.found': 'Found <b>{n}</b>',
    'app.srch.filtered': ' (filtered out results whose name lacks "{q}")',
    'app.srch.hint': 'Hit "Analyze" = the server downloads this chart and computes it, giving the constant directly (about 2-5s)',
    'app.srch.ranked': 'Ranked',
    'app.srch.unranked': 'Unranked',
    'app.srch.cachedconst': 'P.H.M. structural constant (from the shared cache)',
    'app.srch.sh.wide': 'L',
    'app.srch.sh.tall': 'P',
    'app.srch.sh.wide.title': 'Export a landscape share card (QQ / Bilibili / X)',
    'app.srch.sh.tall.title': 'Export a portrait share card (Douyin / Xiaohongshu)',
    'app.srch.calc': 'Go',
    'app.srch.calc.title': 'Let the server download this chart and compute its constant (about 2-5s)',
    'app.srch.dl.title': 'Download the chart pack manually (then drag it into the dashed box below to use the local engine)',
    'app.srch.foot':
      '"Analyze" runs on the <b>server</b>: the browser cannot reach the chart file (Phira\u2019s file CDN sends no CORS headers), '
      + 'but the server is not bound by that and uses <b>the exact same engine as this page</b>. '
      + 'The result goes straight into the shared cache, so the next person who searches the same chart gets it instantly.<br>'
      + 'You can also hit <b>Download</b> and drag the zip into the dashed box below — that is the '
      + '<b>local computation</b> path (the chart file is not uploaded).',

    /* ── one-click compute / download-and-compute ── */
    'app.calc.doing': 'Go…',
    'app.calc.waiting': 'Asking the server to download this chart and compute its constant… (usually 2-5s)',
    'app.calc.done': '\u2705 "{name}" → P.H.M. constant <b>{rc}</b>',
    'app.calc.ps': ' · PS load {v}',
    'app.calc.cached': ' · (from the shared cache)',
    'app.calc.nowrite': ' · computed on the server (⚠ but this run could not be written to the shared cache)',
    'app.calc.written': ' · computed on the server and saved to the shared cache',
    'app.calc.fail':
      'Compute failed: {e}<br>You can use <b>Download</b> on the right instead, '
      + 'then drag the zip into the dashed box below to run the local engine.',
    'app.chart.anon': 'chart',
    'app.chart.id': 'Chart #{id}',
    'app.calc.nochartfile': '⚠ "{name}" has no downloadable file (maybe it was taken down)',
    'app.calc.dling': 'Downloading…',
    'app.calc.dling2': 'Downloading "{name}"…',
    'app.calc.toobig': 'Chart pack too large ({mb} MB, over the {max} MB limit); skipped',
    'app.calc.toobig2': 'Chart pack too large; skipped',
    'app.calc.dled': 'Downloaded {mb} MB, parsing…',
    'app.calc.parsefail': 'Parse failed (not RPE / PGR format)',
    'app.calc.badid': 'Bad chart id',
    'app.calc.writefail': '⚠ The constant is computed, but the shared-cache write did not succeed',
    'app.calc.writefail2': '⚠ The constant is computed, but the shared-cache write failed: {e}',
    'app.calc.done2': '\u2705 "{name}" → P.H.M. constant <b>{rc}</b>',
    'app.calc.apnote': ' (on an AP, per-chart RKS equals exactly this)',
    'app.calc.stored': ' · saved to the shared cache',
    'app.calc.corsfail':
      '⚠ <b>The browser cannot read the chart file directly</b> — Phira\u2019s file CDN '
      + '(<span class="mono">phira-cdn.5wyxi.com</span>) sends no CORS headers. That is a Phira-side limit '
      + 'and the web client cannot get around it.<br>'
      + 'Click <b>Download</b> in the table to get the zip for "{name}", '
      + 'then <b>drag it into the dashed box below</b> — this page\u2019s engine computes the P.H.M. constant at once '
      + '(the same pipeline).<br>'
      + '<span style="color:var(--fg3)">Technical detail: {e}</span>',

    /* ── player-score stats (inside the card) ── */
    'app.playstat':
      '<b>{n}</b> player scores (from the data flywheel) · mean ACC <b>{avg}%</b> · median {med}% · range {min}%–{max}%',
    'app.playstat.oc': ' · library constant {v}',

    /* ── public stats bar ── */
    'app.stats.head': 'Public data on this site: ',
    'app.stats.profiles': '<b>{n}</b> accounts',
    'app.stats.active': '<b>{n}</b> active in 7 days',
    'app.stats.bound': '<b>{n}</b> Phira linked',
    'app.stats.scores': '<b>{n}</b> score records',
    'app.stats.charts': '<b>{n}</b> cached constants',
    'app.stats.thin':
      '<br>⚠ Still a small sample ({n} scores): '
      + '<b>player stats (mean / median) swing widely — treat them as indicative only</b>. '
      + 'Importing a few more scores is what makes it sharper.',

    /* ── first-upload notice (confirm dialog) ── */
    'app.notice.body':
      'P.H.M. auto-uploads data in the following two cases, to calibrate the difficulty reference:\n\n'
      + '  - You look up a Phira account declared as your own -> uploads scores\n'
      + '    (your UID and username, chart name, nominal constant, your ACC and per-chart RKS)\n'
      + '  - You drop a chart -> uploads that chart\u2019s structural features (a string of computed numbers)\n\n'
      + 'Never uploaded:\n'
      + '  - Password, email, account permissions\n'
      + '  - The chart file itself (parsing happens entirely on your device)\n\n'
      + 'Purpose: to study the actual difficulty distribution of charts and improve the constant reference. '
      + 'Only aggregates are public;\n'
      + '      nobody can see your UID or username.\n'
      + 'Do not want to upload: choose "Cancel" and auto-upload is turned off; everything keeps working.\n'
      + '      You can re-enable it any time on the Settings page.\n\n'
      + 'See the Privacy Policy for details. Do you agree?',
  },
};
