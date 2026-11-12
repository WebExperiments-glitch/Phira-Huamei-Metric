/* lib/cookies.mjs —— 读 / 写 Cookie（只为把登录 token 从 localStorage 挪走）
 *
 * 【为什么要挪】
 *   token 现在在 localStorage（`phm_hm_token`），而 CSP 里有 `'unsafe-inline'`。
 *   两个凑一起：页面上只要注入一段脚本，token 就被读走，账号直接丢。
 *   HttpOnly cookie 浏览器不交给 JS —— 注入的脚本读不到它。
 *
 * 【为什么分两步走，不一次改完】
 *   本项目一直用 `x-hm-token` 头发 token，注释里写着「托管网关会吃掉 Authorization，真踩过」。
 *   那么 Cookie 头会不会也被吃掉，是**未知**的。
 *   所以第一步只做「服务端接受 Cookie 兜底」，签发与前端一行不动 ——
 *   万一 Cookie 不通，功能完全不受影响（header 优先）。
 *   线上验证 Cookie 确实能穿透之后，第二步才删 localStorage。
 *
 * 【为什么 cookie 名不叫 phm_hm_token】
 *   localStorage 的键和 cookie 的值分开命名，避免两处混淆。
 *   而且 `__Host-` 前缀有硬性要求（Secure + Path=/ + 不能有 Domain），
 *   托管环境下我们没法保证 `__Host-` 的所有前置条件，所以不用它，改用手动约束。
 */

const TOKEN_COOKIE = 'phm_sess';

/** 从 Cookie 头里取一个值。没找到返回 ''。 */
export function readCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

/** 登录 token 的 cookie 名 */
export const TOKEN_COOKIE_NAME = TOKEN_COOKIE;

/**
 * 生成 Set-Cookie 的值。
 * @param {string} token  登录 token（Clear 时传空字符串）
 * @param {object} opt    { maxAge }  秒；0 或负数 = 立即过期
 *
 * ⚠ HttpOnly 是核心：JS 读不到它，XSS 就偷不走。
 * ⚠ SameSite=Lax：跨站 POST 不带 cookie（挡 CSRF），但正常站内跳转仍会带。
 * ⚠ Secure：只在 https 下发。本地 http 调试时浏览器会丢，所以按协议判断。
 * ⚠ Path=/：全站可用（否则 /api 之外的页面读不到）。
 */
export function tokenCookie(token, { maxAge = 60 * 60 * 24 * 30, secure = true } = {}) {
  const parts = [
    TOKEN_COOKIE + '=' + encodeURIComponent(String(token || '')),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  if (token) parts.push('Max-Age=' + Math.max(0, Math.floor(maxAge)));
  else parts.push('Max-Age=0');   /* 清除 */
  return parts.join('; ');
}
/**
 * 从请求里取出登录 token。
 * 顺序：x-hm-token 头 → Cookie。**绝不回退 Authorization** —— 那里只认 sk- API Key
 * （早先回退过一次，网关注入的 token 被当成账号 token 去验，
 *   匿名看用量的人拿到 account_token_invalid，错得很有迷惑性）。
 */
export function tokenFromRequest(req) {
  const hdr = String((req && req.headers && req.headers['x-hm-token']) || '').trim();
  if (hdr) return hdr;
  return readCookie(req, TOKEN_COOKIE);
}
