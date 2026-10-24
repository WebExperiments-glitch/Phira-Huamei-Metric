/* ============================================================
 * lib/phira-proxy.mjs —— /api/phira/* 上游代理
 * ============================================================
 * 【为什么单独一个模块】
 *   这里是**唯一**能把请求发到 Phira 上游的出口。白名单写错一个字，
 *   我们的服务器就变成公开爬虫的代理（出口 IP + 带宽白送）。
 *   所以它必须：① 孤立可测 ② 判据写在最显眼的地方 ③ 主文件不超行数上限。
 *
 * 【2026-10-24 防御审计修的那一条】
 *   `new URL().pathname` 只折叠**字面**的 `..`；编码的 `%2e%2e` 会原样留下。
 *   于是 `/api/phira/chart/%2e%2e/user/1` 能通过 `startsWith('/chart/')`，
 *   拼成 `https://api.phira.cn/chart/%2e%2e/user/1`，
 *   而 fetch 解析时把 `%2e%2e` 折叠成 `..` → 实际打到 `/user/1`。
 *   → 现在：先拒可疑形态 → 构造 URL → 对 **归一化后的 pathname** 判白名单
 *     → 再确认 origin 没变。
 * ============================================================ */

const PHIRA_API = 'https://api.phira.cn';

/* 允许透传的前缀。**只增不改**，且必须是上游真实存在的路径。 */
const PHIRA_PROXY_PATHS = [
  '/chart',            // 谱面元数据 + 文件直链
  '/chart/',           // 同上（带 id）
  '/record/best/',     // 自己的最佳成绩
  '/record/recent',    // 最近成绩
  '/terms/',           // 服务条款 / 隐私政策（客户端要读）
  '/music',            // 谱面音频
];

/**
 * @returns {Promise<boolean>} 处理了返回 true（⚠ 返回 falsy 会被当成没命中，
 *          继续走 send404 → ERR_HTTP_HEADERS_SENT → 整个进程退出）
 */
export async function phiraProxy(req, res, url, p, ip, gate, gateProxy, send, SEC_HEADERS) {
  if (p !== '/api/phira' && !p.startsWith('/api/phira/')) return false;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 403, JSON.stringify({ error: 'only GET/HEAD' }));
    }
    if (!(await gate(res, gateProxy({ ip }), 'rate limit'))) return;
    const sub = p.replace(/^\/api\/phira/, '') || '/';
    /* ── 白名单必须在**归一化之后**判 ──
       ⚠ 2026-10-24 防御审计指出并核实：`new URL().pathname` 只折叠**字面**的 `..`，
         编码的 `%2e%2e` 会原样留下 → `/api/phira/chart/%2e%2e/user/1` 通过
         `startsWith('/chart/')`，拼成 `https://api.phira.cn/chart/%2e%2e/user/1`，
         而 fetch 解析时把 `%2e%2e` 折叠成 `..` → 实际请求 `/user/1`。
         等于把我们 2026-10-13 堵上的「公开爬虫出口」重新打开。
       → 先显式拒掉可疑形态，再构造 URL，再对 **target.pathname** 判白名单，
         并要求 origin 没变。 */
    if (/%2e|%2f|%5c|\\|\.\./i.test(sub)) {
      return send(res, 404, JSON.stringify({ error: 'path not allowed' }));
    }
    let target;
    try {
      target = new URL(PHIRA_API + sub + (url.search || ''));
    } catch (e) {
      return send(res, 404, JSON.stringify({ error: 'bad path' }));
    }
    if (target.origin !== PHIRA_API) {
      return send(res, 404, JSON.stringify({ error: 'path not allowed' }));
    }
    /* 前缀不匹配 → 404，**不要**透传。
       ⚠ 用 startsWith 而不是正则：前缀是写死的字面量，正则只会引入意外。
       ⚠ 判的是 target.pathname（已归一化），不是原始 sub。 */
    if (!PHIRA_PROXY_PATHS.some(pre => target.pathname === pre || target.pathname.startsWith(pre))) {
      return send(res, 404, JSON.stringify({ error: 'path not allowed' }));
    }
    /* ⚠ 条件请求头必须转发。
       客户端用 HEAD `/terms/{locale}.txt` + `If-Modified-Since` 判断
       「服务条款有没有变」—— 只靠响应里的 `Last-Modified`。
       把这两个头截掉，客户端会直接报
       `获取服务条款和隐私政策内容失败 / invalid last-modified header`。
       （实测：代理只回 content-type 时，条款页永远打不开。） */
    const fwd = {};
    for (const h of ['if-modified-since', 'if-none-match']) {
      if (req.headers[h]) fwd[h] = req.headers[h];
    }
    try {
      const up = await fetch(target, {
        method: req.method,
        headers: Object.assign({
          'accept': 'application/json,text/plain,*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'user-agent': 'phm-huamei/1.0 (+https://phm.app.workbuddy.host)',
        }, fwd),
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const buf = Buffer.from(await up.arrayBuffer());
      /* 回程头白名单 —— **不能只回 content-type**。
         `last-modified` / `etag` 是条件请求的判据；
         `content-length` 给 HEAD 用；`accept-ranges` 留给续传。 */
      const out = { 'content-type': up.headers.get('content-type') || 'application/json; charset=utf-8' };
      for (const h of ['last-modified', 'etag', 'content-length', 'accept-ranges']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      out['cache-control'] = 'no-store';
      res.writeHead(up.status, Object.assign(out, SEC_HEADERS));
      return res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: 'upstream: ' + String(e.message || e).slice(0, 120) }));
    }

  return false;
}
