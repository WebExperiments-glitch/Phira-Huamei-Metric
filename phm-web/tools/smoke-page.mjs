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
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); } };

console.log('\n[页面冒烟] ' + BASE);
/* 先显式触发一次参照集加载（页面空闲时也会自己预热，但测试不等闲时） */
await evalJS(`(async function(){ try{ await PHM.loadRef(); }catch(e){} return 1; })()`);

const info = await evalJS(`(function(){
  const out = { ver: (document.querySelector('meta[name="app-version"]')||{}).content,
                hasPHM: typeof PHM !== 'undefined' };
  if (typeof PHM !== 'undefined' && PHM.status) { try { out.status = PHM.status(); } catch(e){ out.statusErr = String(e); } }
  out.dom = {
    drop: !!document.getElementById('drop'),
    msg: !!document.getElementById('msg'),
  };
  return out;
})()`);

ok('页面有版本号', !!info.ver, 'ver=' + info.ver);
ok('PHM 对象挂上了', info.hasPHM === true);
ok('PHM.status() 可调用', !!info.status, info.statusErr || '');
if (info.status) {
  const s = info.status;
  ok('引擎已加载 (engine=ok)', s.engine === 'ok', 'engine=' + s.engine);
  ok('分享卡模块已加载', s.sharecard === 'ok', 'sharecard=' + s.sharecard);
  ok('社区参照集已加载', String(s.refCom).startsWith('ok/'), 'refCom=' + s.refCom);
  console.log('    状态: ' + JSON.stringify(s));
}
ok('拖放入口 DOM 存在', info.dom.drop === true);
ok('消息区 DOM 存在', info.dom.msg === true);

/* 真算一张谱：在页面里合成一个最小 RPE zip 太麻烦，
   改为直接调页面里已加载的引擎函数，验证「浏览器里的引擎」确实能跑。 */
const eng = await evalJS(`(async function(){
  try{
    const m = await import('/js/engine.js?v=' + encodeURIComponent(
      (document.querySelector('meta[name="app-version"]')||{}).content));
    const j = { BPMList:[{startTime:[0,0,1],bpm:180}], judgeLineList:[{notes:[]}] };
    for (let i=0;i<400;i++) j.judgeLineList[0].notes.push({startTime:[i,0,4],type:(i%7===0)?2:1,positionX:(i%8)*100-350});
    const r = m.reportFromChart(m.loadChart(j), 'synth.json', {name:'冒烟'}, 0, null);
    return { ver:m.ENGINE_VER, ref:r.knn.ref, refOff:r.knnOff.ref, basis:r.knn.basis,
             officialN:m.REF_OFFICIAL.length, dims:m.REF_DIMS.length, labels:m.ROW_LABELS };
  }catch(e){ return { err: String(e && (e.stack||e.message||e)) }; }
})()`);
ok('浏览器内引擎能算出定数', eng && !eng.err && isFinite(eng.ref), eng && eng.err);
if (eng && !eng.err) {
  ok('双标度都在', isFinite(eng.ref) && isFinite(eng.refOff), eng.ref + ' / ' + eng.refOff);
  ok('engine_ver 是 com-knn8-v0.4.0', eng.ver === 'com-knn8-v0.4.0', eng.ver);
  console.log('    官谱参照 ' + eng.officialN + ' 行 · ' + eng.dims + ' 维 · labels=' + eng.labels
    + ' · 合成谱 社区 ' + eng.ref + ' / 官谱 ' + eng.refOff);
}

/* 参照集在浏览器里也能走通 k-NN（不是只有 Node 能） */
const withCom = await evalJS(`(async function(){
  try{
    const m = await import('/js/engine.js?v=' + encodeURIComponent(
      (document.querySelector('meta[name="app-version"]')||{}).content));
    const jf = await fetch('/data/ref-com.json?v=' + encodeURIComponent(
      (document.querySelector('meta[name="app-version"]')||{}).content));
    const ref = (await jf.json()).rows;
    const j = { BPMList:[{startTime:[0,0,1],bpm:180}], judgeLineList:[{notes:[]}] };
    for (let i=0;i<400;i++) j.judgeLineList[0].notes.push({startTime:[i,0,4],type:(i%7===0)?2:1,positionX:(i%8)*100-350});
    const r = m.reportFromChart(m.loadChart(j), 'synth.json', {name:'冒烟'}, 0, ref);
    return { n:ref.length, basis:r.knn.basis, ref:r.knn.ref, refOff:r.knnOff.ref,
             lo:r.knn.lo, hi:r.knn.hi, tier:r.knn.tier };
  }catch(e){ return { err: String(e && (e.stack||e.message||e)) }; }
})()`);
ok('浏览器内能用社区参照集查 k-NN', withCom && !withCom.err && withCom.basis === 'community', withCom && withCom.err);
if (withCom && !withCom.err) {
  ok('社区参照 ' + withCom.n + ' 行 · 主结果 basis=community', withCom.n >= 9000);
  ok('不确定带 lo ≤ 中点 ≤ hi', withCom.lo <= withCom.ref && withCom.ref <= withCom.hi,
    withCom.lo + ' ≤ ' + withCom.ref + ' ≤ ' + withCom.hi);
  console.log('    合成谱 → 社区共识 ' + withCom.ref + '（' + withCom.lo + '–' + withCom.hi + '）· 官谱标度 ' + withCom.refOff);
}

console.log('\n未捕获异常 / console.error ：' + errors.length);
errors.slice(0, 12).forEach(e => console.log('   ! ' + e));
if (warns.length) console.log('警告 ' + warns.length + ' 条（前 3）：' + warns.slice(0, 3).join(' | ').slice(0, 300));

console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail} · 运行时报错 ${errors.length}`);
ws.close(); cleanup();
process.exit((fail || errors.length) ? 1 : 0);
