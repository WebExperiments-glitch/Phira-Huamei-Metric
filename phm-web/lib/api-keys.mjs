/* ============================================================
 * lib/api-keys.mjs —— API Key 的生成 / 哈希 / 掩码 / 分级
 * ============================================================
 * 【格式】sk- + 43 位 base64url（32 字节 = 256 bit 熵）
 *   旧格式 sk- + 32 位十六进制（128 bit）继续接受 —— 换格式不能让存量 key 失效。
 *
 * 【为什么加长】128 bit 已经抗暴力（穷举成本天文数字），但 256 bit 是 2026 年
 *   的生产默认（Stripe/OpenAI 都是这个量级）。加长的真实收益是**降低
 *   "部分泄露后猜剩余位"的风险**，不是防穷举。
 *
 * 【哈希】sha256，库里只存哈希 + 掩码，明文只在创建时返回一次。
 *   没上 pepper：key 本身是 256 bit 随机，pepper 对暴力破解的边际收益接近 0；
 *   它的价值是防"内部人直接读表"——那属于威胁模型里的"平台可信"假设，
 *   真要防得上 KMS/HSM，不是 pepper 能解决的。
 *
 * 【分级】tier 由 owner 前缀推导（零 DDL，立刻生效）：
 *   internal:*            → admin
 *   monitor:* / premium:* → premium
 *   其它                  → normal
 *   改成真正的 DB 列要动 DDL + RPC，那是下一批。
 * ============================================================ */
import crypto from 'node:crypto';

export const KEY_PREFIX = 'sk-';
export const MAX_KEYS_PER_OWNER = 100;
/* 新格式 43 位 base64url；旧格式 32 位 hex 继续认（存量 key 不能失效）。 */
export const KEY_RE = /^sk-(?:[A-Za-z0-9_-]{43}|[0-9a-f]{32})$/;

/* 三级配额：hour = 每小时；burst = 10 秒突发；analyzeDay = 每日重算。
   ⚠ admin 不是"无限" —— 无限等于没有上限，被打了自己先挂。
     20000/h 是"正常永远用不到"的量级，但仍是硬顶。 */
export const TIERS = {
  normal: { hour: 1000, burst: 25, analyzeDay: 200 },
  premium: { hour: 5000, burst: 60, analyzeDay: 2000 },
  admin: { hour: 20000, burst: 200, analyzeDay: 10000 },
};

/** 由 owner 前缀推导档位（零 DDL）。 */
export function tierOfOwner(owner) {
  const o = String(owner || '').toLowerCase();
  if (o.startsWith('internal')) return 'admin';
  if (o.startsWith('monitor') || o.startsWith('premium')) return 'premium';
  return 'normal';
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** sk-495f3739****0709 —— 只用于控制台展示，不能反推。 */
export function maskApiKey(key) {
  const k = String(key);
  if (!KEY_RE.test(k)) return 'sk-****';
  /* 掩码只留前 6 + 后 4：泄露的掩码不该帮攻击者缩小搜索空间。 */
  return k.slice(0, 6) + '…' + k.slice(-4);
}

/** 生成一把新 key。返回 {key, hash, hint}；key 只应回给用户一次。 */
export function generateApiKey() {
  /* 32 字节 = 256 bit 熵，base64url 43 位。不用 hex：同样字节数下 hex 要 64 位，
     肉眼更长但熵一样，base64url 更短更适合贴进配置。 */
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key), hint: maskApiKey(key) };
}
