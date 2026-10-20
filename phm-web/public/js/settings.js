/* ============================================================
 * js/settings.js —— 用户设置的**单一真源**
 * ============================================================
 * 【为什么会有这个文件】
 *   在这之前，「设置」不是一个东西，是散在 7 个 localStorage 键里的一堆
 *   裸读写：app.html 里 5 个、user.html 里 1 个，各自的默认值还写在不同地方。
 *   只有一两个开关时没问题；设置项一多，必然长出
 *   「A 页写了 B 页读不到」和「同一个键两处默认值不一样」。
 *
 *   所以定下规矩：**键名 / 默认值 / 读写 / 清理只在本文档定义**，
 *   其余页面一律 import，不再出现裸的 localStorage.getItem('phm_...')。
 *
 * 【三条硬约束】
 *   1. **键名不能改** —— 改了等于把老用户的设置悄悄清空。
 *      KEYS 是唯一清单，将来只增不改，历史键名也留在里面。
 *   2. **读失败一律返回默认值**，绝不抛异常。隐私模式 / 禁用存储时，
 *      整站的原则是「设置读不到 = 用默认」，而不是页面崩掉。
 *   3. **clearAll() 只清本站自己的键**（白名单）。
 *      **登录凭据 `phm_hm_token` 故意不在这张清单里** —— 它是 auth.js 的，
 *      不归设置管。顺手清掉会把用户踢下线，而"清空设置"从来没承诺过这个。
 *      （以前同源下还住着云 SDK 的会话，同样不在清单里，理由一样。）
 *
 * 【和别的文件的分工】
 *   engine.js  纯计算（解析谱面 → 定数），不碰浏览器 API
 *   ui.js      纯展示（数字 → 字），无状态
 *   settings.js 纯状态（读/写/通知），不渲染任何东西
 * ============================================================ */

/* ══════════════════════════════════════════════════════════════
 * 键名清单 —— 唯一真源，只增不改
 * ══════════════════════════════════════════════════════════════ */
export const KEYS = Object.freeze({
  optin:     'phm_optin',        /* 上传总开关："1" / "0" */
  notice:    'phm_notice_v1',    /* 数据飞轮告知已读："1"（带 _v1：将来换文案要重新征求同意） */
  cid:       'phm_cid',          /* 假名化会话 id（把同一人的多次贡献归组用） */
  phiraName: 'phm_phira_name',   /* Phira 用户名 —— 仅用于下次自动填充 */
  phiraUid:  'phm_phira_uid',
  lastUid:   'phm_last_uid',     /* 上次查询过的玩家 uid */
  /* 登录邮箱 —— 只为「下次自动填」而存。
   * ⚠ 存的是**邮箱**，不是密码、不是 token：token 由 auth.js 自己管
   *   （localStorage 的 `phm_hm_token`），密码绝不落盘。
   *   邮箱是公开信息，存它换来的是「不用每次重打一遍」—— 用户明确要求的手感。
   * ⚠ 存了邮箱**不等于**已登录，界面绝不拿它当登录态显示。 */
  email:     'phm_email',
  ownPrefix: 'phm_own_',         /* + uid =「我声明这是本人的账号」 */
  theme:     'phm_theme',        /* 外观："dark" / "light" / "auto" */
  lang:      'phm_lang',         /* 界面语言："zh" / "en" */
  font:      'phm_font',         /* 标题字体："serif"（默认，思源宋体标题）/ "sans"（全黑体） */
  size:      'phm_size',         /* 字号档位："s" / "m"（默认）/ "l" */
  recent:    'phm_recent',       /* 最近查询：JSON {charter:[名…], user:[名…]} */
});

/** 固定键（不含 own 前缀键）—— 用于清空与导出。 */
export const PLAIN_KEYS = Object.freeze([
  KEYS.optin, KEYS.notice, KEYS.cid, KEYS.phiraName, KEYS.phiraUid, KEYS.lastUid,
  KEYS.email, KEYS.theme, KEYS.lang, KEYS.font, KEYS.size, KEYS.recent,
]);

