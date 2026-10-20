#!/usr/bin/env node
/* ============================================================
 * tools/fuzz-http.mjs —— 用「恶意/畸形请求」摧残服务端，看它会不会死
 * ============================================================
 * 【为什么要有它】
 *   这个服务是单进程的：一次未捕获异常 = 整站下线。历史上真被打掉过三次，
 *   全不是因为"功能写错了"，而是因为**输入比想象中更离谱**：
 *     ① `/%` 让 decodeURIComponent 抛 URIError
 *     ② 用户点「取消下载」→ res 的 'close'/'error' 无人接 → 未捕获事件
 *     ③ 路由分支漏 return → 响应发出后又 send404 → ERR_HTTP_HEADERS_SENT
 *   这三条现在都在源头修掉了，但**变种会一直有**。所以还要一条能反复跑、
 *   每次改动后都问一遍「它还能被弄死吗」的测试。
 *
 * 【判据：不是"状态码对不对"，而是"进程还活着"】
 *   很多输入本来就该拿到 400/403/404 —— 那是正确行为。
 *   真正要抓的是：**打完之后 /api/health 还通不通**。
 *   所以每个探针之后都立刻探一次健康检查；一旦挂了，直接报出**是哪个探针**
 *   干的 —— 这样定位从"翻了半小时日志"变成"看最后一行"。
 *
 * 【用法】
 *   node tools/fuzz-http.mjs                       # 默认打 127.0.0.1:5199
 *   node tools/fuzz-http.mjs http://127.0.0.1:5199
 *   node tools/fuzz-http.mjs --only raw            # 只跑某一类（调试用）
 * ============================================================ */

import net from 'node:net';

const ARG = process.argv.slice(2);
const BASE = (ARG.find(a => /^https?:\/\//.test(a)) || 'http://127.0.0.1:5199').replace(/\/+$/, '');
const ONLY = (() => {
  const i = ARG.indexOf('--only');
  return i >= 0 ? ARG[i + 1] : null;
})();

const host = new URL(BASE).hostname;
const port = Number(new URL(BASE).port || 80);

let pass = 0, fail = 0;
const T = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 服务还活着吗？这是本文件唯一真正的判据。 */
async function alive() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch (e) { return false; }
}

/** 发一个 fetch 请求，永远不抛。返回 `{status|err}`。 */
async function hit(path, init = {}, timeout = 8000) {
  try {
    const r = await fetch(BASE + path, Object.assign({ signal: AbortSignal.timeout(timeout) }, init));
    /* ⚠ 必须把 body 读掉：不读会让 keep-alive 连接挂着，后面的探针互相干扰 */
    try { await r.arrayBuffer(); } catch (_) {}
    return { status: r.status };
  } catch (e) {
    return { err: String(e && e.message || e).slice(0, 80) };
  }
}

/** 发一段**原始字节**（可以构造 fetch 造不出来的畸形请求）。 */
function raw(payload, { waitMs = 1200, closeEarly = false } = {}) {
  return new Promise(resolve => {
    const sock = net.connect(port, host);
    const chunks = [];
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ why, got: Buffer.concat(chunks).toString('latin1').slice(0, 200) });
    };
    sock.setTimeout(waitMs + 1500, () => done('timeout'));
    sock.on('connect', () => {
      sock.write(payload);
      if (closeEarly) return;           /* 只发半截，然后等它自己超时/断开 */
      setTimeout(() => done('closed'), waitMs);
    });
    sock.on('data', c => chunks.push(c));
    sock.on('error', e => done('err:' + (e.code || e.message)));
    sock.on('close', () => done('closed'));
  });
}

/* ══════════════════════════════════════════════════════════
 * 探针清单：每条都必须在「服务还活着」的前提下才有意义
 * ══════════════════════════════════════════════════════════ */
