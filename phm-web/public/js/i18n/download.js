/* ============================================================
 * js/i18n/download.js —— /download 页
 * ============================================================
 * ⚠ 这里只放下载页专属文案。nav.* 在 common.js、foot.* 也在那边 ——
 *   分片之间**不允许**定义同一个 key（i18n.js 会抛错，这是有意的）。
 *
 * 【措辞纪律】
 *   · "客户端" → "the desktop client"（不用 "app"，会和网页端混淆）
 *   · Phira 的判定术语（Perfect / Good / Bad / Miss）保持英文原样
 *   · 客户端版本写 `0.8.2-huamei.N`，**别翻译**，那是协议里的一串字面量
 * ============================================================ */

export default {

zh: {
  'dl.title': '下载客户端',
  'dl.sub': 'Windows 版客户端：把 Phira 的每一局判定明细（含每个音符的早/晚偏移）记进站内的共享数据。'
    + '纯本地运行的桌面客户端，不读取你的 Phira 密码。',

  'dl.btn': '下载 Windows 版',
  'dl.req': 'Windows 10 / 11 · 64 位 · 免安装',

  'dl.m.file': '文件',
  'dl.m.ver': '客户端版本',
  'dl.m.built': '构建日期',
  'dl.m.size': '大小',
  'dl.stamp': '本页数据对应站点版本 {v}。客户端版本（0.8.2-huamei.N）与站点版本是两条独立的版本轴，不必一致。',

  'dl.beta': '这是<b>开发者测试版</b>：功能在持续改动，遇到问题请到仓库提 Issue。'
    + '版本号每改一次就变，所以下载到的永远是当时的最新构建。',

  'dl.how.title': '怎么用',
  'dl.how.s1': '下载上面那个 <span class="mono">.exe</span>，放到任意目录，'
    + '<b>双击即可运行</b>——单文件，不需要安装，也不需要额外的资源文件夹。',
  'dl.how.s2': '首次启动会被 Windows 拦一下（见下面那条说明），选「更多信息 → 仍要运行」。',
  'dl.how.s3': '在客户端里用<b>你自己的邮箱</b>登录站内账号（收验证码即可，不需要 Phira 密码），'
    + '然后在<b>设置</b>里确认已登录。',
  'dl.how.s4': '从<span class="mono">谱面库</span>选一张谱开打。结算时这一局的逐音符判定会自动上报——'
    + '<b>没登录就不会上报</b>，其余功能照常。',

  'dl.verify.title': '校验下载（可选，但建议）',
  'dl.verify.sub': '这个包没有代码签名。要确认下载到的文件没被中途篡改，'
    + '把它的 SHA-256 和下面这串对一下。',
  'dl.copy': '复制',
  'dl.copied': '已复制',
  'dl.copy.manual': '请手动复制',
  'dl.copy.fail': '复制失败',
  'dl.verify.tip': '在 PowerShell 里跑上面这行，比对 Hash 一栏。把路径换成你实际存放的位置。',
  'dl.smart': '运行时会看到<b>「Windows 已保护你的电脑」</b>——这是 SmartScreen 对<b>所有</b>'
    + '未做代码签名的程序的标准提示，不是检测到了病毒。点「更多信息」→「仍要运行」。'
    + '代码签名证书要按年付费，这个项目目前没有买。',

  'dl.src.title': '源码与许可',
  'dl.src.sub': '客户端是 <b>Phira</b>（GPL-3.0-only）的构建产物，全部改动同样以 GPL-3.0 开源。'
    + '分发二进制就必须同时给出对应源码——所以这里把仓库放在最显眼的位置。',
  'dl.src.repo': '源码仓库（GitHub）',
  'dl.src.hist': '版本历史',
  'dl.src.privacy': '隐私政策',
  'dl.src.what': '客户端改了什么：登录门槛去掉（在线谱面无需登录）、内嵌全部资源（单文件即可运行）、'
    + '结算时把逐音符判定上报给本站。每一项都记在 <span class="mono">docs/规范/数据飞轮契约.md</span> 里。',

  'dl.back': '← 返回设置',
},

en: {
  'dl.title': 'Download the client',
  'dl.sub': 'The Windows client records the full judgement breakdown of every Phira play — including each note\u2019s '
    + 'early/late offset — into the shared data on this site. It runs entirely on your machine and never asks for '
    + 'your Phira password.',

  'dl.btn': 'Download for Windows',
  'dl.req': 'Windows 10 / 11 · 64-bit · no installer',

  'dl.m.file': 'File',
  'dl.m.ver': 'Client version',
  'dl.m.built': 'Built',
  'dl.m.size': 'Size',
  'dl.stamp': 'This page matches site version {v}. The client version (0.8.2-huamei.N) and the site version are '
    + 'two independent axes and need not line up.',

  'dl.beta': 'This is a <b>developer beta</b>: features keep changing, so please file an Issue on the repo if something '
    + 'breaks. The version bumps on every change, which means the download is always the newest build at the time.',

  'dl.how.title': 'How to use it',
  'dl.how.s1': 'Download the <span class="mono">.exe</span> above, put it anywhere and <b>double-click it</b> — '
    + 'a single file, no installer and no separate resource folder needed.',
  'dl.how.s2': 'Windows will block it the first time (see the note below); choose "More info → Run anyway".',
  'dl.how.s3': 'Sign in to your account on this site from inside the client using <b>your own e-mail</b> '
    + '(a code is enough — no Phira password), then confirm you are signed in under <b>Settings</b>.',
  'dl.how.s4': 'Pick a chart from the <span class="mono">library</span> and play. The per-note judgements are '
    + 'uploaded when the result screen appears — <b>without signing in nothing is uploaded</b>, and everything else '
    + 'still works.',

  'dl.verify.title': 'Verify the download (optional, recommended)',
  'dl.verify.sub': 'This build is not code-signed. To be sure the file was not tampered with on the way, '
    + 'compare its SHA-256 against the string below.',
  'dl.copy': 'Copy',
  'dl.copied': 'Copied',
  'dl.copy.manual': 'Copy it manually',
  'dl.copy.fail': 'Copy failed',
  'dl.verify.tip': 'Run that line in PowerShell and check the Hash column. Swap the path for wherever you saved the file.',
  'dl.smart': 'You will see <b>"Windows protected your PC"</b> when you run it — that is SmartScreen\u2019s standard '
    + 'notice for <b>every</b> program without a code-signing certificate, not a virus detection. Click "More info" → '
    + '"Run anyway". Code-signing certificates cost money every year and this project has not bought one.',

  'dl.src.title': 'Source and licence',
  'dl.src.sub': 'The client is a build of <b>Phira</b> (GPL-3.0-only) and all our changes are released under GPL-3.0 '
    + 'as well. Shipping a binary obliges us to offer the matching source, so the repository is the most prominent '
    + 'link on this page.',
  'dl.src.repo': 'Source repository (GitHub)',
  'dl.src.hist': 'Version history',
  'dl.src.privacy': 'Privacy Policy',
  'dl.src.what': 'What the client changes: the sign-in gate is gone (online charts load anonymously), all assets are '
    + 'embedded (so one file is enough) and per-note judgements are reported here at the result screen. '
    + 'Every item is documented in <span class="mono">docs/规范/数据飞轮契约.md</span>.',

  'dl.back': '← Back to Settings',
},

};
