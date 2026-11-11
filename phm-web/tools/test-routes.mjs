/* tools/test-routes.mjs —— 路由表与 openapi 的一致性
 *
 * 跑法： node tools/test-routes.mjs
 *
 * 【为什么必须有】
 *   路由表是"成本档 / 是否需要 Key"的唯一真源。它一旦与真实端点漂离，
 *   后果不会立刻暴露：
 *     · 新端点没登记 → 落到默认 normal 档 → 压力下不会被优先牺牲
 *     · 端点删了但表里还在 → 成本统计与文档不一致
 *   两种都是"只有出事才发现"的错，所以要用断言锁住。
 *
 * 【允许的差异】
 *   /admin/* 只在表里、不在 openapi —— 管理台不对外文档化，这是刻意的。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { ROUTES, costOfPath, routeOf } from '../lib/routes.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'openapi.json'), 'utf8'));

let pass = 0, fail = 0;
const T = (name, cond, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + JSON.stringify(got)); }
};

/* openapi 的路径用 {id} 占位，表里用 :id —— 统一成 :id 再比 */
const norm = p => p.replace(/\{([^}]+)\}/g, ':$1');

const fromSpec = new Set();
for (const [p, methods] of Object.entries(spec.paths)) {
  for (const m of Object.keys(methods)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) fromSpec.add(m.toUpperCase() + ' ' + norm(p));
  }
}
/* 允许"只在表里、不在 openapi"的端点：
   · /admin/* —— 管理台不对外文档化
   · /openapi.json —— 它本身就是文档，不自描述 */
const TABLE_ONLY = p => p.startsWith('/admin/') || p === '/openapi.json';
const fromTable = new Set(ROUTES.filter(r => !TABLE_ONLY(r.p)).map(r => r.m + ' ' + r.p));

const missing = [...fromSpec].filter(k => !fromTable.has(k));
const extra = [...fromTable].filter(k => !fromSpec.has(k));

T('openapi 的每个端点都在路由表里', missing.length === 0, missing);
T('路由表里没有 openapi 之外的端点（/admin 除外）', extra.length === 0, extra);

/* 成本档：抽查关键端点，防止有人把 expensive 改成 normal */
const COST = [
  ['POST', '/analyses', 'expensive'],
  ['GET', '/charters/123', 'expensive'],
  ['GET', '/players/123', 'expensive'],
  ['GET', '/charts', 'normal'],
  ['GET', '/charts/123', 'normal'],
  ['GET', '/stats', 'normal'],
  ['GET', '/meta', 'cheap'],
  ['GET', '/behavior', 'cheap'],
  ['GET', '/analyses/probe', 'cheap'],
  ['GET', '/engines', 'cheap'],
];
for (const [m, p, want] of COST) {
  const got = costOfPath(p, m);
  T(`成本档 ${m} ${p} = ${want}`, got === want, got);
}

/* 占位符要能匹配真实 id */
T('数字 id 能匹配 :id', routeOf('GET', '/charts/22681') !== null);
T('uid 能匹配 :uid', routeOf('GET', '/players/257272') !== null);
T('未知路径返回 null', routeOf('GET', '/definitely-not-a-route') === null);
T('method 大小写不敏感', routeOf('get', '/charts') !== null);

/* scope：公开端点不能要求 Key */
const PUBLIC = ['/meta', '/versions', '/status', '/health', '/behavior', '/reference', '/analyses/probe'];
for (const p of PUBLIC) {
  const r = routeOf('GET', p);
  T(`公开端点 ${p} 的 scope 为 null`, r && r.scope === null, r);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
