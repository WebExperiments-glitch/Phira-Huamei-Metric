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
 * ⚠ **不写在源码里** —— 仓库是**公开的**，硬编码等于把钥匙挂在门上。
 *
 * 读取顺序（先命中者胜）：
 *   1. 环境变量 PHM_WRITE_SECRET
 *   2. phm-web/.env 里的 PHM_WRITE_SECRET=（已 gitignore）
 *   3. phm-web/write-secret.txt（已 gitignore）
 *   4. 都没有 → 空串 → 所有写入失败，但**服务本身照常可用**
 *      （/api/analyze 仍返回算好的定数，只是标注 cacheWrite.ok=false）
 *
 * 第 4 条是刻意的 **fail-closed**：宁可不缓存，也绝不留一条不带凭据的写后门。
 *
 * 为什么要多一个 .env（2026-10-07 补）：
 *   原来只有「环境变量 / 文件」两条路，而托管侧没有给我配环境变量的界面，
 *   于是实际上只剩「部署时必须记得带上 write-secret.txt」这一条隐式前提 ——
 *   忘了带，写入就整片失败，虽然可观测但会让人一头雾水。
 *   补上 .env 之后，三条路任选一条都能跑通，且**启动时会把用的是哪一条打出来**，
 *   不用再靠猜测。.env.example 是给人看的模板，不带真值。
 *
 * 轮换：`UPDATE phm_secrets SET v='<新值>' WHERE k='writer'` 并同步改本地那一路 ——
 * 两端必须同时换，只换一边会立刻 42501（同样是 fail-closed，不会静默降级）。 */

/** 极简 .env 解析（零依赖）。只认 KEY=VALUE 行，# 开头是注释。
 *  刻意不做变量展开、不处理 export —— 配置面越小越好审计。 */
