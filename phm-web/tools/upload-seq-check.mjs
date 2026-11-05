#!/usr/bin/env node
/* ============================================================
 * tools/upload-seq-check.mjs —— 「精确计算」按钮的端到端验收
 * ============================================================
 * 【为什么 smoke-page 覆盖不到】
 *   /app 的冒烟只验「页面打开不炸、引擎模块加载成功」。而「精确计算」
 *   这条链路的每一步都可能静默失败，且都不冒异常：
 *     · 结果卡片里的按钮渲染出来了没有
 *     · 点下去权重 fetch 到没有（700 KB，独立路径）
 *     · 从原始 .pez 重新解析出的音符序列是不是**同一张谱**（一个包里 4 个难度）
 *     · 算出来的第二个数字对不对
 *   所以必须真上传一次、真点一次、真读一次 DOM。
 *
 * 【判据】
 *   a. 点之前：只有一个数字（默认档），按钮在
 *   b. 点之后：多出第二个数字，按钮消失
 *   c. 第二个数字与 Node 侧同一条链路的预测一致（±0.02），
 *      而 Node 侧那条链路的值又由 tools/verify-seq-model.mjs 对拍过 numpy
 *
 * 用法（先起服务）：
 *   PHM_TEST_NO_RATELIMIT=1 PORT=5251 node server.mjs &
 *   node tools/upload-seq-check.mjs http://127.0.0.1:5251 tmp/70124.pez
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.argv[2] || 'http://127.0.0.1:5251';
const PEZ = path.resolve(process.argv[3] || path.join(ROOT, 'tmp/70124.pez'));
/* ⚠ 端口不能落在 Chrome 的 **blocked ports** 列表里（10080、6667 之类），
   fetch 会直接报 "bad port"。所以固定在一个窄区间，不用 pid 大幅偏移。 */
const PORT = 9800 + (process.pid % 90);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

/* ── Node 侧的期望值：与浏览器同一条链路（解析 → 20 维 → 前向）。
   ⚠ 它只证明「浏览器这一步没算歪」，模型本身的正确性由 verify-seq-model 守。 */
import { predictSeq } from '../public/js/engine-seq.mjs';
import { seqFeatures20 } from '../public/js/engine-v3.mjs';

function frac(st) {
  if (!st) return 0;
  const den = st.length > 2 && st[2] ? +st[2] : 1;
  return +st[0] + (+st[1] / den);
}
function parseRpe(j) {
  const bpm = (j.BPMList || [{ bpm: 120, startTime: [0, 0, 1] }])
    .slice().sort((a, b) => frac(a.startTime) - frac(b.startTime))
    .map(s => [frac(s.startTime), +s.bpm]);
  const sec = beat => {
    let t = 0;
    for (let i = 0; i < bpm.length; i++) {
      const [b0, v] = bpm[i];
      const b1 = i + 1 < bpm.length ? bpm[i + 1][0] : Infinity;
      if (beat <= b0) break;
      t += (Math.min(beat, b1) - b0) * 60 / v;
      if (beat <= b1) return t;
    }
    return t;
  };
  const out = [];
  for (const ln of j.judgeLineList || []) {
    for (const n of ln.notes || []) {
      if (!n.startTime || n.startTime.length !== 3 || n.type == null) continue;
      const t = sec(frac(n.startTime));
      const hold = (n.type === 2 && n.endTime) ? Math.max(sec(frac(n.endTime)) - t, 0) : 0;
      out.push({ sec: t, type: n.type, x: n.positionX || 0,
        above: (n.above === 0 || n.above === false) ? 0 : 1, hold });
    }
  }
  out.sort((a, b) => a.sec - b.sec);
  return out;
}

const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/seq-model.json'), 'utf8'));
const id = path.basename(PEZ).replace(/\.pez$/i, '');
const chartPath = path.join(ROOT, '..', 'data', 'charts', id, 'chart.json');
let expect = null;
if (fs.existsSync(chartPath)) {
  const notes = parseRpe(JSON.parse(fs.readFileSync(chartPath, 'utf8'))).slice(0, 8000);
  expect = predictSeq(seqFeatures20(notes), W);
  console.log(`Node 侧期望：${id} · n=${notes.length} · ding ${expect.ding.toFixed(3)}`);
} else {
  console.log(`· 没有 ${chartPath}，跳过数值断言`);
}

