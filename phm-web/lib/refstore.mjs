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

const ENGINE_V2 = path.join(ROOT, 'public', 'data', 'engine-v2.json');
let _w2 = null;

/** v2 引擎权重（37 维岭回归）。与参照集一样：首次读盘，之后走内存。
    ⚠ 服务端必须和浏览器用**同一份**权重，否则 API 和页面给出两个数。 */
export function readWeightsV2() {
  if (_w2) return _w2;
  try {
    const j = JSON.parse(fs.readFileSync(ENGINE_V2, 'utf8'));
    if (!Array.isArray(j.w) || !j.w.length) return null;
    _w2 = j;
  } catch (e) {
    console.warn('[phm] engine-v2.json 读取失败，服务端退回 kNN：' + (e.message || e));
    _w2 = null;
  }
  return _w2;
}

const ENGINE_V4 = path.join(ROOT, 'public', 'data', 'engine-v4.json');
let _w4 = null;

const ENGINE_V3 = path.join(ROOT, 'public', 'data', 'engine-v3.json');
let _w3 = null;

/** v3 引擎权重（20 维事件序列 → 142 维池化 → 岭回归）。
    ⚠ 维数是 **142**，不是 v2 的 37 —— 校验写错会让服务端拿着一张
       结构不匹配的权重去点乘，结果不是报错而是**静默偏移**。
    ⚠ 与 v2 一样：服务端必须和浏览器用同一份权重，否则 API 和页面给出两个数。
       读不到就返回 null，由引擎自己降级到 v2/kNN —— 一次读盘失败不该让整次复算中断。 */
export function readWeightsV3() {
  if (_w3) return _w3;
  try {
    const j = JSON.parse(fs.readFileSync(ENGINE_V3, 'utf8'));
    if (!Array.isArray(j.w) || j.w.length !== 142) {
      console.warn('[phm] engine-v3.json 权重结构异常（w 不是 142 维），服务端退回 v2/kNN');
      return null;
    }
    _w3 = j;
  } catch (e) {
    console.warn('[phm] engine-v3.json 读取失败，服务端退回 v2/kNN：' + (e.message || e));
    _w3 = null;
  }
  return _w3;
}

/** v4 引擎权重（142 池化 ‖ 256 片段手型 = **398 维**）。**这是默认档**。
    ⚠ 与 v3 一样：服务端必须和浏览器用同一份权重，否则 API 和页面给出两个数。
    ⚠ 维数校验写成 398。写成 142 的话 v4 会被判成"结构异常"直接跳过 ——
       表现是服务端一直用 v3 而页面用 v4，两处数字差一档，很难看出来。
    读不到返回 null，引擎自己退回 v3 → v2 → kNN。 */
export function readWeightsV4() {
  if (_w4) return _w4;
  try {
    const j = JSON.parse(fs.readFileSync(ENGINE_V4, 'utf8'));
    if (!Array.isArray(j.w) || j.w.length !== 398) {
      console.warn('[phm] engine-v4.json 权重结构异常（w 不是 398 维），服务端退回 v3/v2/kNN');
      return null;
    }
    _w4 = j;
  } catch (e) {
    console.warn('[phm] engine-v4.json 读取失败，服务端退回 v3/v2/kNN：' + (e.message || e));
    _w4 = null;
  }
  return _w4;
}

/** 供诊断/版本校验：参照集元信息 */
export function refComMeta() {
  const j = JSON.parse(fs.readFileSync(REF_COM, 'utf8'));
  return { v: j.v, n: j.rows.length, dims: j.dims, labels: j.labels };
}
