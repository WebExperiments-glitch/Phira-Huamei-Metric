/* lib/ratelimit.mjs 的完整单测 —— 直接 import 真模块。
 *
 * 覆盖十类行为，其中三类是**专门针对已发生过的故障**写的：
 *   · 滑动窗口（不是固定窗口）—— 固定窗口在边界上会放走双倍配额
 *   · 并发不丢计数 —— 读改写不串行就会互相覆盖（bfccd91 修过一次的老 bug）
 *   · 返回值不是布尔 —— `if (!obj)` 永远为真，那正是「限流失效」的同类 bug
 *
 * 跑法： node tools/test-ratelimit.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  limit, tryEnter, leave, snapshot, reset, rlHeaders,
  RL, RL_WINDOW, gateWrite, gateStats, gateAuth, gateAnalyze, gateProxy,
} from '../lib/ratelimit.mjs';

/* ── 子进程模式 ──
 * 父进程用 `--child <key> <max>` 把自己再起一遍，只打一次限流并把结论打进 stdout。
 * ⚠ 必须放在**所有测试之前**：放在末尾的话，子进程会把块 1~12 全跑一遍 ——
 *   不但慢，还会把内存桶和 DB 里的键搞乱，测出来的「跨进程」结论没有意义
 *   （第一版就因此测出一个假的 CHILD_ALLOWED）。
 * 存在的理由：验证「DB 计数跨进程可见」。进程内计数在无状态托管环境里
 * 必然失效（每个请求都落在一个新进程上），这是 DB 那条路唯一的验收标准。 */
if (process.argv.includes('--child')) {
  const k = process.argv[process.argv.indexOf('--child') + 1];
  const mx = Number(process.argv[process.argv.indexOf('--child') + 2]);
  const r = await limit([k], mx, 120_000);
  console.log(r.ok ? `CHILD_ALLOWED via=${r.via}` : `CHILD_REJECTED_DB via=${r.via}`);
  process.exit(0);
}

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('\n【1】基本额度：第 N 次放行，第 N+1 次拒绝');
{
  reset();
  const key = 't1';
  for (let i = 1; i <= 3; i++) T(`第 ${i} 次放行`, (await limit([key], 3, 60_000, { db: false })).ok);
  const r = await limit([key], 3, 60_000, { db: false });
  T('第 4 次拒绝', r.ok === false);
  T('拒绝时 remaining = -1', r.remaining === -1, `实际 ${r.remaining}`);
  T('拒绝时 resetMs > 0', r.resetMs > 0, `实际 ${r.resetMs}`);
  /* remaining 报的是「这一发之后还能发几次」——第一次放行后应是 max-1 */
  reset();
  const first = await limit(['t1b'], 3, 60_000, { db: false });
  T('放行时 remaining = max-1', first.remaining === 2, `实际 ${first.remaining}`);
}

console.log('\n【2】窗口过期后额度恢复');
{
  reset();
  const key = 't2';
  const W = 120;
  for (let i = 0; i < 2; i++) await limit([key], 2, W, { db: false });
  T('第 3 次被拒', (await limit([key], 2, W, { db: false })).ok === false);
  await sleep(W + 40);
  T('过了窗口又能放行', (await limit([key], 2, W, { db: false })).ok === true);
}

console.log('\n【3】★ 滑动窗口 —— 不是固定窗口');
/* 固定窗口的毛病：在边界两侧各打满配额，实际拿到双倍。
   滑动窗口按「过去 W 毫秒内的计数」算，不会有这种免费重置。 */
{
  reset();
  const key = 't3';
  const W = 200;
  for (let i = 0; i < 3; i++) await limit([key], 3, W, { db: false });
  T('先打满 3 次', (await limit([key], 3, W, { db: false })).ok === false);
  /* 等到窗口刚过一点点 —— 固定窗口会在这里「整块清零」，
     滑动窗口只放走最早那一两条，所以仍然接近满。 */
  await sleep(W + 20);
  T('窗口过后放行 1 次', (await limit([key], 3, W, { db: false })).ok === true);
  /* 关键：这一发之后不应该又白送 3 次 */
  let allowed = 1;
  while (allowed < 10 && (await limit([key], 3, W, { db: false })).ok) allowed++;
  T('★ 没有出现「边界双倍」', allowed <= 3, `窗口过后又放行了 ${allowed} 次`);
}

