/* ============================================================
 * lib/cloud.mjs —— 云数据库访问层（server.mjs 与 tools/ 共用）
 * ============================================================
 * 【为什么单独一个文件】
 *   写入配置（数据库地址、publishableKey）与写入凭据只能有一份。
 *   此前它们长在 server.mjs 里，工具脚本要用就得复制一遍 —— 两份迟早会漂移。
 *
 * 【权限真相（实测过，别再想当然）】
 *   认证头是 x-wb-webapp-access-key（= publishableKey），身份由 referer 判定。
 *   ⚠ 这意味着服务端与浏览器**同为 anon 角色** —— 这一层不是「更高权限」。
 *   服务端唯一真正的特权来自写入凭据（配合 SECURITY DEFINER 函数）。
 *
 * 【唯一写路径】
 *   anon / authenticated 对 phm_charts / phm_scores 的 INSERT/UPDATE/DELETE 已被撤销，
 *   直连 REST 写库一律 42501。写入只能经 phm_put_chart() / phm_put_scores()，
 *   而它们要求带上写入凭据。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DB = {
  base: 'https://phm.app.workbuddy.host/.cloud/database/rest',
  key: 'wbpk_TRm3Cbt5VeYHHDwUL854jr_5Xi69EqYG18sPzQnMMJhJr08x67NoE3b',
  referer: 'https://phm.app.workbuddy.host/',
  batch: 8,          /* 环境级限流约 25~40 并发触发，服务端同样要温和 */
  gapMs: 400,
};

/* ── 写入凭据 ──
 * ⚠ **不写在源码里** —— 仓库是公开的，硬编码等于把钥匙挂在门上。
 *   读取顺序：环境变量 PHM_WRITE_SECRET → phm-web/write-secret.txt（已 gitignore）。
 *   都没有 → 空串 → 所有写入失败，但**服务本身照常可用**
 *   （/api/analyze 仍返回算好的定数，只是标注 cacheWrite.ok=false）。
 *   这是刻意的 fail-closed：宁可不缓存，也绝不留一条不带凭据的写后门。
 *
 * 轮换：`UPDATE phm_secrets SET v='<新值>' WHERE k='writer'` 并同步改本地文件 ——
 * 两端必须同时换，只换一边会立刻 42501（同样是 fail-closed，不会静默降级）。 */
export function loadWriteSecret() {
  const fromEnv = (process.env.PHM_WRITE_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  for (const name of ['write-secret.txt', '.phm-write-secret']) {
    try {
      const v = fs.readFileSync(path.join(ROOT, name), 'utf8').trim();
      if (v) return v;
    } catch { /* 没有就试下一个 */ }
  }
  console.warn('[phm] ⚠ 未配置写入凭据（PHM_WRITE_SECRET 或 write-secret.txt）'
    + ' —— 定数照常可算，但无法写入共享缓存');
  return '';
}
export const WRITE_SECRET = loadWriteSecret();

export function dbHeaders(extra) {
  return Object.assign({
    'x-wb-webapp-access-key': DB.key,
    'referer': DB.referer,
    'content-type': 'application/json',
    'prefer': 'resolution=merge-duplicates,return=minimal',
  }, extra || {});
}

/* ⚠ maxBody 不是小事：早先固定截断到 400 字符，本意是「别把错误大页塞进日志」，
   结果把**正常响应**也截了 —— 行数一多 JSON.parse 就失败，调用方拿到空集还以为是
   「库里没数据」。这种「静默返回空」比抛错危险得多（批量任务会白跑一遍）。
   默认放到 8KB 足够单行/小结果；列表类查询显式传更大的值。 */
export async function dbFetch(pathAndQuery, init, timeoutMs = 15000, maxBody = 8192) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(DB.base + pathAndQuery,
      Object.assign({ headers: dbHeaders() }, init || {}, { signal: ctl.signal }));
    clearTimeout(timer);
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt.slice(0, maxBody) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(e.message || e).slice(0, 200) };
  }
}

/* ── phm_charts 的唯一写入口 ──
 * ⚠ 刻意不做 fallback —— 失败就失败，绝不退回到直连写库（那等于自毁这条防线）。 */
export async function dbPutChart(row) {
  const r = await dbFetch('/rpc/phm_put_chart', {
    method: 'POST',
    body: JSON.stringify({ p_secret: WRITE_SECRET, p_row: row }),
  });
  if (r.ok) return { ok: 1, fail: [] };
  return { ok: 0, fail: [String(r.status) + ' ' + String(r.body || r.error || '').slice(0, 120)] };
}

/* ── 成绩写库：同样只走受凭据保护的 RPC ──
 * 保留分批（批 8）+ 遇 429 退避重试 —— 环境级限流实测约 25~40 并发触发。 */
export async function dbPutScores(rows) {
  let ok = 0; const fails = [];
  for (let i = 0; i < rows.length; i += DB.batch) {
    const chunk = rows.slice(i, i + DB.batch);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const r = await dbFetch('/rpc/phm_put_scores', {
        method: 'POST',
        body: JSON.stringify({ p_secret: WRITE_SECRET, p_rows: chunk }),
      });
      if (r.ok) { ok += chunk.length; done = true; break; }
      const limited = r.status === 429 || /rate limit|exceeds|too many/i.test(r.body || '');
      if (limited && attempt < 3) { await new Promise(s => setTimeout(s, 500 * attempt)); continue; }
      fails.push(r.status + ' ' + String(r.body || r.error || '').slice(0, 120));
      done = true;
    }
    if (i + DB.batch < rows.length) await new Promise(s => setTimeout(s, DB.gapMs));
  }
  return { ok, fail: fails.slice(0, 3) };
}

/* 单张谱的缓存行（未命中返回 null）。读是公开的，不需要凭据。 */
export async function dbGetChart(chartId) {
  const r = await dbFetch('/phm_charts?chart_id=eq.' + encodeURIComponent(chartId) + '&select=*');
  if (!r.ok || !r.body || r.body === '[]') return null;
  try { return JSON.parse(r.body)[0]; } catch { return null; }
}

/* 已缓存的全部 chart_id（用于「跳过已有」，让批量任务可断点续跑）。
   库大起来后响应会到几十 KB，所以显式把 maxBody 放宽到 1MB。
   ⚠ 失败时**要说出来**：静默返回空集会让批量任务以为「库是空的」然后白跑一整轮。 */
export async function dbListChartIds() {
  const r = await dbFetch('/phm_charts?select=chart_id&limit=100000', undefined, 20000, 1024 * 1024);
  if (!r.ok || !r.body) {
    console.warn('[phm] ⚠ 读取已缓存 chart_id 失败（' + (r.status || r.error) + '）—— 当作空库处理');
    return new Set();
  }
  try { return new Set(JSON.parse(r.body).map(x => x.chart_id)); }
  catch {
    console.warn('[phm] ⚠ 已缓存 chart_id 响应解析失败（收到 ' + r.body.length + ' 字符）—— 当作空库处理');
    return new Set();
  }
}
