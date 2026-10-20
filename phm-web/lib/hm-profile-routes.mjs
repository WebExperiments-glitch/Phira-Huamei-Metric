/* ============================================================
 * lib/hm-profile-routes.mjs —— 自建账号的档案 / 活跃路由
 * ============================================================
 * 三条：
 *   GET    /api/hm/profile   读自己的档案（绑定 Phira + 活跃数）
 *   PUT    /api/hm/profile   绑定 / 解绑 Phira
 *   DELETE /api/hm/profile   注销账号（删账号 + 档案 + 未用验证码）
 *   POST   /api/hm/touch     活跃 +1
 *
 * 【为什么单独一个文件】
 *   `server.mjs` 有 900 行上限（lint-slop 守着），这三条加上 token 提取
 *   一共六七十行，塞进去必超。它们和 `lib/hm-code-routes.mjs` 是同一件事
 *   的两半（那边管账号，这边管档案），依赖全部由调用方注入。
 *
 * 【⚠ 两条不能忘的约束】
 *   ① **token 从 `x-hm-token` 读，`Authorization` 只兜底**。
 *      托管网关会吃掉/改掉入站的 Authorization（它自己要用），
 *      这个坑在 /api/hm/play 上真实踩过：本机全绿、线上每一步 401。
 *   ② **sub 只能从已验签的 token 里取**，绝不接受前端传 `sub` 参数 ——
 *      否则任何人都能改别人的 Phira 绑定。
 * ============================================================ */

/**
 * @param deps `{ send, gate, gateRead, gateWriteId, whoami, getProfile, putProfile, touchProfile }`
 * @returns `(req, res, p) => Promise<boolean>`：处理了返回 true，没命中返回 false
 */
/** 只读聚合代理：/api/plays?name= —— 「这张谱别人打得怎么样」。
 *  ⚠ 为什么放这个文件：它是**不依赖身份**的只读聚合（phm_plays 是 SECURITY DEFINER
 *    且只回条数/均值/中位/极值，不接触 UID / 用户名 / client_id）。
 *     原来前端直连云 SDK 调这个 RPC —— 账号收敛到自建后就没有云端会话了，
 *     而这条路径本来就不该要求登录。
 *  ⚠ 单独一个路由而不是让前端直连 DB：publishable key 虽然在网页里公开，
 *     但把「按 RPC 名拼 URL」的能力交给前端，等于把整个 RPC 面暴露出去。 */
