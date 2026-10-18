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
import { analyzeChart, pickUniqueChart, ENGINE_VER } from '../public/js/engine.js';
import { loadRefCom } from './refstore.mjs';

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

function fetchTO(url, ms, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, Object.assign({ signal: ctl.signal, headers: { Accept: '*/*' } }, opts || {}))
    .finally(() => clearTimeout(timer));
}

/* ── 谱面文件的下载白名单 ──
 * 【为什么必须有】`recompute()` 拿 Phira 返回的 `info.file` **直接 fetch**，
 * 既不限制协议也不限制主机 —— 这就是一个 SSRF：只要有一张谱的 file 字段
 * 能指向别处，服务端就会替攻击者去请求内网地址。
 *
 * 【⚠ 但重定向不能简单禁掉】实测 `phira.5wyxi.com/files/…` **必然返回 303**
 * 跳到 `phira-cdn.5wyxi.com/…?sign=…`（签名 CDN），文件本体在第二跳。
 * 我第一版写的是 `redirect: 'error'` —— 结果**把正常路径也掐死了**：
 * 未缓存的谱一律 `{"error":"fetch failed"}`，而缓存命中的谱照常返回，
 * 看起来像"有时能算有时不能"。
 * 所以正确做法是：**手动跟随，每一跳都过白名单**。
 *   · `redirect:'error'`  → 功能坏掉（已踩）
 *   · `redirect:'follow'`（默认）→ 重定向目标完全不受约束，SSRF 照样成立
 *   · `redirect:'manual'` + 逐跳校验 → 两个问题都解决
 */
const FILE_HOSTS = new Set(['phira.5wyxi.com', 'phira-cdn.5wyxi.com']);
const MAX_HOPS = 3;

function safeFileUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('谱面文件地址不合法'); }
  if (u.protocol !== 'https:') throw new Error('谱面文件必须走 https');
  if (!FILE_HOSTS.has(u.hostname)) throw new Error('谱面文件域名不在允许列表内：' + u.hostname);
  return u.toString();
}

/** 下载谱面文件：手动跟随重定向，**每一跳都校验域名**。 */
async function fetchChartFile(rawUrl, ms) {
  let url = safeFileUrl(rawUrl);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetchTO(url, ms, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) throw new Error('谱面文件重定向但没给 Location');
    url = safeFileUrl(new URL(loc, url).toString());   /* 下一跳照样要过白名单 */
  }
  throw new Error('谱面文件重定向次数过多（>' + MAX_HOPS + '）');
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

/** 只取 Phira 的谱面元数据（**不下载谱面**）。
 *  给 /api/contribute/ticket 用来确认 chart_id 真实存在且带 file 字段；
 *  与 recompute() 共用同一个上游和超时，避免两套判断漂移。 */
export async function chartInfo(chartId) {
  const r = await fetchTO(PHIRA_API + '/chart/' + encodeURIComponent(chartId), FETCH_TIMEOUT);
  if (!r.ok) throw new Error('Phira 谱面信息 HTTP ' + r.status);
  const info = await r.json();
  if (!info || typeof info !== 'object') throw new Error('谱面信息为空');
  return info;
}

