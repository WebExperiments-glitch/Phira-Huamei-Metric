/* ============================================================
 * tools/test-auth.mjs —— 认证门面单测（不联网、不起浏览器）
 * ============================================================
 * 直接 import public/js/auth.js 的真模块，用**假 fetch** 驱动。
 *
 * 【为什么这些断言值得存在】
 * 登录是安全面，而且它的故障**不报错**：
 *   · 按钮漏一次 `busy=false` → 永久禁用，用户只能刷新
 *   · 倒计时 setInterval 没清 → 60 秒后把别处按钮文案改掉
 *   · 网络故障被说成「密码错误」→ 用户反复改密码，越改越登不上
 *   · 邮箱大小写没规范化 → 输大写就登不进来
 *   · **token 放进 Authorization** → 托管网关吃掉它，线上每一步 401
 * 每一条都是「看起来是用户操作问题，其实是代码问题」。
 * ============================================================ */
import {
  normalizeEmail, isValidEmail, pwProblem, pwScore, PW_MIN,
  classifyAuthError, authErrorKey, createAuth,
} from '../public/js/auth.js';

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const G = s => console.log('\n【' + s + '】');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 假 fetch：按路径路由，并**记录每次请求**（用来断言请求头与 body） ── */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init) => {
    const rec = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body,
    };
    seen.push(rec);
    const path = rec.url.replace(/^https?:\/\/[^/]+/, '');
    const h = routes[path] || (() => ({ status: 404, json: { error: 'no_route' } }));
    const out = h(rec) || {};
    const status = out.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => out.json || {} };
  };
  impl.seen = seen;
  return impl;
}

/* 内存 storage（替代 localStorage） */
function memStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
}

/* ══════════ 1. 纯函数：邮箱 ══════════ */
G('1 · 邮箱规范化');
T('去掉首尾空白', normalizeEmail('  a@b.com  ') === 'a@b.com', normalizeEmail('  a@b.com  '));
T('转小写（服务端按小写查库）', normalizeEmail('A@B.COM') === 'a@b.com', normalizeEmail('A@B.COM'));
T('空值不炸', normalizeEmail(null) === '' && normalizeEmail(undefined) === '');
T('超长截断到 254', normalizeEmail('a'.repeat(300) + '@b.com').length === 254);
T('合法邮箱通过', isValidEmail('a@b.com') && isValidEmail('a.b+c@sub.example.com'));
T('无 @ 拒绝', !isValidEmail('abc.com'));
T('域名无点拒绝', !isValidEmail('a@localhost'));
T('含空格拒绝', !isValidEmail('a b@c.com'));

/* ══════════ 2. 密码策略 ══════════ */
G('2 · 密码策略');
T('短于下限被拒', pwProblem('a'.repeat(PW_MIN - 1)) === 'short');
T('正好下限 + 混合大小写通过', pwProblem('aBcdefghij') === '', pwProblem('aBcdefghij'));
T('纯小写被拒（10 个 a 也不行）', pwProblem('a'.repeat(PW_MIN)) === 'lower');
T('纯数字被拒', pwProblem('1234567890') === 'digits');
T('纯大写被拒', pwProblem('ABCDEFGHIJ') === 'upper');
T('空 / null 返回 short', pwProblem('') === 'short' && pwProblem(null) === 'short');
T('强度分 0..4', pwScore('') === 0 && pwScore('Abcdefghij1!') === 3 && pwScore('Abcdefghijkl1!') === 4,
  String(pwScore('Abcdefghij1!')));

/* ══════════ 3. 异常分类 ══════════ */
G('3 · 异常分类');
T('断网归 network', classifyAuthError(new Error('Failed to fetch')).kind === 'network');
T('429 归 rate-limited', classifyAuthError({ status: 429 }).kind === 'rate-limited');
T('401 归 invalid', classifyAuthError({ status: 401 }).kind === 'invalid');
T('过期归 expired', classifyAuthError({ status: 410 }).kind === 'expired');
T('冲突归 conflict', classifyAuthError({ status: 409 }).kind === 'conflict');
T('认不出来的归 unknown', classifyAuthError({ status: 500 }).kind === 'unknown');
/* ⚠ authErrorKey 只回**尾段**（调用方拼自己的前缀）。必须有两条断言：
   ① 正常 kind 原样透出 ② 带连字符的 kind 要变成 camelCase ——
   漏了 ② 的话 `app.auth.err.rate-limited` 与词条名对不上，
   症状是"操作太频繁"静默显示成"未知错误"。 */
