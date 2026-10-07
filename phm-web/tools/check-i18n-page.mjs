#!/usr/bin/env node
/* ============================================================
 * tools/_check-cn-page.mjs —— 临时工具：某页在英文模式下还剩多少中文
 * ============================================================
 * 用法：
 *   node tools/_check-cn-page.mjs http://127.0.0.1:5199 /app
 *   node tools/_check-cn-page.mjs http://127.0.0.1:5199 /app --zh   （反过来查）
 *
 * 输出：残留的可见中文文本节点（tag.class :: 文本）+ 运行时报错。
 * ⚠ 数据本身就含中文（曲名、谱师名、用户名）—— 这些**不算**漏翻，
 *   靠肉眼分辨：UI 短语 vs 专有名词。
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const PAGES = process.argv.slice(3).filter(a => a.startsWith('/'));
const LANG = process.argv.includes('--zh') ? 'zh' : 'en';
if (!PAGES.length) { console.error('用法: node tools/_check-cn-page.mjs <base> <path> [more paths…]'); process.exit(2); }

const PORT = 9700 + (process.pid % 200);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH'); process.exit(2); }
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-cn-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,1400', 'about:blank'], { stdio: 'ignore' });
const waitPort = async (p, ms = 15000) => { const t0 = Date.now();
  while (Date.now() - t0 < ms) { const ok = await new Promise(res => { const s = net.connect(p, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
process.on('exit', () => { try { chrome.kill(); } catch {} });
if (!(await waitPort(PORT))) { console.error('Chrome 未就绪'); process.exit(2); }
const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
const errors = [];
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')); });
await send('Runtime.enable'); await send('Page.enable');
const evalJS = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 先在首页把语言定下来（同源，后面所有页面共享） */
await send('Page.navigate', { url: BASE + '/' }); await wait(2000);
await evalJS(`try{localStorage.setItem('phm_lang',${JSON.stringify(LANG)})}catch(e){}`);
await send('Page.navigate', { url: BASE + '/' }); await wait(800);

const SCAN = `(function(){
  const out=[];
  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let n;
  while((n=w.nextNode())){
    const s=(n.nodeValue||'').trim(); if(!s) continue;
    if(!/[\\u4e00-\\u9fa5]/.test(s)) continue;
    const el=n.parentElement; if(!el) continue;
    const cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden') continue;
    const tag=el.tagName.toLowerCase();
    if(tag==='script'||tag==='style') continue;
    out.push(tag+'.'+String(el.className||'').split(' ')[0]+' :: '+s.replace(/\\s+/g,' ').slice(0,64));
  }
  const seen=new Set(); const uniq=[];
  for(const x of out){ if(seen.has(x)) continue; seen.add(x); uniq.push(x); }
  return uniq;
})()`;

let total = 0;
for (const p of PAGES) {
  errors.length = 0;
  await send('Page.navigate', { url: BASE + p }); await wait(2800);
  const r = await evalJS(SCAN).catch(e => ['ERR ' + e.message]);
  console.log('\n══════ ' + p + '（lang=' + LANG + '）══════');
  if (!r.length) console.log('  ✓ 无残留');
  else { total += r.length; r.slice(0, 60).forEach(x => console.log('  · ' + x)); if (r.length > 60) console.log('  … 共 ' + r.length + ' 条'); }
  if (errors.length) console.log('  ⚠ 运行时报错:\n    ' + errors.join('\n    '));
}
console.log('\n合计残留 ' + total + ' 条');
process.exit(0);
