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

/* 每条路由要检查的东西。⚠ 站点拆页之后**每一页都要走一遍** ——
   真实事故形态是「首页没事、别的页面白屏」。 */
const ROUTES = [
  { path: '/', name: '首页', sel: ['#stats', '#verfoot'], mod: 'ui' },
  { path: '/app', name: '工作台', sel: ['#drop', '#file', '#msg', '#out', '#csrch'], mod: 'engine' },
  { path: '/user', name: '玩家页', sel: ['#q', '#go', '#out', '#cands'], mod: 'phira' },
  { path: '/charter', name: '谱师页', sel: ['#q', '#go', '#out'], mod: 'phira' },
  { path: '/data', name: '数据管理', sel: ['#sum', '#tbl', '#pgwrap', '#q'], mod: 'data' },
  { path: '/settings', name: '设置', sel: ['#optin', '#inv', '#ownList', '#stMsg', '#abVer'], mod: 'settings' },
];

for (const R of ROUTES) {
  console.log('\n[页面冒烟] ' + BASE + R.path + '  （' + R.name + '）');
  const before = errors.length;
  await send('Page.navigate', { url: BASE + R.path });
  await new Promise(r => setTimeout(r, 2800));

  const info = await evalJS(`(function(){
    const out = { ver: (document.querySelector('meta[name="app-version"]')||{}).content,
                  title: document.title, hasNav: !!document.getElementById('nav') };
    out.dom = {};
    ${JSON.stringify(R.sel)}.forEach(function(s){ out.dom[s] = !!document.querySelector(s); });
    out.navLinks = Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.getAttribute('href'); });
    return out;
  })()`);

  /* 不写死版本号（写死的话每次升版本都要改测试，迟早漏），
     只断言形态：V<数字>.<数字>.<数字>，且各页一致 */
  ok('有版本号', /^V\d+\.\d+\.\d+$/.test(String(info.ver)), 'ver=' + info.ver);
  if (!CC.ver) CC.ver = info.ver;
  else ok('各页版本号一致', CC.ver === info.ver, CC.ver + ' vs ' + info.ver);
  ok('有页面标题', !!info.title && info.title.length > 3, info.title);
  ok('导航已渲染', info.hasNav === true);
  ok('导航含 6 个入口', (info.navLinks || []).length >= 6, JSON.stringify(info.navLinks));
  for (const sel of R.sel) ok('DOM ' + sel + ' 存在', info.dom[sel] === true);

  if (R.mod === 'data') {
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
    /* 导航是真能点的：直接 fetch 一遍所有入口，确认没有 404 */
    const links = await evalJS(`(async function(){
      const hrefs = Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.getAttribute('href'); });
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
console.log('\n未捕获异常 / console.error ：' + errors.length);
errors.slice(0, 12).forEach(e => console.log('   ! ' + e));
if (warns.length) console.log('警告 ' + warns.length + ' 条（前 3）：' + warns.slice(0, 3).join(' | ').slice(0, 300));

console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail} · 运行时报错 ${errors.length}`);
ws.close(); cleanup();
process.exit((fail || errors.length) ? 1 : 0);
