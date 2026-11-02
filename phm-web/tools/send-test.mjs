import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));
const url = process.argv[2] || 'http://127.0.0.1:5199/write';
const prompt = process.argv[3] || '你好，用一句话说明你能做什么';
const waitMs = Number(process.argv[4] || 45000);

const dir = mkdtempSync(join(tmpdir(), 'phm-snd-'));
const port = 9434;
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--user-data-dir=' + dir,
  '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
  catch { await sleep(200); }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  if (m.method === 'Runtime.consoleAPICalled') logs.push('LOG ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
await new Promise((r) => ws.addEventListener('open', r));
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);
await sleep(6000);

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;

console.log('before:', await ev(`document.querySelector('#stat')?.textContent`));
await ev(`window.confirm = () => true; 1`);
await ev(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(prompt)};
  q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return 1})()`);
console.log('sent, waiting…');
await sleep(waitMs);

const dump = await ev(`JSON.stringify({
  n: document.querySelectorAll('.msg').length,
  bot: [...document.querySelectorAll('.msg.bot .body')].map(b=>b.innerText.slice(0,500)),
  tools: [...document.querySelectorAll('.tool')].map(b=>b.innerText.replace(/\\n/g,' ').slice(0,80)),
  dl: [...document.querySelectorAll('a[download]')].map(a=>a.getAttribute('download')+' | '+a.textContent),
  dot: document.querySelector('#dot')?.dataset.ok,
})`);
console.log(dump);

/* 顺手截一张，肉眼看界面比读 JSON 快 */
if (process.env.SHOT) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('shots', { recursive: true });
  const cap = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (cap.result?.data) {
    writeFileSync(process.env.SHOT, Buffer.from(cap.result.data, 'base64'));
    console.log('shot → ' + process.env.SHOT);
  }
}
if (logs.length) console.log('--- console ---\n' + logs.slice(-20).join('\n'));
ws.close(); child.kill(); process.exit(0);