/* ── 起 Chrome（与 smoke-page 同一套 CDP 极简客户端）── */
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-seq-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

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
if (!(await waitPort(PORT))) { console.error('Chrome 调试端口没起来'); process.exit(2); }

const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pend = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const i2 = ++seq; pend.set(i2, { res, rej });
  ws.send(JSON.stringify({ id: i2, method, params: params || {} }));
});
const errs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') errs.push('异常: ' + (m.params.exceptionDetails.text || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errs.push('console.error: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
});
for (const d of ['Runtime', 'Page', 'DOM']) await send(d + '.enable');

const ev_ = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try{localStorage.setItem('phm_optin','0');localStorage.setItem('phm_notice','1');localStorage.setItem('phm_lang','zh');}catch(e){}",
});
await send('Page.navigate', { url: BASE + '/app' });
await sleep(4000);
for (let i = 0; i < 40; i++) {
  const s = await ev_('window.PHM && PHM.status ? JSON.stringify(PHM.status()) : ""');
  if (s && /"engine":"ok"/.test(s) && /"refCom":"ok\//.test(s)) break;
  await sleep(500);
}

const doc = await send('DOM.getDocument', { depth: -1 });
const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
if (!q.nodeId) { console.error('找不到 #file'); process.exit(2); }
await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [PEZ] });

for (let i = 0; i < 120; i++) { if (await ev_('!!document.querySelector(".scalecard")')) break; await sleep(500); }

const snap = () => ev_(`(() => {
  const card = document.querySelector('.scales .scalecard');
  const btn = document.querySelector('[data-seq]');
  const out = document.querySelector('.seqout b');
  const txt = e => e ? e.innerText.replace(/\\s+/g,' ').trim() : '';
  return JSON.stringify({
    ridge: card ? txt(card.querySelector('.v')) : '',
    hasBtn: !!btn, btnText: txt(btn),
    seqVal: out ? txt(out) : '',
    seqDing: out ? out.getAttribute('data-ding') : '',
    seqMs: out ? out.getAttribute('data-ms') : '',
    seqTip: txt(document.querySelector('.seqtip')),
    seqRows: document.querySelectorAll('.seqout').length,
  });
})()`).then(JSON.parse);

const before = await snap();
console.log('点之前：', JSON.stringify(before));

const t0 = Date.now();
await ev_(`(() => { const b=document.querySelector('[data-seq]'); if(b) b.click(); return true; })()`);
let after = before;
for (let i = 0; i < 120; i++) {
  after = await snap();
  if (after.seqVal) break;
  await sleep(250);
}
const ms = Date.now() - t0;
console.log(`点之后（${ms} ms，含 700 KB 权重首次下载）：`, JSON.stringify(after));

let fail = 0;
const ok = (name, cond, extra) => { if (cond) console.log('  ✓ ' + name); else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
ok('默认档只有一个数字', !!before.ridge && !before.seqVal, JSON.stringify(before));
ok('「精确计算」按钮存在', before.hasBtn, before.btnText);
ok('点后出现第二个数字', !!after.seqVal, JSON.stringify(after));
ok('点后按钮收起', !after.hasBtn);
ok('第二个数字带说明', after.seqTip.length > 0, after.seqTip);
if (expect) {
  /* 页面显示 1 位小数，所以比的是 data-ding（未舍入） */
  const d = Math.abs(+after.seqDing - expect.ding);
  ok(`第二个数字与 Node 侧一致（${after.seqDing} vs ${expect.ding.toFixed(4)}，差 ${d.toFixed(5)}）`,
    after.seqDing !== '' && d < 1e-3, after.seqDing);
  console.log(`  · 本谱推理实测 ${after.seqMs} ms（特征 + 前向，不含 700 KB 权重下载）`);
}
if (errs.length) { fail++; console.log('  ✗ 页面有 console.error / 异常：\n    ' + errs.join('\n    ')); }

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过 ✓');
try { ws.close(); } catch {}
process.exit(fail ? 1 : 0);
