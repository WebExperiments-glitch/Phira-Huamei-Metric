/* ============================================================
 * lib/api-extras.mjs —— API v1 的"只读扩展"端点
 * ============================================================
 * 【为什么不写进 api-routes.mjs】
 *   server.mjs 已经贴着 900 行上限；api-routes.mjs 也快满了。
 *   这里集中放数据装配，api-routes 只保留薄薄一层分派。
 *
 * 【数据源全是本地/已有依赖，不引入新的外部服务】
 *   public/data/*.json   行为难度、社区参照集、引擎权重
 *   CHANGELOG.md         版本历史
 *   lib/status.mjs       自监控快照（含事件层）
 *   phm_charts（DB）     标称 vs 实测
 *
 * 【边界】
 *   · 只读。不写库、不触发重算、不接受上传。
 *   · 所有 JSON 懒加载 + 进程内缓存（无状态部署下每进程各一份，可接受）。
 *   · 出错一律抛 Error，由 api-routes 统一转成稳定的错误码，
 *     不把文件路径 / 上游正文透给调用方。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusSnapshot } from './status.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const cache = new Map();

function loadJson(name) {
  if (cache.has(name)) return cache.get(name);
  const raw = fs.readFileSync(path.join(DATA, name + '.json'), 'utf8');
  const j = JSON.parse(raw);
  cache.set(name, j);
  return j;
}

function int(v, dflt, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/* ── 玩家实测难度 ────────────────────────────────────────────
   1,700 张谱 / 15.8 万条成绩，log(std) 双向固定效应反推。
   charts 是 { id: value } 字典，这里转成稳定的数组输出。 */
/* 数组布局来自 public/js/behav.js：
   [0] 实测难度  [1] 样本数  [2] 物量  [3] 时长(s)  [4] BPM
   后三项是"指纹"，页面靠它把没有 id 的本地谱面对上号。
   对外要展开成具名字段 —— 直接 spread 数组会变成 {"0":9.04,...}，没法用。 */
function packBehavior(v) {
  if (Array.isArray(v)) return {
    behavior_difficulty: v[0] ?? null, sample_size: v[1] ?? null,
    notes: v[2] ?? null, duration_s: v[3] ?? null, bpm: v[4] ?? null,
  };
  if (v && typeof v === 'object') return v;
  return { value: v };
}

export function behavior({ chartId, limit = 100, offset = 0 } = {}) {
  const d = loadJson('behavior-diff');
  const all = d.charts || {};
  if (chartId != null) {
    const v = all[String(chartId)];
    return v === undefined
      ? { found: false, chart_id: Number(chartId) }
      : { found: true, chart_id: Number(chartId), ...packBehavior(v) };
  }
  const ids = Object.keys(all);
  const rows = ids.slice(offset, offset + limit)
    .map((id) => ({ chart_id: Number(id), ...packBehavior(all[id]) }));
  return {
    note: d.note || null, total: ids.length, limit, offset, rows,
  };
}

/* ── 社区参照集 ──────────────────────────────────────────────
   idCol 指出 id 在 rows 数组里的下标；dims 是 36 个维度名。 */
export function reference({ chartId, limit = 100, offset = 0 } = {}) {
  const d = loadJson('ref-com');
  const rows = d.rows || [];
  const idCol = Number.isInteger(d.idCol) ? d.idCol : 0;
  const dims = d.dims || [];
  const pack = (row) => {
    const o = { chart_id: row[idCol] ?? null };
    dims.forEach((k, i) => { if (i !== idCol) o[k] = row[i] ?? null; });
    return o;
  };
  if (chartId != null) {
    const row = rows.find((r) => String(r[idCol]) === String(chartId));
    return row ? { found: true, dims, row: pack(row) } : { found: false, chart_id: Number(chartId) };
  }
  return {
    v: d.v ?? null, note: d.note ?? null, dims,
    total: rows.length, limit, offset,
    rows: rows.slice(offset, offset + limit).map(pack),
  };
}

/* ── 引擎版本与权重 ────────────────────────────────────────── */
const ENGINE_FILES = ['engine-v2', 'engine-v3', 'engine-v4', 'seq-model'];

export function engines() {
  return {
    versions: ENGINE_FILES.map((f) => {
      const j = loadJson(f);
      return {
        id: f, note: j.note ?? null,
        dims: Array.isArray(j.dims) ? j.dims.length : null,
        target: j.target ?? null,
        size_bytes: fs.statSync(path.join(DATA, f + '.json')).size,
      };
    }),
  };
}

export function engine(id) {
  if (!/^engine-v[234]$|^seq-model$/.test(String(id))) return null;
  return loadJson(id);
}

/* ── 版本历史（CHANGELOG.md 的表格是真源）──────────────────── */
export function versions(pageRoot = ROOT) {
  const md = fs.readFileSync(path.join(pageRoot, 'CHANGELOG.md'), 'utf8');
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*`(V\d+\.\d+\.\d+\.\d+)`\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*)\|/);
    if (m) out.push({ version: m[1], date: m[2], current: m[3].includes('本次') });
  }
  return { total: out.length, releases: out };
}

/* ── 标称 vs 实测 ────────────────────────────────────────────
   ref_const（实测拟合）与 ref_official（谱师标称）都非空才可比。
   ⚠ 两套标度，差值仅供对照坐标，不是误差指标 —— 与页面口径一致。 */
