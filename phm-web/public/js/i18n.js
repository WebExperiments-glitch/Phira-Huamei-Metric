/* ============================================================
 * js/i18n.js —— 全站双语（中 / 英）
 * ============================================================
 * 【分工】
 *   settings.js  管**存**（键名、持久化）
 *   i18n.js      管**译**（字典、取词、应用到 DOM）
 *   页面         只管调 t()，不自己判断语言
 *
 * 【三种用法】
 *   1. 静态 HTML：给元素加 `data-i18n="key"`，页面加载时 applyStatic() 批量替换。
 *      变体：`data-i18n-html`（值里有标记，用 innerHTML）、
 *            `data-i18n-ph`（写进 placeholder）、`data-i18n-title`（title）
 *   2. JS 渲染时：直接 `t('key')`。带变量的用 `t('key', {n: 5})`，
 *      字典里写 `共 {n} 条`。
 *   3. 切换语言：`setLang('en')` —— 会广播事件，页面监听后自行重渲染
 *      （因为很多内容是 JS 生成的，光换静态文本不够）。
 *
 * 【为什么不在 HTML 里写两套、用 CSS 显隐】
 *   看起来更省事，但会让 DOM 里塞进两份文案：屏幕阅读器会读错、
 *   Ctrl+F 会搜到隐藏的那份、SEO 也乱。文案就该只有一份真实内容。
 *
 * ⚠ 翻译纪律：术语**不硬译**。Phira / Phigros / RKS / ACC / B19 这类
 *   专有名词和站内约定词（标称定数、参考定数）在英文里保持原样或用
 *   社区通用写法，别自己造词 —— 音游玩家看的是社区术语，不是教科书英语。
 * ============================================================ */

import { lang as langStore } from './settings.js';

/* ══════════════════════════════════════════════════════════════
 * 字典
 * ══════════════════════════════════════════════════════════════ */
