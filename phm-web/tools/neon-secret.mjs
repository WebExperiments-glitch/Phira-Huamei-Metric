#!/usr/bin/env node
/* ============================================================
 * tools/neon-secret.mjs —— 把写入凭据写进数据库（phm_secrets.k='writer'）
 * ============================================================
 * 【为什么不写在 .sql 里】
 *   仓库是**公开的**。迁移文件里硬编码凭据 = 把钥匙挂在门上。
 *   凭据的真源一直是 `write-secret.txt` / `.env`（都 gitignored），
 *   这个工具只负责把它**搬进库里**，不负责生成。
 *
 * 【为什么不自动生成一个】
 *   因为服务端已经有一份在用了（write-secret.txt）。库里和本地必须**同一个值**，
 *   否则每次写入都是 42501 —— 而且是"配了凭据却全失败"这种最费解的状态。
 *
 * 【用法】
 *   node tools/neon-secret.mjs            # 从 write-secret.txt / PHM_WRITE_SECRET 取
 *   node tools/neon-secret.mjs --show     # 只看库里现在存了什么（打掩码）
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire('C:/Users/30500/.workbuddy/binaries/node/workspace/');
const { Client } = require('pg');

function env() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      if (line.trim().startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* 忽略 */ }
  return out;
}

/** 与 lib/cloud.mjs 完全一致的取值顺序：环境变量 → .env → write-secret.txt */
function localSecret() {
  const e = env();
  if (process.env.PHM_WRITE_SECRET) return process.env.PHM_WRITE_SECRET.trim();
  if (e.PHM_WRITE_SECRET) return e.PHM_WRITE_SECRET.trim();
  try {
    return fs.readFileSync(path.join(ROOT, 'write-secret.txt'), 'utf8').trim();
  } catch { return ''; }
}

const mask = s => (s ? s.slice(0, 4) + '…' + s.slice(-2) + ` (${s.length} 字符)` : '（空）');

(async () => {
  const e = env();
  const url = process.env.PHM_NEON_URL_DIRECT || e.PHM_NEON_URL_DIRECT;
  if (!url) { console.error('缺 PHM_NEON_URL_DIRECT'); process.exit(1); }
  if (/-pooler/.test(url)) { console.error('要用直连端点（去掉 -pooler）'); process.exit(1); }

  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await c.connect();

  const cur = await c.query("select v from phm_secrets where k='writer'");
  const inDb = cur.rows[0] ? cur.rows[0].v : null;

  if (process.argv.includes('--show')) {
    console.log('库里：' + mask(inDb));
    console.log('本地：' + mask(localSecret()));
    await c.end();
    return;
  }

  const want = localSecret();
  if (!want) {
    console.error('本地没有写入凭据（write-secret.txt / .env / 环境变量都没有）—— 拒绝写空值');
    await c.end();
    process.exit(1);
  }
  if (inDb === want) {
    console.log('✅ 库里与本地凭据一致，无需改动  ' + mask(want));
    await c.end();
    return;
  }

  await c.query(
    `insert into phm_secrets (k, v) values ('writer', $1)
     on conflict (k) do update set v = excluded.v`,
    [want],
  );
  console.log((inDb ? '♻️  已更新' : '✅ 已写入') + ' phm_secrets.writer  ' + mask(want));
  await c.end();
})().catch(e => { console.error('崩溃：', e.message); process.exit(1); });
