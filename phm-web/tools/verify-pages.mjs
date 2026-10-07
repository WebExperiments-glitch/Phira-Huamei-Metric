#!/usr/bin/env node
/* ============================================================
 * tools/verify-pages.mjs —— 功能级页面测试（真浏览器驱动 UI）
 * ============================================================
 * 与 smoke-page.mjs 的分工：
 *   smoke  —— 页面能不能加载、有没有运行时报错（快、粗）
 *   本文件 —— **点按钮、填输入框、看结果真的出来了没有**（慢、细）
 *
 * 【为什么必须有】
 *   2026-10-07 的 bug 是「查了用户名，成绩检测不到」。
 *   页面加载一切正常、控制台零报错 —— smoke 测试全绿，但功能是坏的。
 *   只有真的把字填进去、点下去、检查渲染出来的 DOM，才能拦住这类问题。
 *
 * 用法：
 *   node tools/verify-pages.mjs http://127.0.0.1:5199
 *
 * ⚠ 会真的请求 api.phira.cn（只读、公开数据），需要联网。
 * ============================================================ */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const PORT = 9800 + (process.pid % 500);
const CHROME = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(p => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，设 CHROME_PATH 再跑'); process.exit(2); }

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-vp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,1000', 'about:blank',
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
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
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
const errors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('未捕获异常: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
});
await send('Runtime.enable'); await send('Page.enable');

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
};
const goto = async (p, waitMs) => {
  await send('Page.navigate', { url: BASE + p });
  await new Promise(r => setTimeout(r, waitMs || 2500));
};
/** 等某个条件成立（轮询），返回是否成功 —— 比死等固定时间稳 */
const until = async (expr, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJS(expr)) return true; } catch (e) { /* 页面可能正在导航 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
};

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

/* ══════════════════════════════════════════════════════════
 * 1) 玩家页：重名时必须给候选，而不是盲选第一个
 *    这是「我玩了很多但检测不到」的根因 —— 以前直接取 results[0]，
 *    查到的其实是别人，于是"你的成绩"当然对不上。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[1] /user 玩家页 · 候选列表与成绩读取');
await goto('/user', 2500);
{
  /* 用一个**必然有多个同名/相似名**的词，逼出候选列表 */
  await evalJS(`(function(){
    const q = document.getElementById('q'); q.value = 'huamei';
    document.getElementById('go').click(); return 1;
  })()`);
  await until(`document.querySelectorAll('#cands .cand').length > 0`, 25000);
  const n = await evalJS(`document.querySelectorAll('#cands .cand').length`);
  ok('重名时给出候选列表（不盲选）', n >= 1, '候选 ' + n + ' 个');

  const first = await evalJS(`(function(){
    const c = document.querySelector('#cands .cand');
    return c ? c.textContent.slice(0, 80) : null;
  })()`);
  ok('候选卡片带 UID 信息', !!first && /\d{2,}/.test(first), first);

  /* 点第一个候选 → 应当渲染出账号总览 */
  await evalJS(`document.querySelector('#cands .cand').click()`);
  const got = await until(`document.querySelectorAll('#out .stat').length >= 4`, 30000);
  ok('点选候选后渲染出账号总览', got);

  const stats = await evalJS(`(function(){
    const out = {};
    document.querySelectorAll('#out .stat').forEach(function(s){
      out[s.querySelector('.k').textContent] = s.querySelector('.v').textContent;
    });
    return out;
  })()`);
  ok('显示「总游玩次数」', stats['总游玩次数'] != null, JSON.stringify(stats));
  ok('总游玩次数是数字（账号确实被检测到）',
    /^\d+$/.test(String(stats['总游玩次数'] || '')), '得到 ' + stats['总游玩次数']);
  ok('显示「本次可用成绩」', stats['本次可用成绩'] != null, JSON.stringify(stats));
  ok('显示「平均准度」', /%/.test(String(stats['平均准度'] || '')), stats['平均准度']);

  /* 20 条上限必须被**明确说出来** —— 不说，用户就会以为工具坏了 */
  const txt = await evalJS(`document.getElementById('out').textContent`);
  ok('页面上写明了「只给最近 20 条」这个限制',
    /20\s*条/.test(txt) && /page|pageNum|翻页|接口/.test(txt), '未找到限制说明');

  /* 逐谱查询区块必须出现 */
  const hasChartQ = await evalJS(`getComputedStyle(document.getElementById('chartq')).display !== 'none'`);
  ok('出现「查我在某张谱上的全部成绩」入口', hasChartQ === true);
}

