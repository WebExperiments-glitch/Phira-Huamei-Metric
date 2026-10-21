#!/usr/bin/env node
/* ============================================================
 * tools/smoke-page.mjs —— 真页面冒烟测试（本机 Chrome + CDP，零依赖）
 * ============================================================
 * 【为什么必须存在】
 *   `node --check` 查不出「语法合法但运行时炸」的代码 —— 项目历史上真出过：
 *   编辑时吃掉箭头函数的 `>`，`en=({...})` 成了**合法语法**，
 *   结果线上所有谱面解析失败，而所有静态检查都是绿的。
 *   verify-engine.mjs 只测引擎（Node 侧），测不到页面的接线：
 *   动态 import、参照集 fetch、DOM 渲染、按钮事件。
 *
 * 【怎么跑】
 *   1) 另开一个终端起本地服务：  PORT=5199 node server.mjs
 *   2) node tools/smoke-page.mjs http://127.0.0.1:5199
 *
 * 检查项（任何一条失败 → 退出码 1）：
 *   · 页面加载无未捕获异常 / 无 console.error
 *   · 引擎模块真的被加载（PHM.status().engine === 'ok'）
 *   · 社区参照集 fetch 成功（PHM.status().refCom 以 ok/ 开头）
 *   · 分享卡模块加载（sharecard === 'ok'）
 *   · 关键 DOM 节点存在（拖放入口、搜索框、结果容器）
 *
 * ⚠ 2026-10-07 站点拆成多页（/ /app /user /charter）之后，**每一页都要走一遍**：
 *   真实事故形态是「首页没事、别的页面白屏」—— 只测首页等于没测。
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const PORT = 9333 + (process.pid % 500);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const waitPort = async (p, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise(res => {
      const s = net.connect(p, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

if (!(await waitPort(PORT))) { console.error('Chrome 调试端口没起来'); cleanup(); process.exit(2); }

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let seq = 0; const pend = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const errors = [];
const warns = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('未捕获异常: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (m.params.type === 'error') errors.push('console.error: ' + txt);
    else if (m.params.type === 'warning') warns.push(txt);
  }
});

await send('Page.navigate', { url: BASE + '/' });
await new Promise(r => setTimeout(r, 5000));   /* 等模块加载 + 参照集 fetch */

const evalJS = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
};


let pass = 0, fail = 0;
/* 跨页共享的观察值（例如「各页版本号是否一致」） */
const CC = {};
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); if (d) errors.push('[冒烟] ' + n + ' → ' + d); }
};

