#!/usr/bin/env node
/* ============================================================
 * tools/upload-seq-check.mjs —— 真上传一张谱面，把默认档与「精确计算」两条链路都验掉
 * ============================================================
 * 【为什么 smoke-page 覆盖不到】
 *   /app 的冒烟只验「页面打开不炸、引擎模块加载成功」。而这条链路的每一步
 *   都可能静默失败，且都不冒异常：
 *     · 结果卡片里的按钮渲染出来了没有
 *     · 点下去权重 fetch 到没有（750 KB，独立路径）
 *     · 从原始 .pez 重新解析出的音符序列是不是**同一张谱**（一个包里 4 个难度）
 *     · 默认数字是不是真由 **v4**（398 维）算的，而不是停在 v3 的旧值
 *     · 权重 404 时降级链（v4 → v3 → kNN）会不会把页面搞挂
 *   所以必须真上传一次、真点一次、真读一次 DOM。
 *
 * 【判据】
 *   a. 默认档：卡片 data-basis = ridge-hs398，数字与 engine-v4.json 的
 *      checks（**Python 现场算的**）一致（±1e-3）
 *   b. 点「精确计算」后多出第二个数字，与 Node 侧（seq-v2 + 手型）一致（±1e-3）
 *   c. engine-v4.json 404 → 退回 ridge-seq20（v3），数字与 v3 一致
 *   d. v4 + v3 都 404 → 退回 ridge-beta（v2）
 *   e. v4 + v3 + v2 都 404 → 退回 kNN，页面照常出数字、不报错
 *      （四级降级每一级都要真的走一遍 —— 只测"数字还在"测不出走错档）
 *
 * 用法（先起服务）：
 *   PHM_TEST_NO_RATELIMIT=1 PORT=5261 node server.mjs &
 *   node tools/upload-seq-check.mjs http://127.0.0.1:5261 tmp/70124.pez
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.argv[2] || 'http://127.0.0.1:5261';
const PEZ = path.resolve(process.argv[3] || path.join(ROOT, 'tmp/70124.pez'));
/* ⚠ 端口不能落在 Chrome 的 **blocked ports** 列表里（10080、6667 之类），
   fetch 会直接报 "bad port"。所以固定在一个窄区间，不用 pid 大幅偏移。 */
const PORT = 9800 + (process.pid % 90);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

/* ── Node 侧的期望值：与浏览器**同一条链路**（loadChart → 特征 → 模型）。
   ⚠ 用 loadChart 而不是自己写解析器：v4 的手型要屏幕坐标，而那只有
   line-geom.mjs 会算。手抄一份解析器就等于测副本。
   数值本身的正确性由 tools/verify-engine-v4.mjs / verify-seq-model.mjs 守。 */
import { loadChart, reportFromChart } from '../public/js/engine.js';
import { ridgeV4, ridgeV3, seqFeatures20, handshape256 } from '../public/js/engine-v3.mjs';
import { predictSeq } from '../public/js/engine-seq.mjs';

const readJSON = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const W4 = readJSON('public/data/engine-v4.json');
const W3 = readJSON('public/data/engine-v3.json');
const WSEQ = readJSON('public/data/seq-model.json');

const id = path.basename(PEZ).replace(/\.pez$/i, '');
const chartPath = path.join(ROOT, '..', 'data', 'charts', id, 'chart.json');
let expect = null;
if (fs.existsSync(chartPath)) {
  const r = loadChart(JSON.parse(fs.readFileSync(chartPath, 'utf8')));
  const cur = r.notes.slice(0, 8000);
  const seq = seqFeatures20(cur);
  expect = {
    v4: ridgeV4(r.notes, W4, r.screen).ding,
    v3: ridgeV3(r.notes, W3).ding,
    seq: predictSeq(seq, WSEQ, handshape256(cur, r.screen)).ding,
    /* 四级降级的最底一级：不传任何模型权重 → kNN 参照集。 */
    knn: reportFromChart(r, 'x', { name: 'x' }, 0,
      readJSON('public/data/ref-com.json').rows, null, null, null, null).knn.ref,
    check: (W4.checks || []).find(c => c.id === id) || null,
  };
  console.log(`Node 侧期望：${id} · n=${r.notes.length}`
    + ` · v4 ${expect.v4.toFixed(4)} · v3 ${expect.v3.toFixed(4)} · 精确档 ${expect.seq.toFixed(4)}`
    + ` · kNN ${(+expect.knn).toFixed(4)}`
    + (expect.check ? ` · checks(Python) ${expect.check.ding.toFixed(4)}` : ''));
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
let seqNo = 0; const pend = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const i = ++seqNo; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params: params || {} }));
});
let errs = [];
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