/* ══════════════════════════════════════════════════════════
 * 2) 逐谱查询：绕过 20 条上限的唯一手段
 * ══════════════════════════════════════════════════════════ */
console.log('\n[2] /user · 按谱面查全部成绩（绕过 20 条上限）');
{
  /* 换一个**确定在这张谱上有记录**的账号（Mivik / UID 2 实测在 6766 上有 3 条）。
     第 1 节点的是候选列表里的第一个，那是随机的 —— 随机账号没打过这张谱时，
     应用会正确地回「没有记录」，但那样就测不到"有记录"这条通路。 */
  await evalJS(`(function(){
    const q = document.getElementById('q'); q.value = '2';
    document.getElementById('go').click(); return 1;
  })()`);
  const ready = await until(`document.querySelectorAll('#out .stat').length >= 4`, 30000);
  ok('单数命中直接进详情（不再让用户挑）', ready === true);

  await evalJS(`(function(){
    document.getElementById('cid').value = '6766';
    document.getElementById('cgo').click(); return 1;
  })()`);
  const got = await until(`document.querySelector('#cout .status') && document.querySelector('#cout table')`, 30000);
  ok('返回了该谱的成绩明细', got);
  const summary = await evalJS(`(function(){
    const s = document.querySelector('#cout .status');
    return s ? s.textContent.replace(/\\s+/g,' ').trim().slice(0, 140) : null;
  })()`);
  ok('摘要里有「次游玩」与最好准度', /次游玩/.test(String(summary)) && /最好准度/.test(String(summary)), summary);
}

/* ══════════════════════════════════════════════════════════
 * 3) 谱师页：精确匹配 + 模糊命中分开
 * ══════════════════════════════════════════════════════════ */
console.log('\n[3] /charter 谱师页 · 作品枚举');
await goto('/charter', 2200);
{
  await evalJS(`(function(){
    document.getElementById('q').value = 'Magazet';
    document.getElementById('go').click(); return 1;
  })()`);
  const got = await until(`document.querySelectorAll('#out .sum').length >= 3`, 60000);
  ok('渲染出谱师统计', got);

  const stats = await evalJS(`(function(){
    const out = {};
    document.querySelectorAll('#out .sum').forEach(function(el){
      const k = el.querySelector('.k'), v = el.querySelector('.v');
      if (k && v) out[k.textContent] = v.textContent;
    });
    return out;
  })()`);
  ok('显示「作品数」', /^\d+$/.test(String(stats['作品数'] || '')), JSON.stringify(stats));

  const rows = await evalJS(`document.querySelectorAll('#out table tbody tr').length`);
  ok('列出了作品', rows >= 1, rows + ' 行');

  const dist = await evalJS(`document.querySelectorAll('#out .distlg span').length`);
  ok('画出了档位分布', dist >= 1, dist + ' 个档位');
}

/* ══════════════════════════════════════════════════════════
 * 4) 工作台：页面还在、核心通路没被拆坏
 * ══════════════════════════════════════════════════════════ */
