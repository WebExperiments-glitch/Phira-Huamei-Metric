/* ============================================================
 * lib/review.mjs —— 定数贡献的「服务端复核」
 * ============================================================
 * 【解决的问题】共享定数缓存可以被客户端投毒：
 *   特征由客户端算完提交，攻击者可以伪造一张同名谱面，把假的 ref_const
 *   写进 phm_charts，污染所有用户之后看到的结果。对一个「以数据正确性
 *   为产品本身」的工具，这是最严重的问题。
 *
 * 【做法】不信客户端报上来的值，服务端自己算一遍：
 *   1. 拿 chart_id 向 Phira 要谱面文件地址
 *   2. **服务端下载**（浏览器受 CORS 限制下载不了，服务端不受 —— 这正是
 *      这件事只有服务端能做、而前端做不了的原因）
 *   3. 用**与浏览器完全相同的那一份引擎**（public/js/engine.js）复算
 *   4. 与客户端提交值比对：一致才采纳，且**入库的是服务端算出来的值**
 *
 * 这样投毒在架构上不成立：攻击者能改的只有自己报的数，
 * 而落库的值永远来自服务端自己的计算结果。
 *
 * 【代价与边界】
 *   - 每张新谱要下载一次谱面（几 MB）→ 已缓存的谱直接跳过，不会重复下载
 *   - 单进程串行复核，带超时；失败就拒绝写入（不降级、不回退）
 * ============================================================ */
import { analyzeChart, pickUniqueChart } from '../public/js/engine.js';

const PHIRA_API = 'https://api.phira.cn';
const FETCH_TIMEOUT = 20000;      /* 取谱面信息 */
const DOWNLOAD_TIMEOUT = 60000;   /* 下载谱面包 */
const MAX_ZIP = 60 * 1024 * 1024;

/* 数值容差：服务端与客户端用同一份引擎，理论上应当完全一致；
   留一点浮点余量，避免因极小差异误判。 */
const TOL = {
  ref_const: 0.02,
  ps_score: 0.05,
  nps: 0.005,
  hold_ratio: 0.001,
  notes: 0,
  stair_avg: 0.005,
  speed_peak: 1,
};

function fetchTO(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal, headers: { Accept: '*/*' } })
    .finally(() => clearTimeout(timer));
}

/* 用谱面名在 Phira 精确匹配 chart_id。
 * ⚠ 同名多难度（EZ/HD/IN/AT 名字相同）必须消歧，用与前端同一份 pickUniqueChart；
 *   无法唯一确定时返回 null —— 调用方据此拒绝，而不是猜一个。 */
export async function matchChartId(name, local) {
  const r = await fetchTO(PHIRA_API + '/chart?search=' + encodeURIComponent(name) + '&pageNum=15&page=1', FETCH_TIMEOUT);
  if (!r.ok) throw new Error('Phira 搜索 HTTP ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j.results || []);
  const pick = pickUniqueChart(list, Object.assign({ name }, local || {}));
  return pick.hit || null;
}

/* 服务端复算：下载谱面 → 跑引擎 → 返回权威值 */
export async function recompute(chartId) {
  const info = await (await fetchTO(PHIRA_API + '/chart/' + chartId, FETCH_TIMEOUT)).json();
  if (!info || !info.file) throw new Error('谱面没有可下载的文件');

  const res = await fetchTO(info.file, DOWNLOAD_TIMEOUT);
  if (!res.ok) throw new Error('下载谱面 HTTP ' + res.status);

  const len = +(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP) throw new Error('谱面包过大（' + Math.round(len / 1048576) + ' MB）');

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_ZIP) throw new Error('谱面包过大');

  const reports = await analyzeChart(buf, (info.name || 'chart') + '.pez');
  const rep = reports.find(x => !x.error);
  if (!rep) throw new Error((reports[0] && reports[0].error) || '解析失败');

  const f = rep.feats || {};
  return {
    chart_id: info.id,
    name: info.name,
    level: info.level || rep.level || null,
    difficulty: info.difficulty != null ? +(+info.difficulty).toFixed(3) : null,
    ref_const: rep.knn && rep.knn.ref != null ? +(+rep.knn.ref).toFixed(4) : null,
    ps_score: rep.ps && rep.ps.total != null ? +(+rep.ps.total).toFixed(4) : null,
    nps: f.real_notes_per_second != null ? +(+f.real_notes_per_second).toFixed(4) : null,
    hold_ratio: f.hold_ratio != null ? +(+f.hold_ratio).toFixed(5) : null,
    notes: f.notes_real != null ? Math.round(f.notes_real) : null,
    stair_avg: f.stair_speed_avg != null ? +(+f.stair_speed_avg).toFixed(4) : null,
    speed_peak: rep.spPeak != null ? +(+rep.spPeak).toFixed(2) : null,
    engine_ver: 'server-verified',
    verified_at: new Date().toISOString(),
  };
}

/* 比对：客户端提交值 vs 服务端复算值 */
export function compare(submitted, trusted) {
  const diffs = [];
  for (const [k, tol] of Object.entries(TOL)) {
    const a = submitted[k], b = trusted[k];
    if (a == null || b == null) continue;
    if (Math.abs(Number(a) - Number(b)) > tol) {
      diffs.push({ field: k, submitted: a, trusted: b });
    }
  }
  return { ok: diffs.length === 0, diffs };
}

/* 「差异过大」阈值：超过它就不是「客户端引擎过期」，而是**根本不是同一张谱**
   （典型场景：把某曲 IN 的特征提交到了同曲 HD 的 chart_id 上）。
   这种情况必须拒绝写入 —— 服务端算出来的那个值虽然本身正确，
   但写进去等于坐实了错误的关联。 */
const HUGE = { ref_const: 1.0, ps_score: 2.0, nps: 1.5, hold_ratio: 0.3, notes: 200 };
export function grosslyMismatched(diffs) {
  return diffs.filter(d => {
    const lim = HUGE[d.field];
    if (lim == null) return false;
    return Math.abs(Number(d.submitted) - Number(d.trusted)) > lim;
  });
}

/* 对外主入口：复核一条贡献。
 * ⚠ 不抛错（除非复算本身失败）—— 客户端值与服务端不一致是**允许发生的**：
 *   客户端的引擎可能过期（用户没刷新页面）。正确处理是「不采信客户端的值，
 *   但仍用服务端算出的权威值入库」，而不是拒绝缓存这张谱。
 *   这样既堵死了投毒（落库值永远来自服务端），又不会因客户端陈旧而丢数据。 */
export async function reviewContribution(row) {
  const trusted = await recompute(row.chart_id);
  const cmp = compare(row, trusted);
  return { trusted, diffs: cmp.diffs, consistent: cmp.ok };
}
