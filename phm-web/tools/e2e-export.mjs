/* 真实浏览器 + 真实 AAC，跑一遍我们的导出链路，把包抓回磁盘。
   用法：node tools/e2e-export.mjs tmp/real-aac.m4a out.zip */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const audioPath = resolve(process.argv[2] || 'tmp/real-aac.m4a');
const outPath = resolve(process.argv[3] || 'tmp/e2e-out.zip');
const b64 = readFileSync(audioPath).toString('base64');

let port = 0;
for (let p = 9400; p < 9490; p++) {
  try { await fetch('http://127.0.0.1:' + p + '/json/version', { signal: AbortSignal.timeout(150) }); }
  catch { port = p; break; }
}
const dir = mkdtempSync(join(tmpdir(), 'phm-exp-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + dir, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let v;
for (let i = 0; i < 80; i++) {
  try { v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
  catch { await sleep(200); }
}
const ws = new WebSocket(v.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
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
await send('Page.navigate', { url: 'http://127.0.0.1:5199/write' }, sessionId);
await sleep(4500);

const expr = `(async () => {
  const R = await import('/js/rulechart.js?v=V0.22.0.0');
  const A = await import('/js/audio-analysis.js?v=V0.22.0.0');
  const bin = atob(${JSON.stringify(b64)});
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);

  const sniff = A.sniffAudioKind(raw);
  const fixed = await A.ensurePlayableAudio(raw, '爱属性.mp3');

  const chart = {
    formatVersion: 3, offset: 0, judgeLineGroup: ['Default'],
    BPMList: [{ bpm: 145, startTime: [0, 0, 1] }],
    META: { RPEVersion: 160, background: 'background.png', charter: 'P.H.M.', composer: 'Unknown',
      illustration: '', id: 'e2e1', level: 'IN Lv.12', name: '爱属性', offset: 0, song: 'x', duration: 20 },
    judgeLineList: [{
      Group: 0, Name: 'Default', Texture: 'line.png', anchor: [0.5, 0.5],
      eventLayers: [{ moveXEvents: [{ startTime: [0,0,1], endTime: [4,0,1], start: -500, end: 0,
        easingType: 16, bezier: 0, bezierPoints: [0,0,0,0] }], moveYEvents: [], rotateEvents: [], alphaEvents: [], speedEvents: [] }],
      father: -1, isCover: 1, numOfNotes: 2, zOrder: 0,
      notes: [
        { above: 1, alpha: 255, endTime: [4,0,1], isFake: 0, positionX: 0, size: 1, speed: 1, startTime: [4,0,1], type: 1, yOffset: 0 },
        { above: 0, alpha: 255, endTime: [6,0,1], isFake: 0, positionX: 100, size: 1, speed: 1, startTime: [5,0,1], type: 4, yOffset: 0 },
      ],
    }],
  };
  const built = R.buildPez(chart, { audio: fixed.bytes, audioName: fixed.name });
  const raw2 = built.pez instanceof Uint8Array ? built.pez : new Uint8Array(await new Response(built.pez).arrayBuffer());
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < raw2.length; i += CH) s += String.fromCharCode.apply(null, raw2.subarray(i, i + CH));
  return JSON.stringify({
    sniff, kind: fixed.kind, from: fixed.from || null,
    name: fixed.name, renamed: !!fixed.renamed,
    inBytes: raw.length, outBytes: raw2.length, zipB64: btoa(s),
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
if (res.result?.exceptionDetails) {
  console.log('页面内异常:', JSON.stringify(res.result.exceptionDetails).slice(0, 600));
  if (logs.length) console.log(logs.slice(-8).join('\n'));
  process.exit(2);
}
const out = JSON.parse(res.result.result.value);
const zip = Buffer.from(out.zipB64, 'base64');
writeFileSync(outPath, zip);
console.log('容器识别:', out.sniff, '→ kind:', out.kind, out.from ? '(来自 ' + out.from + ')' : '');
console.log('音频名:', out.name, '| 改名:', out.renamed);
console.log('音频:', out.inBytes, '字节 →', out.outBytes, '字节');
console.log('包:', outPath, zip.length, '字节');
if (logs.length) console.log('--- console ---\n' + logs.slice(-6).join('\n'));
ws.close(); child.kill(); process.exit(0);
