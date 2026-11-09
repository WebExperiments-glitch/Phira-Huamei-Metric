/* 执行一份迁移 SQL（整段一个事务；失败自动回滚）
 *
 * 用法：node tools/db-migrate.mjs db/migrations/2026-11-09-tier.sql
 *
 * ⚠ 执行前会检查 data/backup/ 下有没有当天的备份 —— 没有就拒绝执行。
 *   生产库迁移前不留备份，等于不系安全带开车。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const file = process.argv[2];
if (!file) { console.error('用法：node tools/db-migrate.mjs <sql 文件>'); process.exit(2); }
const SQL = path.resolve(ROOT, file);
if (!fs.existsSync(SQL)) { console.error('找不到 ' + SQL); process.exit(2); }

/* 备份闸门：今天必须有备份目录 */
const BK = path.join(ROOT, 'data', 'backup');
const today = new Date().toISOString().slice(0, 10);
const hasBackup = fs.existsSync(BK)
  && fs.readdirSync(BK).some(d => d.startsWith(today) && fs.existsSync(path.join(BK, d, '_manifest.json')));
if (!hasBackup) {
  console.error(`✗ 今天（${today}）没有数据库备份，拒绝执行。先跑 node tools/db-backup.mjs`);
  process.exit(3);
}
console.log('  ✓ 已找到今天的备份');

const DSN = process.env.PHM_NEON_URL_DIRECT || process.env.PHM_NEON_URL;
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = fs.readFileSync(SQL, 'utf8');
const stmts = (sql.match(/;/g) || []).length;
console.log(`  执行 ${path.basename(file)}（约 ${stmts} 条语句）…`);

try {
  /* 整段交给服务端：文件里自带 begin/commit，服务端按顺序执行 */
  const r = await client.query(sql);
  const last = Array.isArray(r) ? r[r.length - 1] : r;
  console.log('  ✓ 成功' + (last && last.command ? `（最后一条：${last.command}）` : ''));
} catch (e) {
  console.error('  ✗ 失败，已回滚：' + (e.message || e));
  if (e.position) console.error('    位置 ' + e.position);
  process.exitCode = 1;
} finally {
  await client.end();
}