T('kind → 词条尾段', authErrorKey('network') === 'network'
  && authErrorKey('unavailable') === 'unavailable'
  && authErrorKey('rate-limited') === 'rateLimited'
  && authErrorKey('weak-pw') === 'weakPw'
  && authErrorKey('没见过的') === 'unknown');

/* ══════════ 4. ★ token 必须走 x-hm-token ══════════ */
G('4 · ★ token 走 x-hm-token（不是 Authorization）');
{
  const ff = fakeFetch({
    '/api/hm/login': () => ({ json: { ok: true, sub: '1001', token: 'TKN-1' } }),
    '/api/hm/profile': () => ({ json: { ok: true, profile: null } }),
  });
  const auth = createAuth({ fetchImpl: ff, storage: memStore(), onChange: () => {} });
  await auth.signIn('a@b.com', 'Abcdefghij1!');
  await auth.readProfile();
  const profReq = ff.seen.find(r => r.url.indexOf('/api/hm/profile') >= 0);
  T('★ 带上了 x-hm-token', !!profReq && profReq.headers['x-hm-token'] === 'TKN-1',
    JSON.stringify(profReq && profReq.headers));
  T('★ 没有用 Authorization（托管网关会吃掉它）',
    !profReq || !profReq.headers.authorization, JSON.stringify(profReq && profReq.headers));
}

/* ══════════ 5. 登录成功 ══════════ */
G('5 · 登录');
{
  const store = memStore();
  let signedIn = null;
  const ff = fakeFetch({ '/api/hm/login': () => ({ json: { ok: true, sub: '1001', token: 'TKN-1' } }) });
  const auth = createAuth({
    fetchImpl: ff, storage: store, onChange: () => {},
    onSignedIn: u => { signedIn = u; },
  });
  const r = await auth.signIn('  A@B.com ', 'Abcdefghij1!');
  T('返回 ok', r.ok === true, JSON.stringify(r));
  T('状态 signed-in', auth.state.phase === 'signed-in', auth.state.phase);
  T('user.id 是 sub（与旧代码 user.id 兼容）',
    auth.state.user.id === '1001', JSON.stringify(auth.state.user));
  T('busy 已复位（按钮不会永久禁用）', auth.state.busy === false);
  T('★ token 落盘了', store.getItem('phm_hm_token') === 'TKN-1', String(store.getItem('phm_hm_token')));
  T('★ 邮箱规范化后才发给服务端',
    JSON.parse(ff.seen[0].body).email === 'a@b.com', JSON.parse(ff.seen[0].body).email);
  T('回调通知了登录用户', signedIn && signedIn.id === '1001');
}

/* ══════════ 6. 登录失败：错误分类 + 按钮复位 ══════════ */
G('6 · 登录失败');
{
  const cases = [
    [{ status: 401, json: { ok: false, error: 'bad_credentials' } }, 'invalid'],
    [{ status: 429, json: { ok: false, error: 'rate_limited' } }, 'rate-limited'],
    [{ status: 400, json: { ok: false, error: 'email_invalid' } }, 'invalid'],
    [{ status: 503, json: { ok: false, error: 'unavailable' } }, 'network'],
  ];
  for (const [resp, want] of cases) {
    const auth = createAuth({
      fetchImpl: fakeFetch({ '/api/hm/login': () => resp }),
      storage: memStore(), onChange: () => {},
    });
    const r = await auth.signIn('a@b.com', 'Abcdefghij1!');
    T(`status ${resp.status} → ${want}`,
      r.ok === false && auth.state.error && auth.state.error.kind === want,
      JSON.stringify(auth.state.error));
    T(`status ${resp.status} · busy 复位`, auth.state.busy === false);
    T(`status ${resp.status} · 没有误判成已登录`, auth.state.phase !== 'signed-in');
  }
}
{
  const auth = createAuth({
    fetchImpl: async () => { throw new Error('Failed to fetch'); },
    storage: memStore(), onChange: () => {},
  });
  const r = await auth.signIn('a@b.com', 'Abcdefghij1!');
  T('★ fetch 抛异常 → network（不是「密码错误」）',
    r.ok === false && auth.state.error.kind === 'network', JSON.stringify(auth.state.error));
  T('busy 依然复位', auth.state.busy === false);
}

