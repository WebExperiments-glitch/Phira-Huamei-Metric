/* ============================================================
 * lib/api-files.mjs —— 上游文件的中转（**流式**，不落盘）
 * ============================================================
 * 【为什么必须有这个]
 *   2026-11-10 实测：`phira.5wyxi.com/files/xxx` 现在返回 **303**，
 *   重定向到 `phira-cdn.5wyxi.com/<id>?sign=...`。
 *   那个 CDN 的响应头里有：
 *     Access-Control-Allow-Methods: GET,HEAD
 *     Access-Control-Allow-Headers: *
 *     Access-Control-Max-Age: 3600
 *   但**唯独没有 Access-Control-Allow-Origin** —— CORS 检查因此失败，
 *   浏览器 fetch 直接报 "Failed to fetch"。
 *   我们改不了上游的 CDN 配置，所以浏览器直连这条路已经不通。
 *
 *   ⚠ 这与最初的设计意图相反：原本"曲绘/音频由浏览器直连 CDN，
 *     我们的服务器只传字符串"（省带宽、避开 DMCA）。
 *     现在直连 100% 失败，中转是唯一能用的方案。
 *     折中：前端仍**先试直连**，失败才回落这里 —— 上游哪天修好 CORS，
 *     就自动回到零中转。所以这个端点必须一直在。
 *
 * 【为什么不落盘】
 *   谱面包 6~40MB。落盘会让我们变成文件仓库（磁盘 + 清理 + 版权），
 *   而这里只需要当一次管道：上游 → 内存块 → 客户端。
 *
 * 【限制】白名单域名、大小上限、超时。没有这三样，
 *   这个端点就是一个开放的带宽放大器 —— 谁都能借我们的出口下载任意文件。
 * ============================================================ */

/* 只允许这两个域：上游现在是 5wyxi.com 跳 5wyxi-cdn.com。
   ⚠ 用 hostname 精确匹配，不做 endsWith 模糊匹配 —— 否则
     `evil.5wyxi.com.attacker.net` 这类域名能绕过。 */
const ALLOW_HOSTS = new Set(['phira.5wyxi.com', 'phira-cdn.5wyxi.com']);

const MAX_BYTES = 120 * 1024 * 1024;   /* 与前端 chartfiles.js 的上限一致 */
const TIMEOUT_MS = 25_000;

export function isAllowedFileUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return ALLOW_HOSTS.has(u.hostname);
}

/* 流式转发。返回 true 表示已处理。 */
export async function proxyFile(res, rawUrl, { json, apiErr } = {}, filename = '') {
  const target = String(rawUrl || '');
  if (!isAllowedFileUrl(target)) {
    apiErr(res, 400, 'invalid_request_error', 'url_not_allowed',
      'only phira.5wyxi.com / phira-cdn.5wyxi.com are allowed');
    return true;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'phm-file-proxy/1' },
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    apiErr(res, timeout ? 504 : 502, 'server_error', timeout ? 'upstream_timeout' : 'upstream_unreachable',
      timeout ? 'upstream did not respond in time' : 'could not reach upstream');
    return true;
  }

  if (!upstream.ok) {
    apiErr(res, 502, 'server_error', 'upstream_error', 'upstream returned HTTP ' + upstream.status);
    return true;
  }

  /* Content-Length 可能缺失（分块传输）—— 缺失就不预检，靠下面边传边数 */
  const len = Number(upstream.headers.get('content-length')) || 0;
  if (len > MAX_BYTES) {
    apiErr(res, 413, 'invalid_request_error', 'file_too_large',
      'file exceeds ' + Math.round(MAX_BYTES / 1048576) + 'MB');
    return true;
  }

    /* ⚠ 不能把上游的 content-type 原样反射回去。
       白名单主机若返回 text/html 或 text/javascript，浏览器会按**同源内容**渲染 ——
       那就等于我们主动提供了一个同源 XSS 页面（nosniff 只挡 MIME 嗅探，不挡显式
       text/html）。只放行图片与二进制，其余一律降级为 octet-stream。
       2026-11-14 安全审计 P1-1 指出，此处已核实。 */
    const rawType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const SAFE_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'application/octet-stream']);
    const type = SAFE_TYPES.has(rawType) ? rawType : 'application/octet-stream';
    /* 文件名由调用方给（?n=）。为什么要服务端下发：
       手机浏览器（尤其 iOS Safari）对 <a download> 的支持不可靠，
       而 URL 是 /api/v1/file?u=... —— 拿不到像样的名字，落盘就成了无后缀的 "file"。
       用 RFC 5987 的 filename* 才能带中文。⚠ 必须滤掉 CR/LF，否则是响应头注入。 */
    const safeName = String(filename || '').replace(/[\r\n]/g, '').trim();
    res.writeHead(200, {
      'content-type': type,
      ...(safeName ? { 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(safeName) } : {}),
    ...(len ? { 'content-length': String(len) } : {}),
    /* private + 1h：允许浏览器缓存，但**不允许任何共享缓存**存下来 ——
       否则我们的出口会被当成 CDN 的副本，版权与带宽都失控。 */
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'x-proxied-from': 'phm-file-proxy',
  });

  /* 流式管道：8MB 的文件不会在内存里堆成 8MB×N */
  const { Readable } = await import('node:stream');
  const body = Readable.fromWeb(upstream.body);
  await new Promise((resolve) => {
    let sent = 0;
    body.on('data', (chunk) => {
      sent += chunk.length;
      if (sent > MAX_BYTES) { body.destroy(); res.destroy(); resolve(); }
    });
    body.on('error', () => { res.destroy(); resolve(); });
    res.on('close', resolve);
    body.pipe(res);
    res.on('finish', resolve);
  });
  return true;
}

/* 路由处理入口：由 api-routes 在鉴权后调用，避免那个文件继续变长。 */
export async function handleFileRoute(res, reqUrl, deps) {
  const q = String(reqUrl || '').split('?')[1] || '';
  const sp = new URLSearchParams(q);
  const u = sp.get('u') || '';
  /* ?n= 是下载时希望的文件名。不给就不设 Content-Disposition（保持原行为）。 */
  await proxyFile(res, u, deps, sp.get('n') || '');
}
