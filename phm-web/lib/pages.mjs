/* ============================================================
 * lib/pages.mjs —— 需要**服务端渲染**的页面路由
 * ============================================================
 * 目前只有两件事：
 *   ① `/chart/<id>` —— 谱面详情页（SEO 落地页）
 *   ② `/sitemap.xml` —— 动态站点地图（把已缓存的谱面都列进去）
 *
 * 【为什么这两件事必须在服务端】
 *   爬虫**不执行 JS**。如果详情页只是"客户端拉数据再填"，那搜索引擎看到的
 *   是一张白页 —— title 是通用的、正文是空的，等于没做。
 *   所以 title / description / canonical / og:* 必须由服务端注入 HTML。
 *
 * 【为什么不能等太久】
 *   详情页是**首屏入口**，不是后台任务。DB 超时 15 秒、上游也可能慢，
 *   两者串起来能等到 20 秒以上 —— 用户早就走了，爬虫也会判超时。
 *   所以每个来源都套一个短超时，失败了**照样返回 200 + 通用 meta**：
 *   宁可少一点信息，也不能给爬虫一个 5xx。
 *
 * 【为什么 sitemap 也放这里】
 *   静态 sitemap 只有 7 条固定页 —— 谱面一张都进不去。
 *   而"搜某首歌的定数"恰恰是最大的自然流量来源。
 *   动态生成 + 内存缓存 10 分钟：库里有 661 张也不会每请求都打 DB。
 * ============================================================ */

import { dbFetch } from './cloud.mjs';

const SITE = 'https://phm.app.workbuddy.host';
const PHIRA_API = 'https://api.phira.cn';

/* 页面映射：干净 URL → 实际文件。
   ⚠ **显式白名单，不是通配** —— 将来加页面必须同时加进 PUBLIC_FILES，
     不会因为忘了写路由就把文件暴露出去。 */
export const CLEAN = {
  '/app': 'app.html', '/user': 'user.html', '/charter': 'charter.html',
  '/data': 'data.html', '/settings': 'settings.html',
  '/privacy': 'privacy.html', '/terms': 'terms.html',
  '/version': 'version.html', '/download': 'download.html',
  '/developers': 'developers.html', '/platform': 'platform.html',
  '/developer': 'platform.html',   /* 旧链接兼容 */
  '/phm-api': 'phm-api.html', '/rulechart': 'rulechart.html',
  '/status': 'status.html', '/packs': 'packs.html',
};

/** HTML 属性转义。曲名/谱师是**用户可提交的内容**，直接拼进 title
    会被 `"` 截断属性、被 `<` 注入标签 —— 这是最典型的一类 XSS 入口。 */
