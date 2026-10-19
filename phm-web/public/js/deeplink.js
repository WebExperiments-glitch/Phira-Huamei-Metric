/* ============================================================
 * js/deeplink.js —— /app?chart=<id> 深链
 * ============================================================
 * 【为什么单独一个文件】
 *   /chart/<id> 页面的「在分析台打开」跳到 /app?chart=<id>。
 *   这段逻辑有 40 行，塞回 app.html 会把那个文件顶过 2200 行上限
 *   （lint-slop 拦的是"长到没人敢改"，不是"难看"）。
 *
 * 【两个关键点】
 *   ① 谱面文件在 phira.5wyxi.com（CDN，CORS `*`）—— **浏览器直连**，
 *      服务器不中转 2.4MB。CSP 的 connect-src 已放行该域。
 *   ② 与首页接力互斥：接力那次已经带了文件，两边都跑会分析两遍。
 * ============================================================ */

/**
 * @param {{handleFiles:Function, t:Function, $:Function, handedOver:Function}} hooks
 */
export function initDeepLink(hooks) {
  const { handleFiles, t, $, handedOver } = hooks;
  const cid = new URLSearchParams(location.search).get('chart');
  if (!cid || !/^\d{1,12}$/.test(cid)) return;
  if (typeof handedOver === 'function' && handedOver()) return;

  /* ⚠ 延迟一帧：引擎模块是并行加载的，立刻开算会撞上它还没就绪 */
  setTimeout(async () => {
    const m = $('#msg');
    try {
      if (m) m.textContent = t('app.deep.loading', { id: cid });
      const r = await fetch('/api/phira/chart/' + cid, { cache: 'no-cache' });
      if (!r.ok) throw new Error('元数据 HTTP ' + r.status);
      const meta = await r.json();
      if (!meta || !meta.file) throw new Error(t('app.deep.nofile'));
      /* ⚠ 不能直接 fetch meta.file：它 303 到 phira-cdn.5wyxi.com，
         而那个域**没有 Access-Control-Allow-Origin** ——
         浏览器跟随重定向后检查最终响应，直接判 CORS 失败。
         改走我们自己的代理（只做转发，不发散）。
         从 URL 里抽 UUID，且必须是 UUID 形状（代理那边也会再校验一次）。 */
      const uuid = (/\/files\/([0-9a-f-]{36})$/i.exec(String(meta.file)) || [])[1];
      if (!uuid) throw new Error(t('app.deep.nofile'));
      const fr = await fetch('/api/phira-file/' + uuid, { cache: 'no-cache' });
      if (!fr.ok) throw new Error('谱面文件 HTTP ' + fr.status);
      const buf = await fr.arrayBuffer();
      if (m) m.textContent = '';
      /* 上游文件名通常是裸 UUID，这里给一个像样的名字：
         解析器按扩展名判断类型的路径才能走对。 */
      const name = String(meta.name || cid).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
      handleFiles([new File([buf], name + '.pez', { type: 'application/octet-stream' })]);
    } catch (e) {
      /* 失败要说清楚：只说「出错了」用户不知道是链接坏了还是上游挂了 */
      if (m) m.textContent = t('app.deep.fail', { e: String((e && e.message) || e).slice(0, 90) });
    }
  }, 0);
}
