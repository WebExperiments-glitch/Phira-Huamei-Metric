/* ============================================================
 * js/redirect.js —— 登录后的跳转目标
 * ============================================================
 * 【为什么单独抽出来】
 *   这是**安全相关**的逻辑：?redirect= 来自 URL，用户完全可控。
 *   之前它内联在 login.html 里，没法写单测 —— 内联脚本测不了，
 *   于是就没人测。现在抽成模块，`tools/test-redirect.mjs` 直接 import 它。
 *
 * 【威胁】
 *   redirect=javascript:alert(1)   → 登录后执行脚本（XSS）
 *   redirect=//evil.example        → 协议相对 URL，跳到外站（钓鱼）
 *   redirect=https://evil.example   → 外站绝对 URL
 *   redirect=/ 反斜杠 evil.example → 反斜杠在部分浏览器里被当斜杠
 *   redirect=%0a//evil.example     → 控制字符绕过
 *
 * 【规则】只允许**站内相对路径**：以单个斜杠开头，不含双斜杠、反斜杠、控制字符。
 */

const DEFAULT_REDIRECT = '/app';

/* 控制字符类：U+0000-U+001F、U+007F，以及任何空白（含 %00 解码后的） */
const CTRL_RE = new RegExp('[\\u0000-\\u001f\\u007f\\s]');

export function safeRedirect(raw, dflt = DEFAULT_REDIRECT) {
  const v = raw == null ? '' : String(raw);
  if (!v) return dflt;
  /* 以单个斜杠开头；双斜杠（协议相对）与斜杠+反斜杠都要排除 */
  if (!/^\/(?![/\\])/.test(v)) return dflt;
  /* 反斜杠：部分浏览器把它当斜杠 */
  if (v.includes('\\')) return dflt;
  /* 控制字符与空白 */
  if (CTRL_RE.test(v)) return dflt;
  return v;
}

/* 从当前地址取 redirect（页面里用） */
export function redirectFromLocation(href, dflt = DEFAULT_REDIRECT) {
  let raw = '';
  try { raw = new URL(href).searchParams.get('redirect') || ''; } catch { /* 忽略 */ }
  return safeRedirect(raw, dflt);
}