function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 带超时的 fetch：详情页不能被某个慢来源拖住。 */
async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(res => { timer = setTimeout(() => res(fallback), ms); }),
    ]);
  } catch (e) {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** 读缓存行（定数）。失败/超时一律 null —— 页面照样出，只是少一块。 */
async function readCache(id) {
  return withTimeout((async () => {
    const r = await dbFetch('/phm_charts?chart_id=eq.' + encodeURIComponent(id) + '&select=*', undefined, 6000, 256 * 1024);
    if (!r.ok || !r.body || r.body === '[]') return null;
    try { return JSON.parse(r.body)[0] || null; } catch { return null; }
  })(), 2600, null);
}

/** 读上游元数据（曲名/谱师/难度/曲绘）。 */
async function readMeta(id) {
  return withTimeout((async () => {
    const r = await fetch(PHIRA_API + '/chart/' + encodeURIComponent(id), {
      headers: { accept: 'application/json', 'user-agent': 'phm-pages/1.0 (+' + SITE + ')' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    return await r.json();
  })(), 3400, null);
}

const fx = (v, n) => (v == null || !isFinite(+v)) ? null : (+v).toFixed(n);

/**
 * 生成详情页的 <head> 片段。
 *
 * ⚠ 三种状态，文案要分开 —— 它们对搜索者意味着完全不同的东西：
 *   ① 算过：标题里直接给定数（"XXX 定数 16.32" 就是用户搜的那句话）
 *   ② 没算过但有元数据：标题只有曲名 + 难度
 *   ③ 连元数据都没有：只写 id，别编造
 */
export function buildSeo(id, meta, cache) {
  const m = meta || {};
  /* ⚠ name 有**两个**来源，都要用：上游元数据优先，但 DB 缓存里也有 name
     （phm_charts.name）。上游偶发慢/挂时只靠它，title 会退化成
     「谱面 #80511 定数 17.45」—— 有数字没曲名，搜不到。
     实测踩过：一次测试跑下来 title 就是这个退化形态。 */
  const name = m.name || (cache && cache.name) || '';
  const level = m.level || '';
  const charter = m.charter || '';
  const composer = m.composer || '';
  const ref = cache ? +cache.ref_const : null;
  const refOff = cache ? +cache.ref_official : null;
  const hasRef = isFinite(ref) && ref > 0;

  let title, desc;
  if (hasRef) {
    /* 标题就是最可能被搜的那句话。别写「P.H.M. | 谱面详情」这种什么都搜不到的。 */
    title = name
      ? `${name} 定数 ${fx(ref, 2)}（${level || '难度未知'}）· P.H.M.`
      : `谱面 #${id} 定数 ${fx(ref, 2)} · P.H.M.`;
    desc = [
      name ? `${name}（${level || '难度未知'}）` : `谱面 #${id}`,
      charter ? `谱师 ${charter}` : '',
      composer ? `作曲 ${composer}` : '',
      `参考定数 ${fx(ref, 2)}（社区共识标度${isFinite(refOff) && refOff > 0 ? `，官谱标度 ${fx(refOff, 2)}` : ''}）`,
      '由 8 维特征 + 9,508 张社区谱 k-NN 算出，附不确定范围。',
    ].filter(Boolean).join('｜');
  } else if (name) {
    title = `${name}（${level || '难度未知'}）· P.H.M.`;
    desc = `${name}${charter ? `，谱师 ${charter}` : ''}${composer ? `，作曲 ${composer}` : ''}。`
      + '这张谱还没有人算过定数 —— 打开页面丢进去就能看到参考定数与它的不确定范围。';
  } else {
    title = `谱面 #${id} · P.H.M.`;
    desc = 'Phira 谱面定数参考：用 8 维特征 + 9,508 张社区谱 k-NN 给出参考定数和不确定范围。';
  }

  const canonical = `${SITE}/chart/${id}`;
  /* og:image 用页面本身的曲绘更有信息量，但曲绘是外站直链、
     且可能 404 —— 社交平台抓不到图会退回默认，所以只放站点 og.png，
     把曲绘留给页面内的 <img>。 */
  return [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(desc)}">`,
    `<link rel="canonical" href="${attr(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="P.H.M. 谱面定数参考">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:url" content="${attr(canonical)}">`,
    `<meta property="og:image" content="${SITE}/og.png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    /* 结构化数据：让搜索结果能显示成「谱面」而不是一段摘要 */
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: name || `谱面 #${id}`,
      url: canonical,
      ...(composer ? { composer: { '@type': 'Person', name: composer } } : {}),
      ...(charter ? { creator: { '@type': 'Person', name: charter } } : {}),
      ...(hasRef ? { about: `参考定数 ${fx(ref, 2)}` } : {}),
      isPartOf: { '@type': 'WebSite', name: 'P.H.M. 谱面定数参考', url: SITE },
    }).replace(/</g, '\\u003c')}</script>`,
  ].join('\n  ');
}

/** sitemap 内存缓存：库不常变，10 分钟足够；没有它每次都打 DB。 */
let smCache = { at: 0, xml: '' };
const SM_TTL = 10 * 60 * 1000;

async function buildSitemap() {
  if (smCache.xml && Date.now() - smCache.at < SM_TTL) return smCache.xml;
  let ids = [];
  const r = await withTimeout((async () => {
    const res = await dbFetch('/phm_charts?select=chart_id,engine_build&order=chart_id.desc&limit=40000', undefined, 12000, 8 * 1024 * 1024);
    if (!res.ok || !res.body) return [];
    try { return JSON.parse(res.body) || []; } catch { return []; }
  })(), 6000, []);
  ids = (Array.isArray(r) ? r : []).map(x => Number(x && x.chart_id)).filter(n => n > 0);

  const urls = [
    { loc: SITE + '/', cf: 'daily', pri: '1.0' },
    { loc: SITE + '/app', cf: 'weekly', pri: '0.9' },
    { loc: SITE + '/packs', cf: 'daily', pri: '0.8' },
    { loc: SITE + '/charter', cf: 'weekly', pri: '0.7' },
    { loc: SITE + '/user', cf: 'weekly', pri: '0.7' },
    { loc: SITE + '/data', cf: 'daily', pri: '0.6' },
    { loc: SITE + '/rulechart', cf: 'monthly', pri: '0.6' },
    { loc: SITE + '/status', cf: 'hourly', pri: '0.4' },
    { loc: SITE + '/developers', cf: 'monthly', pri: '0.5' },
    { loc: SITE + '/download', cf: 'monthly', pri: '0.5' },
    { loc: SITE + '/version', cf: 'weekly', pri: '0.4' },
  ].concat(ids.map(id => ({ loc: `${SITE}/chart/${id}`, cf: 'weekly', pri: '0.7' })));

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(u => '  <url>\n    <loc>' + attr(u.loc) + '</loc>\n'
        + '    <changefreq>' + u.cf + '</changefreq>\n'
        + '    <priority>' + u.pri + '</priority>\n  </url>').join('\n')
    + '\n</urlset>\n';
  smCache = { at: Date.now(), xml };
  return xml;
}

/**
 * 装配路由。返回一个 `async (req,res,url) => boolean`，语义与 lib/ 其它工厂一致：
 * 处理了就返回 true，没命中返回 false 交给下游。
 *
 * @param {{secHeaders:object, send:Function, send404:Function, readTemplate:Function}} deps
 */
export function makePageRoutes(deps) {
  const { secHeaders, send, send404, readTemplate } = deps;

  return async function pageRoutes(req, res, url) {
    const p = url.pathname;

    /* ── ① 谱面详情页 ── */
    const m = /^\/chart\/(\d{1,12})\/?$/.exec(p);
    if (m) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, secHeaders));
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return true;
      }
      const id = Number(m[1]);
      /* 两个来源并行 —— 串行会让首屏多等一个 RTT */
      const [meta, cache] = await Promise.all([readMeta(id), readCache(id)]);
      let html;
      try {
        html = readTemplate('chart.html');
      } catch (e) {
        /* 模板读不到是部署问题，不该让用户看到堆栈 */
        return send404(res);
      }
      /* ⚠ 只替换一处占位符：模板里所有 meta 都在这一块，
         分散替换容易出现"改了 title 忘了 description"。 */
      html = html.replace('<!--seo-->', buildSeo(id, meta, cache));
      res.writeHead(200, Object.assign({
        'content-type': 'text/html; charset=utf-8',
        /* HTML 一律 no-cache：内容变了必须立刻生效（同名版本号事故的教训） */
        'cache-control': 'no-cache',
      }, secHeaders));
      res.end(req.method === 'HEAD' ? undefined : html);
      return true;
    }

    /* ── ② 动态 sitemap ── */
    if (p === '/sitemap.xml') {
      let xml;
      try { xml = await buildSitemap(); }
      catch (e) { xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'; }
      res.writeHead(200, Object.assign({
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=1800',
      }, secHeaders));
      res.end(req.method === 'HEAD' ? undefined : xml);
      return true;
    }

    return false;
  };
}
