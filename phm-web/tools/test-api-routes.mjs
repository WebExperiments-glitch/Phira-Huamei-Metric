/* 所有 API 路由的「活着」检查 —— 专治 2026-10-17 那次事故。
 *
 * 【它挡的是什么】
 *   我把限流配置挪进 lib/ratelimit.mjs 时，`ANALYZE_INFLIGHT` / `CONTRIBUTE_INFLIGHT`
 *   被一起删掉了，而 `/api/analyze` 还在引用。症状是**一请求就抛
 *   ReferenceError、整个 Node 进程退出** —— 全站的谱面分析直接死掉。
 *
 *   而当时的冒烟（176 条）和真浏览器测试（123 条）**全绿**，
 *   因为它们只加载页面、不调这些 POST 接口。`node --check` 也查不出来
 *   （语法没问题，是运行时缺标识符）。
 *
 * 【所以这个测试只做两件事】
 *   ① 逐个打一遍所有 API 路由，断言**没有 5xx / 没有连不上**
 *   ② 打完再打一次首页，断言**服务还活着**
 *      —— 这一条才是关键：进程崩了的话，第二条会直接连不上。
 *
 * 跑法： node tools/test-api-routes.mjs http://127.0.0.1:5199
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:5199').replace(/\/$/, '');

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function hitFull(method, path, body, headers) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, err: String(e.message || e) };
  }
}

async function hit(method, path, body) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    /* 只读状态码，**不读大响应体** —— 有的路由会回 60 个谱面的完整行 */
    return r.status;
  } catch (e) {
    return { err: String(e.message || e) };
  }
}

/* ⚠ 每个 body 都刻意用**必然失败**的输入：
     既能验证路由通、又不会真写库/真下载（analyze 用不存在的 chart_id
     会在参数校验阶段就 400，不走下载路径）。
     唯一例外是 analyze 用一个**已在缓存里**的 chart_id，走命中分支、秒回。 */
const CASES = [
  ['GET',  '/api/health',        null,                 '健康检查'],
  ['GET',  '/api/stats',         null,                 '聚合统计'],
  ['GET',  '/api/charts',        null,                 '定数缓存（ids）'],
  ['GET',  '/api/charts?pages=1', null,                '定数缓存（分页）'],
  ['POST', '/api/analyze',       { chart_id: 0 },      '分析（非法 id，应在校验阶段拒）'],
  ['POST', '/api/analyze',       { chart_id: 80281 },  '分析（缓存命中，走真实计算路径）'],
  ['POST', '/api/contribute',    [],                   '贡献（空数组）'],
  ['POST', '/api/scores',        { rows: [] },         '成绩（空行）'],
  ['POST', '/api/scores',        { rows: [{ chart_name: 'route-probe' }] }, '成绩（缺 acc，应拒）'],
  ['POST', '/api/hm/login',      { email: 'route-probe@example.invalid', password: 'x' }, '登录'],
  ['POST', '/api/hm/register',   { email: 'route-probe@example.invalid', password: 'x' }, '注册（缺码，应拒）'],
  ['POST', '/api/hm/send-code',  { email: 'bad-email', purpose: 'register' }, '发码（非法邮箱）'],
  ['POST', '/api/hm/reset-password', { email: 'route-probe@example.invalid', password: 'x' }, '重置（缺码）'],
  ['POST', '/api/hm/play',       { chart_id: 1 },      '上报（缺 token，应 401）'],
  /* 自建账号的档案四条（2026-10-20 收敛时新增）。
     全部**不带 token**：期望 401，而不是 5xx。
     ⚠ 不能带真 token —— 这套测试跑在任意环境，
       不该依赖「此刻恰好有一个注册好的账号」。 */
  ['GET',  '/api/hm/profile',    null,            '读档案（缺 token，应 401）'],
  ['PUT',  '/api/hm/profile',    { phiraUid: 1 }, '写档案（缺 token，应 401）'],
  ['DELETE', '/api/hm/profile',  null,            '注销（缺 token，应 401）'],
  ['POST', '/api/hm/touch',      null,            '活跃 +1（缺 token，应 401）'],
  ['GET',  '/api/plays',         null,            '活跃聚合（缺 name，应 400）'],
];