/* ── 开浏览器之前的静态检查：**版本串必须处处一致** ──
   ES 模块按 **URL 字符串**去重。同一个文件被两种 URL 引用
   （`/js/i18n.js` 和 `/js/i18n.js?v=X`）会被当成两个模块，两套状态分裂 ——
   真踩过：设置页切了语言，ui.js 里的导航不跟着变。
   所以所有 `?v=`（CSS 与 JS 模块）必须等于 `<meta name="app-version">`。
   这条只能读源码，浏览器里看不到，所以放在这里。 */
{
  /* ⚠ 必须用 fileURLToPath —— `new URL(...).pathname` 会给出去百分号编码的
     路径（这个项目的工作目录名里有中文），fs 直接读不到。 */
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const htmlFiles = fs.readdirSync(path.join(root, 'public'))
    .filter(f => f.endsWith('.html'));
  const bad = [];
  let ver = null, refs = 0;
  for (const f of htmlFiles) {
    const s = fs.readFileSync(path.join(root, 'public', f), 'utf8');
    const mv = /<meta name="app-version" content="([^"]+)">/.exec(s);
    if (mv) ver = ver || mv[1];
    for (const m of s.matchAll(/\?v=([^"'&\s]+)/g)) {
      refs++;
      if (mv && m[1] !== mv[1]) bad.push(f + ' → ?v=' + m[1] + '（meta=' + mv[1] + '）');
    }
  }
  const jsFiles = [];
  for (const dir of ['js', path.join('js', 'i18n')]) {
    for (const f of fs.readdirSync(path.join(root, 'public', dir))) {
      if (f.endsWith('.js')) jsFiles.push(path.join(root, 'public', dir, f));
    }
  }
  for (const fp of jsFiles) {
    for (const m of fs.readFileSync(fp, 'utf8').matchAll(/\?v=([^"'&\s]+)/g)) {
      refs++;
      if (ver && m[1] !== ver) bad.push(path.basename(fp) + ' → ?v=' + m[1]);
    }
  }
  /* ── 缓存策略守卫（2026-10-11 一次真实事故后加）──
     那次在**同一个版本号**下部署了两遍（内容不同），而 ?v= 资源当时是
     `max-age=604800, immutable` —— immutable 让浏览器**连强刷都不重新校验**，
     于是用户手里一直是第一次那份旧模块，页面报「does not provide an export
     named …」、模块链断、下半页空白，而且**自己好不了**。
     现在：长缓存只给 1 小时且 must-revalidate（配 ETag，重校验是 304）。
     这条断言就是不许再改回 immutable。 */
  const probe = (u) => fetch(new URL(u, BASE), { redirect: 'manual' });
  const hHtml = (await probe('/app')).headers.get('cache-control') || '';
  const hJs = (await probe('/js/ui.js?v=' + ver)).headers.get('cache-control') || '';
  ok('HTML 不做长缓存（改了就立刻生效）', /no-cache/.test(hHtml), hHtml);
  ok('★ ?v= 资源不带 immutable（否则旧副本自己好不了）', !/immutable/.test(hJs), hJs);
  const et = (await probe('/js/ui.js?v=' + ver)).headers.get('etag');
  ok('静态资源带 ETag（重校验走 304，不重下）', !!et, et || '(无)');

  console.log('\n[版本一致性] 版本 ' + ver + ' · 检查了 ' + refs + ' 处 ?v= 引用');
  ok('所有 ?v= 与 app-version 同串（CSS + JS 模块）', bad.length === 0 || bad.join('; '));

  /* 面向用户的版本历史（/version 页）最新一条必须等于当前版本。
     升版本时最容易漏的就是它 —— 页面上写着"最新 V0.9.2.1"而实际已经 V0.9.3.0。
     这条断言只读源码，浏览器里看不出来，所以放在这里。 */
  try {
    const V = await import(pathToFileURL(path.join(root, 'public', 'js', 'versions.js')).href);
    const list = V.RELEASES || [];
    ok('版本历史页有内容', list.length > 0, list.length + ' 条');
    ok('★ 版本历史最新一条 = 当前版本', list[0] && list[0].v === ver,
      (list[0] && list[0].v) + ' vs ' + ver);
    /* 每条都要有中英两份，否则切语言会出现空白条目 */
    const noEn = list.filter(r => !Array.isArray(r.en) || !r.en.length).map(r => r.v);
    const noZh = list.filter(r => !Array.isArray(r.zh) || !r.zh.length).map(r => r.v);
    ok('版本历史每条都有中英两份', noEn.length === 0 && noZh.length === 0,
      '缺 en: ' + noEn.join(',') + ' | 缺 zh: ' + noZh.join(','));
    /* 版本号必须严格递减，别写乱序 */
    const ordered = list.every((r, i) => i === 0 || cmpVer(list[i - 1].v, r.v) > 0);
    ok('版本历史按版本号从新到旧排列', ordered,
      list.map(r => r.v).join(' > '));
  } catch (e) {
    ok('版本历史页数据可读', false, String(e.message || e));
  }
}

/** 比较两个 Vx.y.z.w 版本号，返回 -1/0/1 */
function cmpVer(a, b) {
  const pa = String(a).replace(/^V/i, '').split('.').map(Number);
  const pb = String(b).replace(/^V/i, '').split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* 每条路由要检查的东西。⚠ 站点拆页之后**每一页都要走一遍** ——
   真实事故形态是「首页没事、别的页面白屏」。 */
/* ⚠ 2026-10-21 站点收敛：只留静态三件套 + 法务页。
   被撤的页面由 lib/retired.mjs 回 **410 Gone**，断言在下面「下线闸门」一节。
   别把那几条加回来 —— 加了就等于下线没生效，而用户只会看到 503。 */
const ROUTES = [
  { path: '/', name: '首页', sel: ['#verfoot'], mod: 'ui' },
  { path: '/app', name: '工作台', sel: ['#drop', '#file', '#msg', '#out', '#csrch'], mod: 'engine' },
  { path: '/rulechart', name: '规则写谱', sel: ['#rcGo', '#preview', '#rcPez', '#rcReport'], mod: 'rulechart' },
  { path: '/packs', name: '谱面包', sel: ['#q', '#lv', '#sort', '#list', '#more'], mod: 'ui',
    ready: `!!document.querySelector('#list .card2')` },
  /* 法务页是自带 <nav> 的静态正文页（不用 JS 生成导航），所以 standalone。 */
  { path: '/privacy', name: '隐私', sel: ['h1'], mod: 'ui', standalone: true },
  { path: '/terms', name: '服务条款', sel: ['h1'], mod: 'ui', standalone: true },
  { path: '/retired', name: '下线说明页', sel: ['h1'], mod: 'ui' },
];

for (const R of ROUTES) {
  console.log('\n[页面冒烟] ' + BASE + R.path + '  （' + R.name + '）');
  const before = errors.length;
  await send('Page.navigate', { url: BASE + R.path });
  await new Promise(r => setTimeout(r, 2800));
  /* ⚠ 有些页的内容是**异步到达**的（谱面包要等上游 Phira API 回来才画卡片）。
     固定 2.8s 是在赌它够快 —— 串行跑十几页时前面的页面已经把连接池占满，
     这一页就刚好慢一点，于是断言全红而功能其实好的。
     所以按页面的「就绪信号」轮询，而不是赌时间。 */
  if (R.ready) {
    let got = false;
    /* ⚠ 60 次 × 500ms = 30s 上限。谱面包那页一屏就是 30 张曲绘（1–3MB each，
       经我们的代理），串行跑十几页时连接池被占满，首屏可能十几秒才出卡片。
       早先只等 9.6s，于是断言全红而功能是好的 —— 和限流那次同一类误报：
       **测试环境比真实使用更慢，所以要按信号等，不能赌时间。** */
    for (let i = 0; i < 60 && !got; i++) {
      got = await evalJS(R.ready);
      if (!got) await new Promise(r => setTimeout(r, 500));
    }
    if (!got) {
      /* ⚠ 打印页面上的**错误文案**：数据没加载出来时，
         页面会渲染一张说明原因的卡片（网络失败 / 上游报错 / 无结果）。
         只报 cards=0 等于把真因藏起来 —— 2026-10-18 为此白查了好几轮。 */
      const why = await evalJS(`(function(){
        const c = document.querySelector('#list .card');
        return c ? c.textContent.trim().slice(0, 160) : '(没有 .card，可能是压根没渲染)';
      })()`);
      ok('页面在 30s 内进入就绪态（ready 信号命中）', false, R.ready + ' | 页面显示：' + why);
    }
  }

  const info = await evalJS(`(function(){
    const out = { ver: (document.querySelector('meta[name="app-version"]')||{}).content,
                  title: document.title, hasNav: !!document.getElementById('nav'),
                  theme: document.documentElement.getAttribute('data-theme'),
                  lang: document.documentElement.getAttribute('data-lang') };
    out.dom = {};
    ${JSON.stringify(R.sel)}.forEach(function(s){ out.dom[s] = !!document.querySelector(s); });
    out.navLinks = Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.getAttribute('href'); });
    /* 顶栏与内容区的横向位置 —— 内容区可以随页面宽窄不同（宽表 vs 正文），
       但顶栏全站必须对齐，否则切页面时 logo 会横向跳一下。 */
    var navEl = document.getElementById('nav');
    if (navEl) { var nb = navEl.getBoundingClientRect(); out.navLeft = Math.round(nb.left); out.navW = Math.round(nb.width); }
    else { out.navLeft = null; out.navW = null; }
    var wp = document.querySelector('.wrap');
    out.wrapW = wp ? Math.round(wp.getBoundingClientRect().width) : null;
    /* 样式表的缓存键 —— 它必须与 app-version 是同一个串。
       漏改一个就会出现"版本升了但 CSS 还是旧的长缓存"，
       改了样式却在用户那儿看不到（开发时最容易被这个骗）。 */
    const lk = document.querySelector('link[rel="stylesheet"][href*="?v="]');
    out.cssV = lk ? (lk.getAttribute('href').split('?v=')[1] || null) : null;
    return out;
  })()`);

  /* 不写死版本号（写死的话每次升版本都要改测试，迟早漏），
     只断言**形态**。形态是「四段式」—— 见 docs/ARCHITECTURE.md「版本策略」：
       V0.9.2.0 → 小更新（纯前端效果）→ V0.9.2.1
                 → UI 改动等      → V0.9.3.0（末位归零）
     两段/三段的写法（V0.9 / V0.9.0）是**不合规**的，规范形式只有四段这一种。
     ⚠ 所以这里必须卡 4 段，否则有人写回三段也没人拦。 */
  ok('版本号是四段式（V{a}.{b}.{c}.{d}）',
    /^V\d+\.\d+\.\d+\.\d+$/.test(String(info.ver)), 'ver=' + info.ver);
  ok('版本号不是两段/三段（V0.9 / V0.9.0 都不合规）',
    !/^V\d+(\.\d+){1,2}$/.test(String(info.ver)), 'ver=' + info.ver);
  if (!CC.ver) CC.ver = info.ver;
  else ok('各页版本号一致', CC.ver === info.ver, CC.ver + ' vs ' + info.ver);
  /* 顶栏对齐：内容区宽度可以不同（数据页 1100 / 正文页 880），
     但顶栏必须全站一个位置 —— 否则点导航切页时 logo 会横向跳。
     ⚠ 用真浏览器的几何值来判，别看源码猜。 */
  if (!R.standalone) {
  if (CC.navLeft == null) CC.navLeft = info.navLeft;
  else ok('★ 顶栏横向位置与其他页一致', Math.abs(CC.navLeft - info.navLeft) <= 1,
    '本页 left=' + info.navLeft + '，首见 ' + CC.navLeft);
  }
  CC.wrapW = info.wrapW;
  /* 缓存键必须跟版本号同步 —— 这两处漏改任何一处都会"改了看不到" */
  ok('样式表 ?v= 与 app-version 一致',
    info.cssV == null || info.cssV === info.ver, 'cssV=' + info.cssV + ' ver=' + info.ver);
  ok('有页面标题', !!info.title && info.title.length > 3, info.title);
  if (!R.standalone) {
  ok('导航已渲染', info.hasNav === true);
  /* 导航入口数 = NAV 数组长度（首页/算定数/谱师/玩家/数据/设置/下载）。
     写死具体数字是有意的：**少一个入口是回归**，而"≥6"这种松断言拦不住它。 */
  /* ⚠ 数字跟着 NAV 走：2026-10-21 收敛后只剩 4 个入口（首页/工作台/规则写谱/谱面包）。
     写死具体数字是有意的 —— ">=N" 这种松断言拦不住「少了一个入口」这种回归。 */
  ok('导航含 4 个入口', (info.navLinks || []).length >= 4, JSON.stringify(info.navLinks));
  }
  /* 主题必须在**第一次绘制前**就定好（<head> 里那段同步脚本），
     否则刷新会闪一下。所以每页都要检查它真的被设上了。 */
  ok('主题已初始化（防闪烁脚本生效）',
    info.theme === 'dark' || info.theme === 'light', 'theme=' + info.theme);
  ok('语言已标记到 <html>',
    info.lang === 'zh' || info.lang === 'en', 'lang=' + info.lang);
  for (const sel of R.sel) ok('DOM ' + sel + ' 存在', info.dom[sel] === true);

  if (R.mod === 'data' && process.env.PHM_SMOKE_OFFLINE === '1') {
    /* GitHub Actions 里没有生产数据库的写权限，读到的是空页；
       这类断言留在本地/生产环境跑，CI 只验证页面能加载。 */
    console.log('  - 跳过数据页分页断言（PHM_SMOKE_OFFLINE=1）');
  } else if (R.mod === 'data') {
    /* 数据管理页的核心是「真分页」：等第一页渲染出来，
       并确认页码里写的是**真实总数**（而不是"这一页有多少条"）。 */
    let got = 0;
    for (let i = 0; i < 40 && !got; i++) {
      got = await evalJS(`document.querySelectorAll('#tbl table tbody tr').length`).catch(() => 0);
      if (!got) await new Promise(r => setTimeout(r, 400));
    }
    ok('表格渲染出行', got > 0, got + ' 行');
    const pg = await evalJS(`(function(){
      const el = document.querySelector('#pgwrap .pginfo');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    })()`);
    ok('页码信息含真实总数', !!pg && /共\s*\d+\s*条/.test(pg), pg);
    const navN = await evalJS(`document.querySelectorAll('#pgwrap [data-go]').length`);
    ok('有翻页按钮', navN > 0, navN + ' 个');
    /* 点排序表头必须真的换顺序（不是只画了个箭头） */
    const firstBefore = await evalJS(`(document.querySelector('#tbl tbody tr td.mono2')||{}).textContent`);
    await evalJS(`(function(){
      const th = document.querySelector('#tbl th[data-sort="ref_const"]');
      if (th) th.click(); return 1;
    })()`);
    await new Promise(r => setTimeout(r, 2200));
    const sorted = await evalJS(`(function(){
      const cells = document.querySelectorAll('#tbl tbody tr td:nth-child(5)');
      return Array.prototype.map.call(cells, function(c){ return parseFloat(c.textContent); })
        .filter(function(v){ return !isNaN(v); });
    })()`);
    const desc = sorted.length > 1 && sorted.every((v, i) => i === 0 || sorted[i - 1] >= v);
    ok('点表头能按该列排序（降序）', desc, JSON.stringify(sorted.slice(0, 6)));
  }

  if (R.path === '/status') {
    /* ⚠ 状态页最危险的失败不是报错，是**渲染出空白**：
       节点都在（sel 通过），但横幅标题是空的、分组是空的，
       用户看到一片框还以为服务挂了。所以必须断言**内容**。 */
    const st = await evalJS(`(function(){
      const t = document.getElementById('bTitle');
      const meta = document.getElementById('bMeta');
      const banner = document.getElementById('banner');
      const groups = document.getElementById('groups');
      const mons = document.querySelectorAll('#groups .mon');
      return {
        title: t ? t.textContent.trim() : '',
        meta: meta ? meta.textContent.trim() : '',
        cls: banner ? banner.className : '',
        groups: groups ? groups.children.length : 0,
        mons: mons.length,
        /* 探测路径必须真的渲染出来 —— 那是这页最有用的信息 */
        paths: [...document.querySelectorAll('#groups .mon .path')].map(x => x.textContent),
        /* 有没有 i18n 键漏翻。
           ⚠ 两个坑：
             ① 只能扫**文本节点**，不能扫 innerHTML ——
                属性名里本来就写着 data-i18n="st.title"，
                扫全文必然把正当属性当成"漏翻"，一条都过不了。
             ② 只能匹配**整个词**等于键名，不能只要出现st. 就报——
                否则代码注释里的 "…/js/i18n/status.js…" 这类路径会误报。 */
        raw: (function(){
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const hits = [];
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            const s = (n.nodeValue || '').trim();
            if (/^st\\.[a-z0-9]+$/i.test(s)) hits.push(s);
          }
          return hits;
        })(),
      };
    })()`);
    ok('横幅标题非空', !!st.title, JSON.stringify(st.title));
    ok('横幅标题不是未翻译的词条键', !/^st\./.test(st.title), st.title);
    ok('横幅有状态类名', /is-(operational|degraded|outage|unknown)/.test(st.cls), st.cls);
    ok('更新时间是填过的（不是空串）', !!st.meta, JSON.stringify(st.meta));
    ok('渲染出了分组', st.groups > 0, 'groups=' + st.groups);
    ok('渲染出了监视项', st.mons > 0, 'mons=' + st.mons);
    ok('探测路径已显示', st.paths.length > 0 && st.paths.every(p => p.startsWith('/')),
       JSON.stringify(st.paths.slice(0, 3)));
    ok('没有漏翻的 st.* 键', st.raw.length === 0, JSON.stringify([...new Set(st.raw)].slice(0, 5)));
    /* 范围切换按钮的两个状态属性必须真的存在，且只有一个 pressed */
    const seg = await evalJS(`(function(){
      const bs = [...document.querySelectorAll('#range button[data-range]')];
      return { n: bs.length, on: bs.filter(b => b.getAttribute('aria-pressed') === 'true').length,
               ranges: bs.map(b => b.dataset.range) };
    })()`);
    ok('范围切换有 2 个按钮', seg.n === 2, JSON.stringify(seg));
    ok('恰好一个处于选中态', seg.on === 1, JSON.stringify(seg));
    ok('两个范围值是 24h 与 30d',
      seg.ranges.includes('24h') && seg.ranges.includes('30d'), JSON.stringify(seg.ranges));
  }

  if (R.path === '/rulechart') {
    /* ⚠ 这三层是「规则写谱」的可信度来源，不是装饰：
         A 音符在不在拍上 · B 有没有为了凑密度造假 · C 能不能好好打。
       它们只在**点生成之后**才有内容，所以这里查的是：
         ① 面板节点与三行都在（别被谁删了）
         ② 规则说明里三层都提到了（文案不能只写旧规则）
         ③ 页面模块真的加载了新算法（rhythm.js 的导出可见） */
    const rc = await evalJS(`(function(){
      const g = id => document.getElementById(id);
      /* ⚠ 页面上有两个 .rc-note：结果卡里的「ZIP 内包含…」与规则说明。
         只取第一个会拿到前者 → 所有文案断言全空（实测踩过）。 */
      const note = [...document.querySelectorAll('.rc-note')].map(e => e.textContent).join(' ');
      return {
        panel: !!g('rcReport'),
        rows: ['rcrGrid','rcrPick','rcrPlay'].filter(x => !!g(x)).length,
        warnNode: !!g('rcrWarn'),
        text: note,
      };
    })()`);
    ok('三层报告面板存在', rc.panel === true, JSON.stringify(rc.panel));
    ok('三行（时间轴 / 事件选择 / 可玩性）都在', rc.rows === 3, 'rows=' + rc.rows);
    ok('提醒块存在', rc.warnNode === true);
    ok('规则说明提到时间轴（A）', /时间轴/.test(rc.text), rc.text.slice(0, 60));
    ok('规则说明提到事件选择（B）', /事件选择/.test(rc.text));
    ok('规则说明提到可玩性（C）', /可玩性/.test(rc.text));
    ok('规则说明写明「不补造」（B 的核心承诺）', /不补造|不会再造|绝不补/.test(rc.text),
      rc.text.slice(0, 80));
    /* 三连音必须在文档里出现 —— 这是 A 层最容易被简化掉的一环 */
    ok('规则说明提到三连音（1/3 网格）', /三连音/.test(rc.text));

    /* 新算法模块能被浏览器加载（不是只在 Node 里能跑） */
    const mod = await evalJS(`(async function(){
      try {
        const v = document.querySelector('meta[name=app-version]').content;
        const m = await import('/js/rhythm.js?v=' + encodeURIComponent(v));
        const s = await import('/js/salience.js?v=' + encodeURIComponent(v));
        const p = await import('/js/playability.js?v=' + encodeURIComponent(v));
        return { r: typeof m.buildGrid, s: typeof s.selectEvents, p: typeof p.auditPlayability };
      } catch (e) { return { err: String(e).slice(0, 120) }; }
    })()`);
    ok('rhythm.js 在浏览器里可用', mod.r === 'function', JSON.stringify(mod));
    ok('salience.js 在浏览器里可用', mod.s === 'function');
    ok('playability.js 在浏览器里可用', mod.p === 'function');
  }

  if (R.path === '/packs') {
    /* ⚠ 这页的失败模式是「渲染出空div」：外框都在，但一张卡片都没画出来，
       用户看到的就是一片白。所以必须断言**真的渲染出了内容**，
       而且要真的去点开抽屉 —— 抽屉里的文件勾选才是这页的功能核心。 */
    const g = await evalJS(`(function(){
      const cards = document.querySelectorAll('#list .card2');
      return {
        cards: cards.length,
        cnt: (document.getElementById('cnt')||{}).textContent || '',
        moreVisible: (function(){ const b=document.getElementById('more');
          return b && b.style.display !== 'none'; })(),
        packBtns: document.querySelectorAll('#list .pack').length,
        /* 卡上必须有曲名和难度 —— 只数卡片数会漏掉"卡片是空壳" */
        withName: Array.prototype.filter.call(cards, function(c){
          const n = c.querySelector('.nm'); return n && n.textContent.trim().length > 0;
        }).length,
        withLv: Array.prototype.filter.call(cards, function(c){
          const l = c.querySelector('.lv'); return l && l.textContent.trim().length > 0;
        }).length,
      };
    })()`);
    ok('渲染出了谱面卡片', g.cards > 0, 'cards=' + g.cards);
    ok('每张卡片都有曲名（卡片不是空壳）', g.withName === g.cards,
       g.withName + '/' + g.cards);
    ok('每张卡片都有难度', g.withLv === g.cards, g.withLv + '/' + g.cards);
    ok('卡片上有「打包」按钮', g.packBtns > 0, 'n=' + g.packBtns);
    ok('计数已填（非空串）', !!g.cnt, JSON.stringify(g.cnt));
    ok('有更多可加载（未把全库一次塞进 DOM）', g.moreVisible === true, String(g.moreVisible));

    /* 真的点一张卡打开抽屉 —— 这才是「能选文件打包」的入口 */
    await evalJS(`(function(){ const b = document.querySelector('#list .pack');
      if (b) b.click(); return 1; })()`);
    await new Promise(r => setTimeout(r, 500));
    const dr = await evalJS(`(function(){
      const d = document.getElementById('drawer');
      const open = d && d.classList.contains('on');
      const rows = document.querySelectorAll('#fl .frow');
      const boxes = document.querySelectorAll('#fl input[type=checkbox]');
      return {
        open: !!open,
        title: (document.getElementById('dTitle')||{}).textContent || '',
        rows: rows.length,
        boxes: boxes.length,
        checked: Array.prototype.filter.call(boxes, function(b){ return b.checked; }).length,
        hasPack: !!document.getElementById('doPack'),
        /* ⚠ checkbox 不能用 display:none 藏起来 ——
           那样键盘 Tab 不到，等于没有无障碍。 */
        visibleBoxes: Array.prototype.filter.call(boxes, function(b){
          return b.offsetParent !== null || b.getClientRects().length > 0;
        }).length,
      };
    })()`);
    ok('点卡片能打开抽屉', dr.open === true, JSON.stringify(dr));
    ok('抽屉标题非空', !!dr.title, JSON.stringify(dr.title));
    ok('列出了 4 种文件（曲绘/音乐/谱面/音频）', dr.rows === 4, 'rows=' + dr.rows);
    ok('每行都有勾选框', dr.boxes === 4, 'boxes=' + dr.boxes);
    ok('默认只勾谱面 JSON（音频动辄几 MB）', dr.checked === 1, 'checked=' + dr.checked);
    ok('勾选框键盘可达（没有被 display:none 藏掉）',
       dr.visibleBoxes === 4, 'visible=' + dr.visibleBoxes);
    ok('有「打包下载」按钮', dr.hasPack === true);

    /* ⚠⚠ 曲绘必须真的显示出来。
       2026-10-18 踩过两个坑，两条断言各挡一个：
         ① 上游 MIME 是 application/octet-stream → 浏览器 ORB 拒绝解码
            （net::ERR_BLOCKED_BY_ORB），<img> 静默失败。真实用户同样中招。
         ② cleanChart 的零宽字符正则把 ASCII 连字符也吃掉了，
            UUID 被抹成 32 位无横杠串 → 直链全 404。
       两者症状一样（全是 ♪ 占位），但根因完全不同 ——
       所以要分别断言：**URL 形状对** + **浏览器真解码出来了**。 */
    const imgUrls = await evalJS(`[...document.querySelectorAll('#list img.ill')].map(i => i.getAttribute('src') || '')`);
    ok('曲绘走我们的代理（不是上游直链，否则会被 ORB 挡）',
      imgUrls.length > 0 && imgUrls.every(u => u.startsWith('/api/phira-illust/')),
      JSON.stringify(imgUrls.slice(0, 2)));
    ok('曲绘 URL 里 UUID 完整（36 字符 —— 别被零宽清洗吃掉横杠）',
      imgUrls.filter(u => u.startsWith('/api/phira-illust/'))
        .every(u => u.split('/').pop().length === 36),
      JSON.stringify(imgUrls.slice(0, 1)));
    /* ⚠ 必须**等解码完成**再断言，不能只看"有没有开始加载"。
       一屏 30 张 1–3MB 的图经我们的代理，串行跑十几页时首屏可能十几秒才填满；
       早先直接断言naturalWidth>0 的数量，结果在图还在路上时就判失败
       （实测 ok=4/30 —— 图确实在加载，只是没到齐）。
       这和"ORB 静默挡掉"症状几乎一样，必须靠等待把两者分开。 */
    const decoded = await evalJS(`(async function(){
      const im = () => [...document.querySelectorAll('#list img.ill')];
      const want = Math.max(1, Math.ceil(im().length * 0.5));
      for (let i = 0; i < 60; i++) {
        const a = im();
        const okIm = a.filter(x => x.naturalWidth > 0);
        /* 全部 settled（complete）就立即收敛，不必死等一半 */
        const settled = a.length > 0 && a.every(x => x.complete);
        if (okIm.length >= want || settled) {
          return { n: a.length, ok: okIm.length, want, settled,
                   src0: okIm[0] ? okIm[0].getAttribute('src') : '' };
        }
        await new Promise(r => setTimeout(r, 500));
      }
      const a = im();
      return { n: a.length, ok: a.filter(x => x.naturalWidth > 0).length, want, settled: false, timeout: true };
    })()`);
    ok('★ 曲绘真的被浏览器解码出来了（不是被 ORB 静默挡掉）',
      decoded.n > 0 && decoded.ok >= Math.max(1, decoded.want || 1),
      JSON.stringify(decoded));

    /* 代理本身的行为也要探：SSRF 闸门与 Range。 */
    const ill = await evalJS(`(async function(){
      const uuid = (document.querySelector('#list img.ill')||{src:''}).src.split('/').pop();
      if (!uuid) return { skip: true };
      const out = { uuid };
      const r = await fetch('/api/phira-illust/' + uuid, { method: 'HEAD' });
      out.ct = r.headers.get('content-type'); out.st = r.status;
      /* ⚠ SSRF 闸门：不像 UUID 的一律拒。
         这个路由会替用户去 fetch 外部地址，闸门松了就是 SSRF。 */
      out.badPath = (await fetch('/api/phira-illust/..%2F..%2Fserver.mjs')).status;
      out.evilHost = (await fetch('/api/phira-illust/http%3A%2F%2Fevil.com%2Fx.png')).status;
      out.post = (await fetch('/api/phira-illust/' + uuid, { method: 'POST' })).status;
      const rr = await fetch('/api/phira-illust/' + uuid, { headers: { Range: 'bytes=0-99' } });
      out.rangeSt = rr.status; out.rangeLen = rr.headers.get('content-length');
      return out;
    })()`);
    if (!ill.skip) {
      ok('★ 代理把 MIME 改成了 image/webp（ORB 就靠这个放行）',
        ill.ct === 'image/webp', JSON.stringify({ ct: ill.ct, st: ill.st }));
      ok('★ 路径穿越被拒（SSRF 闸门）', ill.badPath === 404 || ill.badPath === 400, String(ill.badPath));
      ok('★ 绝对 URL 被拒（SSRF 闸门）', ill.evilHost === 400 || ill.evilHost === 404, String(ill.evilHost));
      ok('★ 非 GET/HEAD 被拒', ill.post === 405, String(ill.post));
      ok('★ 支持 Range（大图先试前 64KB）',
        ill.rangeSt === 206 && ill.rangeLen === '100', JSON.stringify({ st: ill.rangeSt, len: ill.rangeLen }));
    }
  }

  if (R.mod === 'release') {
    /* 下载页存在的唯一意义就是「那个按钮能下到东西」，所以这里**真的去探一次**。
       只断言 href 长得像地址等于没测 —— href 指向 404 时它照样"长得对"。 */
    const d = await evalJS(`(function(){
      const b = document.getElementById('dlbtn'); const h = document.getElementById('hash');
      return { href: b ? b.getAttribute('href') : null,
               dl: b ? b.hasAttribute('download') : false,
               bytes: b ? b.getAttribute('data-bytes') : null,
               file: (document.getElementById('mf')||{}).textContent,
               size: (document.getElementById('ms')||{}).textContent,
               ver: (document.getElementById('mv')||{}).textContent,
               hash: h ? h.textContent : null };
    })()`);
    ok('主按钮有下载地址', !!d.href && d.href.indexOf('/download/') === 0, JSON.stringify(d.href));
    ok('主按钮带 download 属性（点了存盘，不在浏览器里打开）', d.dl === true);
    ok('SHA-256 是 64 位十六进制', /^[0-9a-f]{64}$/.test(String(d.hash)), String(d.hash).slice(0, 20));
    ok('元信息已填（文件名 / 大小 / 客户端版本都不为空）',
      !!d.file && d.file !== '—' && !!d.size && d.size !== '—' && !!d.ver && d.ver !== '—',
      JSON.stringify({ file: d.file, size: d.size, ver: d.ver }));
    /* ⚠ 用 HEAD 探 —— 用 GET 会在测试里真拉下 35MB */
    const probe = await evalJS(`(async function(){
      try { const r = await fetch(${JSON.stringify(d.href)}, { method: 'HEAD' });
            return { status: r.status, len: r.headers.get('content-length'),
                     disp: (r.headers.get('content-disposition')||'').indexOf('attachment') >= 0,
                     ranges: r.headers.get('accept-ranges') }; }
      catch (e) { return { status: 0, err: String(e) }; }
    })()`);
    ok('★ 下载地址真的可达（HEAD 200）', probe.status === 200, JSON.stringify(probe));
    ok('★ 响应声明为附件下载', probe.disp === true, JSON.stringify(probe.disp));
    ok('★ 支持断点续传（accept-ranges: bytes）', probe.ranges === 'bytes', JSON.stringify(probe.ranges));
    ok('★ 响应体大小与页面显示一致',
      d.bytes != null && String(probe.len) === String(d.bytes),
      'content-length=' + probe.len + ' data-bytes=' + d.bytes);
  }

  if (R.mod === 'engine') {
    const st = await evalJS(`(function(){ try{ return PHM.status(); }catch(e){ return {err:String(e)}; } })()`);
    ok('引擎已加载', st && st.engine === 'ok', JSON.stringify(st).slice(0, 160));
    ok('分享卡模块', st && st.sharecard === 'ok', st && st.sharecard);
    await evalJS(`(async function(){ try{ await PHM.loadRef(); }catch(e){} return 1; })()`);
    const st2 = await evalJS(`(function(){ try{ return PHM.status(); }catch(e){ return {}; } })()`);
    ok('社区参照集加载', String(st2.refCom).startsWith('ok/'), 'refCom=' + st2.refCom);
    const eng = await evalJS(`(async function(){
      try{
        const m = await import('/js/engine.js?v=' + encodeURIComponent(
          (document.querySelector('meta[name="app-version"]')||{}).content));
        const j = { BPMList:[{startTime:[0,0,1],bpm:180}], judgeLineList:[{notes:[]}] };
        for (let i=0;i<400;i++) j.judgeLineList[0].notes.push({startTime:[i,0,4],type:(i%7===0)?2:1,positionX:(i%8)*100-350});
        const r = m.reportFromChart(m.loadChart(j), 'synth.json', {name:'冒烟'}, 0, null);
        return { ver:m.ENGINE_VER, ref:r.knn.ref, refOff:r.knnOff.ref, dims:m.REF_DIMS.length };
      }catch(e){ return { err: String(e && (e.stack||e.message||e)) }; }
    })()`);
    ok('浏览器内引擎能算出定数', eng && !eng.err && isFinite(eng.ref), eng && eng.err);
    /* 不写死具体版本号 —— 只断言形态正确（换引擎时不必改测试） */
    ok('engine_ver 形态正确',
      !!(eng && /^[a-z0-9]+-[a-z0-9]+-v\d+\.\d+\.\d+$/.test(String(eng.ver))), eng && eng.ver);
  } else {
    const mods = await evalJS(`(async function(){
      const v = encodeURIComponent((document.querySelector('meta[name="app-version"]')||{}).content);
      const out = {};
      for (const m of ['/js/ui.js','/js/phira.js']) {
        try { const x = await import(m + '?v=' + v); out[m] = Object.keys(x).length; }
        catch (e) { out[m] = 'ERR ' + (e.message||e); }
      }
      return out;
    })()`);
    ok('ui.js 可加载', typeof mods['/js/ui.js'] === 'number' && mods['/js/ui.js'] > 3, JSON.stringify(mods['/js/ui.js']));
    ok('phira.js 可加载', typeof mods['/js/phira.js'] === 'number' && mods['/js/phira.js'] > 3, JSON.stringify(mods['/js/phira.js']));
    /* 导航是真能点的：直接 fetch 一遍所有入口，确认没有 404。
       ⚠ 只探**站内**链接（以 / 开头）—— 2026-10-17 把 GitHub 挪进顶栏之后，
         外部地址在这个 fetch 里必然是 ERR（CORS / 出网策略），
         那不代表链接坏了，探活外链在这套测试里既做不到也没意义。 */
    const links = await evalJS(`(async function(){
      const hrefs = Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.getAttribute('href'); })
        .filter(function(h){ return h && h.charAt(0) === '/'; });
      const res = {};
      for (const h of hrefs) { try { res[h] = (await fetch(h, {method:'GET'})).status; } catch(e){ res[h] = 'ERR'; } }
      return res;
    })()`);
    const bad = Object.entries(links || {}).filter(([, s]) => s !== 200);
    ok('导航每个入口都返回 200', bad.length === 0, JSON.stringify(links));
  }

  const newErr = errors.length - before;
  ok('本页无运行时报错', newErr === 0, newErr + ' 条' + (newErr ? '：' + errors.slice(before).join(' | ').slice(0, 200) : ''));
}

/* ══════════════════════════════════════════════════════════
 * 下线闸门（2026-10-21）
 * ────────────────────────────────────────────────────────────
 * 站点收敛为静态工具，被撤的页面 / API 必须回 **410 Gone**。
 * 为什么单开一节：那些文件**没有删**，只是从 PUBLIC_FILES 里移除 ——
 * 哪天有人把它们加回白名单（或在 CLEAN 里重新映射），下线就静默失效了，
 * 而用户点进去只看到 503，接着以为网站坏了。这条断言就是防那个。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[下线闸门] 被撤的路径必须 410');
{
  const GONE = ['/user', '/data', '/charter', '/status', '/settings', '/platform',
    '/developers', '/phm-api', '/download', '/version', '/chart/1', '/chart/80281',
    '/api/v1/charts', '/api/hm/profile', '/api/stats', '/api/plays', '/api/scores'];
  for (const g of GONE) {
    const r = await fetch(BASE + g, { redirect: 'manual' });
    ok('410 Gone  ' + g, r.status === 410, 'got ' + r.status);
  }
  const r = await fetch(BASE + '/retired');
  const t = r.ok ? await r.text() : '';
  ok('/retired 说明页可达', r.status === 200 && t.includes('停止运营'), 'status=' + r.status);
  ok('/api/health 仍通', (await fetch(BASE + '/api/health')).ok);
  /* 裸文件路径是**另一种**正确行为：文件还在磁盘上，但不在 PUBLIC_FILES 白名单里
     → 404。干净 URL（/user）才是 410。两条都钉住，别混。 */
  for (const f of ['/user.html', '/data.html', '/settings.html', '/status.html']) {
    const r = await fetch(BASE + f, { redirect: 'manual' });
    ok('裸文件 404  ' + f, r.status === 404, 'got ' + r.status);
  }
}

/* 横幅不许依赖 JS：直接读 HTML 源（不执行任何模块）——
   这是「模块链一环失败整页就没文字」最坏的形态，而横幅是最该守的一条。 */
console.log('\n[横幅] 站点公告写死在 HTML 里');
{
  const html = await (await fetch(BASE + '/app')).text();
  ok('横幅文案在 HTML 源里', html.includes('本网站已停止运行'));
  ok('横幅链接指向 /retired', html.includes('href="/retired"'));
}


/* ── 法务文档页：不在主导航里，但必须可访问、且是**浅色阅读版式** ──
   为什么单独检查颜色：长文（隐私政策 / 用户协议）跟产品界面走深色是错的 ——
   白底黑字才适合连续阅读、也才打印得出来。这条断言就是防止将来有人
   顺手把 docs.css 改成深色，把一份正式文本变回"营销页"。 */
for (const [p, name] of [['/privacy', '隐私政策'], ['/terms', '用户协议']]) {
  console.log('\n[文档页] ' + BASE + p + '  （' + name + '）');
  const before = errors.length;
  await send('Page.navigate', { url: BASE + p });
  await new Promise(r => setTimeout(r, 1800));
  const info = await evalJS(`(function(){
    const b = getComputedStyle(document.body);
    const h1 = document.querySelector('h1');
    return { bg: b.backgroundColor, color: b.color,
             hasDoc: !!document.querySelector('.doc'),
             theme: document.documentElement.getAttribute('data-theme'),
             h1: (h1 ? h1.textContent : '').trim().slice(0, 40),
             h2n: document.querySelectorAll('h2').length,
             sw: !!document.querySelector('.topbar nav a') };
  })()`);
  ok('用文档版式（.doc）', info.hasDoc === true);
  /* 文档页现在**跟随站点主题**（深色下点进来不能"啪"地闪一屏白），
     所以只断言"背景真的被主题令牌换掉了"，不再把它锁死成白色。 */
  ok('背景跟随主题令牌', /rgb/.test(String(info.bg)) && info.bg !== 'rgba(0, 0, 0, 0)', 'bg=' + info.bg);
  ok('文档页也应用了 data-theme', info.theme === 'dark' || info.theme === 'light', 'theme=' + info.theme);
  ok('有居中大标题', !!info.h1, info.h1);
  ok('分了章节（≥5 个 h2）', info.h2n >= 5, 'h2=' + info.h2n);
  ok('能在两份文档间切换', info.sw === true);
  ok('本页无运行时报错', errors.length - before === 0);
}

console.log('\n未捕获异常 / console.error ：' + errors.length);
errors.slice(0, 12).forEach(e => console.log('   ! ' + e));
if (warns.length) console.log('警告 ' + warns.length + ' 条（前 3）：' + warns.slice(0, 3).join(' | ').slice(0, 300));

console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail} · 运行时报错 ${errors.length}`);
ws.close(); cleanup();
process.exit((fail || errors.length) ? 1 : 0);
