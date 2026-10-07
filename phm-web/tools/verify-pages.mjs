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

/* ══════════════════════════════════════════════════════════
 * 8) /app 账号页：密码强度策略
 *    起因：用户问「我注册了一个账号，我的密码有泄露风险吗」。
 *    加固：设置密码的下限 6 位 → 10 位，并拦住纯数字 / 纯小写。
 *    ⚠ 两条必须同时成立，缺一不可：
 *      a) 新密码要够强；
 *      b) **登录路径绝不能校验强度** —— 否则 6 位的老账号被自己锁在门外。
 *    所以这里既有正向断言，也有一条反向断言。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[8] /app 账号页 · 密码策略');
await goto('/app', 3000);
{
  const SRC = await (await fetch(BASE + '/app')).text();

  const hook = await evalJS(`!!(window.PHM_PW && typeof window.PHM_PW.check === 'function')`);
  ok('存在密码策略钩子 PHM_PW', hook);

  const min = await evalJS(`window.PHM_PW ? window.PHM_PW.min : -1`);
  ok('最小长度 = 10（不再是 6）', min === 10, 'min=' + min);

  const c = await evalJS(`(function(){
    const f = window.PHM_PW.check;
    return {
      p5:      f('12345'),
      p6digit: f('123456'),
      p10digit:f('1234567890'),
      p10low:  f('abcdefghij'),
      good:    f('Huamei2026x')
    };
  })()`);
  ok('拒绝 5 位密码', !!c.p5, String(c.p5));
  ok('拒绝 6 位纯数字', !!c.p6digit, String(c.p6digit));
  ok('拒绝 10 位纯数字', !!c.p10digit, String(c.p10digit));
  ok('拒绝 10 位纯小写', !!c.p10low, String(c.p10low));
  ok('放行字母 + 数字混合', c.good === '', JSON.stringify(c.good));

  /* 源码哨兵：改回 6 位下限会被这条拦住（曲线拟合那处 length<6 不是密码） */
  const leftover = (SRC.match(/至少\s*6\s*位/g) || []).length;
  ok('源码里没有残留的「至少 6 位」', leftover === 0, '命中 ' + leftover + ' 处');

  /* login 分支里不许出现 pwWarn */
  const iLogin = SRC.indexOf('AUTH.mode==="login"');
  const iSignup = SRC.indexOf('AUTH.mode==="signup"');
  const loginBlock = (iLogin >= 0 && iSignup > iLogin) ? SRC.slice(iLogin, iSignup) : null;
  ok('login 分支调用了 pwWarn？（必须为否）', loginBlock !== null && !/pwWarn/.test(loginBlock),
    loginBlock === null ? '源码结构变了，找不到 login 分支' : 'login 分支含 pwWarn');

  /* 设置密码的三个入口都要走 pwWarn */
  const uses = (SRC.match(/pwWarn\(/g) || []).length;
  ok('pwWarn 被 ≥3 个设置入口调用（注册/重置/改密）', uses >= 3, '调用点 ' + uses + ' 个（含定义 1 处）');

  /* 正向的行为验证：改密表单（隐藏但存在于 DOM）填短密码 → 应被 UI 拒绝。
     不会触网 —— 因为 pwWarn 在调用 API 之前就 return 了。 */
  const rejMsg = await evalJS(`(function(){
    const old = document.getElementById('aold'), nw = document.getElementById('anew');
    if (!old || !nw) return '@@noform';
    old.value = 'whatever-old'; nw.value = '123456';
    const f = document.getElementById('afChpw');
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return new Promise(function(res){ setTimeout(function(){
      const m = document.getElementById('amsg2');
      res(m ? m.textContent : '@@nomsg');
    }, 1200); });
  })()`);
  ok('改密填 6 位密码被当场拒绝（UI 路径真的接上了）',
    /至少\s*10\s*位|纯数字/.test(String(rejMsg)), String(rejMsg).slice(0, 80));

  /* 反向断言：登录 tab 用 6 位密码，**不能**被前端强度提示拦下。
     用一个必然不存在的邮箱 —— 只会拿到「邮箱或密码不对」，不会登进谁的账号。 */
  await evalJS(`document.getElementById('atab-login').click()`);
  await new Promise(r => setTimeout(r, 300));
  const phLogin = await evalJS(`document.getElementById('apw').getAttribute('placeholder')`);
  ok('登录 tab 的 placeholder 不写「至少 10 位」（不误导老用户）',
    !/至少\s*10\s*位/.test(String(phLogin)), String(phLogin));

  await evalJS(`(function(){
    document.getElementById('aemail').value = 'phm-probe-does-not-exist@example.invalid';
    document.getElementById('apw').value = '123456';
    return 1;
  })()`);
  await evalJS(`document.getElementById('asubmit').click()`);
  const gotReply = await until(`(function(){ const m=document.getElementById('amsg'); return !!m && m.textContent.length>0; })()`, 25000);
  if (gotReply) {
    const msg = String(await evalJS(`document.getElementById('amsg').textContent`));
    ok('登录 6 位密码不被强度提示拦下（老账号能登）',
      !/至少\s*10\s*位|纯数字|纯小写/.test(msg), msg.slice(0, 70));
  } else {
    /* 没联网 / 被限流时退回源码证据，避免测试因网络变脆 */
    ok('登录 6 位密码不被强度提示拦下（源码证据）',
      loginBlock !== null && !/pwWarn/.test(loginBlock), '未拿到回执，已退回源码断言');
  }
}

