/* ============================================================
 * lib/api-admin.mjs —— 管理后台的 API（受一级密码保护 + 二级密码确认）
 * ============================================================
 * 【两级密码的设计】
 *   一级（adm1-…，存在 admin-secret.txt，我保管）
 *     用途：登录后台、**只读**查看 key 与申请
 *     传输：x-phm-admin + 时间戳 + HMAC 签名（见 api-guard.mjs 的 isAdmin）
 *   二级（用户自己设，只有他知道）
 *     用途：**任何写操作**（改档位 / 批准申请 / 重置二级密码）
 *     存储：scrypt 哈希，存在 admin2-hash.txt —— 明文永不落盘、永不过网存储
 *     校验：每次写操作都要带 x-phm-admin2
 *
 *   为什么写操作要两级？一级密码我也知道。只靠它，等于我一个人能改所有
 *   用户的档位。二级密码把"敏感操作"的钥匙单独交给站点主人。
 *
 * 【为什么二级密码不存数据库】
 *   存本地文件的好处：DB 侧拿不到哈希；坏处：多副本部署要同步这个文件。
 *   我们只有一个部署单元，取前者。
 *
 *   格式：scrypt$N$r$p$saltBase64$hashBase64
 *   scrypt 而不是 sha256：二级密码是**人选的口令**，熵远低于 API key，
 *   必须用慢哈希。参数 N=16384,r=8,p=1 约 50~80ms，够挡住离线爆破。
 * ============================================================ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const H2 = path.join(ROOT, 'admin2-hash.txt');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
      (e, k) => (e ? reject(e) : resolve(k)));
  });
}

export function hasAdmin2() {
  try { return fs.readFileSync(H2, 'utf8').trim().length > 0; } catch { return false; }
}

export async function setAdmin2(pw) {
  const p = String(pw || '');
  if (p.length < 10) return { ok: false, error: 'too_short' };
  if (p.length > 200) return { ok: false, error: 'too_long' };
  const salt = crypto.randomBytes(16);
  const k = await scryptAsync(p, salt);
  const line = ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), k.toString('base64')].join('$');
  fs.writeFileSync(H2, line + '\n', { mode: 0o600 });
  return { ok: true };
}

export async function checkAdmin2(pw) {
  let line = '';
  try { line = fs.readFileSync(H2, 'utf8').trim(); } catch { return false; }
  const parts = line.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let k;
  try {
    k = await new Promise((resolve, reject) => {
      crypto.scrypt(String(pw || ''), Buffer.from(saltB64, 'base64'), SCRYPT.keylen,
        { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
        (e, kk) => (e ? reject(e) : resolve(kk)));
    });
  } catch { return false; }
  const want = Buffer.from(hashB64, 'base64');
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}

/* ── 路由 ────────────────────────────────────────────────────
   由 api-routes 在 identify 之前分发（这几个端点不走 API Key / 匿名配额）。
   返回 true 表示已处理。 */
export function makeAdminRoutes(deps) {
  const { json, apiErr, callApiRpc, isAdmin, readBody } = deps;

  return async function handleAdmin(req, res, method, p) {
    /* 全部要一级密码：isAdmin 校验 x-phm-admin + ts + HMAC */
    if (!isAdmin(req)) {
      return apiErr(res, 401, 'authentication_error', 'admin_required',
        'admin credentials required'), true;
    }

    /* 二级密码确认（写操作必须） */
    const need2 = async () => {
      if (!hasAdmin2()) {
        apiErr(res, 428, 'invalid_request_error', 'admin2_not_set',
          'set the second-level password first (POST /admin/set-admin2)');
        return false;
      }
      const given = String(req.headers['x-phm-admin2'] || '');
      if (!given || !(await checkAdmin2(given))) {
        apiErr(res, 403, 'authentication_error', 'admin2_required',
          'second-level password required');
        return false;
      }
      return true;
    };

    /* GET /admin/state —— 页面用来决定显示"设置"还是"验证" */
    if (method === 'GET' && p === '/admin/state') {
      json(res, 200, { ok: true, admin2_set: hasAdmin2() });
      return true;
    }

    /* POST /admin/set-admin2 —— 首次设置不需要旧密码（一级密码已验过） */
    if (method === 'POST' && p === '/admin/set-admin2') {
      const body = await readBody(req, 4 * 1024);
      const r = await setAdmin2(body && body.password);
      if (!r.ok) {
        apiErr(res, 400, 'invalid_request_error', 'weak_password',
          'password must be 10..200 chars');
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }

    if (method === 'GET' && p === '/admin/keys') {
      const r = await callApiRpc('hm_admin_key_list', {});
      const d = readRpcJson(r) || {};
      if (!r.ok) { apiErr(res, 502, 'server_error', 'admin_unavailable', 'key list failed'); return true; }
      json(res, 200, { ok: true, keys: d.keys || [] });
      return true;
    }

    if (method === 'GET' && p === '/admin/requests') {
      const status = String((req.url.split('?')[1] || '').replace(/^.*status=/, '') || 'pending');
      const r = await callApiRpc('hm_admin_tier_list', { p_status: status.slice(0, 20) });
      const d = readRpcJson(r) || {};
      if (!r.ok) { apiErr(res, 502, 'server_error', 'admin_unavailable', 'request list failed'); return true; }
      json(res, 200, { ok: true, requests: d.requests || [] });
      return true;
    }

    if (method === 'POST' && p === '/admin/plan') {
      if (!(await need2())) return true;
      const body = await readBody(req, 4 * 1024);
      const r = await callApiRpc('hm_admin_set_plan', {
        p_id: String(body && body.id || ''), p_plan: String(body && body.plan || ''),
      });
      const d = readRpcJson(r) || {};
      json(res, d.ok ? 200 : 400, d);
      return true;
    }

    if (method === 'POST' && p === '/admin/decide') {
      if (!(await need2())) return true;
      const body = await readBody(req, 4 * 1024);
      const r = await callApiRpc('hm_admin_tier_decide', {
        p_id: String(body && body.id || ''),
        p_approve: Boolean(body && body.approve),
        p_by: 'phm-admin',
      });
      const d = readRpcJson(r) || {};
      json(res, d.ok ? 200 : 400, d);
      return true;
    }

    return false;
  };
}

function readRpcJson(r) {
  try { return JSON.parse(r && r.body) || {}; } catch { return null; }
}
