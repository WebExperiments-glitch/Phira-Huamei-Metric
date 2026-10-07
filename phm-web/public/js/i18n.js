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
import common from './i18n/common.js';
import home from './i18n/home.js';
import app from './i18n/app.js';
import charter from './i18n/charter.js';
import user from './i18n/user.js';
import data from './i18n/data.js';
import legal from './i18n/legal.js';
import settings from './i18n/settings.js';

/* ══════════════════════════════════════════════════════════════
 * 字典：按页面分片，在这里合并
 * ══════════════════════════════════════════════════════════════
 * 【为什么要分片】
 *   全站文案合起来近千条 —— 塞进一个文件就是两千多行，
 *   改一句首页文案要在里面翻半天。分片之后，"翻某一页"只动一个文件。
 *
 * 【新页面怎么加】
 *   1. 在 js/i18n/ 下建一个文件，导出 { zh: {...}, en: {...} }
 *   2. 在上面 import 进来
 *   3. 加进下面 FRAGMENTS 数组 ← 忘了这步就等于没翻，lint 会拦
 *
 * ⚠ 中英**写在同一个文件里**是刻意的：分语言拆文件会让"改一个词"
 *   变成开两个文件、两处对齐，迟早漂移。
 * ⚠ 重复 key 会被下面检查出来 —— 分片最容易出的错就是两片都定义了同一个 key，
 *   而 Object.assign 会**静默**让后者覆盖前者。宁可崩一下让人看见。
 */
const FRAGMENTS = [
  ['common', common], ['home', home], ['app', app], ['charter', charter],
  ['user', user], ['data', data], ['legal', legal], ['settings', settings],
];

const DICT = { zh: {}, en: {} };
const OWNER = {};        /* key → 分片名，用于报错时指出是谁 */
for (const [name, frag] of FRAGMENTS) {
  for (const lang of ['zh', 'en']) {
    const bag = (frag && frag[lang]) || {};
    for (const k of Object.keys(bag)) {
      if (OWNER[k] && OWNER[k] !== name) {
        throw new Error('i18n 词条「' + k + '」被 ' + OWNER[k] + ' 和 ' + name + ' 重复定义');
      }
      OWNER[k] = name;
      DICT[lang][k] = bag[k];
    }
  }
}

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
    /* 词条属于哪个分片 —— 测试拿它反查"这页的词有没有落到自己的文件里" */
    owner: (k) => OWNER[k] || null,
    fragments: () => FRAGMENTS.map(f => f[0]),
  });
} catch (e) { /* 无 window 时跳过 */ }

/* 页面一加载就把语言写到 <html> 上（CSS 里可以用 [data-lang="en"] 做微调，
   例如英文文案更长时放宽某些容器）。 */
try {
  const v = currentLang();
  document.documentElement.setAttribute('lang', v === 'zh' ? 'zh-CN' : 'en');
  document.documentElement.setAttribute('data-lang', v);
} catch (e) { /* 忽略 */ }