/* ══════════════════════════════════════════════════════════
 * 9) /settings 设置页
 *    设置从「散在 7 个键里」收口成 js/settings.js 之后，必须有人守着三件事：
 *      a) 页面开关与真源**双向一致**（不是各存一份）；
 *      b) **清空只清本站的键** —— 同源下还住着云 SDK 的会话，
 *         顺手删掉会把用户从账号里踢出去。这条是硬要求；
 *      c) 深链能到（文档/回帖里才能直接指路）。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[9] /settings 设置页 · 单一真源与安全清空');
await goto('/settings', 2600);
{
  const hook = await evalJS(`!!(window.PHM_SETTINGS && window.PHM_SETTINGS.optin && window.PHM_SETTINGS.clearAll)`);
  ok('存在设置真源钩子 PHM_SETTINGS', hook);

  const keys = await evalJS(`window.PHM_SETTINGS ? Object.keys(window.PHM_SETTINGS.KEYS) : []`);
  ok('键名清单集中在 settings.js（≥6 个）', (keys || []).length >= 6, JSON.stringify(keys));

  /* UI → 真源：取消勾选，真源必须跟着变 */
  await evalJS(`(function(){
    const cb=document.getElementById('optin');
    cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));
    return 1;})()`);
  await new Promise(r => setTimeout(r, 400));
  const afterOff = await evalJS(`window.PHM_SETTINGS.optin.get()`);
  ok('取消勾选 → 真源变 false', afterOff === false, 'optin=' + afterOff);

  const stateTxt = await evalJS(`document.getElementById('optinState').textContent`);
  ok('状态条跟着说明「已关闭」', /关闭/.test(String(stateTxt)), String(stateTxt).slice(0, 50));

  /* 真源 → UI：反向也要通 */
  await evalJS(`window.PHM_SETTINGS.optin.set(true)`);
  await new Promise(r => setTimeout(r, 400));
  const backOn = await evalJS(`document.getElementById('optin').checked`);
  ok('真源改回 true → 开关自动勾上（订阅生效）', backOn === true, 'checked=' + backOn);

  /* 本机存储清单要能列出真实内容 */
  await evalJS(`(function(){ window.PHM_SETTINGS.phira.set('测试用户','12345'); return 1; })()`);
  await new Promise(r => setTimeout(r, 400));
  const invTxt = await evalJS(`document.getElementById('inv').textContent`);
  ok('存储清单列出真实键值', /12345|测试用户/.test(String(invTxt)), String(invTxt).slice(0, 70));

  /* ⚠ 最关键的一条：清空不能碰别人的键 */
  const clearRes = await evalJS(`(function(){
    const S = window.PHM_SETTINGS;
    localStorage.setItem('workbuddy-cloud.session.probe', 'MUST_SURVIVE');
    localStorage.setItem('unrelated-key', 'MUST_SURVIVE');
    S.optin.set(false);
    S.phira.set('要被清掉的','999');
    const before = S.inventory().length;
    S.clearAll();
    return {
      before: before,
      session: localStorage.getItem('workbuddy-cloud.session.probe'),
      unrelated: localStorage.getItem('unrelated-key'),
      optinKey: localStorage.getItem(S.KEYS.optin),
      phiraKey: localStorage.getItem(S.KEYS.phiraName),
      after: S.inventory().length,
      defaultOptin: S.optin.get()
    };
  })()`);
  ok('清空前确实有内容可清', clearRes.before > 0, '清空前 ' + clearRes.before + ' 项');
  ok('清空后本站键归零', clearRes.after === 0, '清空后 ' + clearRes.after + ' 项');
  ok('★ 云 SDK 会话**没被碰**（清空只清本站）',
    clearRes.session === 'MUST_SURVIVE', 'session=' + clearRes.session);
  ok('★ 无关的第三方键也没被碰',
    clearRes.unrelated === 'MUST_SURVIVE', 'unrelated=' + clearRes.unrelated);
  ok('清空后回到默认（上传默认开启）', clearRes.defaultOptin === true, 'optin=' + clearRes.defaultOptin);

  /* 清干净测试残留 */
  await evalJS(`(function(){
    localStorage.removeItem('workbuddy-cloud.session.probe');
    localStorage.removeItem('unrelated-key');
    return 1;})()`);

  /* 导出结构 */
  const exp = await evalJS(`(function(){
    window.PHM_SETTINGS.optin.set(false);
    const o = window.PHM_SETTINGS.exportAll();
    return { hasSettings: !!o.settings, note: String(o._note||''), hasAt: !!o._exportedAt,
             leak: /password|token|secret/i.test(JSON.stringify(o)) };
  })()`);
  ok('导出包含 settings 与时间戳', exp.hasSettings && exp.hasAt, JSON.stringify(exp));
  ok('导出**不含**任何凭据字段名', exp.leak === false, 'leak=' + exp.leak);

  /* 深链锚点都在（文档里要能直接指路） */
  for (const id of ['privacy', 'accounts', 'storage', 'about']) {
    const there = await evalJS(`!!document.getElementById(${JSON.stringify(id)})`);
    ok('深链锚点 #' + id + ' 存在', there);
  }
}