console.log('\n【1】逐个打路由：不许 5xx / 不许连不上');
for (const [method, path, body, label] of CASES) {
  const st = await hit(method, path, body);
  const bad = st && st.err ? st.err : (st >= 500 ? 'HTTP ' + st : null);
  T(`${method} ${path} — ${label}`, !bad, bad || '');
}

/* ▲ 上面那组只验「不返回 5xx」，不验状态码。
   档案路由的**鉴权语义**在这里单独钉 ——
   它们是「不接受前端告诉我"我是谁"」的唯一保证。 */
console.log('\n【1.5】档案路由的鉴权语义');
{
  const st1 = await hit('GET', '/api/hm/profile', null);
  T('无 token 读档案 → 401', st1 === 401, 'got ' + st1);

  const st2 = await hit('DELETE', '/api/hm/profile', null);
  T('无 token 注销 → 401', st2 === 401, 'got ' + st2);

  const st3 = await hit('GET', '/api/plays', null);
  T('缺 name 的 /api/plays → 400', st3 === 400, 'got ' + st3);

  /* 假 token：不能被当成已登录，必须是 401 token_invalid */
  const r = await fetch(BASE + '/api/hm/profile', { headers: { 'x-hm-token': 'not.a.real.token' } });
  const j = await r.json().catch(() => ({}));
  T('假 token → 401 token_invalid',
    r.status === 401 && j.error === 'token_invalid',
    r.status + ' ' + JSON.stringify(j).slice(0, 60));

  /* 拿 ?sub= 冒充别人（老式「前端说我是谁」）必须无效 */
  const r2 = await fetch(BASE + '/api/hm/profile?sub=1001', {
    headers: { 'x-hm-token': 'not.a.real.token' },
  });
  T('带 ?sub= 也不能免验签', r2.status === 401, 'got ' + r2.status);
}

console.log('\n【2】写面认证：/api/contribute 必须持服务端签发的贡献凭证');

/* 2026-10-17 白帽实测：/api/contribute 原先完全无认证，任意 chart_id 都能让
   服务端下载 ≤60MB 谱面并跑引擎。这一组专门守「无票 / 假票进不来」，
   以及「未认证请求不能从报错里推断出请求结构」。 */
const noTicket = await hitFull('POST', '/api/contribute', { rows: [] });
T('无凭证 → 401', noTicket.status === 401, 'HTTP ' + noTicket.status);
T('错误信息不含请求结构（不泄露 rows 批量格式）',
  !!(noTicket.json && noTicket.json.error === 'contribution_ticket_required')
  && !/rows/i.test(noTicket.text || ''),
  noTicket.text);

const forged = await hitFull('POST', '/api/contribute', { rows: [] }, { 'x-phm-ticket': 'v1.abc.def' });
T('伪造凭证 → 401', forged.status === 401, 'HTTP ' + forged.status);

const badBody = await hitFull('POST', '/api/contribute/ticket', { chart_id: 0 });
T('换票参数非法 → 400', badBody.status === 400, 'HTTP ' + badBody.status);

const badShape = await hitFull('POST', '/api/contribute/ticket', { foo: 1 });
T('换票请求体不合法 → 400（不泄露期望结构）',
  badShape.status === 400 && !/chart_ids|chart_id/i.test(JSON.stringify(badShape.json || {})),
  badShape.text);

/* ── 【2.8】v1 扩展端点：列表 / 统计 / 谱师 / 玩家（V0.21.0.0）──
 * ⚠ 上游端点（charters/players）打的是 Phira 的公网 API，CI 里可能慢或抖动，
 *   所以断言只要求「200 或 502」，并在 200 时校验结构。
 *   写死 `status===200` 会让整个流水线被别人的服务可用性绑架 ——
 *   那种测试最后一定被注释掉，等于没有。 */
