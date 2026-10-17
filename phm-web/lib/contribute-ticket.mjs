/* ============================================================
 * lib/contribute-ticket.mjs —— /api/contribute 的「贡献凭证」
 * ============================================================
 * 【为什么需要它】
 *   /api/contribute 原先没有任何认证：任何人可以 POST 任意 chart_id，
 *   服务端就会替他去 Phira 下载 ≤60MB 谱面并同步跑引擎。复算机制保住了
 *   数据（落库值永远是服务端算的），但**成本面**完全敞开：单请求 20 行 ×
 *   60MB，绕过 /api/analyze 的限流与在途并发闸门。
 *
 * 【为什么不是「要求用户登录」】
 *   网页端目前没有 huamei 账号登录入口，贡献是匿名行为。强行要求 JWT
 *   会让整条贡献链路对匿名用户失效。所以这里签发的是**能力凭证**，
 *   不是身份凭证：它证明「这次写入刚刚在服务端换到过一张真实存在的谱」。
 *
 * 【凭证怎么工作】
 *   1. 客户端先 POST /api/contribute/ticket {chart_ids:[...]}
 *   2. 服务端：过与 /api/analyze 同一档限流 → 用 Phira 元数据确认
 *      chart_id 真实存在且带 file 字段（**只查元数据，不下载谱面**）
 *   3. 服务端用写凭据派生出的独立 HMAC 密钥签发 5 分钟有效的凭证
 *   4. /api/contribute 先验签、验过期、验 IP、验 chart_id 覆盖，再读 body
 *
 * 边界（说清楚，别当成身份认证）：
 *   · 攻击者仍然可以自己领凭证 —— 但领凭证与 /api/analyze 共用限流，
 *     且每张未缓存谱只会真正下载一次（写进缓存后重复请求直接 skipped）。
 *   · IP 绑定在网关收敛成 127.0.0.1 时只是形式绑定；它挡的是凭证被
 *     跨机器转发，不是身份。
 * ============================================================ */
import crypto from 'node:crypto';
import { WRITE_SECRET } from './cloud.mjs';

export const TICKET_TTL_MS = 5 * 60 * 1000;
export const TICKET_MAX_CHARTS = 5;

const KEY = WRITE_SECRET
  ? crypto.createHmac('sha256', WRITE_SECRET).update('phm-contribute-ticket:v1').digest()
  : null;

/** 凭证功能是否可用。没有写凭据时 fail-closed（贡献链路整体关闭）。 */
export function ticketAvailable() { return KEY !== null; }

function sign(body) {
  return crypto.createHmac('sha256', KEY).update(body).digest('base64url');
}

function hashIp(ip) {
  return crypto.createHash('sha256').update('ip:' + String(ip || 'unknown')).digest('base64url').slice(0, 22);
}

/** 签发一张覆盖一组 chart_id 的凭证。 */
export function issueTicket(chartIds, { ip } = {}) {
  if (!KEY) throw new Error('ticket unavailable: WRITE_SECRET missing');
  const cids = [...new Set(chartIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    .slice(0, TICKET_MAX_CHARTS);
  const payload = {
    v: 1,
    cids,
    ip: hashIp(ip),
    exp: Date.now() + TICKET_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { ticket: 'v1.' + body + '.' + sign(body), exp: payload.exp, cids };
}

/**
 * 验凭证（不检查 chart_id 覆盖 —— 那要等 body 读出来）。
 * @returns {{ok:true, cids:number[]}|{ok:false, error:string}}
 */
export function verifyTicket(ticket, { ip } = {}) {
  if (!KEY) return { ok: false, error: 'ticket_unavailable' };
  const raw = String(ticket || '').trim();
  if (!raw) return { ok: false, error: 'ticket_missing' };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, error: 'ticket_invalid' };
  const [, body, sig] = parts;
  let expect;
  try { expect = sign(body); } catch { return { ok: false, error: 'ticket_invalid' }; }
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'ticket_invalid' };

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return { ok: false, error: 'ticket_invalid' }; }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.cids)) return { ok: false, error: 'ticket_invalid' };
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return { ok: false, error: 'ticket_expired' };
  if (payload.ip !== hashIp(ip)) return { ok: false, error: 'ticket_ip_mismatch' };
  const cids = payload.cids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!cids.length) return { ok: false, error: 'ticket_invalid' };
  return { ok: true, cids };
}

/** 检查这一批 chart_id 是否全部被凭证覆盖。 */
export function ticketCovers(cids, wanted) {
  const set = new Set(cids);
  return wanted.every(n => set.has(Number(n)));
}