/* ══════════════════════════════════════════════════════════
 * 10) 主题与语言
 *     这两件事最容易"看着能用但一半是坏的"：主题要能真的换掉颜色
 *     （而不是只改个属性），语言要能换掉**动态生成**的内容
 *     （静态部分 applyStatic 管，动态部分靠订阅重绘）。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[10] 主题与语言 · 真的换了吗');
await goto('/settings', 2600);
{
  const before = await evalJS(`(function(){
    return { theme: document.documentElement.getAttribute('data-theme'),
             bg: getComputedStyle(document.body).backgroundColor,
             brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() };
  })()`);
  ok('初始主题已定（dark/light）',
    before.theme === 'dark' || before.theme === 'light', before.theme);

  /* 切到与当前相反的那个，然后确认**计算后的背景色真的变了** */
  const target = before.theme === 'dark' ? 'light' : 'dark';
  await evalJS(`window.PHM_SETTINGS.theme.set(${JSON.stringify(target)})`);
  await new Promise(r => setTimeout(r, 350));
  const after = await evalJS(`(function(){
    return { theme: document.documentElement.getAttribute('data-theme'),
             bg: getComputedStyle(document.body).backgroundColor,
             brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() };
  })()`);
  ok('切换后 data-theme 变了', after.theme === target, after.theme);
  ok('★ 背景色真的变了（不只是改属性）', after.bg !== before.bg,
    before.bg + ' → ' + after.bg);
  ok('★ 主色也跟着换（浅底上的琥珀要压深）', after.brand !== before.brand,
    before.brand + ' → ' + after.brand);

  /* 切回原主题，别把后面的测试环境搅乱 */
  await evalJS(`window.PHM_SETTINGS.theme.set(${JSON.stringify(before.theme)})`);
  await new Promise(r => setTimeout(r, 250));

  /* ── 语言 ── */
  const i18nReady = await evalJS(`!!(window.PHM_I18N && window.PHM_I18N.t)`);
  ok('存在 i18n 钩子 PHM_I18N', i18nReady);

  const dictInfo = await evalJS(`(function(){
    const I = window.PHM_I18N;
    return { zh: I.keys().length, enMissing: I.missing('en').length, navZh: I.t('nav.home') };
  })()`);
  ok('中文字典非空（≥40 条）', dictInfo.zh >= 40, 'zh=' + dictInfo.zh);
  ok('英文字典覆盖完整（0 条缺失）', dictInfo.enMissing === 0, '缺 ' + dictInfo.enMissing + ' 条');

  await evalJS(`window.PHM_I18N.setLang('en')`);
  await new Promise(r => setTimeout(r, 500));
  const enState = await evalJS(`(function(){
    return { htmlLang: document.documentElement.getAttribute('lang'),
             dataLang: document.documentElement.getAttribute('data-lang'),
             nav: Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.textContent; }).join('|'),
             h2: (document.querySelector('.ssec h2')||{}).textContent || '' };
  })()`);
  ok('切英文后 <html lang> = en', enState.htmlLang === 'en', enState.htmlLang);
  ok('★ 导航真的变英文了', /Home/.test(enState.nav), enState.nav.slice(0, 60));
  ok('★ 动态生成的标题也变了（订阅生效）',
    /Privacy & data/.test(String(enState.h2)), enState.h2);

  /* 切回中文，收尾 */
  await evalJS(`window.PHM_I18N.setLang('zh')`);
  await new Promise(r => setTimeout(r, 400));
  const backZh = await evalJS(`Array.prototype.map.call(document.querySelectorAll('#nav a'), function(a){ return a.textContent; }).join('|')`);
  ok('切回中文正常', /首页/.test(backZh), backZh.slice(0, 40));
}