console.log('\n【4】每个键可以有不同上限（{k, max}）');
{
  reset();
  /* 登录场景：per-IP 5 次，但 per-邮箱 3 次 */
  const spec = () => [{ k: 't4:ip', max: 5 }, { k: 't4:e', max: 3 }];
  T('第 1 次放行', (await limit(spec(), null, 60_000, { db: false })).ok);
  T('第 2 次放行', (await limit(spec(), null, 60_000, { db: false })).ok);
  T('第 3 次放行（per-邮箱到顶）', (await limit(spec(), null, 60_000, { db: false })).ok);
  const r = await limit(spec(), null, 60_000, { db: false });
  T('第 4 次被 per-邮箱 挡下', r.ok === false);
  /* 换个邮箱（同 IP）应该还能放行 —— 证明两个键是独立计数的 */
  T('换个邮箱同 IP 仍放行', (await limit([{ k: 't4:ip', max: 5 }, { k: 't4:e2', max: 3 }], null, 60_000, { db: false })).ok === true);
}

console.log('\n【5】多键任一超限就整体拒绝');
{
  reset();
  await limit(['t5:a', 't5:b'], 1, 60_000, { db: false });          // 两个键各用掉 1 次
  T('两个键都满 → 拒绝', (await limit(['t5:a', 't5:b'], 1, 60_000, { db: false })).ok === false);
  T('只换掉超限的那个 → 放行', (await limit(['t5:c', 't5:b'], 1, 60_000, { db: false })).ok === false);
  T('只换掉没超的那个 → 也放行', (await limit(['t5:a', 't5:d'], 1, 60_000, { db: false })).ok === false);
}

console.log('\n【6】被拒的请求不消耗配额（恢复更快）');
/* 这一条要验证的是：**桶不会因为被拒的请求而变厚**。
   做法是先把额度用干净，再狂撞 30 次，然后看桶里还是不是正好那么多条 ——
   而不是看"还能不能放行"（那种写法在额度没填满时会得出假结论）。 */
{
  reset();
  const key = 't6';
  const MAX = 3;
  for (let i = 0; i < MAX; i++) await limit([key], MAX, 60_000, { db: false });
  const full = snapshot().buckets[key];
  T('额度已用干净', full === MAX, `桶里 ${full} 条`);
  for (let i = 0; i < 30; i++) await limit([key], MAX, 60_000, { db: false });
  T('★ 撞 30 次后桶没有变厚', snapshot().buckets[key] === MAX,
    `桶里 ${snapshot().buckets[key]} 条`);
  T('仍然被拒', (await limit([key], MAX, 60_000, { db: false })).ok === false);
  T('remaining = -1', (await limit([key], MAX, 60_000, { db: false })).remaining === -1);
}

console.log('\n【7】★ 并发不丢计数');
/* 读改写不串行时，并发请求会读到同一个旧值、一起通过检查。
   ⚠ key 必须带时间戳：DB 里的行有 120 秒窗口，两次测试间隔往往不到 120 秒，
     复用同一个 key 会让上一轮留下的行把这一轮的额度用光（实测：50 个全被拒）。 */
{
  reset();
  const key = 't7-' + Date.now();
  const N = 50;
  const results = await Promise.all(Array.from({ length: N }, () => limit([key], N)));
  T(`${N} 个并发全部放行`, results.every(r => r.ok === true),
    `实际放行 ${results.filter(r => r.ok).length}`);
  const after = await limit([key], N, 60_000, { db: false });
  T('第 ' + (N + 1) + ' 个被拒', after.ok === false);
  /* ⚠ snapshot().buckets[k] 返回的是**条数**（number），不是数组 ——
     第一版写成 `.length` 于是恒为 undefined，断言假红。 */
  T('桶里正好 ' + N + ' 条', snapshot().buckets[key] === N,
    `实际 ${snapshot().buckets[key]}`);
}

