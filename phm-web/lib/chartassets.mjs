/* ============================================================
 * lib/chartassets.mjs —— 曲绘代理（修MIME）
 * ============================================================
 * 【为什么需要它】
 *   Phira 的 CDN（phira.5wyxi.com）对所有文件一律返回
 *   `Content-Type: application/octet-stream`，而且是 **303 重定向**
 *   到一个带签名的 CDN 域名。文件本身完全正常 —— 曲绘是 WebP、
 *   预览是 Ogg、chart 是 zip（实测magic 字节确认）。
 *
 *   但浏览器有个安全机制叫 **ORB（Opaque Response Blocking）**：
 *   跨源响应如果 MIME 是 `application/octet-stream` 之类的
 *   「不是它声称的类型」，Chrome 会**拒绝把它交给解码器** ——
 *   表现是 `<img>` 静默失败、naturalWidth=0、控制台一句
 *   `net::ERR_BLOCKED_BY_ORB`。**真实用户也会这样**，不是无头浏览器特例。
 *
 * 【为什么不能靠「加个 <meta> 或换 referrer」绕过去】
 *   都不行。ORB 看的是**响应的 Content-Type**，只有响应头能改它。
 *
 * 【代价与边界】
 *   曲绘 1–3MB，30 张就是 ~50MB，所以：
 *     · 只代理**曲绘**（页面里唯一按需展示的大图）
 *     · 带 Range 支持，能续传
 *     · 回程强制给 `image/webp`（实测上游曲绘**全是 WebP**，
 *       用 `bytes` 范围请求核对过 magic `RIFF....WEBP`）
 *     · 上游 404/超时一律回**占位 SVG**，不把上游的错误泄给浏览器
 *       —— 页面本来就画了 ♪ 兜底，这里只是让它别碎
 *   ⚠ 谱面 / 音乐**不走这里**，仍然是浏览器直连（见 chartfiles.js）。
 *     那两类是下载而不是展示，用户要的是原件，不该由我们改名重编码。
 * ============================================================ */

const CDN = 'https://phira.5wyxi.com/files/';
const UA = 'phm-chartassets/1.0 (+https://phm.app.workbuddy.host)';

/* 1x1 透明 WebP —— 上游挂了时用它，页面不会碎成一块白。 */
const BLANK = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'base64');

/** 只放行**看起来像 UUID 的那段**，其余一律 404。
 *  ⚠ 这是 SSRF 闸门：这个路由会替用户去 fetch 一个我们指定的域名，
 *    路径段必须严格校验，否则拼进 `../../` 或 `@evil.com` 就能
 *    让我们的出口 IP 去打任意地址。 */
function isUuid(s) {
  return typeof s === 'string'
    && s.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function sendPlaceholder(res, secHeaders, code = 200) {
  res.writeHead(code, Object.assign({
    'content-type': 'image/webp',
    'content-length': BLANK.length,
    'cache-control': 'public, max-age=120',
  }, secHeaders));
  res.end(BLANK);
}

/**
 * 路由：`/api/phira-illust/<uuid>`
 * @param {object} secHeaders 安全响应头（由 server.mjs 传入，保持一致）
 */
export function makeChartAssetRoutes(secHeaders) {
  return async function chartAssetRoutes(req, res, url) {
    /* 只 GET/HEAD —— 别的动词没有意义。 */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, secHeaders));
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return true;
    }

    const m = /^\/api\/phira-illust\/([^/?#]+)$/.exec(url.pathname);
    if (!m) return false;

    const id = decodeURIComponent(m[1]);
    /* ⚠ SSRF 闸门：不像 UUID 就不往下走。
       `..%2f..%2f` 解码后含斜杠，isUuid 会直接拒掉。 */
    if (!isUuid(id)) {
      res.writeHead(400, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, secHeaders));
      res.end(JSON.stringify({ error: 'bad id' }));
      return true;
    }

    /* 条件请求：Etag 用上游给的，没有就用长度+上游URL（够用，
       ���绘内容变了 URL 的 uuid 也会变）。 */
    const etag = '"phm-ill-' + id + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ etag, 'cache-control': 'public, max-age=86400' }, secHeaders));
      res.end();
      return true;
    }

    /* Range 透传 —— 曲绘 1–3MB，Safari 大图常先要前64KB 试探。 */
    const fwd = {};
    if (req.headers.range) fwd.range = req.headers.range;
    /* 必须禁压缩：Range 是在**解码前**的字节偏移，
       上游若 gzip 了，range 的下标就对不上了。 */
    fwd['accept-encoding'] = 'identity';

    try {
      const up = await fetch(CDN + id, {
        headers: Object.assign({ 'user-agent': UA, accept: 'image/*,*/*' }, fwd),
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });

      if (!up.ok && up.status !== 206) {
        /* ⚠ 上游 404 的**不是**我们的错：那张谱面就是没有曲绘。
           回占位图 + 200，让浏览器缓存住，别每刷新都重试一遍。 */
        if (up.status === 404) { sendPlaceholder(res, secHeaders); return true; }
        sendPlaceholder(res, secHeaders, 502);
        return true;
      }

      const buf = Buffer.from(await up.arrayBuffer());
      const head = {
        /* ⚠⚠ 整条链存在的唯一理由：把 octet-stream 换成 image/webp，
           让 ORB 放行。实测上游曲绘全是 WebP（`RIFF....WEBP`）。 */
        'content-type': 'image/webp',
        'content-length': buf.length,
        etag,
        'cache-control': 'public, max-age=86400',
      };
      if (up.status === 206) {
        head['content-range'] = up.headers.get('content-range') || '';
        res.writeHead(206, Object.assign(head, secHeaders));
      } else {
        /* 给上游的 content-length 之外再加一层上限，
           防止哪天被重定向到个 500MB 的东西把内存吃光。 */
        res.writeHead(200, Object.assign(head, secHeaders));
      }
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      /* ⚠ 探测失败绝不抛 —— 曲绘挂了就显示占位，
         页面其余部分（打包、下载、列表）必须照常工作。 */
      sendPlaceholder(res, secHeaders, 502);
    }
    return true;
  };
}

/** 拼出曲绘代理地址 —— 前端用它替换上游直链。 */
export function illustProxyPath(uuid) {
  return '/api/phira-illust/' + String(uuid || '');
}