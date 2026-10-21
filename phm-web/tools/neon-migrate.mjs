#!/usr/bin/env node
/* ============================================================
 * tools/neon-migrate.mjs —— 把 db/ 下的迁移灌进 Neon（或任何 Postgres）
 * ============================================================
 * 【为什么不用 psql】
 *   Windows 上没装 psql，而 `pg` 只是 14 个包 —— 与其让每次部署都依赖
 *   外部客户端，不如自己跑。而且它能**逐条执行并报出是哪一条失败**，
 *   psql 的 `-f` 只会给你一个行号，还常常指着错误的位置。
 *
 * 【两个必须做对的地方】
 *   ① **必须用直连端点**（host 不带 `-pooler`）。Neon 的池化是 PgBouncer
 *      事务模式，`SET` / DDL / 会话状态都不可靠（官方 skill 的 gotcha 明写）。
 *   ② **按分号切语句要认 dollar-quote**。`$$ … ; … $$` 里面全是分号，
 *      天真地 `split(';')` 会把函数体切碎，然后报一堆看不懂的语法错。
 *      （本项目在 Python 侧踩过同一个坑，见 db/api-v2/21.sql 的注释。）
 *
 * 【用法】
 *   node tools/neon-migrate.mjs                 # 跑 db/neon/*.sql（按文件名排序）
 *   node tools/neon-migrate.mjs --file x.sql    # 只跑一个文件
 *   node tools/neon-migrate.mjs --list          # 只列语句，不执行
 *   node tools/neon-migrate.mjs --status        # 看库里现在有什么
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARG = process.argv.slice(2);
const flag = n => ARG.includes('--' + n);
const val = n => { const i = ARG.indexOf('--' + n); return i >= 0 ? ARG[i + 1] : null; };

/* `pg` 装在受管 node workspace 里（项目本身刻意零依赖）。
   ⚠ 这是**工具**的依赖，不是服务端运行期的依赖 —— 服务端仍然只发 HTTP。
   等哪天把 lib/cloud.mjs 换成 pg 直连，才需要把它写进 package.json。 */
const require = createRequire('C:/Users/30500/.workbuddy/binaries/node/workspace/');
const { Client } = require('pg');

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      if (line.trim().startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* 没有 .env 就走环境变量 */ }
  return out;
}
const ENV = readEnv();
const URL = val('url') || process.env.PHM_NEON_URL_DIRECT || ENV.PHM_NEON_URL_DIRECT;

/** 按 `;` 切语句，但**跳过 dollar-quote 内部**（$$ … $$ / $tag$ … $tag$）与注释。 */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let tag = null;
  while (i < sql.length) {
    /* 行注释：`--` 到行尾，整段跳过（但要保留换行，否则行号会错位） */
    if (tag === null && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      cur += '\n';
      continue;
    }
    /* 块注释 */
    if (tag === null && sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      cur += ' ';
      continue;
    }
    /* dollar-quote 开/闭 */
    if (sql[i] === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        const t = m[0];
        if (tag === null) tag = t;
        else if (tag === t) tag = null;
        cur += t;
        i += t.length;
        continue;
      }
    }
    const ch = sql[i];
    if (ch === ';' && tag === null) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  const rest = cur.trim();
  if (rest) out.push(rest);
  return out;
}

async function main() {
  if (!URL) {
    console.error('没有连接串：.env 里缺 PHM_NEON_URL_DIRECT，或传 --url');
    process.exit(1);
  }
  if (/-pooler/.test(URL)) {
    console.error('⚠ 这是**池化**端点。迁移必须用直连（host 去掉 -pooler）——');
    console.error('  PgBouncer 事务模式下 SET / DDL 不可靠，报的错还都不提"池化"两个字。');
    process.exit(1);
  }
  const host = URL.split('@')[1]?.split('/')[0] || '?';
  console.log('[neon-migrate] 目标：' + host);

  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: true } });
  await c.connect();

  if (flag('status')) {
    const t = await c.query(`select table_name from information_schema.tables
      where table_schema='public' order by 1`);
    const f = await c.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' order by 1`);
    console.log('  表 ' + t.rowCount + '：' + (t.rows.map(r => r.table_name).join(', ') || '（空）'));
    console.log('  函数 ' + f.rowCount + '：' + (f.rows.map(r => r.proname).join(', ') || '（空）'));
    await c.end();
    return;
  }

  /* 迁移链的顺序就是这里的顺序。⚠ 别改成"扫目录按文件名排" ——
     api-v1.sql 与 api-v2/*.sql 分属两个目录，混排会先跑 v2 再跑 v1。
     api-v2 的**单文件**才是真源（合并版 db/api-v2.sql 已经落后，
     缺 profiles/status/rate/account_delete 那一批，别拿它当全集）。 */
  const chain = [];
  const neonDir = path.join(ROOT, 'db', 'neon');
  if (fs.existsSync(neonDir)) {
    /* db/neon/*.sql 先跑（00-roles → 10-core），再跑历史迁移 */
    for (const f of fs.readdirSync(neonDir).filter(x => x.endsWith('.sql')).sort()) {
      chain.push(path.join(neonDir, f));
    }
  }
  chain.push(path.join(ROOT, 'db', 'api-v1.sql'));
  const v2dir = path.join(ROOT, 'db', 'api-v2');
  if (fs.existsSync(v2dir)) {
    for (const f of fs.readdirSync(v2dir).filter(x => x.endsWith('.sql')).sort()) {
      chain.push(path.join(v2dir, f));
    }
  }
  const only = val('file');
  const files = only ? [path.resolve(ROOT, only)] : chain;
  if (!files.length) {
    console.error('没有找到迁移文件（检查 db/neon、db/api-v1.sql、db/api-v2/）');
    process.exit(1);
  }

  let okN = 0, badN = 0;
  for (const file of files) {
    const stmts = splitStatements(fs.readFileSync(file, 'utf8'));
    console.log(`\n── ${path.relative(ROOT, file)}（${stmts.length} 条）──`);
    for (let i = 0; i < stmts.length; i++) {
      const head = stmts[i].replace(/\s+/g, ' ').slice(0, 76);
      if (flag('list')) { console.log(`  [${i + 1}] ${head}`); continue; }
      try {
        await c.query(stmts[i]);
        okN++;
        console.log(`  ✅ [${i + 1}] ${head}`);
      } catch (e) {
        badN++;
        console.log(`  ❌ [${i + 1}] ${head}`);
        console.log(`     ${(e.message || String(e)).slice(0, 220)}`);
      }
    }
  }
  if (!flag('list')) console.log(`\n────────\n成功 ${okN} · 失败 ${badN}`);
  await c.end();
  process.exit(badN ? 1 : 0);
}

main().catch(e => { console.error('崩溃：', e); process.exit(1); });