const DICT = {
  zh: {
    /* ── 导航 ── */
    'nav.home': '首页',
    'nav.app': '算定数',
    'nav.charter': '谱师',
    'nav.user': '玩家',
    'nav.data': '数据',
    'nav.settings': '设置',

    /* ── 通用操作 ── */
    'c.save': '保存',
    'c.cancel': '取消',
    'c.confirm': '确定',
    'c.clear': '清除',
    'c.reset': '重置',
    'c.export': '导出',
    'c.login': '登录',
    'c.signup': '注册',
    'c.logout': '退出登录',
    'c.loading': '读取中…',
    'c.none': '（没有）',
    'c.copy': '复制',
    'c.copied': '已复制',
    'c.close': '关闭',
    'c.back': '返回',
    'c.unknown': '未知',
    'c.retry': '重试',

    /* ── 主题 / 语言（设置页用）── */
    'set.theme': '外观主题',
    'set.theme.desc': '跟随系统时，系统切换深浅色会立即生效。',
    'set.theme.auto': '跟随系统',
    'set.theme.dark': '深色',
    'set.theme.light': '浅色',
    'set.lang': '界面语言',
    'set.lang.desc': '默认跟随浏览器；手动选择后会固定下来。',
    'set.lang.auto': '跟随浏览器',

    /* ── 设置页 ── */
    'set.title': '设置',
    'set.sec.privacy': '隐私与数据',
    'set.sec.account': '账号管理',
    'set.sec.phira': 'Phira 连接',
    'set.sec.appearance': '外观与语言',
    'set.sec.storage': '本机存储',
    'set.sec.about': '关于',

    'set.privacy.desc': '控制什么会被上传。谱面文件本身永远不上传 —— 解析全部在你浏览器里完成。',
    'set.optin': '登录 Phira 后自动上传成绩数据',
    'set.optin.desc': '用来校准定数参考。关掉后拖谱面、算 RKS、搜谱面全部照常，只是不再贡献数据。',
    'set.notice': '上传告知',
    'set.notice.reset': '撤回确认',
    'set.notice.done': '已确认过上传告知。撤回后，下次上传前会重新问你一次。',
    'set.notice.pending': '尚未确认 —— 下次上传前会弹一次告知。',
    'set.optin.on': '当前：开启 —— 查询已声明为「本人」的账号时，会连同成绩一起上传。',
    'set.optin.off': '当前：关闭 —— 不会上传任何成绩数据。页面仍会请求聚合统计数字用于显示统计条，不含个人信息。',
    'set.flow': '数据流向',
    'set.flow.up': '会上传',
    'set.flow.up.desc': '成绩（Phira UID 与用户名、谱面名、标称定数、你的 ACC 与单曲 RKS），以及谱面的结构特征 —— 一串数字，不是谱面文件。',
    'set.flow.down': '不会上传',
    'set.flow.down.desc': '谱面文件本身；密码与邮箱（这些本站根本接触不到 —— 认证走云服务的认证模块）。',
    'set.flow.foot': '对外的只有聚合数字，其他人看不到你的 UID 或用户名。贡献会带一个随机标识用于归组 —— 这是假名化，不是严格匿名，可在「本机存储」里重置。',

    'set.acct.title': 'P.H.M. 账号',
    'set.acct.desc': '本站的账号只用于：绑定你的 Phira 账号、查看你自己的贡献记录。不需要它也能用全部功能。',
    'set.acct.loggedout': '未登录',
    'set.acct.loggedout.desc': '注册一个账号可以把「本人账号声明」同步到云端，换设备也不用重新声明。',
    'set.acct.go': '去登录 / 注册',
    'set.acct.bound': '已绑定 Phira',
    'set.acct.unbound': '尚未绑定 Phira 账号',
    'set.acct.bind': '绑定这个 Phira 账号',
    'set.acct.unbind': '解除绑定',
    'set.acct.bindhint': '先去「玩家」页查一次你自己的账号，再回来绑定。',
    'set.acct.binddone': '已绑定 Phira',
    'set.acct.clearcid': '重置匿名标识',

    'set.phira.desc': '本站连 Phira 只读公开资料（RKS、最好成绩），不需要也不接受密码。',
    'set.phira.name': '上次填过的用户名',
    'set.phira.uid': '上次填过的 UID',
    'set.phira.last': '上次查询的玩家',
    'set.phira.clear': '清除以上信息',
    'set.phira.clear.desc': '只影响下次自动填充，不影响任何已上传的数据。',
    'set.own.title': '已声明的「本人账号」',
    'set.own.desc': '只有你明确声明过的账号，查询时才会自动上传成绩 —— 否则任何人都能把别人的公开成绩复制进数据集，难度统计就失真了。',
    'set.own.empty': '尚未声明任何账号',
    'set.own.revoke': '撤回',
    'set.own.note': '查询该账号时会自动上传成绩',

    'set.storage.desc': '本站存在你浏览器里的全部内容 —— 就这些，没有别的。',
    'set.storage.empty': '本机没有存任何设置（全部是默认值）',
    'set.storage.export': '导出为 JSON',
    'set.storage.clear': '清空本站设置',
    'set.storage.note': '「清空本站设置」只会删本站自己的键。同源下还住着云服务的登录会话，那是另一个系统的数据 —— 本站不会碰它，所以清空后你不会被登出，只回到未配置状态。',

    'set.about.ver': '页面版本',
    'set.about.eng': '引擎版本',
    'set.about.cache': '共享定数缓存',
    'set.about.store': '本机存储可用',
    'set.about.note': '页面版本与引擎版本是两根不同的轴：前者是本页面的版本，后者是难度算法的版本 —— 算法一变，所有缓存都要重算，所以它单独记在每一行数据里。',
    'set.about.yes': '可用',
    'set.about.no': '不可用（隐私模式？）',
    'set.about.fail': '读取失败',

    /* ── 首页 ── */
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
    'c.save': 'Save',
    'c.cancel': 'Cancel',
    'c.confirm': 'Confirm',
    'c.clear': 'Clear',
    'c.reset': 'Reset',
    'c.export': 'Export',
    'c.login': 'Sign in',
    'c.signup': 'Sign up',
    'c.logout': 'Sign out',
    'c.loading': 'Loading…',
    'c.none': '(none)',
    'c.copy': 'Copy',
    'c.copied': 'Copied',
    'c.close': 'Close',
    'c.back': 'Back',
    'c.unknown': 'Unknown',
    'c.retry': 'Retry',

    /* ── theme / language ── */
    'set.theme': 'Appearance',
    'set.theme.desc': 'On "System", the theme follows your OS setting instantly.',
    'set.theme.auto': 'System',
    'set.theme.dark': 'Dark',
    'set.theme.light': 'Light',
    'set.lang': 'Language',
    'set.lang.desc': 'Follows your browser by default; pinning it here overrides that.',
    'set.lang.auto': 'Browser',

    /* ── settings ── */
    'set.title': 'Settings',
    'set.sec.privacy': 'Privacy & data',
    'set.sec.account': 'Account',
    'set.sec.phira': 'Phira connection',
    'set.sec.appearance': 'Appearance & language',
    'set.sec.storage': 'Local storage',
    'set.sec.about': 'About',

    'set.privacy.desc': 'Control what gets uploaded. Chart files never leave your device — parsing happens entirely in your browser.',
    'set.optin': 'Auto-upload scores after checking Phira',
    'set.optin.desc': 'Used to calibrate the difficulty reference. Turning it off keeps everything else working — you just stop contributing data.',
    'set.notice': 'Upload notice',
    'set.notice.reset': 'Withdraw consent',
    'set.notice.done': 'You have accepted the upload notice. Withdrawing it will make us ask again before the next upload.',
    'set.notice.pending': 'Not yet accepted — we will ask before the first upload.',
    'set.optin.on': 'Currently on — when you look up an account you declared as your own, its scores are uploaded along with it.',
    'set.optin.off': 'Currently off — no score data is uploaded. The page still requests aggregate totals to draw the stats bar; those contain no personal information.',
    'set.flow': 'Data flow',
    'set.flow.up': 'What we upload',
    'set.flow.up.desc': 'Scores (Phira UID and username, chart name, nominal constant, your ACC and per-chart RKS) and the chart\u2019s structural features — a string of numbers, not the chart file.',
    'set.flow.down': 'What we never upload',
    'set.flow.down.desc': 'The chart file itself; your password and email (we cannot reach those at all — authentication runs on the cloud provider\u2019s auth module).',
    'set.flow.foot': 'Only aggregates are public; nobody can see your UID or username. Contributions carry a random identifier used for grouping — that is pseudonymisation, not strict anonymity, and you can reset it under Local storage.',

    'set.acct.title': 'P.H.M. account',
    'set.acct.desc': 'This account exists only to link your Phira account and to view your own contributions. Every feature works without it.',
    'set.acct.loggedout': 'Not signed in',
    'set.acct.loggedout.desc': 'An account syncs your "this is my account" declarations to the cloud, so you do not have to re-declare on another device.',
    'set.acct.go': 'Sign in / Sign up',
    'set.acct.bound': 'Phira linked',
    'set.acct.unbound': 'No Phira account linked',
    'set.acct.bind': 'Link this Phira account',
    'set.acct.unbind': 'Unlink',
    'set.acct.bindhint': 'Look up your own account on the Players page first, then come back to link it.',
    'set.acct.binddone': 'Phira linked',
    'set.acct.clearcid': 'Reset anonymous ID',

    'set.phira.desc': 'Phira is accessed read-only for public data (RKS, best scores). A password is neither required nor accepted.',
    'set.phira.name': 'Last username entered',
    'set.phira.uid': 'Last UID entered',
    'set.phira.last': 'Last player looked up',
    'set.phira.clear': 'Clear the above',
    'set.phira.clear.desc': 'Affects autofill only; nothing already uploaded is touched.',
    'set.own.title': 'Accounts declared as yours',
    'set.own.desc': 'Only accounts you explicitly declare are auto-uploaded. Without that, anyone could copy another player\u2019s public scores into the dataset and the difficulty statistics would be worthless.',
    'set.own.empty': 'No account declared yet',
    'set.own.revoke': 'Revoke',
    'set.own.note': 'Scores are auto-uploaded when this account is looked up',

    'set.storage.desc': 'Everything this site stores in your browser — that is all of it.',
    'set.storage.empty': 'Nothing stored (all defaults)',
    'set.storage.export': 'Export as JSON',
    'set.storage.clear': 'Clear site settings',
    'set.storage.note': '"Clear site settings" removes only this site\u2019s own keys. The same origin also holds the cloud provider\u2019s session, which belongs to another system — we never touch it, so you stay signed in and simply return to an unconfigured state.',

    'set.about.ver': 'Page version',
    'set.about.eng': 'Engine version',
    'set.about.cache': 'Shared constant cache',
    'set.about.store': 'Local storage',
    'set.about.note': 'Page version and engine version are two separate axes: the former is this page\u2019s version, the latter is the difficulty algorithm\u2019s. Changing the algorithm invalidates every cached row, which is why it is recorded on each row.',
    'set.about.yes': 'available',
    'set.about.no': 'unavailable (private mode?)',
    'set.about.fail': 'read failed',

    /* ── home ── */
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
  },
};

