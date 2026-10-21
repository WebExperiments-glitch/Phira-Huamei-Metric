/* ============================================================
 * lib/retired.mjs —— 下线闸门：把不打算再运营的部分一次性撤掉
 * ============================================================
 * 【背景】
 *   2026-10-21 决定：本站收敛成一个**静态的谱面分析工具**，
 *   账号 / 成绩 / 数据管理 / 状态页 / 开放 API 全部撤回。
 *   直接删文件太蠢（git 里有历史，随时能回来），但"留着没人管"更蠢 ——
 *   用户点进去只会看到 503，然后以为网站坏了。
 *
 *   所以中间态是：**代码留在仓库，路由明确关闭**。
 *   访问被撤的路径返回 **410 Gone**（不是 404 —— 410 的意思是
 *   "以前有，现在没了，别再来"，对人和对爬虫都是正确的信号），
 *   并给一个 `/retired` 说明页指路。
 *
 * 【两个设计约束】
 *   ① **说明页本身不能依赖数据库** —— 库正在被隔离，依赖它就自相矛盾了。
 *      所以整页是写死的 HTML，零依赖。
 *   ② **链接地址只有一处**：`RETIRE_URL`。横幅、410 页、说明页都读它。
 *      以前见过"地址散落五处，改了三处漏两处"的事故。
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 站点版本号。**从 package.json 读**，和各页 `<meta name="app-version">` 同源 ——
    硬编码一份就等于埋一个"改了看不到"的坑（本项目为此专门定了 bump-version.py）。 */
const VER = (() => {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return 'V' + JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  } catch { return ''; }
})();

/** 「继续使用请到」的地址。⚠ 换地址只改这一行。 */
export const RETIRE_URL = 'https://github.com/WebExperiments-glitch/Phira-Huamei-Metric';
/* ↑ 「继续使用请到」的地址。⚠ **全站只有这一处**（横幅、410 页、说明页都读它），
   换地址只改这一行。2026-10-21 定成 GitHub 仓库：用户没有现成的后继站，
   而仓库是「这个项目继续存在」最稳的落点 —— 不依赖数据库、不依赖托管平台，
   代码与说明都在。要换成别的地方（比如以后真做出一个后继站），改这一行即可。 */

/** 被撤回的页面路径 → 一句话原因（会显示在 410 页上）。
    ⚠ `/chart/<id>` 是**参数路由**，必须用前缀匹配 —— 只写 `/chart` 拦不住
   `/chart/80281`（2026-10-21 实测踩到：裸路径 410 了，带 id 的照样 200）。 */
export const RETIRED_PAGES = {
  '/user': '玩家成绩与成绩卡',
  '/data': '数据管理',
  '/charter': '谱师作品',
  '/status': '服务状态',
  '/platform': 'API 开放平台',
  '/developer': 'API 开放平台（旧链接）',
  '/developers': 'API 文档',
  '/phm-api': '单文件 API 客户端',
  '/settings': '账号设置',
  '/download': '下载页',
  '/version': '版本历史',
  '/chart': '谱面详情页',
};

/** 被撤回的**文件名**（public/ 下的 html）。文件留在仓库里，但不放行。
    review-gate 用它来判断「这个 html 不在白名单是**故意的**还是漏了」。 */
export const RETIRED_HTML = [
  'user.html', 'data.html', 'charter.html', 'status.html', 'settings.html',
  'platform.html', 'developers.html', 'phm-api.html', 'download.html',
  'version.html', 'chart.html',
];

/** 被撤回的 API 前缀（整段关掉，不是逐条）。 */
export const RETIRED_API = [
  '/api/v1', '/api/hm', '/api/stats', '/api/charts',
  '/api/plays', '/api/scores', '/api/contribute', '/api/analyze',
];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 下线说明页的模板：**静态文件 + 送出前替换占位符**。
    ────────────────────────────────────────────────────────────
    为什么不整页写在字符串里（第一版就是这么写的，后来改了）：
    ① 里面的「主题防闪烁」脚本会踩 lint-slop 的「裸 localStorage」规则 ——
       那条豁免只认 `.html` 结尾的文件；
    ② HTML 躺在 .html 里才有高亮、才有人愿意改；
    ③ `?v=__APP_VER__` 会被 lint-slop 的「串值唯一」规则当成第二个版本号假报 ——
       两个规则都为 retired.html 开了专门豁免（见各自的注释）。
    占位符只有两个：__APP_VER__ 与 __RETIRE_URL__。 */