/* 预置：关掉匿名上传、中文界面。
   额外的 failPattern 用来模拟「权重 404」——只拦 /data/ 下那几个 json，
   其余（引擎模块、参照集）照常，这样页面走的是真实的加载失败分支。 */
const BOOT = "try{localStorage.setItem('phm_optin','0');localStorage.setItem('phm_notice','1');localStorage.setItem('phm_lang','zh');}catch(e){}";
/* ⚠ 模拟 404 的脚本必须**随文档注入**（addScriptToEvaluateOnNewDocument），
   不能在导航前给当前页设一个全局变量 —— 导航会换文档，变量跟着没。
   （第一版就是这么写的，结果②③两段测的还是 v4：脚本根本没生效。） */
let bootScript = null;
async function loadPage(failPatterns) {
  if (bootScript) {
    if (bootScript) { try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootScript.identifier }); } catch {} }
  }
  const list = JSON.stringify(failPatterns || []);
  bootScript = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: BOOT + `
      (function(){
        const f = window.fetch, P = ${list};
        window.fetch = function(u, o){
          const s = String(u);
          for (const p of P) if (s.indexOf(p) >= 0) return Promise.resolve(new Response('', {status:404}));
          return f.apply(this, arguments);
        };
      })();`,
  });
  await send('Page.navigate', { url: BASE + '/app' });
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    const s = await ev_('window.PHM && PHM.status ? JSON.stringify(PHM.status()) : ""');
    if (s && /"engine":"ok"/.test(s)) break;
    await sleep(500);
  }
}

/* 一个页面最多同时只有一次上传；每次都要重新选文件（reload 会清空 input）。 */
async function uploadAndWait() {
  /* 等上一张卡片消失，避免读到旧值 */
  await ev_("(() => { const c=document.querySelector('.scales'); if(c) c.remove(); return true; })()");
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  if (!q.nodeId) throw new Error('找不到 #file');
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [PEZ] });
  for (let i = 0; i < 160; i++) {
    if (await ev_('!!document.querySelector(".scalecard .v[data-ding]")')) return;
    await sleep(500);
  }
  throw new Error('等结果卡片超时');
}

const snap = () => ev_(`(() => {
  const card = document.querySelector('.scales .scalecard');
  const v = card ? card.querySelector('.v[data-ding]') : null;
  const btn = document.querySelector('[data-seq]');
  const out = document.querySelector('.seqout b[data-ding]');
  const txt = e => e ? e.innerText.replace(/\\s+/g,' ').trim() : '';
  return JSON.stringify({
    basis: card ? card.getAttribute('data-basis') : '',
    ding: v ? v.getAttribute('data-ding') : '',
    shown: v ? txt(v) : '',
    hasBtn: !!btn, btnText: txt(btn),
    seqDing: out ? out.getAttribute('data-ding') : '',
    seqMs: out ? out.getAttribute('data-ms') : '',
    seqTip: txt(document.querySelector('.seqtip')),
    note: txt(card ? card.querySelector('.note') : null),
  });
})()`).then(JSON.parse);

let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name);
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, tol) => a !== '' && b != null && Math.abs(+a - b) <= tol;

/* ══ 第一阶段：正常路径（v4 默认档 + 精确计算）══ */
console.log('\n—— ① 正常路径（v4 默认档）——');
errs = [];
await loadPage([]);
await uploadAndWait();
const s1 = await snap();
console.log('  卡片：', JSON.stringify(s1));
ok('默认档是 v4（data-basis = ridge-hs398）', s1.basis === 'ridge-hs398', s1.basis);
if (expect) {
  ok(`默认数字来自 v4（页面 ${s1.ding} vs Node ${expect.v4.toFixed(4)}）`, near(s1.ding, expect.v4, 1e-3), s1.ding);
  if (expect.check) {
    ok(`v4 数字与 engine-v4.json::checks 对得上（Python ${expect.check.ding.toFixed(4)}）`,
      Math.abs(expect.v4 - expect.check.ding) < 1e-3 && near(s1.ding, expect.check.ding, 2e-3),
      `${s1.ding} vs ${expect.check.ding}`);
  }
  ok('默认数字不等于 v3 的旧值', !near(s1.ding, expect.v3, 1e-4), `v4 ${s1.ding} / v3 ${expect.v3.toFixed(4)}`);
}
ok('模型说明提到片段手型', /片段手型/.test(s1.note), s1.note);
ok('「精确计算」按钮存在', s1.hasBtn, s1.btnText);

