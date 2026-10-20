#!/usr/bin/env node
/* ============================================================
 * tools/test-resilience.mjs —— 兜底层自己的单测
 * ============================================================
 * 【为什么单测一个"兜底"】
 *   `tools/fuzz-http.mjs` 证明的是「打不死」——但它跑完 0 条兜底记录，
 *   说明生产路径其实很干净。**兜底代码因此从来没被执行过**，
 *   而"从没执行过的错误处理"等于没有：真出事那天它自己先抛，就白搭了。
 *   所以这里造四种**必然抛出**的处理函数，逼它走一遍：
 *     ① 同步抛          ② async reject
 *     ③ 头已发出之后再抛 ④ res 自己 emit 'error'（用户中途取消）
 *   判据两条：**状态码正确**（没发头 → 500；头已发 → 不许再改，只收尾）
 *             并且**进程还活着**（本文件跑在同一个进程里，死了就没输出了）。
 * ============================================================ */

import http from 'node:http';
import { installFaultGuards, guardRequest } from '../lib/resilience.mjs';

let pass = 0, fail = 0;
const T = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
};

/* 兜底层会把异常打到 stderr —— 这里故意压掉，免得测试输出被淹没 */
const realErr = console.error;
const muted = [];
console.error = (...a) => { muted.push(a.join(' ')); };

const softFault = installFaultGuards();

const server = http.createServer(guardRequest(async (req, res) => {
  const p = req.url;
  if (p === '/sync') throw new Error('同步抛：模拟路由里忘了 try/catch');
  if (p === '/async') { await Promise.resolve(); throw new Error('异步 reject：模拟 await 之后抛'); }
  if (p === '/late') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('已经开始回了');
    throw new Error('头已发出之后才抛：这正是 ERR_HTTP_HEADERS_SENT 的现场');
  }
  if (p === '/reserror') {
    /* 客户端中途取消 → res 会 emit 'error'。没人接就是未捕获事件。 */
    res.emit('error', new Error('客户端断了'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}, softFault));

const PORT = 0;
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

async function get(path) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(4000) });
    const body = await r.text().catch(() => '');
    return { status: r.status, body };
  } catch (e) {
    return { err: String(e && e.message || e).slice(0, 80) };
  }
}

console.log('\n【1】同步抛 → 500，且不许崩');
{
  const r = await get('/sync');
  T('同步抛得到 500', r.status === 500, JSON.stringify(r).slice(0, 90));
  T('回的是 JSON（前端能解析）', /"error"\s*:\s*"internal"/.test(r.body || ''), r.body);
}

console.log('\n【2】async reject → 500');
{
  const r = await get('/async');
  T('异步 reject 得到 500', r.status === 500, JSON.stringify(r).slice(0, 90));
}

console.log('\n【3】头已发出之后再抛 → 不许改状态码，只收尾');
{
  const r = await get('/late');
  /* 关键：如果兜底层试图再 writeHead，Node 会抛 ERR_HTTP_HEADERS_SENT，
     而那个抛出现在 catch 之外 → 进程退出。这里能拿到响应就说明没走那条路。 */
  T('拿到的是已经发出的 200（不是 500）', r.status === 200, JSON.stringify(r).slice(0, 90));
  T('响应被干净收尾（没有挂死）', !r.err, r.err || '');
}

console.log('\n【4】res 自己 emit error（用户中途取消）→ 未捕获事件也不许崩');
{
  const r = await get('/reserror');
  T('请求有回音（连接没被吞掉）', !r.err || r.status === 200, JSON.stringify(r).slice(0, 90));
}

console.log('\n【5】★ 打完全部异常，服务仍然正常');
{
  const r = await get('/ok');
  T('/ok 仍 200', r.status === 200 && r.body === 'ok', JSON.stringify(r).slice(0, 60));
  T('★ 兜底层记了日志（说明它真的跑到了）', muted.length >= 3, '日志 ' + muted.length + ' 条');
  T('★ 日志里没有"兜底自己抛"的痕迹',
    !muted.some(l => /请求处理异常[\s\S]*无法序列化/.test(l)), '');
}

console.error = realErr;
server.close();

console.log(`\n────────\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