export async function discrepancy({ chartId, minGap, dbFetch } = {}) {
  if (typeof dbFetch !== 'function') throw new Error('db unavailable');
  const q = '/phm_charts?select=chart_id,ref_const,ref_official'
    + '&ref_const=not.is.null&ref_official=not.is.null&limit=5000';
  const r = await dbFetch(q);
  if (!r.ok) throw new Error('upstream unavailable');
  let rows = [];
  try { rows = JSON.parse(r.body); } catch { throw new Error('upstream unparseable'); }
  if (!Array.isArray(rows)) throw new Error('upstream unparseable');

  const items = rows.map((x) => ({
    chart_id: x.chart_id,
    ref_const: Number(x.ref_const),
    ref_official: Number(x.ref_official),
    delta: Number((Number(x.ref_const) - Number(x.ref_official)).toFixed(3)),
  })).filter((x) => Number.isFinite(x.ref_const) && Number.isFinite(x.ref_official));

  if (chartId != null) {
    const hit = items.find((x) => String(x.chart_id) === String(chartId));
    return hit ? { found: true, ...hit } : { found: false, chart_id: Number(chartId) };
  }
  const abs = items.map((x) => Math.abs(x.delta)).sort((a, b) => a - b);
  const med = abs.length ? abs[Math.floor(abs.length / 2)] : null;
  const gap = minGap == null ? null : Number(minGap);
  const shown = Number.isFinite(gap) ? items.filter((x) => Math.abs(x.delta) >= gap) : items;
  return {
    note: 'ref_const 与 ref_official 基于两套标度，delta 仅供对照坐标，不是误差指标。',
    comparable: items.length,
    median_abs_delta: med,
    over_1: items.filter((x) => Math.abs(x.delta) >= 1).length,
    over_1_5: items.filter((x) => Math.abs(x.delta) >= 1.5).length,
    min_gap: Number.isFinite(gap) ? gap : null,
    rows: shown.slice(0, 500),
  };
}

/* ── 站内自检状态与事件 ────────────────────────────────────── */
export async function statusData() { return buildStatusSnapshot('24h'); }
export async function incidents() {
  const s = await buildStatusSnapshot('24h');
  return {
    overall: s.overallState ?? s.overall ?? 'unknown',
    components: s.components || [],
    active: s.incidents || [],
    history: s.incidentHistory || [],
    updatedAt: s.updatedAt || Date.now(),
  };
}

/* ── 第三方连通性探测 ────────────────────────────────────────
   这是给外部服务"探一下能不能连上"的专用入口，
   ⚠ 托管环境只暴露一个 HTTP 端口，物理上开不了第二个 ——
      用专用端点 + 逐依赖结果代替，语义等价。
   ⚠ 只回 ok / ms / 分类，不回内部主机名、连接串、上游正文。 */
export async function health({ dbFetch, phiraBase } = {}) {
  const checks = [];
  const t = () => Date.now();

  async function probeDependency(name, fn) {
    const s = t();
    try {
      await fn();
      checks.push({ name, ok: true, ms: t() - s });
    } catch (e) {
      checks.push({ name, ok: false, ms: t() - s, reason: (e && e.code) || 'unreachable' });
    }
  }

  await probeDependency('database', async () => {
    if (typeof dbFetch !== 'function') throw Object.assign(new Error('no db'), { code: 'no_driver' });
    const r = await dbFetch('/phm_charts?select=chart_id&limit=1');
    if (!r.ok) throw Object.assign(new Error('db'), { code: 'db_' + r.status });
  });

  await probeDependency('phira-upstream', async () => {
    if (!phiraBase) throw Object.assign(new Error('no base'), { code: 'no_config' });
    /* 探一个**真实存在**的端点：直接打 / 会 404，
       那不是"上游挂了"，是探测地址写错了（2026-11-08 踩过）。 */
    const r = await fetch(String(phiraBase).replace(/\/$/, '') + '/chart?page=0&pageNum=1', {
      signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' },
    });
    if (!r.ok) throw Object.assign(new Error('upstream'), { code: 'http_' + r.status });
  });

  await probeDependency('local-data', async () => {
    for (const f of ['behavior-diff', 'ref-com', 'engine-v4']) loadJson(f);
  });

  await probeDependency('status-monitor', async () => {
    const s = await buildStatusSnapshot('24h');
    if (!s) throw Object.assign(new Error('empty'), { code: 'no_snapshot' });
  });

  return {
    ok: checks.every((c) => c.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export const EXTRA_SCOPES = ['behavior:read', 'reference:read', 'engines:read', 'system:read'];

/* ── 分析链路探针（匿名只读）────────────────────────────────
   【为什么需要】
     2026-11-09：POST /analyses 对匿名返回 403 之后，「分析谱面」那条监控
     连续红了 10.2 小时。它测的东西已经不存在了 —— 但也不能把监控删掉了事，
     因为"分析能不能用"是核心能力。
   【能测什么】
     · DB 可达（分析要先查缓存表）
     · 引擎权重文件可加载
     · 缓存里有可用于演示的谱面
   【不能测什么】
     · 真正跑一遍引擎（要下载谱面 + 算，代价太大、匿名不该触发）
     所以返回里的 `engine_runnable` 恒为 null，别当成"引擎正常"的证据。 */
export async function analysisProbe({ dbFetch } = {}) {
  const out = { ok: false, db: false, engine: false, charts_cached: 0, engine_runnable: null };
  if (typeof dbFetch === 'function') {
    try {
      const r = await dbFetch('/phm_charts?select=chart_id&limit=1');
      out.db = Boolean(r && r.ok);
      if (out.db) {
        const s = await dbFetch('/phm_charts?select=chart_id&offset=1000&limit=1');
        out.charts_cached = s && s.ok ? 1001 : 1;
      }
    } catch { /* 保持 false */ }
  }
  try {
    const e = engine('engine-v4');
    out.engine = Boolean(e && e.dims);
  } catch { /* 保持 false */ }
  out.ok = out.db && out.engine;
  out.checkedAt = new Date().toISOString();
  return out;
}
