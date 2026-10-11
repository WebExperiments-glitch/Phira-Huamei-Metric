#!/usr/bin/env node
/* ============================================================
 * tools/collect-display-chars.mjs —— 采集「标题字体」需要覆盖的字符
 * ============================================================
 * 【为什么要有它】中文衬线字体动辄 10MB+。我们只拿它做**标题**，
 * 而标题用到的字就那么几十个 —— 按实际用字裁一个子集，几十 KB 就够。
 * 但"实际用字"必须**从渲染结果里采**，不能靠人肉列：
 * 很多标题是 JS 用 t() 填的（各页 <h2>、结果卡、版本号…），
 * 在源码里 grep 不到。
 *
 * 采完写 tools/display-chars.txt，交给 tools/subset-display-font.py。
 *
 * 用法：MSYS_NO_PATHCONV=1 node tools/collect-display-chars.mjs <base>
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const PAGES = ['/', '/app', '/charter', '/user', '/data', '/settings', '/version', '/privacy', '/terms', '/404.html'];

/* 哪些元素用标题字体 —— 必须与 base.css 里 --font-display 的应用范围一致，
   否则会出现"采集了但没用"或"用了但没采集到（掉回黑体）"。 */
const SEL = 'h1, h2, h3, .big, .num, .brand, .hsearch button, .verfoot, .rel .ver';

const PORT = 9700 + (process.pid % 150);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-dc-'));
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--disable-gpu', '--window-size=1400,1200', 'about:blank'], { stdio: 'ignore' });
const wp = async (p, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const ok = await new Promise(r => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); }); if (ok) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
process.on('exit', () => { try { ch.kill(); } catch {} });
if (!(await wp(PORT))) { console.error('Chrome 未就绪'); process.exit(2); }
const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await send('Runtime.enable'); await send('Page.enable');
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const wait = ms => new Promise(r => setTimeout(r, ms));

const charset = new Set();
for (const lang of ['zh', 'en']) {
  await send('Page.navigate', { url: BASE + '/' }); await wait(1200);
  await ev(`try{localStorage.setItem('phm_lang','${lang}')}catch(e){}`);
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p }); await wait(2600);
    const txt = await ev(`(function(){
      var out=[];
      document.querySelectorAll(${JSON.stringify(SEL)}).forEach(function(e){ out.push(e.textContent); });
      return out.join('\\n');
    })()`);
    for (const c of String(txt || '')) charset.add(c);
    process.stdout.write('  ' + lang + ' ' + p + ' 累计 ' + charset.size + ' 字\n');
  }
}

/* ASCII 可打印 + 常用标点/符号一并带上 —— 标题里会混英文、数字、百分号、箭头 */
for (let i = 33; i <= 126; i++) charset.add(String.fromCharCode(i));
for (const c of '　、。，．·；：？！…—～「」『』（）【】《》〈〉“”‘’±×÷≥≤≠→←↑↓√°′″‰%‰$¥€£©®™№§¶†‡•‥·') charset.add(c);

const chars = [...charset].filter(c => c.trim() !== '' || c === ' ').join('').replace(/\s+/g, '');
const outDir = path.join(ROOT, 'tools');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'display-chars.txt'), chars, 'utf8');
console.log('\n采集完成：' + chars.length + ' 个字符（含 ASCII 与标点）');
console.log('  → tools/display-chars.txt');
process.exit(0);