console.log('\n【8】在途并发上限 tryEnter / leave');
{
  reset();
  T('能进 2 个', tryEnter('t8', 2) && tryEnter('t8', 2));
  T('第 3 个进不去', tryEnter('t8', 2) === false);
  T('snapshot 显示 2', (snapshot().inflight.t8 || 0) === 2);
  leave('t8');
  T('leave 后能进 1 个', tryEnter('t8', 2) === true);
  /* 漏 leave 会把名额永久吃掉 —— 这是调用方的责任，
     所以这里验证「leave 到 0 会删键」，避免 snapshot 里留下僵尸计数 */
  leave('t8'); leave('t8');
  T('leave 到 0 后键被删掉', snapshot().inflight.t8 === undefined,
    JSON.stringify(snapshot().inflight));
}

console.log('\n【9】429 的标准响应头');
{
  const h = rlHeaders({ ok: false, remaining: -1, resetMs: 42_000 });
  T('retry-after = 42', h['retry-after'] === '42', JSON.stringify(h));
  T('ratelimit-remaining = 0', h['ratelimit-remaining'] === '0');
  T('ratelimit-reset 有值', h['ratelimit-reset'] === '42');
  T('拿不到 resetMs 时兜底给整个窗口（宁可让客户端多等，不可让它立刻重试）',
    rlHeaders({})['retry-after'] === String(RL_WINDOW / 1000),
    JSON.stringify(rlHeaders({})));
  T('不是布尔值不能当 true 用（防 if(!obj) 那类 bug）',
    typeof (await limit(['t9'], 1)).ok === 'boolean');
}

console.log('\n【10】配额表本身合理');
{
  T('写入 20/分', RL.writeIp === 20);
  T('登录 per-IP 5/分', RL.loginIp === 5);
  T('登录 per-邮箱 3/分（比 per-IP 更严）', RL.loginEmail < RL.loginIp);
  T('登录有全局桶', RL.loginGlobal > 0);
  T('analyze 有全局桶', RL.analyzeGlobal > 0);
  T('代理有独立配额', RL.proxyIp > 0);
  T('所有配额都是正数', Object.values(RL).every(v => Number.isInteger(v) && v > 0));
  T('读路径有全局桶兜底（IP 键失效时的后手）', RL.statsGlobal > RL.statsIp);
}

console.log('\n【11】各 gate 句柄真的能跑（不起服务器）');
{
  reset();
  T('gateWrite 放行', (await gateWrite('g1', { db: false })).ok === true);
  T('gateStats 放行', (await gateStats('g1', { db: false })).ok === true);
  T('gateProxy 放行', (await gateProxy('g1', { db: false })).ok === true);
  T('gateAnalyze 放行', (await gateAnalyze('g1', { db: false })).ok === true);
  T('gateAuth 放行', (await gateAuth('g1', 'a@b.com', { db: false })).ok === true);
  /* per-邮箱 3 次后第 4 次必拒，且换 IP 也绕不过 */
  for (let i = 0; i < 2; i++) await gateAuth('g1', 'a@b.com', { db: false });
  T('per-邮箱第 4 次被拒', (await gateAuth('g1', 'a@b.com', { db: false })).ok === false);
  T('★ 换 IP 打同一邮箱仍被拒',
    (await gateAuth('g-other', 'a@b.com', { db: false })).ok === false);
  T('换邮箱同 IP 放行', (await gateAuth('g1', 'other@b.com', { db: false })).ok === true);
}

