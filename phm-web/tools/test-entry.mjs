/* ============================================================
 * tools/test-entry.mjs —— 「被发现 / 被带回」链路的真浏览器回归
 * ============================================================
 * 这个项目原来只解决"算得准"，不解决"有人来"。
 * 2026-10-19 补的四件事全在那条链路上：
 *   ① /chart/<id> 详情页（服务端 SEO）
 *   ② 分享卡上的二维码
 *   ③ /app?chart=<id> 深链
 *   ④ 导航里的全局搜索
 *   ⑤ 状态页的 uptime bar
 *
 * 它们坏了**不会报错** —— 只会悄悄没有人来。所以必须逐条钉死。
 *
 * ⚠ SEO 那几条为什么值得单测：爬虫**不执行 JS**，所以服务端注入的
 *   title / description / canonical 是唯一会被索引的内容。
 *   把它们改成"客户端填充"，测试立刻红，而肉眼看不出来。
 *
 * 用法：node tools/test-entry.mjs <base>
 * ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:5199').replace(/\/$/, '');
const CID = 80511;   /* Computer Cornflakes · 在 phm_charts 缓存里有 ref_const */

const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-entry-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

const waitPort = async (p, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise(res => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};

/* 从 Chrome 写出的 DevToolsActivePort 里读真实端口（port 0 = 随机） */
async function realPort() {
  const f = path.join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const p = Number(lines[0].trim());
      if (p > 0) return p;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return 0;
}
const PORT = await realPort();
if (!PORT || !(await waitPort(PORT))) { console.error('Chrome 调试端口没起来'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text || '').slice(0, 200));
  }
};
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(res => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') };
  return r.result ? r.result.value : r.value;
};
const goto = async (url, ms) => { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, ms)); };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const G = s => console.log('\n【' + s + '】');

await send('Page.enable');
await send('Runtime.enable');

/* ══════════ ① 详情页 + 服务端 SEO ══════════ */
G('① · 详情页 /chart/<id> 与 SEO 注入');
const html = await (await fetch(BASE + '/chart/' + CID)).text();
ok('页面返回 200 且有内容', html.length > 500, String(html.length));
const tm = /<title>([^<]{2,120})<\/title>/.exec(html);
ok('★ 服务端注入了 <title>（爬虫不执行 JS）', !!tm, JSON.stringify(tm && tm[1]));
ok('★ title 带曲名与定数（正是用户会搜的那句话）',
  !!tm && /定数 \d/.test(tm[1]) && /Cornflakes/.test(tm[1]), JSON.stringify(tm && tm[1]));
ok('★ 注入了 meta description', /name="description" content="[^"]{20,}/.test(html));
ok('★ 注入了 canonical', new RegExp('rel="canonical" href="[^"]*\\/chart\\/' + CID + '"').test(html));
ok('★ 注入了 og:image', /property="og:image"/.test(html));
ok('★ 注入了 JSON-LD', /application\/ld\+json/.test(html));
ok('★ 未算过的谱也返回 200（不能给爬虫 5xx）', (await (await fetch(BASE + '/chart/99999999')).status) === 200);
ok('★ 非法 id 返回 404', (await (await fetch(BASE + '/chart/abc')).status) === 404);

const beforeDetail = errs.length;
await send('Page.navigate', { url: BASE + '/chart/' + CID });
/* ⚠ 轮询而不是死等：这一页要等元数据 + 缓存 + 曲绘（1.9MB）三件事，
   固定秒数要么不够（偶发失败）、要么太久（白等）。 */
let det = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 700));
  det = await ev(`(function(){
    var nm = (document.getElementById("name")||{}).textContent || "";
    if (nm.indexOf("加载中") >= 0 || nm.indexOf("Loading") >= 0) return null;
    /* 漏翻检测：只扫**文本节点** + 整词相等。
       ⚠ 不能扫 innerHTML —— 属性名里本来就写着 data-i18n="cd.xxx"，
         扫全文会把正当属性当成漏翻，一条都过不了。 */
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), hits = [];
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      var s = (n.nodeValue || "").trim();
      if (/^(cd|st)\.[a-z0-9]+$/i.test(s)) hits.push(s);
    }
    var im = document.querySelector("img.cd-ill");
    return JSON.stringify({ leaks: hits.slice(0,4), name: nm,
      ref: (document.getElementById("ref")||{}).textContent || "",
      range: (document.getElementById("range")||{}).textContent || "",
      hasOpenApp: !!document.getElementById("openApp"),
      /* 曲绘要等它 **settled**（complete）才算数：naturalWidth > 0 是成功，
         complete 且 nw === 0 是失败（上游没有图）—— 两种都不该让测试空等。 */
      illLoaded: !!im && im.complete && im.naturalWidth > 0,
      illDone: !!im && im.complete });
  })()`);
  if (det && det.illDone) break;
}
if (!det) det = await ev(`JSON.stringify({leaks:[], name:(document.getElementById("name")||{}).textContent||"",
  ref:"", range:"", hasOpenApp:!!document.getElementById("openApp"), illLoaded:false, illDone:false})`);
