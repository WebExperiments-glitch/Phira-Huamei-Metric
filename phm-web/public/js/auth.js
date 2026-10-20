/* ============================================================
 * js/auth.js —— 登录/注册/找回密码的**统一门面**（解耦）
 * ============================================================
 * 【为什么抽出来】
 *   这套逻辑原来内联在 app.html 里约 150 行，settings.html 又另写一份
 *   「读会话 + 退出」。两份实现必然漂移，而症状极难查：
 *   「/app 显示已登录、/settings 显示未登录」。
 *   （lint-slop 的「重复函数定义」按名字判，曾经真的抓到过一次。）
 *
 * 【这里管什么】
 *   ① 状态机：idle → submitting → awaiting-code → signed-in
 *      **按钮禁用由状态驱动**，不是调用方到处写 `btn.disabled = false`
 *      （漏一处处按钮就永久禁用，这是最烦人的一类 bug）。
 *   ② 错误分类：把 SDK 的各种失败归成有限的几种
 *      （网络 / 凭证错 / 被限流 / 会话过期 / 未知），
 *      调用方只要按 kind 翻文案，不用去猜 error.message 里写了什么。
 *   ③ 节流：同一动作 800ms 内不重复触发（连点提交按钮）。
 *   ④ 倒计时：验证码重发间隔由这里管，切走/重置时**一定清掉** ——
 *      原来的 setInterval 没人清，60 秒后会把别处的按钮文案改掉。
 *   ⑤ 邮箱规范化：trim + 小写（SDK 侧大小写敏感，用户输大写就登不进来）。
 *
 * 【不碰 i18n】
 *   和 cloud.js 一样：错误文案由调用方翻，这里只给 kind 与可读的英文 detail。
 *   （settings.js 的循环依赖约束同样适用于这里。）
 * ============================================================ */

/** 节流窗口：短于这个间隔的重复调用直接忽略。 */
const THROTTLE_MS = 800;
/** 验证码重发间隔（秒）。 */
const RESEND_SEC = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 纯函数：邮箱规范化 ──
 * 只做「trim + 小写」。⚠ 不做 Gmail 的点号折叠：
 * 那会改变用户实际拥有的地址（`a.b@gmail.com` 与 `ab@gmail.com`
 * 在 Gmail 是同一个，但不是所有服务商都这样），猜错比不猜糟。 */
export function normalizeEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().slice(0, 254);
}

/** 邮箱格式（宽松但够用：拒绝明显不是邮箱的东西，不做 RFC 5322 全套）。 */
export function isValidEmail(raw) {
  const e = normalizeEmail(raw);
  return /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(e) && /\./.test(e.split('@')[1]);
}

/* ── 纯函数：密码策略 ──
 * ⚠ 登录路径**不走这里**：老账号可能是 6 位密码，登录时必须放行。
 *    只在「设置新密码」时用（注册 / 重置 / 改密）。
 * 返回空串 = 通过，否则返回给用户看的原因（调用方翻译）。 */
export const PW_MIN = 10;
export function pwProblem(pw) {
  const p = String(pw == null ? '' : pw);
  if (p.length < PW_MIN) return 'short';
  if (/^\d+$/.test(p)) return 'digits';
  if (/^[a-z]+$/.test(p)) return 'lower';
  if (/^[A-Z]+$/.test(p)) return 'upper';
  return '';
}

/** 密码强度 0–4，只用于「实时提示」，不用于拦截。
 *  ⚠ 强度提示与策略是两件事：策略是硬门槛，强度是劝告。
 *    混在一起会让用户以为「不够强就不让注册」，其实只是提醒。 */
export function pwScore(pw) {
  const p = String(pw == null ? '' : pw);
  if (!p) return 0;
  let s = 0;
  if (p.length >= PW_MIN) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^\w\s]/.test(p)) s++;
  return Math.min(4, s);
}

/* ── 纯函数：错误分类 ──
 * SDK 的错误信息是不可依赖的（版本一变文案就变，且常是英文长句）。
 * 所以这里**只认有限几个稳定信号**，认不出来的归 unknown ——
 * 宁可说"未知错误"，也不要把网络故障说成"密码错误"（那会让人反复改密码）。
 *
 * kind 取值：
 *   'network'      fetch 本身失败（断网 / DNS / 超时）
 *   'invalid'      凭证或验证码不对
 *   'rate-limited' 被限流（登录/发码太频繁）
 *   'expired'      会话或验证码过期
 *   'conflict'     邮箱已被注册 / 已被绑定
 *   'weak-pw'      密码不合策略（本地就挡住，不该到这里）
 *   'unknown'      其它 */
