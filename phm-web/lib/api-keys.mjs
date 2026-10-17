/* ============================================================
 * lib/api-keys.mjs —— API Key 的生成 / 哈希 / 掩码
 * ============================================================
 * 格式对齐 DeepSeek 控制台：`sk-` + 32 位十六进制。
 * 明文只在「创建」的响应里出现一次；库里只存 sha256 哈希 + 掩码。
 * ============================================================ */
import crypto from 'node:crypto';

export const KEY_PREFIX = 'sk-';
export const MAX_KEYS_PER_OWNER = 100;
export const KEY_RE = /^sk-[0-9a-f]{32}$/;

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** sk-495f3739****0709 —— 只用于控制台展示，不能反推。 */
export function maskApiKey(key) {
  const k = String(key);
  if (!KEY_RE.test(k)) return 'sk-****';
  return k.slice(0, 11) + '****' + k.slice(-4);
}

/** 生成一把新 key。返回 {key, hash, hint}；key 只应回给用户一次。 */
export function generateApiKey() {
  const key = KEY_PREFIX + crypto.randomBytes(16).toString('hex');
  return { key, hash: hashApiKey(key), hint: maskApiKey(key) };
}