/** 本地存储表的行名 —— ⚠ 值是 **i18n 词条名**，不是给人看的字面量。
 *
 *  【为什么不能直接写中文】
 *    这个文件是「**存**」的层（键名 + 读写 + 持久化），i18n 是「译」的层，
 *    而 i18n.js 要 import 本文件拿 `lang` 存取器 —— 本文件一旦反过来
 *    import i18n 就是**循环依赖**。所以这里只给键，翻译由页面做：
 *      页面上写 `t(LABELS[k])`。
 *    以前这里写的是中文字面量，于是设置页「本机存储」那一栏
 *    切到英文后仍然是中文。 */
export const LABELS = Object.freeze({
  [KEYS.optin]:     'set.store.optin',
  [KEYS.notice]:    'set.store.notice',
  [KEYS.cid]:       'set.store.cid',
  [KEYS.phiraName]: 'set.store.phiraName',
  [KEYS.phiraUid]:  'set.store.phiraUid',
  [KEYS.lastUid]:   'set.store.lastUid',
  /* 这两项名字与设置页的分区标题一致，直接复用已有词条，不再造一份 */
  [KEYS.theme]:     'set.theme',
  [KEYS.lang]:      'set.lang',
  [KEYS.font]:      'set.font',
  [KEYS.size]:      'set.size',
  [KEYS.recent]:    'set.store.recent',
});

/* ══════════════════════════════════════════════════════════════
 * 底座：安全读写（永不抛）
 * ══════════════════════════════════════════════════════════════ */

function store() {
  try { return window.localStorage; } catch (e) { return null; }
}

/** 存储是否真的可用。不可用时设置页要如实说，而不是假装写成功了。 */
export const available = (function () {
  try {
    const s = window.localStorage;
    s.setItem('__phm_probe', '1');
    s.removeItem('__phm_probe');
    return true;
  } catch (e) { return false; }
})();

function isOurs(k) {
  return PLAIN_KEYS.indexOf(k) >= 0 || String(k).indexOf(KEYS.ownPrefix) === 0;
}

export function get(key, dflt) {
  const s = store();
  if (!s) return dflt;
  try {
    const v = s.getItem(key);
    return v === null ? dflt : v;
  } catch (e) { return dflt; }
}

/** 写：`null` / `undefined` 表示删除该键。返回是否真的写成功。 */
export function set(key, val) {
  const s = store();
  if (!s) return false;
  try {
    if (val === null || val === undefined) s.removeItem(key);
    else s.setItem(key, String(val));
    emit(key);
    return true;
  } catch (e) { return false; }
}

function bool(key, dflt) {
  const v = get(key, null);
  return v === null ? dflt : v === '1';
}

/* ── 变更通知 ──
   同一个页面里可能有多个地方关心同一个键（例如页脚的开关与状态条）。
   另外：用户开了两个标签页时，一个页签改了设置，另一个页签要跟上 ——
   那是 `storage` 事件，只有**别的**页签会收到（本页不会），正好互补。 */
const watchers = new Set();

function emit(key) {
  for (const fn of watchers) { try { fn(key); } catch (e) { /* 订阅者自己的错不该影响写入 */ } }
}

/** 订阅任意设置变更。返回取消订阅函数。 */
export function subscribe(fn) {
  watchers.add(fn);
  return function () { watchers.delete(fn); };
}

try {
  window.addEventListener('storage', function (e) {
    if (e && e.key && isOurs(e.key)) emit(e.key);
  });
} catch (e) { /* 无 window 时（极端情况）静默 */ }

/* ══════════════════════════════════════════════════════════════
 * 分组 API
 * ══════════════════════════════════════════════════════════════ */

/* ── 上传偏好 ──
   默认 **true**。产品定位是「随走即用」：登录 Phira 后自动贡献成绩，
   定数飞轮才转得起来。但「自动」≠「静默」—— 首次上传前会弹一次明确告知
   （见 app.html 的 ensureNotice()），用户不同意就直接把它关成 false。
   ⚠ 默认值只在这里写一次。历史上 app.html 与文档各写过一遍。 */