export function makeProfileRoutes(deps) {
  const {
    send, gate, gateRead, gateWriteId, whoami,
    getProfile, putProfile, touchProfile, deleteAccount,
  } = deps;

  /** 从请求里取 token 并**验签**。返回 `{sub}` 或 `{err}`。
   *  ⚠ 这里不接受任何"前端告诉我我是谁"的形式。 */
  async function whoFromReq(req) {
    const hdr = String(req.headers['x-hm-token'] || '').trim();
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = hdr || auth;
    if (!token) return { err: 'token_required' };
    const who = await whoami(token);
    if (!who || !who.sub) return { err: 'token_invalid', detail: who && who.err };
    return { sub: String(who.sub), email: who.email || null };
  }

  return async function profileRoutes(req, res, p, url) {
    /* ── 只读聚合：不需要登录 ── */
    if (p === '/api/plays') {
      const name = String(url.searchParams.get('name') || '').slice(0, 120);
      if (!name) return send(res, 400, JSON.stringify({ error: 'name required' })), true;
      /* 限流跟**真实客户端 IP**，不能用一个写死的字符串——
         那会变成全站共用一个桶：一个人刷完别人就没得用了。 */
      const ip = req.socket.remoteAddress || 'unknown';
      if (gateRead && !(await gate(res, gateRead({ ip }), 'rate limit'))) return true;
      const r = await deps.dbFetch('/rpc/phm_plays',
        { method: 'POST', body: JSON.stringify({ name_in: name }) }, 15000, 8192);
      if (!r.ok) return send(res, 502, JSON.stringify({ error: 'upstream' })), true;
      return send(res, 200, r.body || '{}'), true;
    }

    if (p !== '/api/hm/profile' && p !== '/api/hm/touch') return false;

    const isTouch = p === '/api/hm/touch';
    const isDel = !isTouch && req.method === 'DELETE';
    /* ⚠⚠ **每个分支都必须 `return ..., true;`**。
       这个工厂的契约是「处理了就返回 true」，返回 falsy 会被
       server.mjs 当成「没命中」继续往下走 → send404 →
       **ERR_HTTP_HEADERS_SENT → 整个 Node 进程退出**。
       2026-10-20 真实踩到过：401 分支漏了 `, true`，
       任何未登录请求都能把站点打下线。还好新加的 API 测试当场抓到了。 */
    if (isTouch && req.method !== 'POST') return send(res, 405, '{"error":"POST only"}'), true;
    if (!isTouch && !isDel && req.method !== 'GET' && req.method !== 'PUT') {
      return send(res, 405, '{"error":"GET, PUT or DELETE only"}'), true;
    }

    const who = await whoFromReq(req);
    if (who.err) {
      /* 401 的两种含义要分开：
         token_required = 你没登录（该去登录）
         token_invalid  = token 坏了/过期（该重新登录）
         前端据此决定是「跳登录」还是「提示会话过期」。 */
      return send(res, 401, JSON.stringify({ ok: false, error: who.err })), true;
    }

    /* 读写分别限流：读便宜（每页刷新一次），写贵（改绑定 / 删账号）。 */
    if (isTouch || isDel || req.method === 'PUT') {
      if (!(await gate(res, gateWriteId(who.sub), 'rate limit'))) return true;
    } else if (gateRead && !(await gate(res, gateRead({ sub: who.sub }), 'rate limit'))) {
      return true;
    }

    if (isTouch) {
      const r = await touchProfile(who.sub, who.email);
      return send(res, 200, JSON.stringify({ ok: !!(r && r.ok), visits: (r && r.visits) || null })), true;
    }

    /* ── 注销 ──
       ⚠ 这里**不需要再验一次密码**：token 已经在前面验过签，而删除的只能是
          token 自己那个 sub（前端传不了别人的）。多要一次密码并不能防住
          "手机被人拿走"这类场景（cookie 里就有 token），只会让注销更烦。
         真要提高门槛的话，正确做法是给删除加二次验证码，不是加密码。 */
    if (isDel) {
      const r = await deleteAccount(who.sub);
      if (r.error) {
        /* unavailable = 本机没配写入凭据（服务端问题）；store_failed = 库那边出错
           （常见原因：20.sql 没执行）。两者都不是用户的错，文案要分开。 */
        return send(res, r.error === 'unavailable' ? 503 : 502,
          JSON.stringify({ ok: false, error: r.error })), true;
      }
      return send(res, 200, JSON.stringify({ ok: true, deleted: r.deleted !== false })), true;
    }

    if (req.method === 'GET') {
      const raw = await getProfile(who.sub);
      /* 账号已注销但旧 token 还没过期 —— 必须回 401，让前端把 token 清掉。
         回 200 + profile:null 的话前端会一直显示"已登录、只是没绑 Phira"。 */
      if (raw && raw.account_exists === false) {
        return send(res, 401, JSON.stringify({ ok: false, error: 'token_invalid' })), true;
      }
      const prof = (raw && raw.sub) ? raw : null;
      /* ⚠ 没有档案是**正常状态**（新注册），回 `{profile:null}` 而不是 404 ——
         404 会被前端当成"接口坏了"，而这里只是"还没绑过"。 */
      return send(res, 200, JSON.stringify({
        ok: true,
        profile: prof ? {
          phiraUid: prof.phira_uid == null ? null : Number(prof.phira_uid),
          phiraName: prof.phira_name || null,
          visits: Number(prof.visits) || 0,
          firstSeen: prof.first_seen || null,
          lastSeen: prof.last_seen || null,
        } : null,
      })), true;
    }

    /* PUT：绑定 / 解绑 */
    let body = {};
    try { body = JSON.parse(await readRaw(req) || '{}'); } catch (e) { body = {}; }
    const clear = !!body.clear || body.phiraUid == null;
    const r = await putProfile(who.sub, {
      email: who.email,
      clear,
      phiraUid: clear ? null : body.phiraUid,
      phiraName: clear ? null : body.phiraName,
    });
    if (r.error) {
      /* bad_uid     → 400（前端传错了）
         no_account  → 401（账号已注销，旧 token 还活着 → 该重新登录）
         其它        → 503（服务端/库的问题） */
      const status = r.error === 'bad_uid' ? 400 : (r.error === 'no_account' ? 401 : 503);
      return send(res, status, JSON.stringify({ ok: false, error: r.error })), true;
    }
    return send(res, 200, JSON.stringify({ ok: true, cleared: clear })), true;
  };
}

/** 读请求体（带上限）。⚠ 与 server.mjs 的 readBody 同款逻辑，但这里不 import 它 ——
 *  那个函数在 server.mjs 内部，抽出来会动到主文件的行数预算。 */
function readRaw(req) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > 8192) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