function readDotEnv(file) {
  const out = {};
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/** 返回 {value, source} —— source 会打进启动日志，出问题一眼可查 */
export function resolveWriteSecret() {
  const fromEnv = (process.env.PHM_WRITE_SECRET || '').trim();
  if (fromEnv) return { value: fromEnv, source: '环境变量 PHM_WRITE_SECRET' };
  const env = readDotEnv(path.join(ROOT, '.env'));
  if ((env.PHM_WRITE_SECRET || '').trim()) return { value: env.PHM_WRITE_SECRET.trim(), source: '.env' };
  for (const name of ['write-secret.txt', '.phm-write-secret']) {
    try {
      const v = fs.readFileSync(path.join(ROOT, name), 'utf8').trim();
      if (v) return { value: v, source: name };
    } catch { /* 没有就试下一个 */ }
  }
  return { value: '', source: '未配置' };
}

export function loadWriteSecret() {
  const r = resolveWriteSecret();
  if (!r.value) {
    console.warn('[phm] ⚠ 未配置写入凭据（PHM_WRITE_SECRET / .env / write-secret.txt 都没有）');
    console.warn('[phm]   → 定数照常可算，但结果**写不进共享缓存**（cacheWrite.ok=false）');
  } else {
    console.log('[phm] 写入凭据来源：' + r.source);
  }
  return r.value;
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
    /* ⚠ content-range 必须带出去：分页要有「总数」就得靠它
       （配合 Prefer: count=exact，格式是 `0-49/649`）。
       之前只回 ok/status/body，于是任何分页都只能是"猜"，
       前端做出来的页码是假的。 */
    return { ok: r.ok, status: r.status, body: txt.slice(0, maxBody),
             contentRange: r.headers.get('content-range') };
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

/* ── 过期行：engine_build 不等于当前引擎的行 ──
 * 为什么要有这个：引擎一改，缓存里所有旧行都成了「另一个算法算出来的数」，
 * 而它们在页面上长得和新行一模一样。没有这一列就只能在黑里猜：
 * 要么全量重算（浪费），要么指望人记得上次跑到哪（会忘）。
 * 返回 {chart_id, ref_const, ref_official, difficulty, ...}，供对账任务直接比对。
 * ⚠ 老行的 engine_build 是 NULL（加这列之前没有这个概念），也算过期。 */
export async function dbListStale(engineBuild, maxBody = 8 * 1024 * 1024) {
  const q = '/phm_charts?or=(engine_build.is.null,engine_build.neq.'
    + encodeURIComponent(engineBuild) + ')&select=chart_id,name,level,difficulty,ref_const,ref_official,ps_score,engine_build&limit=100000';
  const r = await dbFetch(q, undefined, 25000, maxBody);
  if (!r.ok || !r.body) {
    console.warn('[phm] 读取过期行失败（' + (r.status || r.error) + '）');
    return null;
  }
  try { return JSON.parse(r.body); }
  catch { console.warn('[phm] 过期行响应解析失败'); return null; }
}

/* ── 全量缓存行（对账任务要拿它逐行比）── */
export async function dbListAll(maxBody = 8 * 1024 * 1024) {
  const r = await dbFetch('/phm_charts?select=chart_id,name,level,difficulty,ref_const,ref_official,'
    + 'ps_score,nps,hold_ratio,notes,stair_avg,speed_peak,engine_ver,engine_build,verified_at,computed_at'
    + '&limit=100000', undefined, 25000, maxBody);
  if (!r.ok || !r.body) {
    console.warn('[phm] 读取缓存失败（' + (r.status || r.error) + '）');
    return null;
  }
  try { return JSON.parse(r.body); }
  catch { console.warn('[phm] 缓存响应解析失败'); return null; }
}

/* ══════════════════════════════════════════════════════════════
 * 分页查询 phm_charts —— 「数据管理」页与对外只读接口共用
 * ══════════════════════════════════════════════════════════════
 * 【为什么必须做真分页】
 *   原来只有 `?ids=` 一个读法，于是任何"看全库"的需求都只能
 *   `limit=100000` 一次拉回来 —— 649 行时没问题，几万行时就是
 *   一次几十 MB 的响应，而且浏览器还要把它全部渲染出来。
 *   分页不是"好看"，是"库变大之后还能用"。
 *
 * 【底层能力（实测过，不是猜的）】
 *   网关是 PostgREST：
 *     · limit / offset            ✅
 *     · order=col.asc|desc        ✅（可加 .nullslast）
 *     · 过滤 ilike / like / neq / not.is.null  ✅
 *     · Prefer: count=exact       ✅ 回 206 + `Content-Range: 0-49/649`
 *   ⚠ 不用它就没有总数，页码就是个假的。
 *
 * 【安全】排序字段与过滤字段必须是**白名单**。这里直接拼进 URL，
 *   不做白名单就等于把查询表达式交给调用方（PostgREST 的 order 能写
 *   列名与方向，拼错东西至少是 400，但白名单是零成本的正解）。 */

export const SORTABLE = new Set(['chart_id', 'name', 'level', 'difficulty', 'ref_const',
  'ref_official', 'ps_score', 'nps', 'notes', 'hold_ratio', 'speed_peak',
  'engine_build', 'computed_at', 'verified_at']);
export const LEVELS = ['EZ', 'HD', 'IN', 'AT', 'SP'];

const qsEnc = (o) => Object.entries(o)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

/** 分页查缓存。
 *  @param opts.page      从 1 开始
 *  @param opts.pageSize  每页条数（1..200，服务端夹紧）
 *  @param opts.sort      白名单里的列名（默认 chart_id）
 *  @param opts.order     'asc' | 'desc'
 *  @param opts.q         曲名模糊搜索
 *  @param opts.level     档位（EZ/HD/IN/AT/SP）
 *  @param opts.only      过滤：'stale'（引擎版本过期）| 'official'（有官谱标度）| 'no_phm'（没算过）
 *  @param opts.build     只保留这个 engine_build（与 only=stale 互斥）
 *  @returns {rows,total,page,pageSize,pages} 或 null（读失败）
 */
export async function dbPageCharts(opts) {
  const o = opts || {};
  const pageSize = Math.min(200, Math.max(1, parseInt(o.pageSize, 10) || 50));
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const sort = SORTABLE.has(o.sort) ? o.sort : 'chart_id';
  const dir = o.order === 'desc' ? 'desc' : 'asc';

  const params = {
    select: '*',
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: sort + '.' + dir + (sort === 'chart_id' ? '' : '.nullslast'),
  };
  if (o.q) params.name = 'ilike.*' + String(o.q).replace(/[*(),]/g, ' ').slice(0, 60) + '*';
  if (o.level && LEVELS.includes(String(o.level).toUpperCase())) {
    params.level = 'ilike.*' + String(o.level).toUpperCase() + '*';
  }
  if (o.only === 'official') params.ref_official = 'not.is.null';
  else if (o.only === 'stale') params.or = '(engine_build.is.null,engine_build.neq.' + (o.build || '') + ')';
  else if (o.build) params.engine_build = 'eq.' + o.build;

  /* ⚠ 必须用 dbHeaders(...) 增补，不能直接传 `{headers:{Prefer:...}}` ——
     dbFetch 里是 `Object.assign({headers: dbHeaders()}, init)`，浅合并会把
     **整份认证头覆盖掉**，症状是静默 401（读不到数据还以为库是空的）。
     这是这个文件里第二次踩浅合并（上一次是 dbFetch 的 body 截断）。 */
  const r = await dbFetch('/phm_charts?' + qsEnc(params), {
    headers: dbHeaders({ prefer: 'count=exact' }),
  }, 20000, 6 * 1024 * 1024);
  if (!r.ok || !r.body) return null;
  let rows;
  try { rows = JSON.parse(r.body); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  /* Content-Range: 0-49/649 → 总行数在斜杠后面。拿不到就退化成"至少这么多"。 */
  let total = null;
  if (r.contentRange) {
    const m = /\/(\d+|\*)$/.exec(r.contentRange);
    if (m && m[1] !== '*') total = parseInt(m[1], 10);
  }
  if (total == null) total = (page - 1) * pageSize + rows.length;
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** 全库汇总：给「数据管理」页顶部的数字。只用一个请求（select 子集 + count=exact）。 */
export async function dbSummary() {
  const all = await dbFetch('/phm_charts?select=chart_id,level,engine_build,ref_const,ref_official,difficulty'
    + '&limit=100000', undefined, 25000, 12 * 1024 * 1024);
  if (!all.ok || !all.body) return null;
  let rows;
  try { rows = JSON.parse(all.body); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const byBuild = {}, byLevel = {};
  let withOfficial = 0, withConst = 0, withDiff = 0;
  for (const r of rows) {
    const b = r.engine_build || '(旧版/未标记)';
    byBuild[b] = (byBuild[b] || 0) + 1;
    const lv = (String(r.level || '').match(/EZ|HD|IN|AT|SP/i) || ['?'])[0].toUpperCase();
    byLevel[lv] = (byLevel[lv] || 0) + 1;
    if (r.ref_official != null) withOfficial++;
    if (r.ref_const != null) withConst++;
    if (+r.difficulty > 0) withDiff++;
  }
  return { total: rows.length, byBuild, byLevel, withOfficial, withConst, withDiff };
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