export const optin = {
  get() { return bool(KEYS.optin, true); },
  set(on) { return set(KEYS.optin, on ? '1' : '0'); },
};

export const notice = {
  agreed() { return bool(KEYS.notice, false); },
  agree() { return set(KEYS.notice, '1'); },
  /** 撤回：下次上传前会重新征求一次同意。 */
  forget() { return set(KEYS.notice, null); },
};

/* ── Phira 连接信息 ──
   只用于「下次自动填充」。**不含密码，也不接受密码**（见 SECURITY.md）。
   独立成组是为了设置页能一次性展示与清除。 */
export const phira = {
  get() {
    return { name: get(KEYS.phiraName, ''), uid: get(KEYS.phiraUid, '') };
  },
  set(name, uid) {
    set(KEYS.phiraName, name || null);
    set(KEYS.phiraUid, uid || null);
  },
  clear() { set(KEYS.phiraName, null); set(KEYS.phiraUid, null); },
};

export const lastUid = {
  get() { return get(KEYS.lastUid, ''); },
  set(uid) { return set(KEYS.lastUid, uid || null); },
};

/* ── 「本人账号」声明 ──
   Phira 没有给第三方 OAuth，无法做真正的所有权验证；退一步要求用户
   **明确声明一次**。否则任何访问者都能把某个公开 Phira 用户的成绩
   复制进数据集，来源真实性归零。
   声明只存在本地，不依赖账号系统。 */
export const own = {
  is(uid) { return bool(KEYS.ownPrefix + uid, false); },
  mark(uid) { return set(KEYS.ownPrefix + uid, '1'); },
  unmark(uid) { return set(KEYS.ownPrefix + uid, null); },
  list() {
    const s = store();
    if (!s) return [];
    const out = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.indexOf(KEYS.ownPrefix) === 0) out.push(k.slice(KEYS.ownPrefix.length));
      }
    } catch (e) { /* 枚举失败就当没有 */ }
    return out;
  },
};

/* ── 匿名会话 id ──
   只用来把同一个人的多次贡献归到一组（**假名化**，不是严格匿名 ——
   文档里一直这么写，别改成「匿名」）。不携带任何身份信息。 */
export const cid = {
  get() {
    let v = get(KEYS.cid, null);
    if (v) return v;
    v = Math.random().toString(36).slice(2, 10);
    set(KEYS.cid, v);
    return v;
  },
  /** 换一个新身份：之后再贡献的数据不会被归到之前那组。 */
  reset() { set(KEYS.cid, null); return cid.get(); },
};

/* ══════════════════════════════════════════════════════════════
 * 外观主题
 * ══════════════════════════════════════════════════════════════
 * 'auto' = 跟随系统。⚠ 真正写进 `<html data-theme>` 的**只有** dark/light，
 * auto 会先被解析成具体值 —— 因为 CSS 只需要维护两套值，
 * 不必再为 "auto + 系统是浅色" 写第三遍。
 *
 * 【为什么页面 <head> 里还有一段一模一样的内联脚本】
 *   主题必须在**第一次绘制之前**就定好。模块是异步加载的，等它跑完，
 *   用户已经看到默认色闪了一下（FOUC）。所以每页 <head> 里有一段同步的
 *   最小实现，它只认 localStorage 里那个键；这里这份负责后续切换与
 *   跟随系统变化。两边读的是**同一个键**（KEYS.theme）。 */
export const THEME_MODES = ['auto', 'dark', 'light'];

export function applyTheme(mode) {
  const m = mode || theme.get();
  /* ⚠ resolved() 返回的是**模式名字符串**（'dark' / 'light'），不是布尔。
     早先这里写成 `const dark = theme.resolved(m)` 再 `dark ? 'dark' : 'light'` ——
     字符串 'light' 也是真值，于是**每次都被设成 dark**：
     点「深色」恰好正确（巧合），点「浅色」则纹丝不动。
     变量名和类型必须对得上，这种错编译器不会管，只能靠测试。 */
  const resolved = theme.resolved(m);
  const isDark = resolved === 'dark';
  try {
    const el = document.documentElement;
    el.setAttribute('data-theme', isDark ? 'dark' : 'light');
    el.setAttribute('data-theme-mode', m);
  } catch (e) { /* 无 document 时（Node 测）忽略 */ }
  return isDark;
}