console.log('\n[4] /app 工作台 · 迁移后仍可用');
await goto('/app', 2800);
{
  /* ⚠ 不要用 `typeof exportCard === 'function'` 判分享模块：
     exportCard 是**模块作用域**的 const，不会挂到 globalThis 上，
     这样写必然 false。只能用页面自己暴露的 PHM.status()（它从模块内部看）。 */
  await until(`typeof PHM !== 'undefined' && PHM.status && PHM.status().engine === 'ok'`, 20000);
  const st = await evalJS(`(function(){ try{ return PHM.status(); }catch(e){ return { err:String(e) }; } })()`);
  ok('引擎与分享模块都在', st && st.engine === 'ok' && st.sharecard === 'ok', JSON.stringify(st).slice(0, 170));
  const hasDrop = await evalJS(`!!document.getElementById('drop') && !!document.getElementById('file')`);
  ok('拖放入口还在', hasDrop === true);
  /* 曾经的内联玩家面板必须已经移除（否则就是两份实现） */
  const noPanel = await evalJS(`!document.getElementById('ppanel') && !document.getElementById('pname')`);
  ok('旧的玩家面板已移除（不再有两份实现）', noPanel === true);
  /* 指向新页面的入口要在 */
  const link = await evalJS(`Array.prototype.some.call(document.querySelectorAll('a'), function(a){ return a.getAttribute('href') === '/user'; })`);
  ok('有指向 /user 的入口', link === true);
  /* 搜索框仍在（这是工作台的核心入口之一） */
  await evalJS(`(function(){ const i=document.getElementById('csrch'); i.value='属性'; document.getElementById('cgo').click(); return 1; })()`);
  const searched = await until(`document.querySelector('#cout, #csmsg') &&
    (document.querySelector('#cout').textContent.trim().length > 10 || document.querySelector('#csmsg').textContent.trim().length > 5)`, 30000);
  ok('搜谱面仍然可用', searched);
}