const TPL = (() => {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'retired.html');
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    /* 读不到也得给人一句话 —— 但别把异常吞得无声无息 */
    console.error('[retired] 读不到 public/retired.html，用兜底文案：', e && e.message);
    return '<!DOCTYPE html><meta charset="utf-8"><title>已停止运营</title>'
      + '<body><h1>本网站已停止运营</h1><p>继续使用请到 __RETIRE_URL__</p></body>';
  }
})();

/** 渲染说明页。URL 仍从 RETIRE_URL 来 —— **全站只有这一处**。 */
function retiredPage() {
  return TPL.split('__APP_VER__').join(VER).split('__RETIRE_URL__').join(esc(RETIRE_URL));
}

/**
 * 下线闸门。**在任何其他路由之前调用**。
 * @returns true 表示已处理（调用方应直接 return）
 */
/* ⚠ 2026-10-21 起「撤不撤」是可切换的 —— 同一份代码要跑两个站：
     · 腾讯那个 = **静态指路牌**（账号/成绩/API 全撤，只见横幅与三个本地功能）
     · 新站      = **全功能**（数据库已搬到 Neon，见 lib/db-pg.mjs）
   切换用**标记文件**而不是环境变量：部署工具上传的是整个目录，
   我这边没有配环境变量的入口，但「目录里有没有这个文件」是确定的。
   本文件所在目录（lib/）的上一级根目录下出现 `.static-only` 即视为静态站。 */
export const STATIC_ONLY = (() => {
  if (process.env.PHM_STATIC_ONLY === '1') return true;
  if (process.env.PHM_STATIC_ONLY === '0') return false;
  try {
    return fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.static-only'));
  } catch { return false; }
})();

export function retiredGate(p, req, res, send) {
  /* 全功能站（新站）：整道闸门不生效，连 /retired 也不需要 */
  if (!STATIC_ONLY && p !== '/retired') return false;
  if (!STATIC_ONLY && p === '/retired') {
    /* 全功能站上 /retired 没有意义 —— 首页还在，说明"本站已停止运营"就是假话。
       ⚠ 这里的 send() 只有 4 个参数（code/body/type），带不了头 ——
       要跳转就得自己 writeHead。 */
    res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  /* 说明页自己永远可达 */
  if (p === '/retired') {
    send(res, 200, retiredPage(), 'text/html; charset=utf-8');
    return true;
  }

  /* 被撤的页面：410 + 人话。`/chart/<id>` 走前缀，别只匹配裸路径。 */
  const why = RETIRED_PAGES[p]
    || (p === '/chart' || p.startsWith('/chart/') ? RETIRED_PAGES['/chart'] : null);
  if (why) {
    send(res, 410, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="app-version" content="${VER}">
<meta name="robots" content="noindex"><title>已停止运营</title>
<link rel="stylesheet" href="/css/base.css?v=${VER}">
</head><body><main style="max-width:560px;margin:16vh auto;padding:0 20px;line-height:1.7">
<h1 style="font-size:1.3rem">「${esc(why)}」已停止运营</h1>
<p>本网站已收敛为静态谱面分析工具，该功能随账号体系一起撤回了。</p>
<p>继续使用请到 <a href="${esc(RETIRE_URL)}">${esc(RETIRE_URL)}</a>，
或看看 <a href="/retired">还能用什么</a>。</p>
<p><a class="btn" href="/app">去谱面分析</a></p>
</main></body></html>`, 'text/html; charset=utf-8');
    return true;
  }

  /* 被撤的 API：410 + JSON（调用方是程序，给它机器读的答案） */
  if (RETIRED_API.some(pre => p === pre || p.startsWith(pre + '/') || p.startsWith(pre + '?'))) {
    send(res, 410, JSON.stringify({
      error: 'gone',
      message: '该接口随本站收敛为静态工具而撤回',
      see: RETIRE_URL,
    }), 'application/json; charset=utf-8');
    return true;
  }

  return false;
}

/** 全功能站要把公告横幅**从 HTML 里摘掉** —— 那句话说"本站已停止运行"，
    而在新站上它是假话。静态站原样保留（写死在 HTML 里，模块链断了也还在）。 */
export function stripBanner(html) {
  if (STATIC_ONLY) return html;
  /* 从注释头到 banner 的闭合 </div>。⚠ 三处细节都是踩过的：
     ① `-->` 与 `<div` 之间**有换行**（模板里是 ` 数据库）。 -->\n<div…`），
        中间必须允许 `\s*`，否则整条正则一次都不匹配（实测：长度一字未变）；
     ② 非贪婪 `[\s\S]*?`，否则会一路吃到页脚；
     ③ 锚定注释开头，别用"删第一个 div" —— 那会连带吃掉 .wrap。 */
  return html.replace(/<!-- ⚠ 2026-10-21：[\s\S]*?-->\s*<div class="retire-banner"[\s\S]*?<\/div>/, '');
}
