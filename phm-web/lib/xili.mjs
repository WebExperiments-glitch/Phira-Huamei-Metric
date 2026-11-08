/* ============================================================
 * lib/xili.mjs —— 看板娘成品图的**受控投递**
 * ============================================================
 * 【为什么不能直接放 public/】
 *   public/img/xili/fullbody.webp 一旦存在，任何人都能：
 *     右键存图 / 直接请求 URL / 批量爬。
 *   而「看板娘在页面角落出现」这件事，根本不需要一个可下载的文件。
 *
 * 【所以拆成 36 块 + 短签名】
 *   ① 前端先要 manifest：/api/xili/manifest/fullbody
 *      服务端校验**同源**（Origin / Referer 的 host 必须等于本站 host），
 *      通过后发一张 5 分钟有效的签名。
 *   ② 再按签名逐块取图：/api/xili/tile/fullbody/3-4?exp=…&sig=…
 *      块本身没有签名拿不到；签名过期拿不到。
 *
 * 【能做到什么、不能做到什么（写清楚，别自欺）】
 *   ✓ 提高成本：直接抓 URL → 403；抓单块 → 只有 1/36，且带满屏水印
 *   ✓ 留痕：水印烘在像素里，拼回去也带着
 *   ✗ 拦不住：截屏、录屏、DevTools 导出 canvas
 *   真正的源头防线是**原图不在仓库里**（assets/ 已 gitignore，且仓库是公开的）。
 * ============================================================ */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'xili');
const TTL_MS = 5 * 60 * 1000;

function sig(key, exp, secret) {
  return crypto.createHmac('sha256', secret).update(key + '.' + exp).digest('base64url').slice(0, 26);
}

/** 同源判定：Origin 优先，其次 Referer。都没有就拒绝（curl 直接打会被挡）。 */
function sameOrigin(req) {
  const host = (req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
  }
  const ref = req.headers.referer;
  if (ref) {
    try { return new URL(ref).host.toLowerCase() === host; } catch { return false; }
  }
  return false;
}

export function makeXiliRoutes({ secret, secHeaders }) {
  const key = secret || 'xili-dev-secret';

  const send = (res, code, body, headers) => {
    res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers, secHeaders || {}));
    res.end(body);
  };

  return function xiliRoutes(req, res, url) {
    const m = url.pathname.match(/^\/api\/xili\/(manifest|tile)\/([a-z]+)(?:\/(\d+-\d+))?$/);
    if (!m) return false;

    const [, kind, name, idx] = m;

    if (kind === 'manifest') {
      if (!sameOrigin(req)) return send(res, 403, JSON.stringify({ error: 'forbidden' })), true;
      const metaPath = path.join(DIR, name, 'meta.json');
      if (!fs.existsSync(metaPath)) return send(res, 404, JSON.stringify({ error: 'not found' })), true;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const exp = Date.now() + TTL_MS;
      send(res, 200, JSON.stringify(Object.assign({}, meta, { exp, sig: sig(name, exp, key) })), {
        /* manifest 是**凭据**，任何缓存都可能把它发给别人 */
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, noimageindex',
      });
      return true;
    }

    /* ── tile ── */
    const exp = Number(url.searchParams.get('exp') || 0);
    const got = url.searchParams.get('sig') || '';
    if (!exp || exp < Date.now()) return send(res, 403, JSON.stringify({ error: 'expired' })), true;
    const want = sig(name, exp, key);
    /* 定长比较，避免时序侧信道（这里其实不敏感，但便宜就做对） */
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      return send(res, 403, JSON.stringify({ error: 'bad signature' })), true;
    }
    if (!idx || !/^\d+-\d+$/.test(idx)) return send(res, 400, JSON.stringify({ error: 'bad tile' })), true;

    const fp = path.join(DIR, name, idx + '.webp');
    if (!fp.startsWith(DIR + path.sep) || !fs.existsSync(fp)) {
      return send(res, 404, JSON.stringify({ error: 'not found' })), true;
    }
    const buf = fs.readFileSync(fp);
    res.writeHead(200, Object.assign({
      'content-type': 'image/webp',
      'content-length': buf.length,
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex, noimageindex',
    }, secHeaders || {}));
    res.end(buf);
    return true;
  };
}