console.log('\n【12】★ DB 计数路径（无状态托管环境的唯一解）');
/* 进程内计数在无状态环境里必然失效 —— 实测（2026-10-16）：
   同一出口 IP 连发 200 个 /api/stats 零 429，换 250 个 XFF 也零 429。
   不是多实例分裂，是**每个请求都落在新进程上**，桶活了不到一个请求的寿命。
   所以权威计数必须放在进程外（数据库）。

   ⚠ 第 4 次在同进程里是被**内存预筛**挡下的（via='memory'）—— 这是对的：
     预筛本来就是为了省一次 DB 往返。所以「DB 真的在计数」这件事
     必须在**另一个进程**里验：那里内存是空的，只有 DB 还记得。 */
{
  /* ⚠ 本机没有可用数据库时**优雅跳过**这一段，而不是假失败。
     真实 DB 路径（跨进程计数）本来只能在有库的环境里验；没有库时
     limit() 会走内存兜底（via='memory'），下面那几条断言必然挂 ——
     那是环境缺东西，不是代码坏了。

     ⚠⚠ 但**「环境缺东西」与「代码坏了」必须分开**。`limit()` 的 via 有四种取值
     （见 lib/ratelimit.mjs）：
       bypass    NO_RL=1，压根不计数          → 该跳
       memory    没配写入凭据，走内存兜底      → 该跳
       db        正常走库                     → 必须断言
       db-down   **配了凭据，但 DB 报错**     → 必须红
     早先这里写的是 `if (probe.via !== 'db') 跳过` —— 于是 db-down 被当成
     "没有数据库"跳过了，而它恰恰是本段唯一想抓的回归：
     DB 计数真的坏了的时候，这条测试会静默变绿。 */
  /* ⚠ 2026-10-21：真实 DB 断言改成**显式开关**（PHM_TEST_DB=1）。
     原因是换到 Neon 之后，这条测试依赖一个**会睡觉的远端库**（免费档空闲 5 分钟
     缩到零，唤醒 1.7~13 秒）—— 于是 `npm run check` 时红时绿，取决于运气。
     这与本项目早就定下的规矩是同一件事：**浏览器/E2E 类依赖外部服务的断言
     不进 check，留给发版前手动跑**。
     默认跳过 → 本地与 CI 都确定；要验真实 DB：PHM_TEST_DB=1 node tools/test-ratelimit.mjs
     （predeploy 与 neon-migrate 也会从另一条路验库，不靠这条测试兜底）。 */
  let SKIP_DB = process.env.PHM_RL_FORCE_DB_DOWN === '1' || process.env.PHM_TEST_DB !== '1';
  if (SKIP_DB) {
    console.log('  - 跳过真实 DB 断言（默认不跑；要验真实库：PHM_TEST_DB=1）');
  } else {
    const probe = await limit(['probe-db-' + Date.now()], 3, 120_000);
    if (probe.via === 'db-down') {
      throw new Error('DB 配了写入凭据但计数报错（via=db-down）—— 这是回归，不是环境缺失');
    }
    if (probe.via !== 'db') {
      SKIP_DB = true;
      console.log('  - 跳过真实 DB 断言（via=' + probe.via + '，本机没有可用数据库）');
    }
  }
  let K;
  if (SKIP_DB) console.log('  - 跳过真实 DB 断言（CI 无写入凭据 / 本机无数据库；本地发版前会跑真实 DB 路径）');
  else {
  K = 'test-db-' + Date.now();
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await limit([K], 3, 120_000));
  T('前 3 次走 DB 且放行', seq.slice(0, 3).every(r => r.ok && r.via === 'db'),
    JSON.stringify(seq.slice(0, 3)));
  T('第 4 次被拒（同进程里由内存预筛挡下，省一次 DB 往返）',
    seq[3].ok === false && seq[3].via === 'memory', JSON.stringify(seq[3]));
  T('remaining 递减 2/1/0',
    seq[0].remaining === 2 && seq[1].remaining === 1 && seq[2].remaining === 0,
    `${seq[0].remaining}/${seq[1].remaining}/${seq[2].remaining}`);
  T('resetMs 在窗口内', seq[3].resetMs > 0 && seq[3].resetMs <= 120_000,
    String(seq[3].resetMs));
  const memOnly = await limit([K], 3, 120_000, { db: false });
  T('内存预筛路径仍可强制走', memOnly.via === 'memory');
  }

  /* DB 调不通时的行为要分两类，这是**必须分开**的：
       写入/登录 → fail-closed（拒绝）：它们本来就要读写库，库不通时无论如何
                   都做不成事，放行只会让「限流在库抖动时静默消失」——
                   2026-10-13 审计暴露的正是这种形态（一度出现 70 连发全 200）。
       只读统计/charts/代理 → fail-open（放行）：便宜的读，
                   为了库抖一下把全站只读接口全关掉不值得。 */
  process.env.PHM_RL_FORCE_DB_DOWN = '1';
  const K2 = 'failmode-' + Date.now();
  const w = await limit([K2], 3, 120_000, { failClosed: true });
  T('★ 库不通时写入/登录 fail-closed（拒绝）',
    w.ok === false && w.via === 'db-down', JSON.stringify(w));
  const rd = await limit([K2 + ':r'], 3, 120_000);
  T('★ 库不通时只读 fail-open（放行）',
    rd.ok === true && rd.via === 'memory', JSON.stringify(rd));
  const gw = await gateWrite('g1', { db: undefined });
  T('gateWrite 自带 failClosed', gw.ok === false && gw.via === 'db-down', JSON.stringify(gw));
  const ga = await gateAuth('g1', 'fc@b.com');
  T('gateAuth 自带 failClosed', ga.ok === false && ga.via === 'db-down', JSON.stringify(ga));
  delete process.env.PHM_RL_FORCE_DB_DOWN;
  if (!SKIP_DB) {
  const back = await limit([K2 + ':back' + Date.now()], 3, 120_000);
  T('撤掉故障标记后恢复走 DB', back.via === 'db', JSON.stringify(back));

  /* ★ 跨进程：起一个子进程打同一把钥匙。子进程内存是空的，
     只有 DB 还记得前 3 次 —— 所以第 4 次必须被 DB 挡下。
     这一步是整个 DB 路径存在的理由，不能省。
     ⚠ execFileSync 失败时会把子进程的 stderr 全塞进 error.message，
       直接拿去当断言消息会刷出几十万字符。这里只取第一行。 */
  /* ⚠ 先断言测试旁路**没被打开**。
     `lib/ratelimit.mjs` 里有个 PHM_TEST_NO_RATELIMIT=1 的旁路，
     给浏览器测试用（十几页都从 127.0.0.1 拉 Phira 会撞光proxyIp 配额）。
     它是**继承环境变量**的 —— 万一开发者在自己 shell 里设了没撤，
     下面这些断言会「全部通过」而其实一条都没真的限流。 */
  T('测试旁路未打开（本套断言真的在测限流）',
    process.env.PHM_TEST_NO_RATELIMIT !== '1',
    'PHM_TEST_NO_RATELIMIT=1 —— 撤掉这个变量再跑，否则测的是空气');
  let out = '';
  try {
    out = execFileSync(process.execPath, [
      fileURLToPath(import.meta.url), '--child', K, '3',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHM_TEST_NO_RATELIMIT: '' } });
  } catch (e) {
    out = String(e.stdout || '') + '\n' + String(e.stderr || '').split('\n')[0];
  }
  T('★ 跨进程仍被挡下（无状态环境也管得住）',
    out.includes('CHILD_REJECTED_DB'),
    out.trim().split('\n').filter(l => l.startsWith('CHILD')).join(' ') || '(子进程无输出)');
  }
}

