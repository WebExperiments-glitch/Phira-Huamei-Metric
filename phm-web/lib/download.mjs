/* ============================================================
 * lib/download.mjs —— 构建产物（Windows 客户端）的下载端点
 * ============================================================
 * 【为什么不共用 sendFile】
 *   server.mjs 里的 sendFile 用 `readFileSync` 把整份文件读进内存，而且不支持
 *   Range。对 HTML/JS 没问题（几十 KB），对 35MB 的 .exe 就有两个后果：
 *     · 每个请求都读一遍 35MB，几个人同时下载内存就顶上去了；
 *     · 断点续传、下载管理器、以及「下载到一半网断了」全都救不回来。
 *   所以这个文件单独走流式 + Range + ETag。
 *
 * 【为什么是工厂函数而不是直接 import 常量】
 *   它需要 server.mjs 的三样东西：安全响应头、404 页、以及被允许的文件表。
 *   硬编码在这里就等于把「站点长什么样」复制到第二个文件里，必然漂移。
 *
 * 【安全模型】
 *   `files` 这张表**就是**全部可达的文件 —— 调用方只把 URL 映射成表里的键，
 *   不接受拼出来的路径。因此这里不存在目录穿越，也就不需要额外过滤。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

/** URL 路径 → downloads/ 下的文件名。**这里就是全部可达的文件**。 */
export const DOWNLOAD_FILES = { '/download/phira-huamei.exe': 'phira-huamei.exe' };

/**
 * @param {object} deps
 * @param {string} deps.dir      构建产物所在目录（绝对路径）
 * @param {object} deps.secHeaders 站点的安全响应头（CSP 等）
 * @param {(res) => void} deps.notFound 找不到时用的 404 渲染函数
 * @returns {(req, res, name: string) => void}
 */
export function makeDownloadHandler({ dir, secHeaders, notFound }) {
  /* ⚠ 这里的每一个 on('error') / on('close') 都不是装饰：
     · `fs.createReadStream` 在文件被替换、磁盘出错时 emit 'error'；
     · `res` 在客户端**中途取消下载**时 emit 'close'。
     任何一个没接住，Node 按未捕获事件处理 → **整个进程退出**。
     也就是「用户点了取消」能下线整个站点。这是最容易漏的一处。 */
  return function serveDownload(req, res, name) {
    const fp = path.join(dir, name);
    let st;
    try { st = fs.statSync(fp); } catch { return notFound(res); }
    if (!st.isFile()) return notFound(res);

    /* ⚠ cache-control 用 **no-cache** 而不是长缓存：URL 是稳定的文件名
       （/download/phira-huamei.exe），一旦被缓存住，用户会拿着旧包
       却看到页面上的新版本号和 SHA-256 —— 这比多一次往返严重得多。
       配 ETag 之后重校验是 304，开销只是一次往返。 */
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    const head = Object.assign({
      'content-type': 'application/vnd.microsoft.portable-executable',
      'content-disposition': 'attachment; filename="' + name + '"',
      'cache-control': 'no-cache',
      'etag': etag,
      'accept-ranges': 'bytes',
    }, secHeaders);

    if (String(req.headers['if-none-match'] || '').split(',').some(t => t.trim() === etag)) {
      res.writeHead(304, head);
      return res.end();
    }

    /* 只认 `bytes=a-b` / `bytes=a-` / `bytes=-n`；其余（多段 range 等）
       一律当没带 Range 处理、整份送 —— 不支持多段是允许的，不该报错。 */
    let start = 0, end = st.size - 1, partial = false;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, st.size - parseInt(m[2], 10));      /* 末 n 字节 */
      } else {
        start = parseInt(m[1], 10);
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), st.size - 1);
      }
      if (start > end || start >= st.size) {
        const h = Object.assign({}, head, { 'content-range': 'bytes */' + st.size });
        delete h['content-disposition'];
        res.writeHead(416, h);
        return res.end();
      }
      partial = true;
    }

    if (partial) head['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    head['content-length'] = end - start + 1;
    res.writeHead(partial ? 206 : 200, head);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(fp, { start, end });
    res.on('close', () => stream.destroy());   /* 客户端断开 → 别继续读磁盘 */
    res.on('error', () => stream.destroy());
    stream.on('error', () => { try { res.destroy(); } catch { /* 已经关了 */ } });
    stream.pipe(res);
  };
}
