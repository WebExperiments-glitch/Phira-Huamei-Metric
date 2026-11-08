/* tools/test-redirect.mjs —— 登录跳转目标的白名单单测
 *
 * 跑法： node tools/test-redirect.mjs
 *
 * 【为什么必须有】
 *   ?redirect= 完全由用户控制。放任它就是开放重定向 + 可能的 XSS，
 *   而这类代码**内联在 HTML 里就没人能测**（内联脚本没法 import）。
 *   所以它必须住在模块里，而且必须有单测。
 */
import { safeRedirect, redirectFromLocation } from '../public/js/redirect.js';

let pass = 0, fail = 0;
const T = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → 实际得到 ' + JSON.stringify(got)); }
};

/* ── 应该被放行的：站内相对路径 ── */
T('站内路径原样放行', safeRedirect('/app') === '/app', safeRedirect('/app'));
T('带查询串的站内路径放行', safeRedirect('/packs?q=x') === '/packs?q=x', safeRedirect('/packs?q=x'));
T('带 hash 的站内路径放行', safeRedirect('/app#top') === '/app#top', safeRedirect('/app#top'));
T('深层路径放行', safeRedirect('/a/b/c') === '/a/b/c', safeRedirect('/a/b/c'));
T('空值回落到默认值', safeRedirect('') === '/app', safeRedirect(''));
T('null 回落到默认值', safeRedirect(null) === '/app', safeRedirect(null));
T('undefined 回落到默认值', safeRedirect(undefined) === '/app', safeRedirect(undefined));

/* ── 应该被挡下的 ── */
const BAD = [
  ['javascript: 协议', 'javascript:alert(1)'],
  ['大写 JavaScript 协议', 'JavaScript:alert(1)'],
  ['data: 协议', 'data:text/html,<script>alert(1)</script>'],
  ['协议相对 URL', '//evil.example/steal'],
  ['外站绝对 URL', 'https://evil.example/steal'],
  ['http 外站', 'http://evil.example'],
  ['反斜杠伪装', '/\\evil.example'],
  ['带空格的路径', '/ app'],
  ['带换行的路径', '/app\n//evil.example'],
  ['带制表符的路径', '/app\t//evil.example'],
  ['纯空白的 redirect', '   '],
  ['裸路径 app', 'app'],
  ['点路径', './app'],
  ['父路径上跳', '../other'],
];
for (const [name, v] of BAD) {
  T('挡下 ' + name, safeRedirect(v) === '/app', safeRedirect(v));
}

/* ── 从 URL 里取也要过同一道门 ── */
T('从 URL 取站内路径',
  redirectFromLocation('https://phm.app.workbuddy.host/login?redirect=/packs') === '/packs');
T('从 URL 取恶意目标 → 回落',
  redirectFromLocation('https://phm.app.workbuddy.host/login?redirect=//evil.example') === '/app');
T('从畸形 URL 取值不抛异常',
  redirectFromLocation('not a url') === '/app');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
