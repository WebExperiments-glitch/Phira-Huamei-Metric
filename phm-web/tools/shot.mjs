#!/usr/bin/env node
/* ============================================================
 * tools/shot.mjs —— 深浅主题截图（设计迭代用）
 * ============================================================
 * 【为什么要它】改配色、调间距这类**视觉改动，数字说明不了问题** ——
 *   对比度校验只能证明"读得清"，证明不了"好不好看"。
 *   要判断好不好看，只能把两种主题都渲染出来给人看。
 *
 * 用法：
 *   MSYS_NO_PATHCONV=1 node tools/shot.mjs <base> <path> <outDir>
 *   例：MSYS_NO_PATHCONV=1 node tools/shot.mjs http://127.0.0.1:5199 /app ./shots
 *
 *   ⚠ Git Bash 里必须加 MSYS_NO_PATHCONV=1，否则 `/app` 会被改写成 Windows 路径。
 *   ⚠ 它靠 CDP 往页面里塞 phm_theme / phm_lang —— 不是应用代码，
 *     所以下面的裸 localStorage 是有意的（已登记进 lint-slop 白名单）。
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const PAGE = process.argv[3] || '/app';
const OUT = process.argv[4] || 'D:/tmp';
const PORT = 9600 + (process.pid % 200);
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-sh-'));
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1280,1500', 'about:blank'], { stdio: 'ignore' });
const wp = async (p, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const ok = await new Promise(r => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); }); if (ok) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
process.on('exit', () => { try { ch.kill(); } catch {} });
if (!(await wp(PORT))) { console.error('no chrome'); process.exit(2); }
const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await send('Runtime.enable'); await send('Page.enable');
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const wait = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

for (const [name, mode] of [['dark', 'dark'], ['light', 'light']]) {
  await send('Page.navigate', { url: BASE + '/' }); await wait(1200);
  await ev(`try{localStorage.setItem('phm_theme','${mode}');localStorage.setItem('phm_lang','zh')}catch(e){}`);
  /* ⚠ 3200ms 不够：首页的「站点数据」是异步拉 /api/status 的，
     截出来是「读取中…」四格破折号 —— 发到 README 上很难看。
     给到 6 秒，覆盖冷启动时的接口延迟。 */
  await send('Page.navigate', { url: BASE + PAGE }); await wait(Number(process.argv[5] || 6000));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const f = path.join(OUT, 'phm-' + PAGE.replace(/\W/g, '') + '-' + name + '.png');
  fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log('  ' + f + '  (' + Math.round(Buffer.from(shot.data, 'base64').length / 1024) + ' KB)');
}
process.exit(0);
