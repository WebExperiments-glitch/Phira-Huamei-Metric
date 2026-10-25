/* 带附件跑一遍：CDP 把文件塞进 <input type=file>，再输入文字发送。
   守的就是「上传音频就 Failed to fetch」那条。
   用法：node tools/send-test-audio.mjs <base> <audioPath> <prompt> [waitMs] */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const url = process.argv[2] || 'http://127.0.0.1:5199/write';
const audio = resolve(process.argv[3] || 'tmp/test-150bpm.wav');
const prompt = process.argv[4] || '按这个音频写一张谱，难度中等。';
const waitMs = Number(process.argv[5] || 110000);

const dir = mkdtempSync(join(tmpdir(), 'phm-aud-'));
/* ⚠ 端口必须确认**空着**再用：残留的无头 Chrome 占着端口时，
   fetch 会连到**另一个实例**，于是导航到 /write 却查到一个首页，
   表现为「附件状态 undefined、一条消息都没有」——看起来像应用坏了。 */
let port = 0;
for (let p = 9400; p < 9490; p++) {
  try { await fetch('http://127.0.0.1:' + p + '/json/version', { signal: AbortSignal.timeout(150) }); }
  catch { port = p; break; }
}
if (!port) { console.error('没有空闲调试端口'); process.exit(3); }
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--no-default-browser-check', '--user-data-dir=' + dir,
  '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version;
for (let i = 0; i < 80; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
  catch { await sleep(200); }
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled') logs.push('LOG ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
});
const send = (method, params = {}, sid) => new Promise((r) => {
  const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params, sessionId: sid }));
});
await new Promise((r) => ws.addEventListener('open', r));
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('DOM.enable', {}, sessionId);
console.log('导航目标:', JSON.stringify(url), '| 音频:', audio);
 const navRes = await send('Page.navigate', { url }, sessionId);
 console.log('navigate 结果:', JSON.stringify(navRes.result || navRes.error));
await sleep(5000);

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;

console.log('落点:', await ev('location.href'), '| 有 #q:', await ev('!!document.querySelector("#q")'));

/* 塞文件 */
const doc = await send('DOM.getDocument', {}, sessionId);
const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' }, sessionId);
await send('DOM.setFileInputFiles', { files: [audio], nodeId: node.result.nodeId }, sessionId);
await sleep(4000);
console.log('附件状态:', await ev(`document.querySelector('#hintAudio')?.textContent`));

await ev(`window.confirm = () => true; 1`);
await ev(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(prompt)};
  q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return 1})()`);
console.log('已发送，等待…');
await sleep(waitMs);

console.log(await ev(`JSON.stringify({
  tools: [...document.querySelectorAll('.tool')].map(b=>b.innerText.replace(/\\n/g,' ').slice(0,70)),
  bot: [...document.querySelectorAll('.msg.bot .body')].map(b=>b.innerText.slice(-1600)),
  dl: [...document.querySelectorAll('a[download]')].map(a=>a.textContent),
  dot: document.querySelector('#dot')?.dataset.ok,
})`));
if (logs.length) console.log('--- console ---\n' + logs.slice(-10).join('\n'));

/* 把包真的下载到磁盘 —— 走的是用户点「下载」的同一条路径。
   ⚠ 不要用 CDP 把字节 base64 回传：2 MB 的包会让 evaluate 的返回值变成
     一个对象，直接 `Buffer.from(obj)` 报 ERR_INVALID_ARG_TYPE。 */
if (process.env.ZIPOUT) {
  const dir = resolve(process.env.ZIPOUT);
  const { mkdirSync, readdirSync, copyFileSync, statSync } = await import('node:fs');
  const dlDir = join(dirname(dir), 'dl-' + Date.now());
  mkdirSync(dlDir, { recursive: true });
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }, sessionId);
  const clicked = await ev(`(()=>{const a=document.querySelectorAll('a[download]');
    if(!a.length) return 0; a[a.length-1].click(); return 1})()`);
  await sleep(2500);
  const files = readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'));
  if (clicked && files.length) {
    const src = join(dlDir, files[0]);
    copyFileSync(src, dir);
    console.log('已从下载目录取回 → ' + dir, statSync(dir).size, '字节（原文件名 ' + files[0] + '）');
  } else {
    console.log('没有下载到文件（这一轮没出包？clicked=' + clicked + '）');
  }
}

if (process.env.SHOT) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('shots', { recursive: true });
  const cap = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (cap.result?.data) { writeFileSync(process.env.SHOT, Buffer.from(cap.result.data, 'base64')); console.log('shot → ' + process.env.SHOT); }
}
ws.close(); child.kill(); process.exit(0);
