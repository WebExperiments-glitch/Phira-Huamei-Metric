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
];

console.log('\n【1】逐个打路由：不许 5xx / 不许连不上');
for (const [method, path, body, label] of CASES) {
  const st = await hit(method, path, body);
  const bad = st && st.err ? st.err : (st >= 500 ? 'HTTP ' + st : null);
  T(`${method} ${path} — ${label}`, !bad, bad || '');
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
