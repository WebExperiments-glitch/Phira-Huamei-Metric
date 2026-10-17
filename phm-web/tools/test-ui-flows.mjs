/* ══════════════════════════════════════════════════════════════
 * test-ui-flows.mjs —— 真浏览器里的**交互**回归
 * ══════════════════════════════════════════════════════════════
 * 【为什么需要这个文件】
 *   smoke-page.mjs 只"打开页面看有没有报错"，verify-pages.mjs 也只点几下
 *   固定按钮。2026-10-17 一天之内坏了三次，全是**渲染路径**上的问题：
 *     · card() 里删了 `const rows` 却留着 `rows.map()` → 拖谱面毫无反应
 *     · 模块缺导出 → 整段脚本不执行 → 半页空白
 *     · `.btn.primary` 选择器漏了 → 两个主按钮没有样式
 *   这三条**一条都没被 176 条断言抓到**，因为没人真的往里拖一个文件。
 *
 * 【这里测什么】
 *   1) 落地页的接力区存在、点得动
 *   2) 往落地页拖 .pez → 真的跳到 /app?drop=1，并且 /app **真的开算了**
 *      （用一个坏的 zip：能开出错误提示就等于整条链路通了）
 *   3) 往 /app 自己的拖拽区拖 → 出错误提示而不是静默死掉
 *   4) 谱师页 / 玩家页的例子芯片渲染出来了、点下去会填进输入框
 *
 * 【为什么允许"报错"作为通过条件】
 *   我们喂的是坏文件，引擎当然算不出来。这里要证明的是
 *   **文件进得来、函数调得到、界面有反应**，不是算法对不对
 *   （算法有 verify-engine.mjs 的 45 条守着）。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:5199').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT || 9361);

const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1280,900', 'about:blank',
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
const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
if (!(await waitPort(PORT))) { console.error('Chrome 端口未就绪'); cleanup(); process.exit(2); }

const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let seq = 0; const pend = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
let errors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('未捕获异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
});
await send('Runtime.enable'); await send('Page.enable');

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: '
      + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  }
  return r.result.value;
};
const goto = async (p, waitMs) => {
  errors = [];
  await send('Page.navigate', { url: BASE + p });
  await new Promise(r => setTimeout(r, waitMs || 2200));
};
const until = async (expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJS(expr)) return true; } catch (e) { /* 导航中 */ }
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
};

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

/* ══════════════════════════════════════════════════════════
 * 1) 落地页接力区
 * ══════════════════════════════════════════════════════════ */
console.log('\n[1] / 落地页 · 接力区');
await goto('/', 2200);
ok('有接力区 #hdrop', await evalJS(`!!document.getElementById('hdrop')`));
ok('接力区可聚焦（键盘能到）',
  await evalJS(`(function(){var e=document.getElementById('hdrop');return !!e&&e.tabIndex>=0;})()`));
ok('文案有兜底（不是空壳）',
  await evalJS(`(function(){var e=document.getElementById('hdrop');return !!e&&e.textContent.trim().length>6;})()`),
  await evalJS(`(function(){var e=document.getElementById('hdrop');return e?JSON.stringify(e.textContent.trim().slice(0,20)):'无元素';})()`));
ok('有隐藏的 file input（点一下能选文件）',
  await evalJS(`(function(){var i=document.getElementById('hfile');return !!i&&i.type==='file';})()`));

/* ══════════════════════════════════════════════════════════
 * 2) 拖到落地页 → 交接 → /app 真的开算
 * ══════════════════════════════════════════════════════════ */