/* ══════════════════════════════════════════════════════════════
 * 取词
 * ══════════════════════════════════════════════════════════════ */

let _lang = null;

/** 当前语言（'zh' | 'en'）。首次调用会从设置里读一次并缓存。 */
export function currentLang() {
  if (_lang === null) _lang = langStore.get();
  return _lang;
}

export function setLang(v) {
  _lang = v;
  langStore.set(v);
  try {
    const html = document.documentElement;
    html.setAttribute('lang', v === 'zh' ? 'zh-CN' : 'en');
    html.setAttribute('data-lang', v);
  } catch (e) { /* 忽略 */ }
  applyStatic();
  /* 页面里 JS 生成的内容要自己重渲染 —— 广播出去，谁需要谁听 */
  for (const fn of _subs) { try { fn(v); } catch (e) { /* 订阅者自己的错 */ } }
}

const _subs = new Set();
/** 语言变化订阅。返回取消订阅函数。 */
export function onLangChange(fn) { _subs.add(fn); return () => _subs.delete(fn); }

/**
 * 取词。`t('key')` 或 `t('key', {n: 5})`（字典里写 `共 {n} 条`）。
 * 找不到时**返回 key 本身**而不是空串 —— 页面上会直接看到 `set.foo`，
 * 一眼就知道漏翻了，比悄悄显示空白好。
 */