/* ══════════════════════════════════════════════════════════
 * 5) 分页：必须证明「翻页真的换了数据」
 *    只画个页码、点了没反应，是最容易糊弄过去的形态 ——
 *    所以每一条都**比对内容**，不看有没有按钮。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[5] /data 数据管理 · 真分页');
await goto('/data', 2600);
{
  let rows = 0;
  for (let i = 0; i < 45 && !rows; i++) {
    rows = await evalJS(`document.querySelectorAll('#tbl table tbody tr').length`).catch(() => 0);
    if (!rows) await new Promise(r => setTimeout(r, 400));
  }
  ok('第一页渲染出行', rows > 0, rows + ' 行');

  const info1 = await evalJS(`(document.querySelector('#pgwrap .pginfo')||{}).textContent.replace(/\s+/g,' ').trim()`);
  ok('页码显示「共 N 条」的真实总数', /共\s*\d+\s*条/.test(String(info1)), info1);
  const totalFromPage = Number((String(info1).match(/共\s*(\d+)\s*条/) || [])[1] || 0);

  /* ⚠ 取 td:first-child（chart_id）。用 td.mono2 会一行命中三个单元格
     （chart_id / 引擎 / 计算时间），那三个里有两个是恒定文本，
     比对必然"重叠 98" —— 是测试写错了，不是分页坏了。 */
  const idsBefore = await evalJS(`Array.prototype.map.call(
    document.querySelectorAll('#tbl tbody tr td:first-child'), function(t){ return t.textContent.trim(); })`);

  /* 翻到第 2 页 —— 内容必须**完全不同** */
  await evalJS(`(function(){
    const b = Array.prototype.find.call(document.querySelectorAll('#pgwrap .pg'),
      function(x){ return x.textContent.trim() === '2'; });
    if (b) b.click(); return 1;
  })()`);
  await new Promise(r => setTimeout(r, 2600));
  const idsAfter = await evalJS(`Array.prototype.map.call(
    document.querySelectorAll('#tbl tbody tr td:first-child'), function(t){ return t.textContent.trim(); })`);
  const overlap = (idsBefore || []).filter(x => (idsAfter || []).includes(x)).length;
  ok('翻到第 2 页后行内容变了（无重叠）', overlap === 0,
    '重叠 ' + overlap + ' · before=' + JSON.stringify((idsBefore || []).slice(0, 3))
    + ' after=' + JSON.stringify((idsAfter || []).slice(0, 3)));

  const info2 = await evalJS(`(document.querySelector('#pgwrap .pginfo')||{}).textContent.replace(/\s+/g,' ').trim()`);
  ok('页码信息同步到第 2 页', /第\s*2\s*\/\s*\d+\s*页/.test(String(info2)), info2);
  ok('总数在翻页后不变', Number((String(info2).match(/共\s*(\d+)\s*条/) || [])[1] || -1) === totalFromPage,
    'p1=' + totalFromPage + ' p2=' + info2);

  /* 过滤：只留 AT 档 */
  await evalJS(`(function(){ const s=document.getElementById('level'); s.value='AT';
    s.dispatchEvent(new Event('change')); return 1; })()`);
  await new Promise(r => setTimeout(r, 2200));
  const atInfo = await evalJS(`(document.querySelector('#pgwrap .pginfo')||{}).textContent.replace(/\s+/g,' ').trim()`);
  const atTotal = Number((String(atInfo).match(/共\s*(\d+)\s*条/) || [])[1] || -1);
  ok('按档位过滤后总数变小', atTotal > 0 && atTotal < totalFromPage,
    'AT=' + atTotal + ' 全部=' + totalFromPage);

  /* 搜索 */
  await evalJS(`(function(){ const s=document.getElementById('level'); s.value='';
    s.dispatchEvent(new Event('change'));
    const q=document.getElementById('q'); q.value='pandemic';
    q.dispatchEvent(new Event('input')); return 1; })()`);
  await new Promise(r => setTimeout(r, 2600));
  const qInfo = await evalJS(`(document.querySelector('#pgwrap .pginfo')||{}).textContent.replace(/\s+/g,' ').trim()`);
  const qTotal = Number((String(qInfo).match(/共\s*(\d+)\s*条/) || [])[1] || -1);
  ok('搜曲名能收窄结果', qTotal >= 1 && qTotal < totalFromPage, 'q=' + qTotal);

  /* 排序字段的注入尝试必须被服务端挡住（前端不该崩） */
  const inj = await evalJS(`(async function(){
    try { const r = await fetch('/api/charts?page=1&sort=password'); const j = await r.json();
          return { status: r.status, err: !!j.error }; }
    catch (e) { return { status: 0, err: false, msg: String(e) }; }
  })()`);
  ok('非法排序字段被服务端拒绝', inj && inj.status === 400 && inj.err === true, JSON.stringify(inj));

  /* ⚠ 这一条是给一个**真出过的 bug** 立的哨兵：
     dbPageCharts 曾经把 engine_build 过滤写成 `else if (o.build)`，
     而服务端**无条件**传了 build —— 于是换引擎的那一刻，整个列表
     会静默变成 0 行（所有行都还不等于新版本号）。不报错、不崩，
     只是"看起来库里没数据"。缓存还没重算时正好暴露。
     断言：不带任何过滤的分页，总数必须 > 0，且与 /api/summary 的总数一致。 */
  const bare = await evalJS(`(async function(){
    try {
      const r = await fetch('/api/charts?page=1&pageSize=5&sort=chart_id');
      const j = await r.json();
      const s2 = await (await fetch('/api/summary')).json();
      return { status: r.status, total: j.total, rows: (j.rows||[]).length,
               sumTotal: s2.total, ver: j.engineVer };
    } catch (e) { return { err: String(e) }; }
  })()`);
  ok('不带过滤的分页返回全部数据（换引擎后也不能空）',
    bare && bare.total > 0 && bare.rows > 0 && bare.total === bare.sumTotal,
    JSON.stringify(bare));
}

/* ══════════════════════════════════════════════════════════
 * 6) 谱师页：扫描 + 客户端分页
 * ══════════════════════════════════════════════════════════ */