/* ══════════ 7. 节流：同动作挡、不同动作不挡 ══════════ */
G('7 · 节流（按动作分键）');
{
  let logins = 0, codes = 0;
  const ff = fakeFetch({
    '/api/hm/login': () => { logins++; return { json: { ok: true, sub: '1', token: 't' } }; },
    '/api/hm/send-code': () => { codes++; return { json: { ok: true } }; },
  });
  const auth = createAuth({ fetchImpl: ff, storage: memStore(), onChange: () => {} });
  await auth.signIn('a@b.com', 'Abcdefghij1!');
  const second = await auth.signIn('a@b.com', 'Abcdefghij1!');
  T('同动作连点被挡', second.throttled === true, JSON.stringify(second));
  T('只发出一次登录请求', logins === 1, String(logins));
  /* ★ 注册是「先发码、再提交」两步，发码不该被上一个动作的节流牵连 */
  const codeRes = await auth.requestCode('b@b.com', 'register');
  T('★ 紧接着发码**不被**上一个动作挡住', codeRes.ok === true, JSON.stringify(codeRes));
  T('发码真的发出去了', codes === 1, String(codes));
}

/* ══════════ 8. 注册流程守卫 ══════════ */
G('8 · 注册流程');
{
  const auth = createAuth({
    fetchImpl: fakeFetch({ '/api/hm/register': () => ({ json: { ok: true, sub: '2', token: 't2' } }) }),
    storage: memStore(), onChange: () => {},
  });
  const r = await auth.signUp('a@b.com', '123456', 'Abcdefghij1!');
  T('没发过码 → 拒绝', r.ok === false);
  T('错误是「没有待验证的码」',
    auth.state.error && /pending/.test(String(auth.state.error.detail)),
    JSON.stringify(auth.state.error));
}
{
  let posts = 0;
  const ff = fakeFetch({
    '/api/hm/send-code': () => ({ json: { ok: true } }),
    '/api/hm/register': () => { posts++; return { json: { ok: true, sub: '2', token: 't2' } }; },
  });
  const auth = createAuth({ fetchImpl: ff, storage: memStore(), onChange: () => {} });
  await auth.requestCode('a@b.com', 'register');
  T('发码后进入 awaiting-code', auth.state.phase === 'awaiting-code', auth.state.phase);
  T('倒计时启动', auth.state.resendIn > 0, String(auth.state.resendIn));

  const weak = await auth.signUp('a@b.com', '123456', 'short');
  T('★ 弱密码本地挡住（不白发请求）', weak.ok === false && posts === 0,
    JSON.stringify(auth.state.error) + ' posts=' + posts);

  const ok1 = await auth.signUp('a@b.com', '123456', 'Abcdefghij1!');
  T('注册成功', ok1.ok === true, JSON.stringify(ok1));
  T('注册后 signed-in', auth.state.phase === 'signed-in', auth.state.phase);
  T('pending 被清掉（码不能复用）', auth.state.pending === null);
  T('token 落盘', auth.state.token === 't2');
}
{
  const auth = createAuth({
    fetchImpl: fakeFetch({ '/api/hm/send-code': () => ({ json: { ok: true } }) }),
    storage: memStore(), onChange: () => {},
  });
  await auth.requestCode('a@b.com', 'register');
  const r = await auth.signUp('other@b.com', '123456', 'Abcdefghij1!');
  T('★ 邮箱被改过 → 拒绝（不能拿 A 的码给 B 注册）', r.ok === false, JSON.stringify(auth.state.error));
}

