/* ============================================================
 * lib/hm-code-routes.mjs —— 「发验证码」与「重置密码」两条路由
 * ============================================================
 * ⚠ 为什么单独一个文件：`server.mjs` 有 900 行上限（lint-slop 守着）。
 *   这两条路由加起来五十多行，塞进去就超了。而且它们本来就属于
 *   「账号体系的邮件环节」，和 `lib/hm-accounts.mjs` 是一件事的两半。
 *
 * 依赖全部由调用方注入（`send` / `gate` / 闸句柄 / 账号模块的两个入口）——
 * 模块本身不 import server.mjs，避免循环依赖。
 */

/** @param deps `{send, gate, gateCode, gateAuth, readBody, ip, sendCode, resetPassword}`
 *  返回两个可直接 await 的处理函数，参数都是 `(res, body)`。 */
export function makeCodeRoutes(deps) {
  const { send, gate, gateCode, gateAuth, sendCode, resetPassword, verifyCode, register, login } = deps;

  /* ── 发邮箱验证码 ──
     用途只有两个：注册、重置密码。**登录永远不需要验证码**。
     发信走平台自带的 /.cloud/auth/v1/verification（零成本、零配置）。 */
  async function sendCodeRoute(res, body, ip) {
    const email = String((body && body.email) || '').trim();
    const purpose = String((body && body.purpose) || 'register');
    if (!(await gate(res, gateCode({ ip }, email),
        '验证码发得太频繁了（同一邮箱每分钟 1 封，每个 IP 每分钟 3 封）'))) return;
    const r = await sendCode(email, purpose);
    if (r.error) {
      /* 400 = 输入问题（邮箱格式 / 用途不对 / 邮箱已注册）
         503 = 平台发信失败 —— 那是我们这边的问题，别让用户以为是自己输错了 */
      const clientErr = ['email_invalid', 'purpose_invalid', 'email_taken'].includes(r.error);
      const payload = { ok: false, error: r.error };
      if (clientErr && r.detail) payload.detail = r.detail;
      return send(res, clientErr ? 400 : 503, JSON.stringify(payload));
    }
    return send(res, 200, JSON.stringify({ ok: true, ttl: r.ttl }));
  }

  /* ── 重置密码 ──
     ⚠ 不需要旧密码（有邮箱验证码就够）—— 这正是「忘记密码」的语义。
     反过来说，**能收到这封邮件的人就能改密码**，所以验证码只发邮箱本人、
     且一个码只能用一次（hm_code_consume 保证）。 */
  async function resetPasswordRoute(res, body, ip) {
    const email = String((body && body.email) || '').trim();
    const password = String((body && body.password) || '');
    const code = String((body && body.code) || '').trim();
    if (!email || !password || !code) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'email_password_code_required' }));
    }
    if (!(await gate(res, gateAuth({ ip }, email), '尝试太频繁，请一分钟后再试'))) return;
    const r = await resetPassword(email, password, code);
    if (r.error) {
      const clientErr = ['email_invalid', 'password_invalid',
        'code_missing', 'code_expired', 'code_used', 'code_too_many',
        'code_wrong', 'code_invalid', 'bad_credentials'].includes(r.error);
      const payload = { ok: false, error: r.error };
      if (clientErr && r.detail) payload.detail = r.detail;
      return send(res, clientErr ? 400 : 503, JSON.stringify(payload));
    }
    return send(res, 200, JSON.stringify({ ok: true, sub: r.sub }));
  }

  /* ── 注册 / 登录 ──
     ⚠ 注册必须带邮箱验证码（白帽报告发现 4：不验证邮箱所有权 = 可以拿别人的
       邮箱批量注册）。**登录仍然只要密码** —— 那是产品体验，登录侧有
       per-IP + per-邮箱 三重限流兜着，不需要验证码。 */
  async function accountRoute(res, p, body, ip) {
    const email = String((body && body.email) || '').trim();
    const password = String((body && body.password) || '');
    if (!email || !password) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'email_and_password_required' }));
    }
    let r;
    if (p === '/api/hm/register') {
      const code = String((body && body.code) || '').trim();
      if (!code) return send(res, 400, JSON.stringify({ ok: false, error: 'code_required' }));
      const v = await verifyCode(email, 'register', code);
      if (v.error) return send(res, 400, JSON.stringify({ ok: false, error: v.error }));
      r = await register(email, password);
    } else {
      r = await login(email, password);
    }
    if (r.error) {
      /* 400 = 调用方自己的输入不合法（改一下就能好）；
         401 = 凭据不被接受（账号已被注册 / 邮箱或密码不对 / 库里没这行）。 */
      const clientErr = (r.error === 'email_invalid' || r.error === 'password_invalid');
      const payload = { ok: false, error: r.error };
      /* detail 只在**输入不合法**时给 —— 那是帮助用户改对的提示。
         凭据类错误的 detail 可能是库的原始报文，含表名/列名，不外泄。 */
      if (clientErr && r.detail) payload.detail = r.detail;
      return send(res, clientErr ? 400 : 401, JSON.stringify(payload));
    }
    /* token 只在响应体里回一次，**不落服务端日志** —— 它是 bearer 凭据。 */
    return send(res, 200, JSON.stringify({ ok: true, sub: r.sub, token: r.token }));
  }

  return { sendCodeRoute, resetPasswordRoute, accountRoute };
}