console.log('\n[6] /charter 谱师页 · 扫描与分页');
await goto('/charter', 2200);
{
  await evalJS(`(function(){
    document.getElementById('q').value = 'YanY';
    document.getElementById('go').click(); return 1;
  })()`);
  const got = await until(`document.querySelectorAll('#out .sum').length >= 3`, 60000);
  ok('扫描后渲染出汇总', got);

  const rows = await evalJS(`document.querySelectorAll('#out table tbody tr').length`);
  ok('列出作品', rows > 0, rows + ' 行');

  const scanMeta = await evalJS(`(function(){
    const el = document.querySelector('#out .chhead .mt');
    return el ? el.textContent.replace(/\s+/g,' ').trim() : null;
  })()`);
  ok('显示「已扫 X/Y 页搜索结果」', /已扫\s*\d+\s*\/\s*\d+\s*页/.test(String(scanMeta)), scanMeta);

  const pg = await evalJS(`(function(){
    const el = document.querySelector('#pg1 .pginfo');
    return el ? el.textContent.replace(/\s+/g,' ').trim() : null;
  })()`);
  ok('作品列表有分页信息', !!pg && /共\s*\d+\s*条/.test(pg), pg);

  /* 继续扫描按钮：没扫完时必须出现 */
  const needMore = await evalJS(`(function(){
    const el = document.querySelector('#out .chhead .mt');
    return /尚未扫完/.test(el ? el.textContent : '');
  })()`);
  ok('未扫完时明确标注（不假装完整）', needMore === true || /扫描完整/.test(String(scanMeta)),
    'meta=' + scanMeta);
}

/* ══════════════════════════════════════════════════════════
 * 7) 玩家页：全服记录分页
 * ══════════════════════════════════════════════════════════ */
console.log('\n[7] /user 玩家页 · 全服记录分页');
await goto('/user?uid=2', 2600);
{
  const ready = await until(`document.querySelectorAll('#out .stat').length >= 4`, 35000);
  ok('?uid= 深链能自动查询', ready);

  await evalJS(`(function(){
    document.getElementById('cid').value = '6766';
    const s = document.getElementById('cmode'); s.value = 'all';
    s.dispatchEvent(new Event('change'));
    return 1;
  })()`);
  const got = await until(`document.querySelector('#cout table')`, 40000);
  ok('全服记录表渲染出来', got);

  const info = await evalJS(`(function(){
    const el = document.querySelector('#cpg .pginfo');
    return el ? el.textContent.replace(/\s+/g,' ').trim() : null;
  })()`);
  ok('全服记录有分页信息（真实总数）', !!info && /共\s*\d+\s*条/.test(info), info);

  const before = await evalJS(`Array.prototype.map.call(
    document.querySelectorAll('#cout tbody tr td:first-child'), function(t){ return t.textContent; })`);

  await evalJS(`(function(){
    const b = Array.prototype.find.call(document.querySelectorAll('#cpg .pg'),
      function(x){ return x.textContent.trim() === '2'; });
    if (b) b.click(); return 1;
  })()`);
  await new Promise(r => setTimeout(r, 3000));
  const after = await evalJS(`Array.prototype.map.call(
    document.querySelectorAll('#cout tbody tr td:first-child'), function(t){ return t.textContent; })`);
  const overlap = (before || []).filter(x => (after || []).includes(x)).length;
  ok('全服记录翻页后名次变了（无重叠）', overlap === 0,
    'before=' + JSON.stringify((before || []).slice(0, 3)) + ' after=' + JSON.stringify((after || []).slice(0, 3)));
}

console.log('\n未捕获异常 / console.error ：' + errors.length);
errors.slice(0, 8).forEach(e => console.log('   ! ' + e));
console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail} · 运行时报错 ${errors.length}`);
ws.close(); cleanup();
process.exit((fail || errors.length) ? 1 : 0);