/** 标题字体三档：
 *    「serif」= 思源宋体标题（默认）
 *    「kai」  = 霞鹜文楷
 *    「sans」 = 全黑体
 *  ⚠ 只切 --font-display，正文永远是系统黑体 —— 评审的原话是
 *    「正文用系统黑体栈」，所以不做「全站换字体」那种大动作。
 *  ⚠ 「楷体」这一档曾因字体体积被推迟（全量中文 15MB，会拖死首屏）。
 *    现在两套都是**子集**（serif 83KB / kai 63KB），按需加载，代价可以忽略。 */
const FONT_OK = ['serif', 'kai', 'sans'];
export const font = {
  get() { return get(KEYS.font, 'serif'); },
  set(v) {
    const ok = FONT_OK.indexOf(v) >= 0 ? v : 'serif';
    set(KEYS.font, ok);
    applyFont(ok);
    return true;
  },
  apply: applyFont,
};

/** 字号三档。用 html 的 font-size 百分比缩放，**不逐个选择器改 px** ——
 *  全站本来就以 rem/em 为主，改一处全站跟随。 */
export const size = {
  get() { return get(KEYS.size, 'm'); },
  set(v) {
    const ok = (v === 's' || v === 'l') ? v : 'm';
    set(KEYS.size, ok);
    applySize(ok);
    return true;
  },
  apply: applySize,
};

export const theme = {
  get() { return get(KEYS.theme, 'auto'); },
  set(m) { set(KEYS.theme, m); applyTheme(m); return true; },
  /** 把 'auto' 解析成实际生效的 'dark' / 'light' */
  resolved(m) {
    const mode = m || theme.get();
    if (mode === 'dark' || mode === 'light') return mode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'dark'; }
  },
  apply: applyTheme,
};

/** 把字体档位写到 <html data-font> 上 —— CSS 里靠它覆盖 --font-display。 */
export function applyFont(v) {
  try {
    document.documentElement.setAttribute('data-font', FONT_OK.indexOf(v) >= 0 ? v : 'serif');
  } catch (e) { /* 没有 document 的环境（单测）静默跳过 */ }
}

/** 把字号档位写到 <html data-size> 上。 */
export function applySize(v) {
  try {
    document.documentElement.setAttribute('data-size', (v === 's' || v === 'l') ? v : 'm');
  } catch (e) { /* 同上 */ }
}

/* 系统主题变化时，只有 'auto' 模式需要跟着变 */
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSys = function () { if (theme.get() === 'auto') applyTheme('auto'); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);       /* 老 Safari */
} catch (e) { /* 忽略 */ }

/* ── 界面语言 ──
   默认**跟随浏览器**（不写死中文）：首次访问的中文用户看到中文，
   英文用户看到英文，也省掉一次手动切换。用户手动选过就固定住。 */
function guessLang() {
  try {
    const list = navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || 'zh'];
    for (const l of list) {
      if (/^zh/i.test(l)) return 'zh';
      if (/^en/i.test(l)) return 'en';
    }
    return 'zh';
  } catch (e) { return 'zh'; }
}

export const LANGS = ['zh', 'en'];

export const lang = {
  get() { return get(KEYS.lang, null) || guessLang(); },
  set(v) { set(KEYS.lang, v); return true; },
  /** 用户是否手动选过（设置页用它显示"跟随浏览器"状态） */
  explicit() { return get(KEYS.lang, null); },
};

/* ══════════════════════════════════════════════════════════════
 * 盘点 / 导出 / 清空 —— 设置页的「数据」区块用
 * ══════════════════════════════════════════════════════════════ */

/** 列出本站实际存在哪些键（含 own 声明）。设置页据此展示「存了什么」。
 *
 *  @returns [{key, value, labelKey, vars}]
 *    labelKey 是 i18n 词条名，vars 是插值变量 —— 页面自己调 `t(labelKey, vars)`。
 *    本模块不碰 i18n（见 LABELS 上面的说明：会循环依赖）。 */