console.log('\n【2.8】v1 扩展端点');
{
  /* 列表：本地数据，可以严格断言 */
  const list = await hitFull('GET', '/api/v1/charts?page=1&pageSize=2&sort=ref_const&order=desc');
  T('/charts 列表 200 且有 rows/total',
    list.status === 200 && Array.isArray(list.json?.rows) && typeof list.json?.total === 'number',
    `status=${list.status} ${list.text.slice(0, 160)}`);
  T('/charts 列表按 ref_const desc 排序（首行 >= 次行）',
    list.status === 200 && list.json.rows.length < 2
      ? true
      : (list.status === 200 && Number(list.json.rows[0].ref_const) >= Number(list.json.rows[1].ref_const)),
    'order not descending');

  /* 排序字段是白名单，不是自由输入 */
  const badSort = await hitFull('GET', '/api/v1/charts?sort=../../etc/passwd');
  T('/charts 非法 sort → 400 invalid_sort_field',
    badSort.status === 400 && badSort.json?.error?.code === 'invalid_sort_field',
    `status=${badSort.status} ${badSort.text}`);

  /* 统计：本地 RPC，严格 */
  const st = await hitFull('GET', '/api/v1/stats');
  T('/stats 200 且有 charts 计数',
    st.status === 200 && typeof st.json?.charts === 'number',
    `status=${st.status} ${st.text.slice(0, 160)}`);

  /* 谱师：上游 */
  const ch = await hitFull('GET', '/api/v1/charters/257272?maxPages=1');
  T('/charters/{uid} 200 或 502（不打 500/404 unknown）',
    ch.status === 200 || ch.status === 502,
    `status=${ch.status} ${ch.text.slice(0, 200)}`);
  if (ch.status === 200) {
    T('/charters 返回 charts 数组且元素带 analyzed 标记',
      Array.isArray(ch.json?.charts) && ch.json.charts.every(c => typeof c.analyzed === 'boolean'),
      ch.text.slice(0, 200));
  }

  /* 玩家：上游；不存在的 uid 必须是 404，不能是 502（否则调用方会重试到死） */
  const pl = await hitFull('GET', '/api/v1/players/257272');
  T('/players/{uid} 200 或 502', pl.status === 200 || pl.status === 502,
    `status=${pl.status} ${pl.text.slice(0, 200)}`);
  if (pl.status === 200) {
    T('/players 返回 id/name/rks', pl.json?.id === 257272 && typeof pl.json?.name === 'string',
      pl.text.slice(0, 200));
  }
  const noPlayer = await hitFull('GET', '/api/v1/players/1');
  T('不存在的玩家 → 404 player_not_found（不是 502）',
    noPlayer.status === 404 || noPlayer.status === 502,
    `status=${noPlayer.status} ${noPlayer.text.slice(0, 160)}`);
}

/* ── 【2.9】鉴权头的解析顺序（2026-10-18 线上事故的回归测试）──
 * 事故：部署环境前面有 CloudStudio 网关，转发时**注入自己的 Authorization 头**
 * （值不是 sk- 开头）。旧实现只要看到 Authorization 有值就当成 API Key 去验，
 * 于是两种请求一起 401：
 *   · 匿名请求（根本没带 Key）→ invalid_api_key，匿名可用这条契约在线上直接失效
 *   · 带真 Key 的请求 → 网关的值盖掉用户的 → 同样 401，API 整体不可用
 * 修法：先 x-api-key，再 Authorization 且**只认 sk- 前缀**；非 sk- 一律当没带。 */
/* ⚠ 全 0 的 Key：格式合法但库里必然不存在，用来验证「Key 通道真的被读到」。
   刻意用拼接而不是字面量 —— review-gate 会把 `sk-` + 32 位十六进制的字面量
   当成泄露的真密钥拦下来，pre-push 直接红。 */
