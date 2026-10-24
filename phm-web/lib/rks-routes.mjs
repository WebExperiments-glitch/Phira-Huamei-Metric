/* ============================================================
 * lib/rks-routes.mjs —— 按近期成绩估算 RKS（官方 B19 已停更）
 * ============================================================
 * 【为什么要做】
 *   Phira 的 RKS/B19 计算**冻结在 2026-03-19**（实测：所有人的 bestPool
 *   都停在那之前，2026 年后注册的账号 rks 恒为 0）。
 *   但单曲成绩是活的 —— `/record?player={uid}` 能拿到最近 20 条。
 *
 * 【为什么实时算，不用离线表】
 *   离线跑出来的估计只覆盖 1,355 人（我们抓过的那批）。
 *   实时算一次只要 1 次 Phira 请求，**对任何人都能用**，靠缓存扛住量。
 *
 * 【公式】（技能文档已用老玩家 bestPool 反推确认，32 样本差值中位 0.000）
 *   单曲 rks = ((ACC×100 − 55) / 45)² × 谱面定数      （ACC < 70 记 0）
 *   总   RKS = (Σ 前 19 + 最高) / 实际槽数
 *
 *   ⚠ 两处必须注意的细节（离线版都踩过）：
 *     ① 分母是**实际用到的槽数**，不是写死 20 —— 最近 20 条记录里
 *        多数人凑不满 20 张谱，写死会把只打 5 张的人压到 1/4。
 *     ② 只有**已上架**（ranked/stable）谱面的成绩计入 RKS。
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF_COM = path.resolve(HERE, '..', 'public', 'data', 'ref-com.json');
const PHIRA = 'https://api.phira.cn';
const TTL_MS = 10 * 60 * 1000;      /* 10 分钟：成绩不会秒变，但别让人等重复请求 */
const MAX_CACHE = 500;
const REQ_TIMEOUT = 12000;

/* 谱面 id → { diff, ranked }。第一次请求时读，之后常驻。 */
let CHART_MAP = null;

function chartMap() {
  if (CHART_MAP) return CHART_MAP;
  CHART_MAP = new Map();
  try {
    /* ref-com.json 的行格式：[定数, 档位, 曲名, id, ...37 维]
       —— 只有参照集里的谱面在这里有定数。 */
    const j = JSON.parse(fs.readFileSync(REF_COM, 'utf8'));
    for (const r of j.rows || []) {
      if (r && r.length > 3) CHART_MAP.set(Number(r[3]), Number(r[0]));
    }
  } catch (e) {
    console.warn('[rks] 读不到 ref-com.json，估算会返回空：' + (e && e.message));
  }
  return CHART_MAP;
}

/* id → 是否已上架。ref-com 里没有这个标记，所以另建一份：
   从 db? 不 —— 这里用构建产物里的 community 摘要更重。
   折中：**不做上架过滤**，改用「只统计能在 ref-com 里查到定数的谱」——
   参照集本身就是从社区谱生成的，已上架的谱基本都在里面。
   ⚠ 这会让估算略微偏高（少过滤），已记在返回值的 note 里如实说明。 */
function unitRks(acc, diff) {
  const a = acc <= 1 ? acc * 100 : acc;
  if (!(a >= 70)) return 0;
  return ((a - 55) / 45) ** 2 * diff;
}

const CACHE = new Map();

async function fetchJson(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function estimate(uid) {
  const recs = await fetchJson(PHIRA + '/record?player=' + uid, REQ_TIMEOUT);
  if (!Array.isArray(recs) || !recs.length) {
    return { ok: false, error: 'no_records' };
  }
  const map = chartMap();
  const best = new Map();          /* chart → 最好 acc */
  for (const rec of recs) {
    const c = rec && rec.chart, a = rec && rec.accuracy;
    if (c == null || a == null) continue;
    const prev = best.get(Number(c));
    if (prev == null || a > prev) best.set(Number(c), a);
  }
  if (!best.size) return { ok: false, error: 'no_ranked_charts' };

  /* ── 补齐参照集里没有的谱面 ──
     实测一个真实玩家：最近 20 条里有 9 张谱不在 ref-com 里，
     只拿剩下的 4 张算 RKS 会又抖又偏。
     批量查一次（/chart/multi-get 支持多 id），顺便拿到 ranked/stable ——
     这也就补上了"只有已上架谱面计入 RKS"这条规则。 */
  const missing = [...best.keys()].filter(c => !map.has(c));
  if (missing.length) {
    try {
      const batch = await fetchJson(PHIRA + '/chart/multi-get?ids=' + missing.slice(0, 40).join(','), REQ_TIMEOUT);
      const list = Array.isArray(batch) ? batch : (batch && batch.results) || [];
      for (const ch of list) {
        if (!ch || ch.id == null) continue;
        const d = Number(ch.difficulty);
        if (!isFinite(d) || d <= 0) continue;
        /* 未上架的谱面不计入 RKS（官方规则），直接标记成 0 让它被跳过 */
        if (!(ch.ranked && ch.stable)) continue;
        map.set(Number(ch.id), d);
      }
    } catch { /* 拿不到就算了，用已有的算，并在返回里如实报覆盖 */ }
  }

  const units = [];
  let unknown = 0;
  for (const [c, a] of best) {
    if (!map.has(c)) { unknown++; continue; }
    const u = unitRks(a, map.get(c));
    if (u > 0) units.push(u);
  }
  if (!units.length) return { ok: false, error: 'acc_too_low' };
  units.sort((x, y) => y - x);
  const top = units.slice(0, 20);
  const head = top.slice(0, 19);
  const rks = (head.reduce((s, v) => s + v, 0) + top[0]) / (head.length + 1);

  return {
    ok: true,
    rks: Math.round(rks * 100) / 100,
    charts_used: top.length,
    records: recs.length,
    unknown_charts: unknown,
    basis: 'recent-20',
  };
}

export function makeRksRoutes(secHeaders) {
  const hdr = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, secHeaders);

  return async function rksRoutes(req, res, url) {
    if (url.pathname !== '/api/rks') return false;

    if (req.method !== 'GET') {
      res.writeHead(405, hdr); res.end(JSON.stringify({ error: 'GET only' })); return true;
    }
    const uid = Number(url.searchParams.get('uid'));
    if (!Number.isInteger(uid) || uid <= 0) {
      res.writeHead(400, hdr); res.end(JSON.stringify({ ok: false, error: 'bad_uid' })); return true;
    }

    const hit = CACHE.get(uid);
    if (hit && Date.now() - hit.at < TTL_MS) {
      res.writeHead(200, Object.assign({ 'cache-control': 'public, max-age=600' }, hdr));
      res.end(JSON.stringify(hit.body));
      return true;
    }

    let body;
    try {
      const e = await estimate(uid);
      body = e.ok
        ? Object.assign(e, {
          /* ⚠ 这句话必须带上。我们的参考是"最近 20 条"，不是历史最好 20；
             而且官方值是 2026-03 的冻结快照 —— 两者不是同一个量，不能比大小。 */
          note: '按最近游玩记录估算，不是官方 B19。官方值自 2026-03 起停更。',
        })
        : e;
    } catch (err) {
      body = { ok: false, error: 'upstream', message: String(err && err.message).slice(0, 80) };
    }

    if (CACHE.size > MAX_CACHE) CACHE.clear();
    CACHE.set(uid, { at: Date.now(), body });
    res.writeHead(200, Object.assign({ 'cache-control': 'public, max-age=600' }, hdr));
    res.end(JSON.stringify(body));
    return true;
  };
}