const t0 = Date.now();
await ev_(`(() => { const b=document.querySelector('[data-seq]'); if(b) b.click(); return true; })()`);
let s2 = s1;
for (let i = 0; i < 160; i++) {
  s2 = await snap();
  if (s2.seqDing) break;
  await sleep(250);
}
console.log(`  点之后（${Date.now() - t0} ms，含 750 KB 权重首次下载）：`, JSON.stringify(s2));
ok('点后出现第二个数字', !!s2.seqDing, JSON.stringify(s2));
ok('点后按钮收起', !s2.hasBtn);
ok('第二个数字带说明', s2.seqTip.length > 0, s2.seqTip);
if (expect) {
  ok(`精确档是 seq-v2（页面 ${s2.seqDing} vs Node ${expect.seq.toFixed(4)}）`, near(s2.seqDing, expect.seq, 1e-3), s2.seqDing);
  console.log(`  · 本谱推理实测 ${s2.seqMs} ms（特征 + 前向，不含权重下载）`);
}
ok('① 无 console.error / 异常', errs.length === 0, errs.join(' | '));

/* ══ 第二阶段：engine-v4.json 404 → 退回 v3 ══ */
console.log('\n—— ② engine-v4.json 404 → 退回 v3 ——');
errs = [];
await loadPage(['engine-v4.json']);
await uploadAndWait();
const s3 = await snap();
console.log('  卡片：', JSON.stringify(s3));
ok('降级到 ridge-seq20', s3.basis === 'ridge-seq20', s3.basis);
if (expect) ok(`数字来自 v3（页面 ${s3.ding} vs Node ${expect.v3.toFixed(4)}）`, near(s3.ding, expect.v3, 1e-3), s3.ding);
ok('页面照常出数字（不空白）', s3.ding !== '', s3.ding);
ok('② 除权重 404 外无异常', errs.filter(e => !/engine-v4/.test(e)).length === 0, errs.join(' | '));

/* ══ 第三阶段：v4 + v3 都 404 → 退回 v2 ══ */
console.log('\n—— ③ engine-v4 + engine-v3 都 404 → 退回 v2 ——');
errs = [];
await loadPage(['engine-v4.json', 'engine-v3.json']);
await uploadAndWait();
const s4 = await snap();
console.log('  卡片：', JSON.stringify(s4));
ok('降级到 ridge-beta（v2）', s4.basis === 'ridge-beta', s4.basis);
ok('v2 数字存在且在合理范围', s4.ding !== '' && +s4.ding > 1 && +s4.ding < 25, s4.ding);
ok('「精确计算」入口仍然可用（不依赖 v4/v3 权重）', s4.hasBtn, s4.btnText);
ok('③ 无异常', errs.filter(e => !/engine-v[34]/.test(e)).length === 0, errs.join(' | '));

/* ══ 第四阶段：v4 + v3 + v2 全 404 → 退回 kNN ══ */
console.log('\n—— ④ 三个模型权重都 404 → 退回 kNN ——');
errs = [];
await loadPage(['engine-v4.json', 'engine-v3.json', 'engine-v2.json']);
await uploadAndWait();
const s5 = await snap();
console.log('  卡片：', JSON.stringify(s5));
ok('降级到 kNN（data-basis = knn）', s5.basis === 'knn', s5.basis);
ok('kNN 数字存在且在合理范围', s5.ding !== '' && +s5.ding > 1 && +s5.ding < 25, s5.ding);
if (expect) ok(`kNN 数字与 Node 侧一致（页面 ${s5.ding} vs Node ${(+expect.knn).toFixed(4)}）`, near(s5.ding, expect.knn, 0.05), s5.ding);
ok('④ 无异常（降级不能崩）', errs.length === 0, errs.join(' | '));

if (bootScript) { try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootScript.identifier }); } catch {} }
console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过 ✓');
try { ws.close(); } catch {}
process.exit(fail ? 1 : 0);
