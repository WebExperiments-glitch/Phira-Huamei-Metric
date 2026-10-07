/* 生成分享卡片 public/og.png（1200×630）
 *
 * 为什么需要：链接被发到 QQ / B站 / 群里时，预览图就是第一印象。
 * 没有 og:image 的链接只有一行灰字，点开率差很多。
 *
 * 实现：用本机 Chrome 渲染一段 HTML 卡片，再通过 CDP 截图 —— 零依赖
 * （Node 22 自带 fetch 与 WebSocket，不需要装 playwright / puppeteer）。
 *
 * 用法（在 phm-web/ 目录下）：
 *     node tools/make-og.mjs
 *
 * ⚠ 改了卡片文案、或者 index.html 里的 og:image 尺寸，记得跑一次重新生成。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 文案两套：中文给 QQ / B站，英文给 X（国际圈看不懂「参考定数」四个字）。
   用法：node tools/make-og.mjs         → og.png
        node tools/make-og.mjs --en     → og-en.png */
const EN = process.argv.includes('--en');
const OUT = path.join(ROOT, 'public', EN ? 'og-en.png' : 'og.png');
const W = 1200, H = 630, PORT = 9337;

const T = EN ? {
  sub: 'An <b>auditable difficulty reference</b> for Phira charts<br>' +
       '8 features + k-NN over <b>9,508 community charts</b> (+ 1,037 official as a second scale)<br>' +
       'runs in your browser · <b>charts never uploaded</b>',
  kRef: 'Reference', kPs: 'Load (PS)', kOfficial: 'Rated', kDrift: 'Drift',
  foot: 'We do not call anything mis-rated. We publish numbers and their uncertainty.',
} : {
  sub: 'Phira / Phigros 谱面难度参考 —— <b>客观、可审计、可追溯</b><br>' +
       '8 维特征 + 9,508 张社区谱 k-NN（另附 1,037 张官谱标度），纯浏览器计算，<b>谱面文件不上传</b>',
  kRef: '参考定数', kPs: 'PS 负荷', kOfficial: '标称定数', kDrift: '偏差',
  foot: '不判定「虚标」· 公开不确定度 · 每条结论都能点开看依据',
};

/* Chrome 位置（Windows 常见路径；找不到就自己改这一行） */
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
     ].find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!CHROME) {
  console.error('找不到 Chrome。设 CHROME_PATH 环境变量指向 chrome 可执行文件再跑。');
  process.exit(1);
}

const card = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:#0d1117;color:#e6edf3;overflow:hidden;
 font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;position:relative}
.glow{position:absolute;width:900px;height:900px;right:-320px;top:-380px;border-radius:50%;
 background:radial-gradient(circle,rgba(232,163,61,.20) 0%,rgba(232,163,61,0) 62%)}
.glow2{position:absolute;width:700px;height:700px;left:-260px;bottom:-340px;border-radius:50%;
 background:radial-gradient(circle,rgba(90,162,232,.16) 0%,rgba(90,162,232,0) 62%)}
.wrap{position:relative;padding:62px 72px 54px;height:100%;display:flex;flex-direction:column}
.brand{font-size:56px;font-weight:800;letter-spacing:1px}
.brand b{color:#e8a33d}
.sub{margin-top:16px;font-size:26px;color:#9aa7b4;line-height:1.55}
.sub b{color:#e6edf3}
.card{margin-top:auto;background:#161b22;border:1px solid #2a313c;border-radius:16px;padding:22px 26px;
 display:flex;align-items:center;gap:30px}
.card .k{font-size:17px;color:#6b7684}
.card .v{font-size:38px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15}
.card .v.a{color:#e8a33d} .card .v.b{color:#5aa2e8}
.card .sep{width:1px;height:56px;background:#2a313c}
.foot{margin-top:26px;font-size:19px;color:#6b7684;display:flex;justify-content:space-between;align-items:center}
.foot .u{color:#5aa2e8;font-weight:600}
</style></head><body>
<div class="glow"></div><div class="glow2"></div>
<div class="wrap">
  <div class="brand"><b>P.H.M.</b> Standard</div>
  <div class="sub">${T.sub}</div>

  <div class="card">
    <div><div class="k">${T.kRef}</div><div class="v a">15.70</div></div>
    <div class="sep"></div>
    <div><div class="k">${T.kPs}</div><div class="v b">11.41</div></div>
    <div class="sep"></div>
    <div><div class="k">${T.kOfficial}</div><div class="v" style="color:#9aa7b4">16.20</div></div>
    <div style="margin-left:auto;text-align:right">
      <div class="k">${T.kDrift}</div><div class="v" style="font-size:30px;color:#4cc38a">−0.50</div></div>
  </div>

  <div class="foot">
    <span>${T.foot}</span>
    <span class="u">phm.app.workbuddy.host</span>
  </div>
</div></body></html>`;

const tmpHtml = path.join(os.tmpdir(), 'phm-og-card.html');
const prof = path.join(os.tmpdir(), 'phm-og-chrome');
fs.writeFileSync(tmpHtml, card, 'utf8');
fs.rmSync(prof, { recursive: true, force: true });
fs.mkdirSync(prof, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--disable-gpu', '--disable-extensions', '--hide-scrollbars',
  '--window-size=' + W + ',' + H, 'about:blank',
], { stdio: 'ignore' });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try { ready = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch {}
  if (!ready) await sleep(250);
}
if (!ready) { chrome.kill(); console.error('Chrome 未能启动调试端口'); process.exit(1); }

const target = await (await fetch(
  `http://127.0.0.1:${PORT}/json/new?file:///${tmpHtml.replace(/\\/g, '/')}`,
  { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const cmd = (method, params) => new Promise(res => {
  const i = ++seq; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
});
await new Promise(r => ws.addEventListener('open', r));
await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await sleep(2500);                                   /* 等字体与渐变稳定，否则截图可能缺字 */

const shot = await cmd('Page.captureScreenshot',
  { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
const buf = Buffer.from(shot.result.data, 'base64');
fs.writeFileSync(OUT, buf);

ws.close(); chrome.kill();
console.log('已写出 ' + OUT + '  (' + W + '×' + H + ', ' + Math.round(buf.length / 1024) + 'KB)');