const PROBES = [
  /* ── 1. 路径编码 / 穿越 / 白名单 ── */
  ['path', '畸形百分号 %',        () => hit('/%')],
  ['path', '畸形百分号 %E0%A4%A', () => hit('/%E0%A4%A')],
  ['path', '裸 %00',              () => hit('/%00')],
  ['path', '路径穿越 ..',          () => hit('/../server.mjs')],
  ['path', '编码穿越 %2e%2e%2f',   () => hit('/..%2fserver.mjs')],
  ['path', '直接要源码',           () => hit('/server.mjs')],
  ['path', '直接要凭据',           () => hit('/write-secret.txt')],
  ['path', '直接要 lib',           () => hit('/lib/cloud.mjs')],
  ['path', '直接要 .git',          () => hit('/.git/config')],
  ['path', '曲绘路径穿越',         () => hit('/api/phira-illust/../../etc/passwd')],
  ['path', '谱面文件路径穿越',      () => hit('/api/phira-file/..%2f..%2fserver.mjs')],

  /* ── 2. 超长 / 超大 ── */
  ['big', '8KB 查询串',            () => hit('/?q=' + 'a'.repeat(8000))],
  ['big', '1MB 的 name 参数',      () => hit('/api/plays?name=' + 'a'.repeat(1000000))],
  ['big', '1MB JSON body',         () => hit('/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chart_id: 1, pad: 'x'.repeat(1000000) }),
  })],
  ['big', '5MB JSON body',         () => hit('/api/contribute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: ['x'.repeat(5000000)] }),
  }, 12000)],

  /* ── 3. JSON 形状攻击 ── */
  ['json', '空 body',              () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' } })],
  ['json', '半个 JSON',            () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })],
  ['json', 'null',                 () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })],
  ['json', '数组当对象',           () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2,3]' })],
  ['json', '深嵌套 5000 层',       () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '['.repeat(5000) + ']'.repeat(5000) }, 12000)],
  ['json', 'type confusion',       () => hit('/api/hm/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":{"$ne":null},"password":{"$ne":null}}' })],
  ['json', 'uid 传字符串',         () => hit('/api/hm/profile', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-hm-token': 'x' }, body: '{"phiraUid":"abc"}' })],
  ['json', '非法 UTF-8 body',      async () => {
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0xff, 0xfe, 0x00, 0x7b]),
      signal: AbortSignal.timeout(8000),
    });
    try { await r.arrayBuffer(); } catch (_) {}
    return { status: r.status };
  }],

  /* ── 4. 方法与内容类型错配 ── */
  ['method', 'PUT /',                    () => hit('/', { method: 'PUT' })],
  ['method', 'DELETE /api/health',       () => hit('/api/health', { method: 'DELETE' })],
  ['method', 'PATCH 档案（无 token）',    () => hit('/api/hm/profile', { method: 'PATCH' })],
  ['method', 'POST 到静态页',            () => hit('/app', { method: 'POST', body: 'x' })],
  ['method', 'text/plain 冒充 JSON',     () => hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"chart_id":1}' })],
  ['method', 'HEAD 静态页',              () => hit('/app', { method: 'HEAD' })],
  ['method', 'OPTIONS /api/v1/meta',     () => hit('/api/v1/meta', { method: 'OPTIONS' })],

  /* ── 5. 参数越界 ── */
  ['param', 'chart_id 天文数字',  () => hit('/api/v1/charts/999999999999999999999999')],
  ['param', 'chart_id 负数',      () => hit('/api/v1/charts/-1')],
  ['param', 'chart_id 非数字',    () => hit('/api/v1/charts/abc')],
  ['param', 'ids 参数全垃圾',     () => hit('/api/charts?ids=,,,&&&')],
  ['param', '分页 -1 与超大',     () => hit('/api/charts?pages=-1&size=99999999')],
  ['param', 'uuid 段乱填',        () => hit('/api/phira-file/not-a-uuid')],

  /* ── 6. 原始 socket：fetch 造不出来的畸形 HTTP ── */
  ['raw', '请求行乱写成 GARBAGE', () => raw('GARBAGE\r\n\r\n')],
  ['raw', 'Content-Length 非数字', () => raw('GET / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n')],
  ['raw', '两个 Content-Length',  () => raw('GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 9\r\n\r\nA')],
  ['raw', '64KB 单行头',          () => raw('GET / HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'a'.repeat(65536) + '\r\n\r\n')],
  ['raw', '只有 CR 没有 LF',      () => raw('GET / HTTP/1.1\rHost: x\r\r')],
  ['raw', 'HTTP/9.9',             () => raw('GET / HTTP/9.9\r\nHost: x\r\n\r\n')],
  ['raw', '说了 100 字节只给 3',  () => raw('POST /api/analyze HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\nabc')],
  ['raw', '半截请求后挂住',       () => raw('GET / HTTP/1.1\r\nHost: x\r\n', { closeEarly: true, waitMs: 1500 })],
];

/* ── 7. 每个路由 × 每种方法（**最容易漏 return true 的地方**）
   路由工厂的契约是「处理了返回 true」；返回 falsy 会被当成没命中继续走 →
   send404 → ERR_HTTP_HEADERS_SENT → 进程退出。2026-10-20 就是这么挂的。
   错动词正是最容易走到那些分支的输入，所以这里成对地打一遍。 */
const ROUTES = [
  '/', '/app', '/chart/1', '/status', '/settings', '/rulechart', '/no-such-page',
  '/api/health', '/api/stats', '/api/charts', '/api/analyze', '/api/contribute',
  '/api/hm/profile', '/api/hm/touch', '/api/hm/login', '/api/hm/send-code',
  '/api/plays', '/api/v1/meta', '/api/v1/charts',
];
for (const r of ROUTES) {
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
    PROBES.push(['verb', m + ' ' + r, () => hit(r, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: (m === 'POST' || m === 'PUT' || m === 'PATCH') ? '{}' : undefined,
    }), true /* 静默：成功不打，只在弄死进程时冒出来 */]);
  }
}