/* ══════════ 9. 倒计时一定被清掉 ══════════ */
G('9 · 倒计时清理');
{
  const auth = createAuth({
    fetchImpl: fakeFetch({ '/api/hm/send-code': () => ({ json: { ok: true } }) }),
    storage: memStore(), onChange: () => {},
  });
  await auth.requestCode('a@b.com', 'register');
  T('倒计时在跑', auth.state.resendIn > 0);
  auth.setMode('login');
  T('切 tab 后归零', auth.state.resendIn === 0, String(auth.state.resendIn));
  await sleep(1200);
  T('过了一秒多仍然归零（timer 真停了）', auth.state.resendIn === 0, String(auth.state.resendIn));
  auth.destroy();
  T('destroy 不抛异常', true);
}

/* ══════════ 10. 找回密码 ══════════ */
G('10 · 找回密码');
{
  const ff = fakeFetch({
    '/api/hm/send-code': () => ({ json: { ok: true } }),
    '/api/hm/reset-password': () => ({ json: { ok: true, sub: '3' } }),
  });
  const auth = createAuth({ fetchImpl: ff, storage: memStore(), onChange: () => {} });
  const r1 = await auth.requestReset('a@b.com');
  T('第一步发重置码', r1.ok === true, JSON.stringify(r1));
  T('★ purpose 是 reset', JSON.parse(ff.seen[0].body).purpose === 'reset', String(ff.seen[0].body));
  const r2 = await auth.confirmReset('a@b.com', '123456', 'Abcdefghij1!');
  T('第二步提交新密码', r2.ok === true, JSON.stringify(r2));
  T('★ 重置后**不直接发凭据**（要用户重新登录）',
    r2.needSignIn === true && auth.state.phase === 'idle', auth.state.phase);
}

/* ══════════ 11. 退出登录 ══════════ */
G('11 · 退出登录');
{
  const store = memStore();
  let out = 0;
  const auth = createAuth({
    fetchImpl: fakeFetch({ '/api/hm/login': () => ({ json: { ok: true, sub: '1', token: 't' } }) }),
    storage: store, onChange: () => {}, onSignedOut: () => { out++; },
  });
  await auth.signIn('a@b.com', 'Abcdefghij1!');
  await auth.signOut();
  T('状态回 idle', auth.state.phase === 'idle', auth.state.phase);
  T('user 清空', auth.state.user === null);
  T('★ token 从存储里删掉了', store.getItem('phm_hm_token') === null);
  T('回调通知了', out === 1);
}

/* ══════════ 12. 会话恢复 ══════════ */
G('12 · 会话恢复');
{
  const store = memStore();
  store.setItem('phm_hm_token', 'OLD');
  const auth = createAuth({
    fetchImpl: fakeFetch({
      '/api/hm/profile': () => ({ json: { ok: true, sub: '9', profile: { visits: 3 } } }),
    }),
    storage: store, onChange: () => {},
  });
  const r = await auth.ready;
  T('有 token → 恢复成功', r.ok === true, JSON.stringify(r));
  T('phase=signed-in', auth.state.phase === 'signed-in', auth.state.phase);
  T('拿到了 profile', r.profile && r.profile.visits === 3);
}
{
  const store = memStore();
  store.setItem('phm_hm_token', 'EXPIRED');
  const auth = createAuth({
    fetchImpl: fakeFetch({
      '/api/hm/profile': () => ({ status: 401, json: { ok: false, error: 'token_invalid' } }),
    }),
    storage: store, onChange: () => {},
  });
  const r = await auth.ready;
  T('token 失效 → 恢复失败', r.ok === false);
  T('★ 失效的 token 被清掉（不会反复拿它重试）', store.getItem('phm_hm_token') === null);
  T('phase 回 idle', auth.state.phase === 'idle', auth.state.phase);
}
{
  /* 网络故障**不该**清 token —— 那会让用户「被登出」，下次还得重登 */
  const store = memStore();
  store.setItem('phm_hm_token', 'KEEP');
  const auth = createAuth({
    fetchImpl: async () => { throw new Error('Failed to fetch'); },
    storage: store, onChange: () => {},
  });
  await auth.ready;
  T('★ 网络故障时保留 token（不是登出）', store.getItem('phm_hm_token') === 'KEEP',
    String(store.getItem('phm_hm_token')));
}
{
  const auth = createAuth({ fetchImpl: fakeFetch({}), storage: memStore(), onChange: () => {} });
  await auth.ready;
  T('没有 token → idle，不报错', auth.state.phase === 'idle' && auth.state.error === null);
}

console.log('\n────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