export function classifyAuthError(err, ctx) {
  const c = ctx || {};
  const raw = err && typeof err === 'object'
    ? (err.message || err.error_description || err.code || err.status || '')
    : String(err == null ? '' : err);
  const m = String(raw).toLowerCase();

  /* 网络层：没有任何 HTTP 状态，纯连接失败 */
  if (/failed to fetch|networkerror|network request failed|load failed|timeout|econn|enotfound/i.test(m)) {
    return { kind: 'network', detail: m.slice(0, 120) };
  }
  const status = Number(err && (err.status || err.statusCode)) || 0;
  if (status === 429 || /too many|rate.?limit|throttl/i.test(m)) {
    return { kind: 'rate-limited', detail: m.slice(0, 120) };
  }
  if (status === 401 || /invalid|incorrect|wrong|unauthor|bad credentials|not.*match/i.test(m)) {
    return { kind: 'invalid', detail: m.slice(0, 120) };
  }
  if (status === 410 || /expired|expire|stale/i.test(m)) {
    return { kind: 'expired', detail: m.slice(0, 120) };
  }
  if (status === 409 || /already|exist|taken|conflict|registered|bound/i.test(m)) {
    return { kind: 'conflict', detail: m.slice(0, 120) };
  }
  /* 注册时密码不合规：SDK 的措辞不统一，按上下文兜底判断 */
  if (c.settingPassword && /password/i.test(m)) return { kind: 'weak-pw', detail: m.slice(0, 120) };
  return { kind: 'unknown', detail: m.slice(0, 120) };
}

/** 把 SDK 的 `{ error }` 返回形状拍平成 classifyAuthError 的输入。 */
function errOf(res, ctx) {
  if (res && res.error) return classifyAuthError(res.error, ctx);
  return null;
}

/* ══════════════════════════════════════════════════════════════
 * 工厂：自建账号认证门面
 * ══════════════════════════════════════════════════════════════
 * 【为什么不再用云 SDK】
 *   平台 token 是 HS256、密钥在平台手里 —— 服务端只能解析不能验签，
 *   等于任何人都能手搓一个 JWT 把 sub 写成别人的。自建 token 的密钥只在服务端。
 *   这不是取舍，是安全边界。
 *
 * 【⚠ 一条不能忘的实现约束】
 *   **token 必须走 `x-hm-token` 头，不能用 `Authorization`。**
 *   托管网关会吃掉/改掉入站的 Authorization（它自己要用）——
 *   这个坑在 /api/hm/play 上真实踩过：本机全绿、线上每一步 401。
 *
 * @param {object} opts
 *   fetchImpl  可注入（测试用），默认全局 fetch
 *   baseUrl    前缀，默认 ''
 *   storage    可注入（测试用），默认 localStorage
 *   onChange(state) / onSignedIn(user) / onSignedOut()
 * ============================================================ */