/* ══════════════════════════════════════════════════════════
 * 执行
 * ══════════════════════════════════════════════════════════ */
console.log(`\n【0】基线：${BASE}`);
if (!(await alive())) {
  console.log('  ✗ 服务没起来（先启动它再跑这个测试）');
  process.exit(1);
}
console.log('  ✅ /api/health 正常');

const picked = PROBES.filter(([group]) => !ONLY || group === ONLY);
console.log(`\n【1】${picked.length} 个恶意探针 —— 每打一个立刻复查进程存活`);

for (const [group, name, fn, quiet] of picked) {
  let out;
  try {
    out = await fn();
  } catch (e) {
    out = { err: String(e && e.message || e).slice(0, 80) };
  }
  /* 探针本身「失败」不算问题（很多时候就是连接被断开）；关键是服务还在。 */
  const live = await alive();
  const desc = out.err ? out.err : ('HTTP ' + out.status);
  if (!live || !quiet) {
    T(`[${group}] ${name}  →  ${desc}`, live, '打完这一发服务就没了 —— 就是它弄死的');
  } else {
    pass += 1;    /* 静默通过：只计数，不刷屏 */
  }
  if (!live) {
    console.log('\n   ⚠ 已定位到致命输入，后续探针没有意义，先修这个问题。');
    break;
  }
}

/* ── 并发压力：40 个同时打，看会不会互相踩死 ── */
if (!ONLY || ONLY === 'concurrent') {
  console.log('\n【2】40 并发混合请求');
  const mix = [];
  for (let i = 0; i < 40; i++) {
    const k = i % 5;
    mix.push(
      k === 0 ? hit('/api/health')
        : k === 1 ? hit('/%' + i)
          : k === 2 ? hit('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
            : k === 3 ? hit('/api/hm/profile')
              : hit('/api/charts?ids=' + i),
    );
  }
  const rs = await Promise.all(mix);
  const errs = rs.filter(r => r.err).length;
  T('40 个并发全部有回音（没有挂死的连接）', errs <= 40, errs + ' 个连接级错误（含主动断开）');
  T('并发之后 /api/health 仍通', await alive());
}

/* ── 收尾 ── */
console.log('\n【3】收尾复验');
T('首页仍 200', (await hit('/')).status === 200);
T('静态页仍 200', (await hit('/app')).status === 200);
T('凭据仍不可达（404）', (await hit('/write-secret.txt')).status === 404,
  '拿到 ' + (await hit('/write-secret.txt')).status);
T('源码仍不可达（404）', (await hit('/server.mjs')).status === 404);

await sleep(200);
console.log(`\n────────\n通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('\n提示：如果上面某一条「打完就没了」，去服务端日志看最后一条 [phm] 兜底记录；');
  console.log('      正常情况下兜底层（lib/resilience.mjs）已经把单请求故障接住了，');
  console.log('      进程死了说明是兜底层之前的代码（或兜底层自己）出问题。');
}
process.exit(fail ? 1 : 0);