/* 子进程模式：父进程用 --child <key> <max> 调起来，只打一次并把结论打进 stdout。 */

console.log('\n【13】★ 限流键怎么选（身份优先 / IP 兜底 / 全局兜底）');
/* 这一块对应 2026-10-17 的结论：不采信 XFF，改用「真实对端 + 身份」。
   白帽报告说 XFF 能 100% 绕过 —— 那是旧版（取 XFF 第一段）。
   现在的行为要在测试里钉死，免得哪天又改回去。 */
{
  const { isSharedPeer, buildKeys } = await import('../lib/ratelimit.mjs');

  T('127.0.0.1 判为共享对端（网关）', isSharedPeer('127.0.0.1') === true);
  T('::1 判为共享对端', isSharedPeer('::1') === true);
  T('10.x 判为共享对端', isSharedPeer('10.1.2.3') === true);
  T('192.168.x 判为共享对端', isSharedPeer('192.168.1.5') === true);
  T('172.16~31 判为共享对端', isSharedPeer('172.20.3.4') === true);
  T('公网 IP 不是共享对端', isSharedPeer('49.233.240.214') === false);

  /* 共享对端 → 不生成 per-IP 键，**而且全局键必须用严格档**
     （2026-10-17 实测踩过：丢掉 per-IP 后只剩宽松的 global，
      20/分 悄悄变成 120/分，38 连发全 200）。 */
  const LIM = { perIp: 20, perId: 60, global: 120 };
  const kShared = buildKeys('w', { ip: '127.0.0.1' }, LIM);
  T('共享对端不生成 per-IP 键', !kShared.some(k => k.k.includes(':ip:')),
    JSON.stringify(kShared));
  T('★ 共享对端时全局键用**严格档**（不是 120）',
    kShared.length === 1 && kShared[0].k === 'w:g' && kShared[0].max === LIM.perIp,
    JSON.stringify(kShared));

  /* 公网对端 → per-IP 20 + 全局 120 */
  const kPub = buildKeys('w', { ip: '49.233.240.214' }, LIM);
  T('公网对端生成 per-IP 键且上限 20',
    kPub.some(k => k.k === 'w:ip:49.233.240.214' && k.max === 20), JSON.stringify(kPub));
  T('公网对端仍保留全局键（120）',
    kPub.some(k => k.k === 'w:g' && k.max === 120), JSON.stringify(kPub));

  /* 有身份 → 按身份 60 + 全局 120，且**不再**叠加 per-IP（身份更准） */
  const kId = buildKeys('w', { sub: '1184199020533149554', ip: '49.233.240.214' }, LIM);
  T('★ 有身份时按身份计（上限 60）',
    kId.some(k => k.k === 'w:id:1184199020533149554' && k.max === 60), JSON.stringify(kId));
  T('★ 有身份时不再叠加 per-IP', !kId.some(k => k.k.includes(':ip:')), JSON.stringify(kId));
  T('有身份时仍保留全局键', kId.some(k => k.k === 'w:g'), JSON.stringify(kId));

  /* 字符串入参要按 ip 处理，不能静默退化成"谁都不是" */
  const kStr = buildKeys('w', '49.233.240.214', LIM);
  T('字符串入参按 ip 处理', kStr.some(k => k.k === 'w:ip:49.233.240.214'), JSON.stringify(kStr));

  /* 防回归：绝不能有**读这个头**的代码 —— 一旦有人加回去，这条立刻红。
     ⚠ 只查「读请求头」的用法，不查注释里的文字：本文件与模块的注释里
       大量讨论 XFF（为什么不用它），用裸字符串匹配会假红。 */
  const HEAD_ACCESS = /headers\s*\[\s*['"]x-(forwarded-for|real-ip)['"]\s*\]/i;
  const src = readFileSync(fileURLToPath(new URL('../lib/ratelimit.mjs', import.meta.url)), 'utf8');
  T('★ 模块里没有读 XFF 的代码（不采信 XFF）', !HEAD_ACCESS.test(src));
  /* server.mjs 里也不该有 */
  const srv = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  T('★ server.mjs 里没有读 XFF 的代码', !HEAD_ACCESS.test(srv));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