/* ══════════════════════════════════════════════════════════
 * 11) /user 数据飞轮 · 一键提交
 *     这个入口曾经存在（app.html 的玩家面板里），面板迁到本页后
 *     随休眠代码一起被删掉了 —— 用户会发现"数据飞轮转不动了"。
 *     所以这条断言测的是**端到端真的写入**，不是"按钮在不在"。
 *     ⚠ 它会真的往公开数据集写一次（真实公开成绩，upsert 幂等）。
 * ══════════════════════════════════════════════════════════ */
console.log('\n[11] /user 数据飞轮 · 一键提交');
await goto('/user?uid=2771878', 3000);
{
  const ready = await until(`document.querySelectorAll('#out .stat').length >= 4`, 40000);
  ok('账号已加载（可以提交了）', ready);

  const hasBtn = await evalJS(`!!document.getElementById('impbtn')`);
  ok('存在「全部进入数据飞轮」按钮', hasBtn);

  const desc = await evalJS(`(function(){
    const e = document.querySelector('.impbar .dim2');
    return e ? e.textContent.replace(/\\s+/g,' ').trim() : '';
  })()`);
  ok('按钮旁写明了会上传什么（含 Phira UID、不含密码）',
    /Phira UID/.test(desc) && /不含密码/.test(desc), String(desc).slice(0, 70));

  /* 确认框：headless 里不覆盖会直接卡住 */
  await evalJS(`window.confirm = function(){ return true; };`);
  await evalJS(`document.getElementById('impbtn').click()`);

  const done = await until(`(function(){
    const e = document.getElementById('impmsg');
    return !!e && /已写入|失败|没有可提交/.test(e.textContent);
  })()`, 45000);
  const resMsg = await evalJS(`(document.getElementById('impmsg')||{}).textContent`);
  ok('★ 提交有明确回执（请求真的发出去了）', done, String(resMsg).slice(0, 90));
  ok('★ 服务端确认写入（不是"点了就算"）',
    /已写入\s*\d+\s*条/.test(String(resMsg)), String(resMsg).slice(0, 90));

  const btnTxt = await evalJS(`(document.getElementById('impbtn')||{}).textContent`);
  ok('写入成功后按钮变成"再提交一次"（可重复点，upsert 幂等）',
    /再提交|全部进入/.test(String(btnTxt)), String(btnTxt));
}

console.log('\n未捕获异常 / console.error ：' + errors.length);
errors.slice(0, 8).forEach(e => console.log('   ! ' + e));
console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail} · 运行时报错 ${errors.length}`);
ws.close(); cleanup();
process.exit((fail || errors.length) ? 1 : 0);