/* 服务端复算：下载谱面 → 跑引擎 → 返回权威值 */
export async function recompute(chartId, opts) {
  const o = opts || {};
  const info = await (await fetchTO(PHIRA_API + '/chart/' + chartId, FETCH_TIMEOUT)).json();
  if (!info || !info.file) throw new Error('谱面没有可下载的文件');

  const res = await fetchChartFile(info.file, DOWNLOAD_TIMEOUT);
  if (!res.ok) throw new Error('下载谱面 HTTP ' + res.status);

  const len = +(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP) throw new Error('谱面包过大（' + Math.round(len / 1048576) + ' MB）');

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_ZIP) throw new Error('谱面包过大');

  /* ★ 两处关键传参：
       refCom    —— 用社区参照集（9,508 张 Phira 社区谱），而不是只有官谱。
                    实测：留出验证 |偏差|均值 1.187 → 0.820，≤1.0 命中 67.0% → 84.2%。
       excludeId —— **必须排除这张谱自己**。参照集里本来就有它，
                    不排除就是距离 0 的自匹配，落库值会等于它自己的声明值，
                    整个共享缓存会退化成"把 Phira 的标签抄一遍"。
                    （这个坑不含 excludeId 时表现为误差 0.00，看起来"完美"。） */
  /* ⚠ excludeId 的两种口径都会用到：
       · 默认（排除自己）= **权威口径** —— 参照集里有这张谱，不排除就是距离 0 的
         自匹配，落库值会退化成"把 Phira 的标签抄一遍"。
       · noExclude（不排除）只用于**一致性比对的兜底**：浏览器拖入谱面时
         并不知道 chart_id，自然也没法排除自己，于是它的 ref_const 会系统性
         偏一点。两个口径差 1 级以上并不罕见（留出验证里约两成），
         拿排除口径去卡"没排除"的客户端，会把**正确的贡献**判成"不是同一张谱"。
       所以：落库永远用排除口径；比对时允许客户端对上任一口径。 */
  const reports = await analyzeChart(buf, (info.name || 'chart') + '.pez',
    { refCom: loadRefCom(), excludeId: o.noExclude ? undefined : +chartId });
  const rep = reports.find(x => !x.error);
  if (!rep) throw new Error((reports[0] && reports[0].error) || '解析失败');

  const f = rep.feats || {};
  return {
    chart_id: info.id,
    name: info.name,
    level: info.level || rep.level || null,
    difficulty: info.difficulty != null ? +(+info.difficulty).toFixed(3) : null,
    /* ref_const  = 社区共识标度（主结果，页面上那个大数字）
       ref_official = 官谱标度（与 Phigros 官方一致的绝对标度，对照用）
       两个都存：只存一个的话，以后想复核"当时两个标度差多少"就无从查起。 */
    ref_const: rep.knn && rep.knn.ref != null ? +(+rep.knn.ref).toFixed(4) : null,
    ref_official: rep.knnOff && rep.knnOff.ref != null ? +(+rep.knnOff.ref).toFixed(4) : null,
    ps_score: rep.ps && rep.ps.total != null ? +(+rep.ps.total).toFixed(4) : null,
    nps: f.real_notes_per_second != null ? +(+f.real_notes_per_second).toFixed(4) : null,
    hold_ratio: f.hold_ratio != null ? +(+f.hold_ratio).toFixed(5) : null,
    notes: f.notes_real != null ? Math.round(f.notes_real) : null,
    stair_avg: f.stair_speed_avg != null ? +(+f.stair_speed_avg).toFixed(4) : null,
    speed_peak: rep.spPeak != null ? +(+rep.spPeak).toFixed(2) : null,
    engine_ver: 'server-verified',
    /* 产生这一行的引擎版本。engine_ver 是**信任标记**（服务端复算过），
       engine_build 是**算法版本** —— 后者让对账任务能一眼筛出
       "旧引擎算的过期行"，不用逐行重算。 */
    engine_build: ENGINE_VER,
    /* 技能分（stamina / dexterity / reading / precision + top + profile）。
       ⚠ **不落库**：phm_charts 表只有 16 个汇总字段，没有 feats，
          缓存行算不出技能分。所以它只出现在"刚分析完"的响应里，
          列表接口（读缓存）给不了 —— 这是数据模型的限制，不是遗漏。
       ⚠ 纯展示层：由 js/skills.js 从 feats 重组，不改任何引擎数值，
          因此不影响 ENGINE_VER，也不需要重算已有缓存。 */
    skills: rep.skills || null,
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
export async function reviewContribution(row, opts) {
  const trusted = await recompute(row.chart_id, opts);
  const cmp = compare(row, trusted);
  return { trusted, diffs: cmp.diffs, consistent: cmp.ok };
}