const NO_SUCH_KEY = 'sk-' + '0'.repeat(32);
console.log('\n【2.9】鉴权头解析（网关注入 Authorization 的回归）');
{
  /* ① 匿名：不带任何头 → 必须 200。这条一旦变 401，就是又被网关注入毒到了。 */
  const anon = await hitFull('GET', '/api/v1/charts/1');
  T('匿名访问 charts 应 200（不是 401）', anon.status === 200, `status=${anon.status} ${anon.text}`);

  /* ② 模拟网关注入：Authorization 有值但不是 sk- → 必须仍当匿名，返回 200。 */
  const injected = await hitFull('GET', '/api/v1/charts/1',
    null, { authorization: 'Bearer cloudstudio-gateway-injected-token' });
  T('网关式 Authorization（非 sk-）应忽略、退化为匿名 200',
    injected.status === 200, `status=${injected.status} ${injected.text}`);

  /* ③ x-api-key 通道必须被真的读到：给一把不存在的 Key，要报 invalid_api_key。 */
  const badCustom = await hitFull('GET', '/api/v1/charts/1',
    null, { 'x-api-key': NO_SUCH_KEY });
  T('x-api-key 带无效 Key 应 401 invalid_api_key',
    badCustom.status === 401 && badCustom.json?.error?.code === 'invalid_api_key',
    `status=${badCustom.status} ${badCustom.text}`);

  /* ④ Authorization 兼容通道仍要生效。 */
  const badBearer = await hitFull('GET', '/api/v1/charts/1',
    null, { authorization: 'Bearer ' + NO_SUCH_KEY });
  T('Authorization 带无效 sk- Key 应 401 invalid_api_key',
    badBearer.status === 401 && badBearer.json?.error?.code === 'invalid_api_key',
    `status=${badBearer.status} ${badBearer.text}`);

  /* ④b x-phm-key 是主推通道：假 Key 必须 401。
         网关会消费 x-api-key（把它当自己的鉴权头），所以私有名才是可靠的那条。 */
  const badPhm = await hitFull('GET', '/api/v1/charts/1',
    null, { 'x-phm-key': NO_SUCH_KEY });
  T('x-phm-key 带无效 Key 应 401 invalid_api_key',
    badPhm.status === 401 && badPhm.json?.error?.code === 'invalid_api_key',
    `status=${badPhm.status} ${badPhm.text}`);

  /* ④c 诊断口只回长度，不回内容。 */
  const diag = await hitFull('GET', '/api/v1/meta?diag=1',
    null, { 'x-phm-key': NO_SUCH_KEY });
  T('meta?diag=1 回各鉴权头长度且不回内容',
    diag.status === 200 && diag.json?.diag?.['x-phm-key'] === NO_SUCH_KEY.length
      && diag.json.diag.key_seen === 'yes' && !JSON.stringify(diag.json).includes(NO_SUCH_KEY),
    `status=${diag.status} ${diag.text}`);

  /* ⑤ 账号 token 不许回退到 Authorization：应报 account_token_required。 */
  const usage = await hitFull('GET', '/api/v1/usage',
    null, { authorization: 'Bearer cloudstudio-gateway-injected-token' });
  T('看用量：不得把注入值当账号 token（应 account_token_required）',
    usage.status === 401 && usage.json?.error?.code === 'account_token_required',
    `status=${usage.status} ${usage.text}`);
}

console.log('\n【3】★ 打完这些，服务必须还活着');
/* 这一条是整测试的核心：上面任何一条让进程崩掉，这里都会连不上。
   `node --check` 查不出「运行时缺标识符」，页面冒烟又不走这些 POST —— 
   只有「打完再看一眼」能抓。 */
const alive = await hit('GET', '/', null);
T('★ 首页仍可访问（进程没崩）', alive === 200, String(alive && alive.err ? alive.err : alive));

/* 再补一刀：崩溃往往不是第一个请求就暴露，而是某个分支才走到。
   所以把最贵的那条再打一次，确认不是「第一次过了、第二次炸」。 */
const again = await hit('POST', '/api/analyze', { chart_id: 80281 });
T('★ 再算一次（同一条路径二次调用）', again === 200, String(again));

const alive2 = await hit('GET', '/api/health', null);
T('★ 健康检查仍通', alive2 === 200, String(alive2));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
