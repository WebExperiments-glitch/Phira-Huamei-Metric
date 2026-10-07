/* ============================================================
 * lib/refstore.mjs —— 社区参照集的 Node 侧读取
 * ============================================================
 * 引擎（public/js/engine.js）必须保持**纯计算**：不读文件、不发请求。
 * 所以参照集由调用方读好后当参数传进去 —— 浏览器用 fetch，
 * 服务端用这里。
 *
 * 为什么要单独一个文件：不只是 server.mjs 要它，tools/warm-cache.mjs
 * 与 tools/reconcile-cache.mjs 同样要它。三个地方各写一遍 fs.readFileSync
 * 是这类项目最容易积累的债务（迟早有一处忘了带 excludeId）。
 *
 * ⚠ 读失败时**抛错，不静默降级**：如果拿不到社区参照，服务端就会用官谱参照
 *   去算并在落库时写一个"另一个标度"的数字 —— 那会让缓存里混进两种标度的值，
 *   而它们在页面上长得一模一样。宁可拒绝写入，也不要制造这种不可分辨的污染。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF_COM = path.join(ROOT, 'public', 'data', 'ref-com.json');

let _cache = null;

/** 社区参照集（9,508 行）。首次调用读盘，之后走内存。 */
export function loadRefCom() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(REF_COM, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j.rows) || !j.rows.length) throw new Error('ref-com.json 结构异常');
  _cache = j.rows;
  return _cache;
}

/** 供诊断/版本校验：参照集元信息 */
export function refComMeta() {
  const j = JSON.parse(fs.readFileSync(REF_COM, 'utf8'));
  return { v: j.v, n: j.rows.length, dims: j.dims, labels: j.labels };
}