export function inventory() {
  const rows = [];
  for (const k of PLAIN_KEYS) {
    const v = get(k, null);
    if (v !== null) rows.push({ key: k, value: v, labelKey: LABELS[k] || k, vars: null });
  }
  for (const uid of own.list()) {
    rows.push({ key: KEYS.ownPrefix + uid, value: '1', labelKey: 'set.store.own', vars: { uid } });
  }
  return rows;
}

/** 导出快照（JSON 对象）。只含设置，**不含任何凭据**。
 *  `_note` 是给人看的说明，所以直接写双语 —— 这个文件可能被任何人打开，
 *  而它不经过 i18n（导出的是数据，不是界面）。 */
export function exportAll() {
  const o = {
    _note: 'P.H.M. local settings snapshot / 本地设置快照 — browser settings only, no credentials / 只含浏览器里存的那几项，不含账号凭据',
    _exportedAt: new Date().toISOString(),
    settings: {},
  };
  for (const r of inventory()) o.settings[r.key] = r.value;
  return o;
}

/** 清空本站设置。⚠ 见文件头的第 3 条约束：**不碰别的键**。 */
export function clearAll() {
  for (const k of PLAIN_KEYS) set(k, null);
  for (const uid of own.list()) set(KEYS.ownPrefix + uid, null);
  emit('*');
  return true;
}

/* ══════════════════════════════════════════════════════════════
 * 最近查询 —— 纯便利数据
 * ══════════════════════════════════════════════════════════════
 * 存的是**公开账号名**（谁查过谁的谱师页/成绩页），不含任何身份信息，
 * 也不上传。作用只有一个：回来时不用重新敲一遍。
 *
 * 【为什么一个键存一个 JSON，而不是每个 kind 一个键】
 *   clearAll 的白名单是 PLAIN_KEYS，键名要逐个登记。按 kind 拆键的话，
 *   每加一个页面就得记得同步白名单 —— 漏一次就是「清空」清不掉，
 *   而那种 bug 用户只会以为是"清空坏了"。
 */
const RECENT_KINDS = ['charter', 'user'];
const RECENT_MAX = 6;

/** 取某一类的最近查询（新的在前）。 */
export function recent(kind) {
  if (RECENT_KINDS.indexOf(kind) < 0) return [];
  let o = {};
  try { o = JSON.parse(get(KEYS.recent, '{}')) || {}; } catch (e) { o = {}; }
  const arr = o[kind];
  return Array.isArray(arr) ? arr.filter(x => typeof x === 'string').slice(0, RECENT_MAX) : [];
}

/** 记一条（去重、置顶、截断）。返回是否写成功。 */
export function pushRecent(kind, value) {
  if (RECENT_KINDS.indexOf(kind) < 0) return false;
  const v = String(value == null ? '' : value).trim().slice(0, 64);
  if (!v) return false;
  let o = {};
  try { o = JSON.parse(get(KEYS.recent, '{}')) || {}; } catch (e) { o = {}; }
  const arr = (Array.isArray(o[kind]) ? o[kind] : [])
    .filter(function (x) { return typeof x === 'string' && x !== v; });
  arr.unshift(v);
  o[kind] = arr.slice(0, RECENT_MAX);
  return set(KEYS.recent, JSON.stringify(o));
}

/* ══════════════════════════════════════════════════════════════
 * 只读测试钩子
 * ══════════════════════════════════════════════════════════════
 * 让 tools/verify-pages.mjs 能断言**真身**的行为，而不是 grep 源码。
 * 纯读写封装，不含任何凭据，暴露出来没有额外风险。 */
try {
  window.PHM_SETTINGS = Object.freeze({
    KEYS, PLAIN_KEYS, LABELS, available,
    optin, notice, phira, lastUid, own, cid,
    theme, lang, THEME_MODES, LANGS, applyTheme,
    inventory, exportAll, clearAll,
  });
} catch (e) { /* 无 window 时跳过 */ }
