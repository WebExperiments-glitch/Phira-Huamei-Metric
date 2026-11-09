/* 生产库备份 + 结构探查（只读，不改任何东西）
 *
 * 用法：node tools/db-backup.mjs [--out data/backup/xxx]
 * 输出：每张表一个 .json（行数组）+ 一个 _schema.txt（列定义）+ _manifest.json
 *
 * ⚠ 备份文件含 key 哈希与账号邮箱 —— 不进 git（data/ 已在 .gitignore 里），
 *   也不打印到终端，只在最后报告行数。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/* 读 .env（不引第三方库） */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const DSN = process.env.PHM_NEON_URL_DIRECT || process.env.PHM_NEON_URL;
if (!DSN) { console.error('缺少 PHM_NEON_URL_DIRECT'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(ROOT, 'data', 'backup', stamp);
fs.mkdirSync(OUT, { recursive: true });

/* 本次迁移相关 + 关键业务表 */
const TABLES = ['hm_api_keys', 'hm_api_key_meta', 'hm_api_usage', 'hm_accounts', 'phm_secrets'];

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });
await client.connect();

const manifest = { at: new Date().toISOString(), out: OUT, tables: {} };
const schemaLines = [];

for (const t of TABLES) {
  /* 结构 */
  const cols = await client.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema='public' and table_name=$1
       order by ordinal_position`, [t]);
  schemaLines.push(`\n=== ${t} (${cols.rowCount} 列) ===`);
  for (const c of cols.rows) {
    schemaLines.push(`  ${c.column_name.padEnd(22)} ${c.data_type.padEnd(22)} null=${c.is_nullable}  default=${c.column_default || '—'}`);
  }
  if (!cols.rowCount) { manifest.tables[t] = { exists: false }; continue; }

  /* 数据 —— 大表就分批，避免一次拉爆内存 */
  const cnt = await client.query(`select count(*)::int as n from public.${t}`);
  const n = cnt.rows[0].n;
  const rows = [];
  const BATCH = 2000;
  for (let off = 0; off < n; off += BATCH) {
    const r = await client.query(`select * from public.${t} order by 1 limit $1 offset $2`, [BATCH, off]);
    rows.push(...r.rows);
    if (n > BATCH) process.stdout.write(`\r  ${t}: ${Math.min(off + BATCH, n)}/${n}`);
  }
  fs.writeFileSync(path.join(OUT, `${t}.json`), JSON.stringify(rows));
  manifest.tables[t] = { exists: true, rows: n, bytes: fs.statSync(path.join(OUT, `${t}.json`)).size };
  console.log(`\r  ✓ ${t.padEnd(20)} ${String(n).padStart(7)} 行  ${(fs.statSync(path.join(OUT, `${t}.json`)).size / 1024).toFixed(0)} KB`);
}

fs.writeFileSync(path.join(OUT, '_schema.txt'), schemaLines.join('\n'));
fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));

console.log('\n  结构：');
console.log(schemaLines.join('\n'));
console.log(`\n  备份目录：${OUT}`);
await client.end();
