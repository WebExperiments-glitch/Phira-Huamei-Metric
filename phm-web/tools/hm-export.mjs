#!/usr/bin/env node
/* 把 hm_* 相关表整表导出成 JSON（不用 pg_dump —— 本机没装 Postgres 客户端）。
 *
 * 用法：node tools/hm-export.mjs [输出目录]
 * 输出：每张表一个 .json + _manifest.json
 *
 * ⚠ 导出的是**原始行**（含 judge_blob 全文），文件较大但可完整还原。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'backup', 'migrate-tokyo');

const TABLES = [
  'phm_secrets', 'hm_accounts', 'hm_api_keys', 'hm_api_key_meta', 'hm_api_usage',
  'phm_plays', 'hm_plays', 'hm_rate_hit',
];

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const url = env.match(/^PHM_NEON_URL\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');

const { default: pg } = await import('pg');
let client;
for (let i = 0; i < 4; i++) {
  try {
    client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 60_000, query_timeout: 120_000 });
    await client.connect();
    break;
  } catch (e) {
    if (i === 3) throw e;
    await new Promise(r => setTimeout(r, 2000));
  }
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = { at: new Date().toISOString(), out: OUT, tables: {}, totalBytes: 0 };

for (const t of TABLES) {
  try {
    const r = await client.query(`select * from ${t}`);
    const file = path.join(OUT, `${t}.json`);
    const json = JSON.stringify(r.rows);
    fs.writeFileSync(file, json);
    const kb = (Buffer.byteLength(json) / 1024).toFixed(1);
    manifest.tables[t] = { rows: r.rows.length, kb: Number(kb) };
    manifest.totalBytes += Buffer.byteLength(json);
    console.log(`  ✓ ${t.padEnd(18)} ${String(r.rows.length).padStart(6)} 行  ${kb.padStart(9)} KB`);
  } catch (e) {
    manifest.tables[t] = { error: e.message.slice(0, 120) };
    console.log(`  ✗ ${t.padEnd(18)} ${e.message.slice(0, 60)}`);
  }
}

/* schema 也导出来 —— 迁移时要重建同样的列 */
const cols = await client.query(`
  select table_name, column_name, data_type, udt_name, is_nullable, column_default
    from information_schema.columns
   where table_schema = 'public' and table_name = any($1)
   order by table_name, ordinal_position`, [TABLES]);
fs.writeFileSync(path.join(OUT, '_columns.json'), JSON.stringify(cols.rows, null, 2));
console.log('  ✓ _columns.json      %d 列定义', cols.rows.length);

/* 函数体也导出来 —— RPC 是业务核心 */
const fns = await client.query(`
  select p.proname, pg_get_functiondef(p.oid) as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'hm_%' or p.proname like 'phm_%'`);
for (const f of fns.rows) {
  fs.writeFileSync(path.join(OUT, `_fn_${f.proname}.sql`), f.src);
}
console.log('  ✓ 函数 %d 个已导出', fns.rows.length);

fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));
console.log('\n  合计 %.1f MB → %s', manifest.totalBytes / 1024 / 1024, OUT);
await client.end();