console.log('\n[2] 拖进落地页 → 接力到 /app');
{
  /* 用一个**结构不对的 zip**：目的不是算出定数，是证明"文件被接住了、
     引擎被调到了、界面有反应"。 */
  errors = [];
  const fire = `(function(){
    const f = new File([new Uint8Array([80,75,3,4,0,0,0,0])], 'broken.pez', {type:'application/zip'});
    const dt = new DataTransfer(); dt.items.add(f);
    const box = document.getElementById('hdrop');
    box.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    return 'fired';
  })()`;
  /* ⚠ 这里**必然**会撞上一次 CDP 报错：交接成功后页面真的会跳走，
     正在求值的那次 evaluate 就以 "Inspected target navigated" 结束。
     那是**成功**的信号，不是失败 —— 所以单独吞掉这一种。 */
  try { await evalJS(fire); } catch (e) {
    if (!/navigated|closed/i.test(String(e.message))) throw e;
  }

  const navd = await until(`location.pathname === '/app'`, 15000);
  const where = navd ? await evalJS(`location.pathname + location.search`) : '(没跳)';
  ok('拖完跳到 /app?drop=1', navd && /^\/app\?drop=1$/.test(String(where)), String(where));

  /* ⚠ 结果落在 #out（卡片区），不是 #msg —— handleFiles 成功/失败都会把
     #msg 清空再渲染卡片。断言写错地方会得到"假失败"。 */
  const started = await until(`(function(){
    const o = document.getElementById('out');
    return !!o && o.textContent.trim().length > 0;
  })()`, 25000);
  ok('★ /app 真的开始处理了（结果卡有内容）', started);
  ok('处理过程没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
}

/* ══════════════════════════════════════════════════════════
 * 3) 直接往 /app 拖（当初 rows is not defined 的那条路径）
 * ══════════════════════════════════════════════════════════ */
console.log('\n[3] /app 自己的拖拽区');
await goto('/app', 2600);
{
  const before = await evalJS(`document.getElementById('msg').textContent`);
  const after = await evalJS(`(async function(){
    const f = new File([new Uint8Array([80,75,3,4,1,2])], 'broken.pez', {type:'application/zip'});
    const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 250));
      const o = document.getElementById('out').textContent.trim();
      if (o) return o;
    }
    return document.getElementById('out').textContent.trim();
  })()`);
  ok('拖入后有反应（错误提示或结果）', String(after).trim().length > 0, '前:' + JSON.stringify(before) + ' 后:' + JSON.stringify(after));
  ok('没有 ReferenceError 之类的运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
  /* 这一条是当初那次事故的**直接照妖镜**：card() 里引用未定义变量时，
     这条会红。 */
  ok('页面没被异常打断（导航还在）',
    await evalJS(`!!document.getElementById('nav') && getComputedStyle(document.getElementById('nav')).display !== 'none'`));
}

/* ══════════════════════════════════════════════════════════
 * 4) 例子芯片
 * ══════════════════════════════════════════════════════════ */
console.log('\n[4] 例子 / 最近查过 芯片');
for (const [p, label] of [['/charter', '谱师页'], ['/user', '玩家页']]) {
  await goto(p, 2200);
  const n = await evalJS(`document.querySelectorAll('#exrow .chip').length`);
  ok(label + ' 有例子芯片', n >= 2, '实际 ' + n + ' 个');
  const filled = await evalJS(`(function(){
    const c = document.querySelector('#exrow .chip');
    if (!c) return '';
    c.click();
    return document.getElementById('q').value;
  })()`);
  ok(label + ' 点芯片会填进输入框', String(filled).length > 0, JSON.stringify(filled));
  ok(label + ' 没有运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));
}

/* ══════════════════════════════════════════════════════════
 * 5) 表单卡收窄（评审 B）—— 只是确认窄卡生效，不是审美判断
 * ══════════════════════════════════════════════════════════ */
console.log('\n[5] 表单卡版式');
for (const [p, label] of [['/charter', '谱师页'], ['/user', '玩家页']]) {
  await goto(p, 2000);
  const w = await evalJS(`(function(){
    const c = document.querySelector('.card.narrow');
    return c ? Math.round(c.getBoundingClientRect().width) : -1;
  })()`);
  ok(label + ' 表单卡收窄到 ≤740px', w > 0 && w <= 740, w + 'px');
}

console.log('\n────────');
console.log('通过 ' + pass + ' · 失败 ' + fail);
cleanup();
process.exit(fail ? 1 : 0);
