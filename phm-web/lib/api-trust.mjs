/* ============================================================
 * lib/api-trust.mjs —— 协议自洽性评分（不弹验证就判断是不是真人）
 * ============================================================
 * 【为什么只能做这一层】
 *   2026 年判断真人最强的信号是 TLS 指纹（JA4）、HTTP/2 帧序、IP/ASN 信誉。
 *   但我们的流量在 CloudStudio 网关就终止了 TLS —— 客户端真实指纹、
 *   真实 IP、头部顺序全被网关吃掉（这也是"匿名共用一个 IP 桶"的同一根因）。
 *   所以只能退到**应用层协议自洽性**：请求自己说的和实际带的东西一致吗？
 *
 * 【核心原则：只怀疑"装作浏览器"的，不惩罚"明说是脚本"的】
 *   curl / python-requests / okhttp / 监控 UA 明确承认自己是机器 —— 它们是
 *   合法使用方式，扣分等于把正门锁上。真正该怀疑的是：UA 声称是 Chrome，
 *   却既不送 sec-ch-ua、也没有 sec-fetch-*，更没有 origin —— 那是在伪装。
 *
 * 【动作】低分不直接拒绝，而是**要求 PoW 挑战**：
 *   真人 / 诚实脚本几毫秒过；伪装者每请求都要付计算成本。
 *   这比 CAPTCHA 无感，比直接 403 不容易误伤。
 *
 * 【阈值为什么是 50】
 *   隐私插件会剥掉 sec-ch-ua（-30），某些旧浏览器没有 sec-fetch（-15），
 *   两者叠加到 55 —— 仍然通过。要掉到 50 以下，基本得同时缺三样。
 * ============================================================ */

/* 明确承认自己是机器的 UA：不扣分 */
const HONEST_BOT = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|undici|axios|okhttp|go-http-client|java\/|libwww|postmanruntime|insomnia|uptime|monitor|better\s*stack|pingdom|statuscake|bot\b|crawler|spider)/i;

export function trustSignals(req) {
  const h = (req && req.headers) || {};
  const ua = String(h['user-agent'] || '');
  const url = String((req && req.url) || '');
  const isApi = url.startsWith('/api/');
  const reasons = [];
  let score = 100;

  const honestBot = HONEST_BOT.test(ua);
  const claimsBrowser = /Mozilla\//i.test(ua) && /(Chrome|Firefox|Safari|Edg)\//i.test(ua);

  /* 空 UA：既不是浏览器也不是诚实的脚本 —— 可疑但不是决定性 */
  if (!ua) { score -= 20; reasons.push('empty_ua'); }

  if (claimsBrowser && !honestBot) {
    const chUa = String(h['sec-ch-ua'] || '');
    const chPlatform = String(h['sec-ch-ua-platform'] || '').replace(/"/g, '');
    const fetchMode = String(h['sec-fetch-mode'] || '');
    const fetchDest = String(h['sec-fetch-dest'] || '');

    /* ① 声称 Chrome 却不送 Client Hints（Firefox/Safari 本来就不送，所以只查 Chrome） */
    if (/Chrome\//i.test(ua) && !chUa) { score -= 30; reasons.push('chrome_without_client_hints'); }

    /* ② UA 的 OS 与 sec-ch-ua-platform 矛盾 —— 跨层不一致是强信号 */
    if (chPlatform) {
      const uaWin = /Windows/i.test(ua);
      const uaMac = /Macintosh|Mac OS X/i.test(ua);
      const uaLinux = /Linux/i.test(ua) && !/Android/i.test(ua);
      if ((uaWin && /macOS|Linux|Android/i.test(chPlatform))
        || (uaMac && /Windows|Linux|Android/i.test(chPlatform))
        || (uaLinux && /Windows|macOS|Android/i.test(chPlatform))) {
        score -= 25;
        reasons.push('platform_mismatch');
      }
    }

    /* ③ 导航请求却在调 API —— 真人是点出来的，不是"导航"到 API */
    if (isApi && fetchMode === 'navigate') { score -= 25; reasons.push('navigate_on_api'); }

    /* ④ 完全没有 Fetch Metadata（现代浏览器一定带） */
    if (!fetchMode && !fetchDest) { score -= 15; reasons.push('no_fetch_metadata'); }

    /* ⑤ 浏览器从页面发起的同源请求一定带 Origin 或 Referer */
    if (isApi && !h['origin'] && !h['referer']) { score -= 15; reasons.push('no_origin'); }
  }

  return {
    score: Math.max(0, score),
    reasons,
    claimsBrowser,
    honestBot,
    /* 低于这个分数才要求 PoW；正常浏览器 100，隐私插件最多掉到 55 */
    sus: score < 50,
  };
}