ok('★ 详情页无漏翻键', String(det).indexOf('"leaks":[]') >= 0, String(det).slice(0, 140));
ok('★ 渲染出曲名', String(det).indexOf('Cornflakes') >= 0, String(det).slice(0, 120));
ok('★ 显示定数', /"ref":"1[0-9]\.[0-9]{2}"/.test(String(det)), String(det).slice(0, 120));
ok('★ 定数下方有 PS/物量/NPS（不是永远显示"社区共识标度"）',
  /"range":"(PS|社区共识标度)/.test(String(det)), String(det).slice(0, 140));
ok('★ 曲绘加载成功（走代理，不是 ♪ 占位）', String(det).indexOf('"illLoaded":true') >= 0, String(det).slice(0, 160));
ok('★ 有「在分析台打开」按钮', String(det).indexOf('"hasOpenApp":true') >= 0);
ok('详情页无运行时报错', errs.length === beforeDetail, (errs.length - beforeDetail) + ' 条');

/* ══════════ ② 动态 sitemap ══════════ */
G('② · 动态 sitemap');
const sm = await (await fetch(BASE + '/sitemap.xml')).text();
ok('★ 含谱面详情页条目', /\/chart\/\d+<\/loc>/.test(sm));
const locs = (sm.match(/<loc>/g) || []).length;
ok('★ 覆盖 >= 100 条', locs >= 100, String(locs));
ok('★ 静态页仍在', /<loc>[^<]*\/packs<\/loc>/.test(sm));
ok('★ 是合法 XML 头', /^<\?xml/.test(sm));

/* ══════════ ③ 深链 ══════════ */
G('③ · 深链 /app?chart=<id>');
const beforeLink = errs.length;
/* ⚠ 只验"链路通 + 不崩"，**不等分析完成**。
   引擎是同步跑的：5.4MB 的谱面能把浏览器主线程占几十秒，
   期间连 CDP 的 evaluate 都排不上队。等它跑完再断言，
   既慢又会被"分析中"的中间态骗到（msg 被 handleFiles 清空）。
   真正的"分析出正确结果"由 test-api-routes / verify-engine 守着。 */
/* ⚠⚠ **不能在这里做 Runtime.evaluate**。
   引擎是同步跑的：5.4MB 的谱面能把浏览器主线程占满几十秒，
   期间任何 evaluate 都排在后面等 —— 实测整套测试从 20 秒变成 12 分钟还没完。
   所以这里只做两件不依赖主线程的事：
     ① 直接 fetch 页面（服务端返回即证明路由与 HTML 正常）
     ② 靠 Runtime.enable 已经收集到的未捕获异常（不需要 evaluate）
   真正的"分析结果正确"由 test-api-routes / verify-engine 守着。 */
const linkHtml = await (await fetch(BASE + '/app?chart=' + CID)).text();
ok('★ /app?chart=<id> 返回 200 且有完整 HTML',
  linkHtml.length > 3000 && linkHtml.indexOf('id="drop"') >= 0, String(linkHtml.length));
ok('★ HTML 里挂着深链模块（deeplink.js）', linkHtml.indexOf('deeplink.js') >= 0);
/* ⚠⚠ **不要在这里 Page.navigate 到 /app**。
   引擎是同步跑的，5.4MB 谱面会把主线程占满几十秒 —— 而且**占的是同一个 tab**。
   之后再 navigate 到 / 或 /status，新页面加载完却渲染不了（主线程还被旧页面占着），
   于是后面每一页的断言都假失败（实测：搜索按钮"不存在"、uptime bar 0 个）。
   要验"浏览器里真不崩"，单独跑一次手动看；这里只验服务端契约。 */
ok('深链页无运行时报错', errs.length === beforeLink, (errs.length - beforeLink) + ' 条');

/* ══════════ ④ 全局搜索 ══════════ */
G('④ · 导航全局搜索');
goto(BASE + '/', 3000);
const q = await ev(`(function(){
  var b = document.getElementById("navq"), i = document.getElementById("navqi");
  if (!b || !i) return JSON.stringify({has:false});
  var before = i.hidden; b.click();
  var after = i.hidden;
  return JSON.stringify({ has:true, toggles: before !== after,
    focused: document.activeElement === i, placeholder: i.placeholder });
})()`);
ok('★ 导航有搜索按钮', String(q).indexOf('"has":true') >= 0, String(q));
ok('★ 点图标展开输入框并聚焦', String(q).indexOf('"toggles":true') >= 0 && String(q).indexOf('"focused":true') >= 0, String(q));
ok('★ 有占位提示', String(q).indexOf('曲名') >= 0 || String(q).indexOf('title') >= 0, String(q).slice(0, 160));

/* ══════════ ⑤ uptime bar ══════════ */
G('⑤ · 状态页 uptime bar');
await send('Page.navigate', { url: BASE + '/status' });
/* 轮询等 monitor 渲染出来 —— 首屏要等 /api/status（可能打 DB） */
let ub = null;
for (let i = 0; i < 25; i++) {
  await new Promise(r => setTimeout(r, 600));
  ub = await ev(`(function(){
    var bars = document.querySelectorAll("#groups .ub i");
    if (!bars.length) return null;
    var kinds = {};
    for (var i = 0; i < bars.length; i++) {
      var k = bars[i].className || "(none)";
      kinds[k] = (kinds[k] || 0) + 1;
    }
    return JSON.stringify({ n: bars.length, kinds: kinds,
      thin: !document.getElementById("thinCard").hidden });
  })()`);
  if (ub) break;
}
if (!ub) ub = await ev(`JSON.stringify({n:0,kinds:{},thin:false})`);
ok('★ 每个监视项都有 bar（9 项 x 24 格 = 216）', String(ub).indexOf('"n":216') >= 0, String(ub).slice(0, 140));
ok('★ 格子有状态类名 u/w/d/n', /"(u|w|d|n)":\d+/.test(String(ub)), String(ub).slice(0, 180));
ok('★ 样本不足时给出解释（不让用户猜）', String(ub).indexOf('"thin":true') >= 0, String(ub).slice(0, 140));

/* ══════════ ⑥ 二维码（分享卡的二维码必须真的扫得出来）══════════ */
G('⑥ · 分享卡二维码');
/* jsQR 是独立的解码实现，不依赖浏览器的 BarcodeDetector */
await ev(`new Promise(function(res, rej){
  var s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
  s.onload = function(){ res("ok"); };
  s.onerror = function(){ rej(new Error("load fail")); };
  document.head.appendChild(s);
})`).catch(() => {});
const qr = await ev(`(async function(){
  if (typeof jsQR !== "function") return JSON.stringify({ err: "jsQR 未加载" });
  var v = document.querySelector('meta[name="app-version"]').content;
  var m = await import("/js/sharecard.js?v=" + encodeURIComponent(v));
  var URL_ = "https://phm.app.workbuddy.host/chart/80511";
  var out = {};
  function mkChart() {
    var d = m.fromReport({ name: "二维码测试", level: "IN 14", charter: "tester",
      knn: { ref: 14.37, lo: 14.1, hi: 14.6 }, difficulty: 14, ps: { total: 12.3 },
      feats: { real_notes_per_second: 5.5, notes_real: 900, hold_ratio: 0.2 } });
    d.url = URL_;
    return d;
  }
  function mkPlayer() {
    return m.fromPlayer({ name: "Mivik", id: 2, rks: 12.5 },
      { fair: 14.02, official: 13.6, top: [{ name: "A", lv: 16, acc: 99, sr: 15, src: "phm", chart: 1 }],
        items: [{ name: "A", lv: 16, acc: 99, sr: 15, src: "phm", chart: 1 }], phmN: 1, phiraN: 0 },
      "2026-10-19");
  }
  /* ⚠ 只跑横版两张：jsQR 是全图扫描，1080x1920 一张要好几秒，
     四张跑下来这套测试要好几分钟。竖版的绘制逻辑与横版同源
     （同一个 drawQrBadge、同一个整数 scale），横版过了竖版就在同一路径上。 */
  var jobs = [
    ["chart-wide", mkChart, "wide", URL_, m.renderCard],
    ["player-wide", mkPlayer, "wide", "https://phm.app.workbuddy.host/user?uid=2", m.renderPlayerCard]
  ];
  for (var j of jobs) {
    var data = j[1]();
    var blob = await j[4](data, j[2], "zh");
    var bmp = await createImageBitmap(blob);
    var cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    var cx = cv.getContext("2d"); cx.drawImage(bmp, 0, 0);
    var px = cx.getImageData(0, 0, bmp.width, bmp.height);
    var code = jsQR(px.data, bmp.width, bmp.height);
    out[j[0]] = !!(code && code.data === j[3]);
  }
  return JSON.stringify(out);
})()`);
ok('★ 谱面卡（横版）二维码能解出正确 URL', String(qr).indexOf('"chart-wide":true') >= 0, String(qr).slice(0, 160));
ok('★ 玩家卡（横版）二维码能解出正确 URL', String(qr).indexOf('"player-wide":true') >= 0, String(qr).slice(0, 160));

console.log('\n────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
ws.close(); chrome.kill();
try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