export function createAuth(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const base = o.baseUrl || '';
  const storage = o.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : o.storage;
  const onChange = o.onChange;
  const onSignedIn = o.onSignedIn;
  const onSignedOut = o.onSignedOut;
  const tokenKey = o.tokenKey || 'phm_hm_token';

  const state = {
    phase: 'idle',          /* idle | submitting | awaiting-code | signed-in */
    user: null,             /* { id: sub, email } —— id 与原来的 user.id 兼容 */
    email: '',
    mode: 'login',          /* login | signup | reset */
    pending: null,          /* { email } —— 自建的验证码服务端自己记，前端只留邮箱 */
    error: null,            /* { kind, detail } */
    busy: false,
    resendIn: 0,
    token: null,
    offline: false,         /* 有 token 但读不到状态（网络/5xx）—— 与"未登录"必须分开 */
  };

  let _timer = null;
  const _lastAt = Object.create(null);

  function notify() { if (onChange) { try { onChange(state); } catch (e) {} } }
  function setError(e) { state.error = e; }
  function clearError() { state.error = null; }
  function throttleOf(action) {
    const now = Date.now();
    const last = _lastAt[action] || 0;
    if (now - last < THROTTLE_MS) return false;
    _lastAt[action] = now;
    return true;
  }
  function stopTimer() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    state.resendIn = 0;
  }
  function saveToken(t) {
    state.token = t || null;
    try { if (storage && t) storage.setItem(tokenKey, t); else if (storage) storage.removeItem(tokenKey); } catch (e) {}
  }
  function loadToken() {
    try { return storage ? storage.getItem(tokenKey) : null; } catch (e) { return null; }
  }

  /** 发一个请求。返回 `{ok, status, data}`；网络异常归 kind='network'。 */
  async function call(path, init) {
    const i = init || {};
    const headers = { 'content-type': 'application/json' };
    if (i.token) headers['x-hm-token'] = i.token;   /* ⚠ 不是 Authorization */
    let r;
    try {
      r = await fetchImpl(base + path, {
        method: i.method || 'GET',
        headers,
        body: i.body === undefined ? undefined : JSON.stringify(i.body),
        cache: 'no-cache',
      });
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'network', detail: String(e && e.message || e) } };
    }
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data: data || {} };
  }

  /** 把服务端的 `{error}` 码映射成有限几种 kind。
   *  ⚠ 这张表是**唯一**的错误语义来源 —— 别在调用方再猜 status。 */
  function errKind(res) {
    const code = String((res.data && res.data.error) || '');
    const status = res.status;
    if (!status || code === 'network') return 'network';
    if (status === 429) return 'rate-limited';
    if (code === 'email_invalid' || code === 'password_invalid' || code === 'bad_uid') return 'invalid';
    if (code === 'email_taken') return 'conflict';
    if (code === 'code_expired' || code === 'code_used' || code === 'token_invalid' || code === 'token_required') return 'expired';
    if (code === 'code_missing' || code === 'code_wrong' || code === 'code_invalid'
      || code === 'bad_credentials') return 'invalid';
    if (code === 'code_too_many') return 'rate-limited';
    if (status === 503 || code === 'unavailable' || code === 'store_failed') return 'network';
    if (status === 401) return 'invalid';
    return 'unknown';
  }

  async function runAction(fn) {
    state.busy = true;
    clearError();
    notify();
    try {
      return await fn();
    } catch (e) {
      setError(classifyAuthError(e));
      return { ok: false };
    } finally {
      state.busy = false;
      notify();
    }
  }

  function startResendCountdown() {
    stopTimer();
    state.resendIn = RESEND_SEC;
    notify();
    _timer = setInterval(() => {
      state.resendIn -= 1;
      if (state.resendIn <= 0) stopTimer();
      notify();
    }, 1000);
  }

  function adopt(sub, email, token) {
    state.user = { id: String(sub), email: email || state.email || null };
    state.phase = 'signed-in';
    stopTimer();
    if (token) saveToken(token);
    notify();
    if (onSignedIn) { try { Promise.resolve(onSignedIn(state.user)).catch(() => {}); } catch (e) {} }
  }

  /* ── 对外动作 ── */

  function setMode(mode) {
    state.mode = mode;
    state.pending = null;
    stopTimer();
    clearError();
    notify();
  }

  /** 发验证码。purpose: 'register' | 'reset' */
  async function requestCode(emailRaw, purpose) {
    if (!throttleOf('code')) return { ok: false, throttled: true };
    const email = normalizeEmail(emailRaw);
    if (!isValidEmail(email)) {
      setError({ kind: 'invalid', detail: 'email' });
      notify();
      return { ok: false };
    }
    state.email = email;
    return runAction(async () => {
      const res = await call('/api/hm/send-code', {
        method: 'POST',
        body: { email, purpose: purpose === 'reset' ? 'reset' : 'register' },
      });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      state.pending = { email };
      state.phase = 'awaiting-code';
      startResendCountdown();
      return { ok: true };
    });
  }

  async function signIn(emailRaw, password) {
    const email = normalizeEmail(emailRaw);
    /* ⚠ 节流放在**本地校验之后**：本地就能判死的输入不该消耗窗口 ——
       否则用户输错 → 改对 → 再点，被 800ms 挡住，表现是「点了没反应」。
       只有真的要发请求时才算一次尝试。 */
    if (!email || !password) {
      setError({ kind: 'invalid', detail: 'missing' });
      notify();
      return { ok: false };
    }
    if (!throttleOf('signIn')) return { ok: false, throttled: true };
    state.email = email;
    return runAction(async () => {
      const res = await call('/api/hm/login', { method: 'POST', body: { email, password } });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      adopt(res.data && res.data.sub, email, res.data && res.data.token);
      return { ok: true };
    });
  }

  async function signUp(emailRaw, code, password) {
    const email = normalizeEmail(emailRaw);
    if (!state.pending || state.pending.email !== email) {
      setError({ kind: 'invalid', detail: 'no pending code' });
      notify();
      return { ok: false };
    }
    const prob = pwProblem(password);
    if (prob) {
      setError({ kind: 'weak-pw', detail: prob });
      notify();
      return { ok: false };
    }
    /* ⚠ 同上：弱密码、没发码这些本地就能判的，不该吃掉节流窗口 */
    if (!throttleOf('signUp')) return { ok: false, throttled: true };
    return runAction(async () => {
      const res = await call('/api/hm/register', {
        method: 'POST',
        body: { email, password, code: String(code || '').trim() },
      });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      state.pending = null;
      adopt(res.data && res.data.sub, email, res.data && res.data.token);
      return { ok: true };
    });
  }

  /** 找回密码第一步：发重置码。 */
  async function requestReset(emailRaw) {
    /* ⚠ 与 requestCode 共用「发码」动作的节流键 —— 同一个人连点两个按钮
       也只该发一封。 */
    return requestCode(emailRaw, 'reset');
  }

  /** 找回密码第二步：提交新密码。 */
  async function confirmReset(emailRaw, code, password) {
    const email = normalizeEmail(emailRaw);
    if (!isValidEmail(email)) {
      setError({ kind: 'invalid', detail: 'email' });
      notify();
      return { ok: false };
    }
    const prob = pwProblem(password);
    if (prob) {
      setError({ kind: 'weak-pw', detail: prob });
      notify();
      return { ok: false };
    }
    if (!throttleOf('reset')) return { ok: false, throttled: true };
    state.email = email;
    return runAction(async () => {
      const res = await call('/api/hm/reset-password', {
        method: 'POST',
        body: { email, password, code: String(code || '').trim() },
      });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      /* ⚠ 重置接口只回 sub，不回 token（不该凭"改密码成功"直接发凭据）。
         所以这里让用户用新密码登录一次 —— 多一步，但语义干净。 */
      state.phase = 'idle';
      state.pending = null;
      return { ok: true, needSignIn: true };
    });
  }

  async function signOut() {
    saveToken(null);
    state.user = null;
    state.phase = 'idle';
    state.pending = null;
    stopTimer();
    notify();
    if (onSignedOut) { try { onSignedOut(); } catch (e) {} }
    return { ok: true };
  }

  /** 用已存的 token 恢复会话（页面刷新时调用）。 */
  async function restore() {
    const t = loadToken();
    if (!t) { state.phase = 'idle'; state.offline = false; notify(); return { ok: false }; }
    const res = await call('/api/hm/profile', { token: t });
    if (!res.ok) {
      /* 401 = token 坏了/过期/账号已注销 → 清掉；
         其它（网络 / 5xx）→ **保留 token** 下次再试，并标 offline ——
         这两种在页面上必须长得不一样：
         前者该说"请重新登录"，后者该说"读不到状态，刷新重试，不是你账号的问题"。
         混成一句"未登录"会让网络抖动的人以为自己的账号没了。 */
      if (res.status === 401) { saveToken(null); state.offline = false; }
      else { state.offline = true; }
      state.phase = 'idle';
      notify();
      return { ok: false, error: errKind(res), offline: state.offline };
    }
    state.offline = false;
    state.token = t;
    const prof = (res.data && res.data.profile) || null;
    /* profile 里没有 email —— 用本地存过的最后一个邮箱补上（只为显示）。 */
    let lastEmail = null;
    try { lastEmail = storage ? storage.getItem('phm_email') : null; } catch (e) {}
    adopt(res.data && res.data.sub, lastEmail, t);
    return { ok: true, profile: prof };
  }

  /** 读自己的档案。 */
  async function readProfile() {
    const t = state.token || loadToken();
    if (!t) return { ok: false, error: 'expired' };
    const res = await call('/api/hm/profile', { token: t });
    if (!res.ok) {
      if (res.status === 401) { saveToken(null); state.phase = 'idle'; notify(); }
      return { ok: false, error: errKind(res) };
    }
    return { ok: true, profile: (res.data && res.data.profile) || null };
  }

  /** 绑定 / 解绑 Phira。`{clear:true}` 表示解绑。 */
  async function writeProfile(patch) {
    const t = state.token || loadToken();
    if (!t) return { ok: false, error: 'expired' };
    if (!throttleOf('profile')) return { ok: false, throttled: true };
    return runAction(async () => {
      const res = await call('/api/hm/profile', { method: 'PUT', token: t, body: patch || {} });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      return { ok: true };
    });
  }

  /** 活跃 +1。失败**不抛** —— 统计不该阻断业务。 */
  async function touch() {
    const t = state.token || loadToken();
    if (!t) return { ok: false };
    const res = await call('/api/hm/touch', { method: 'POST', token: t });
    return { ok: !!res.ok, visits: (res.data && res.data.visits) || null };
  }

  /** 注销账号：删账号 + 档案 + 未用的验证码，然后本地登出。
   *
   *  ⚠ 顺序不能反：**先删成功再登出**。反过来的话删失败时用户已经被登出，
   *    看到的是「已退出」而不是「没删掉」—— 那是最糟的一种骗人。
   *  ⚠ 服务端删完还留着本地 token 的话，下次刷新会拿它去 restore，
   *    而 /api/hm/profile 现在会回 401（account_exists:false）—— 能自愈，
   *    但会白闪一次"已登录"。所以这里主动清掉。 */
  async function destroyAccount() {
    const t = state.token || loadToken();
    if (!t) return { ok: false, error: 'expired' };
    if (!throttleOf('delete')) return { ok: false, throttled: true };
    return runAction(async () => {
      const res = await call('/api/hm/profile', { method: 'DELETE', token: t });
      if (!res.ok) {
        const k = errKind(res);
        setError({ kind: k, detail: String((res.data && res.data.error) || '') });
        return { ok: false, error: k };
      }
      saveToken(null);
      state.user = null;
      state.phase = 'idle';
      state.pending = null;
      stopTimer();
      notify();
      if (onSignedOut) { try { onSignedOut(); } catch (e) {} }
      return { ok: true };
    });
  }

  function destroy() { stopTimer(); }

  /* 恢复会话：构造时自己跑一次（页面刷新不用等调用方记得调）。 */
  const ready = restore().catch(() => ({ ok: false }));

  return {
    state, ready,
    setMode, requestCode, signIn, signUp, requestReset, confirmReset,
    signOut, restore, readProfile, writeProfile, touch, destroyAccount, destroy,
    /* 测试缝 */
    _setError: e => { setError(e); notify(); },
    _stopTimer: stopTimer,
    _saveToken: saveToken,
  };
}

/** kind → 词条**尾段**（camelCase），调用方拼自己的前缀再用 t() 翻：
 *      /app    → t('app.auth.err.' + authErrorKey(k))
 *      /settings → t('set.auth.err.'  + authErrorKey(k))
 *
 *  ⚠ 只回尾段，不回完整键名 —— 两个页面的前缀不同，回完整的会让调用方
 *    再去切字符串。
 *  ⚠ **必须返回 camelCase**：`authErrorKey('rate-limited')` 要给出
 *    `rateLimited` 而不是原样的 `rate-limited`。原样返回的话拼出来是
 *    `app.auth.err.rate-limited`，而词条名是 `app.auth.err.rateLimited` ——
 *    症状是"操作太频繁"显示成"未知错误"，且**不会报错**（t() 原样返回键名）。 */
export function authErrorKey(kind) {
  switch (kind) {
    case 'network': return 'network';
    case 'invalid': return 'invalid';
    case 'rate-limited': return 'rateLimited';
    case 'expired': return 'expired';
    case 'conflict': return 'conflict';
    case 'weak-pw': return 'weakPw';
    case 'unavailable': return 'unavailable';
    default: return 'unknown';
  }
}