#!/usr/bin/env node
/* ============================================================
 * tools/lint-openapi.mjs —— OpenAPI 契约校验（零依赖）
 * ============================================================
 * 目标不是替代 Spectral，而是把「文档与实现漂移」钉死在 CI 里：
 *   · 结构合法、$ref 可解析
 *   · 已实现的每个路径都在 spec 里，反之亦然
 *   · 每个 operation 有 operationId / summary / tags / 2xx 响应
 *   · scope 只用已知值；路径参数都声明了
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = path.join(WEB, 'api', 'openapi.json');
const KNOWN_PATHS = ['/meta', '/charts/{chart_id}', '/analyses', '/usage', '/keys', '/keys/{id}', '/keys/{id}/rotate'];
const KNOWN_SCOPES = new Set(['charts:read', 'analyses:write', 'usage:read']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

let spec;
try { spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')); }
catch (e) { console.log('无法读取 ' + SPEC_PATH + ': ' + e.message); process.exit(1); }

check(String(spec.openapi || '').startsWith('3.'), 'openapi 3.x');
check(spec.info && spec.info.title && spec.info.version, 'info.title / info.version');
check(Array.isArray(spec.servers) && spec.servers.some(s => /\/api\/v1\/?$/.test(s.url || '')), 'servers 指向 /api/v1');
check(spec.components && spec.components.securitySchemes && spec.components.securitySchemes.bearer, 'securitySchemes.bearer');

const paths = Object.keys(spec.paths || {});
for (const p of KNOWN_PATHS) check(paths.includes(p), '实现了 ' + p);
for (const p of paths) check(KNOWN_PATHS.includes(p), 'spec 路径 ' + p + ' 有实现');

const schemas = Object.keys((spec.components && spec.components.schemas) || {});
const resolveRef = (ref) => {
  if (!ref || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((o, k) => (o ? o[k] : null), spec);
};
let refs = 0, refBad = 0;
const walk = (o) => {
  if (!o || typeof o !== 'object') return;
  if (typeof o.$ref === 'string') { refs++; if (!resolveRef(o.$ref)) { refBad++; bad('无法解析 $ref ' + o.$ref); } }
  for (const v of Object.values(o)) walk(v);
};
walk(spec);
check(refBad === 0, '$ref 全部可解析（' + refs + ' 个）');

const ids = new Set();
for (const p of paths) {
  const item = spec.paths[p];
  const pathParams = [...p.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  for (const [method, op] of Object.entries(item)) {
    if (!METHODS.has(method)) { bad(p + ' 非法方法 ' + method); continue; }
    const label = method.toUpperCase() + ' ' + p;
    check(!!op.operationId, label + ' 有 operationId');
    if (op.operationId) { if (ids.has(op.operationId)) bad('重复 operationId ' + op.operationId); ids.add(op.operationId); }
    check(!!op.summary, label + ' 有 summary');
    check(Array.isArray(op.tags) && op.tags.length > 0, label + ' 有 tags');
    check(op.responses && Object.keys(op.responses).length > 0, label + ' 有 responses');
    check(Object.keys(op.responses || {}).some(k => /^2\d\d$/.test(k)), label + ' 有 2xx 响应');
    const declared = new Set((op.parameters || []).map(x => x.name));
    for (const pp of pathParams) check(declared.has(pp), label + ' 声明路径参数 ' + pp);
    for (const sc of (op['x-scopes'] || [])) check(KNOWN_SCOPES.has(sc), label + ' scope ' + sc + ' 合法');
    if (op.security && op.security.length) check(op.security.some(x => x.bearer), label + ' security 含 bearer');
  }
}
for (const name of ['Chart', 'Error', 'Meta', 'Usage', 'ApiKey', 'ApiKeyCreated']) check(schemas.includes(name), 'schema ' + name);
check(!JSON.stringify(spec).includes('"nullable"'), '未使用 OpenAPI 3.1 不支持的 nullable');

console.log('\nOpenAPI 校验：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
