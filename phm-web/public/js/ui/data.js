/* js/ui/data.js —— 谱面缓存与派生计算（IO，不是 UI）
 *
 * ⚠ cachedRow ↔ bestConst 互相调用：**必须留在同一个文件里**。
 *   拆到两个文件会形成 ESM 循环依赖，运行时拿到 undefined。
 */

import { PHIRA_API } from '../phira.js?v=V0.31.0.2';
const _cache = new Map();          /* chart_id → { ref_const, ref_official, ... } */

/* 服务端 /api/charts?ids= 一次最多吃 **60** 个（见 server.mjs 的 .slice(0,60)）。
   ⚠ 这里必须 ≤ 那个上限 —— 以前这里写的是 200，多出来的 140 个 id
   服务端**不报错、直接丢**，响应里没有它们，于是那些谱永远显示"未算"。 */
const IDS_PER_REQ = 50;

/** 批量读本站定数缓存（只读、便宜、60/分/IP）。返回 Map。
 *
 *  ⚠ 失败时**不要把 id 记成 null**。以前 catch 里给整批 id 写 null，
 *    而 `missing` 的判据是 `!_cache.has(id)` —— 一旦写进 null 就再也不会重试，
 *    一次网络抖动会让这一批谱**在整个会话里**都显示"没有定数"。
 *    现在失败就是不写缓存，下次调用会重新请求。 */
export async function loadChartCache(ids) {
  const want = [...new Set((ids || []).map(Number).filter(n => n > 0))];
  const missing = want.filter(id => !_cache.has(id));
  for (let i = 0; i < missing.length; i += IDS_PER_REQ) {
    const chunk = missing.slice(i, i + IDS_PER_REQ);
    try {
      const r = await fetch('/api/charts?ids=' + chunk.join(','));
      if (!r.ok) continue;                 /* 失败 → 不落缓存，留给下次重试 */
      const j = await r.json();
      const rows = (j && (j.charts || j.rows || j)) || {};
      /* 请求成功时，**库里确实没有**的行才记 null —— 那是真结论，可以缓存 */
      for (const id of chunk) _cache.set(id, rows[id] || null);
    } catch (e) {
      /* 网络/解析失败：什么都不记（下次会重试） */
    }
  }
  const out = new Map();
  for (const id of want) out.set(id, _cache.get(id) || null);
  return out;
}
export function cachedRow(id) { return _cache.get(Number(id)) || null; }

/** 取用于 RKS 的定数：**优先本站算的**（用谱面结构算的，比谱师自报准），
 *  退到 Phira 标称。两者都没有返回 null。 */
export function bestConst(chartId, info) {
  const row = cachedRow(chartId);
  const mine = row && row.ref_const != null ? +row.ref_const : null;
  if (mine != null && mine >= 1 && mine <= 20) return { lv: mine, src: 'phm' };
  const off = info && info.difficulty != null ? +info.difficulty : null;
  if (off != null && off >= 1 && off <= 20) return { lv: off, src: 'phira' };
  return null;
}

/* ══════════════════════════════════════════════════════════════
 * P.H.M. RKS —— Phira 官方 RKS/B19 停更后的替代值
 * ══════════════════════════════════════════════════════════════
 * 公式与 Phigros 官方一致（用老玩家 bestPool 反推验证过：
 * 「内部定数 ÷ 标称定数」比值中位 1.0000）：
 *     单曲 rks = ((acc − 55) / 45)² × 定数      （acc < 70 记 0）
 *     总   rks = (Σ 前 19 条 + φ位) / 20
 *
 * ⚠ 它**不是**官方 RKS 的复现：官方分母固定 20，样本不足时会被压低；
 *   而我们的样本受「只能拿最近 20 条」限制，所以这个值大概率**偏低**。
 *   页面必须如实标注，不要当成"官方值"卖给用户。
 */
export function phmRks(rows) {
  const items = [];
  for (const r of rows || []) {
    const info = r.info || {};
    const lvInfo = bestConst(r.chart, info);
    if (!lvInfo) continue;                       /* 定数缺失/离群（谱师乱填）→ 跳过 */
    const name = info.name || ('谱面 #' + r.chart);
    /* B19 模式：Phira 已经给好单曲 rks，不重算（重算会因为定数被改过而有偏差） */
    if (r.rks != null && r.acc == null && r.accuracy == null) {
      items.push({ lv: lvInfo.lv, acc: null, sr: +r.rks, name, src: lvInfo.src, chart: r.chart });
      continue;
    }
    const acc = accOf(r);
    if (acc == null || acc < 70) continue;
    const k = (acc - 55) / 45;
    items.push({ lv: lvInfo.lv, acc, sr: k * k * lvInfo.lv, name, src: lvInfo.src, chart: r.chart });
  }
  if (!items.length) return null;
  items.sort((a, b) => b.sr - a.sr);
  const top = items.slice(0, 19);
  const phi = items.filter(x => x.acc != null && x.acc >= 100)
    .sort((a, b) => b.lv - a.lv)[0] || null;
  let sum = 0; for (const x of top) sum += x.sr;
  const bonus = phi ? phi.lv : 0;
  const cnt = top.length + (phi && !top.includes(phi) ? 0 : 0);
  return {
    items, top, phi, sum, bonus,
    n: top.length,
    official: (sum + bonus) / 20,          /* 官方 ÷20 口径：样本不足时会偏低 */
    fair: top.length ? (sum + bonus) / (top.length + (phi ? 1 : 0)) : 0,  /* 按实际条数平均 */
    phmN: items.filter(x => x.src === 'phm').length,
    phiraN: items.filter(x => x.src === 'phira').length,
    _cnt: cnt,
  };
}

/** 从一条 record 里取准确率百分比。accuracy 是 0–1 小数（陷阱 9）。 */
export function accOf(r) {
  if (r == null) return null;
  if (r.accuracy != null) {
    const a = +r.accuracy;
    /* 容错：有的端点给 0–1，有的给 0–100 */
    return a <= 1.5 ? a * 100 : a;
  }
  if (r.acc != null) {
    const a = +r.acc;
    return a <= 1.5 ? a * 100 : a;
  }
  return null;
}

/** RKS 说明。以前是一个常量字符串 —— 那样切语言时它不会变，
 *  所以改成**函数**：每次调用现取，语言一变内容就跟着变。 */
