#!/usr/bin/env node
/* lib/api-keys.mjs 单测（不联网、不碰数据库）。 */
import { generateApiKey, hashApiKey, maskApiKey, KEY_RE, MAX_KEYS_PER_OWNER } from '../lib/api-keys.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
};

const a = generateApiKey();
const b = generateApiKey();
T('格式 sk- + 32 hex', KEY_RE.test(a.key), a.key);
T('两把 key 不重复', a.key !== b.key);
T('哈希稳定', hashApiKey(a.key) === a.hash);
T('哈希是 64 位 hex', /^[0-9a-f]{64}$/.test(a.hash));
/* 掩码只留前 6 + 后 4：泄露的掩码不该帮攻击者缩小搜索空间。
   ⚠ 2026-11-09 起 key 是新格式（43 位 base64url），旧断言只认 hex 会假红。 */
T('掩码形状 sk-xxx…xxxx', /^sk-[A-Za-z0-9_-]{3}…[A-Za-z0-9_-]{4}$/.test(a.hint), a.hint);
T('掩码不含完整 key', !a.hint.includes(a.key.slice(3)), a.hint);
T('新旧两种 key 格式都认（换格式不能让存量失效）',
  KEY_RE.test(a.key) && KEY_RE.test('sk-00000000000000000000000000000000'), a.key);
T('非法 key 的掩码兜底', maskApiKey('not-a-key') === 'sk-****');
T('每账号上限 100', MAX_KEYS_PER_OWNER === 100, String(MAX_KEYS_PER_OWNER));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