export function t(key, vars) {
  const bag = DICT[currentLang()] || DICT.zh;
  let s = bag[key];
  if (s === undefined) s = DICT.zh[key];
  if (s === undefined) return key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  }
  return s;
}

/* ══════════════════════════════════════════════════════════════
 * 静态 HTML：把 data-i18n 批量换掉
 * ══════════════════════════════════════════════════════════════
 * 支持的属性：
 *   data-i18n        → textContent
 *   data-i18n-html   → innerHTML（值里带 <b> 之类的标记）
 *   data-i18n-ph     → placeholder
 *   data-i18n-title  → title
 */
export function applyStatic(root) {
  const scope = root || document;
  let n = 0;
  scope.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n')); n++;
  });
  scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
    el.innerHTML = t(el.getAttribute('data-i18n-html')); n++;
  });
  scope.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); n++;
  });
  scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); n++;
  });
  return n;
}

/* 只读测试钩子：让 tools/verify-pages.mjs 能断言**真身**的行为
   （切语言后 t() 真的变了、字典真的齐全），而不是 grep 源码。 */
try {
  window.PHM_I18N = Object.freeze({
    t, currentLang, setLang, applyStatic,
    keys: () => Object.keys(DICT.zh),
    missing: (l) => Object.keys(DICT.zh).filter(k => DICT[l] && DICT[l][k] === undefined),
  });
} catch (e) { /* 无 window 时跳过 */ }

/* 页面一加载就把语言写到 <html> 上（CSS 里可以用 [data-lang="en"] 做微调，
   例如英文文案更长时放宽某些容器）。 */
try {
  const v = currentLang();
  document.documentElement.setAttribute('lang', v === 'zh' ? 'zh-CN' : 'en');
  document.documentElement.setAttribute('data-lang', v);
} catch (e) { /* 忽略 */ }
