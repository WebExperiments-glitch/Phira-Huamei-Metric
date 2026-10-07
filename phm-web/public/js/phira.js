/* ============================================================
 * js/phira.js —— Phira 公开 API 客户端（单一真源）
 * ============================================================
 * 【为什么单独一个模块】
 *   原来这套调用逻辑埋在 index.html 里，而「查玩家」「查谱师」「查单谱成绩」
 *   是三张不同的页面 —— 不抽出来就会有三份，迟早漂移。
 *
 * 【全部结论都是实测的，不是从文档抄的】
 *   官方在 https://api.phira.cn/openapi.json 给了 OpenAPI 规范，
 *   但**规范里有参数 ≠ 处理器认这个参数**。下面的「陷阱」一节全是实测出来的。
 *
 * 本模块**不碰 DOM、不碰 localStorage**：只负责取数与整形。
 * 这样 Node 里能直接 import 来做测试（tools/verify-phira.mjs）。
 * ============================================================ */

export const PHIRA_API = 'https://api.phira.cn';

/* ── 陷阱清单（每条都踩过或实测确认过）────────────────────────────
 *
 * 1. 用户名搜索的 `count` 字段是**坏的**：实测 `/user?search=Mivik` 返回
 *    `{"count":0,"results":[{...Mivik...}]}` —— count=0 但 results 非空。
 *    ⇒ 永远不要用 count 判断"有没有找到"，一律看 results.length。
 *
 * 2. `/chart?search=` 同时匹配**曲名和谱师**，两者混在一起无法区分。
 *    ⇒ 想要"某谱师的作品"，必须自己在客户端按 charter 字段精确过滤。
 *
 * 3. `/chart?charter=` / `?author=` 这类参数**不存在**（返回全量 9690 条，
 *    静默忽略而不是报错）。⇒ 别指望服务端帮你按谱师过滤。
 *
 * 4. ⚠️ `/record?player=` 只给**最近 20 条**，`page` / `pageNum` **完全无效**：
 *    分页参数在 OpenAPI 规范里写着，但处理器不认 —— 实测 page=0/1/2
 *    返回的 20 个 id **完全相同**（并集也是 20）。
 *    ⇒ 想看"全部成绩"只能**按谱面逐个查**（见第 5 条）。
 *
 * 5. ✅ `/record?player={uid}&chart={cid}` 有效 —— 给出这个人在**这张谱上
 *    的全部记录**（不限 20）。这是绕过第 4 条限制的唯一手段。
 *
 * 6. `/record?order=` 只认 `time` / `-time`（默认 `-time` 即最新优先）。
 *    `order=id` / `order=accuracy` 直接 400。
 *
 * 7. ⚠️ `time` 字段是 **ISO 字符串**（"2026-08-13T17:59:40Z"），不是 unix 秒。
 *    当数字比较会得到 NaN。ISO 串按字典序比较恰好等价于按时间比较，
 *    但别把它塞进 `new Date(x * 1000)`。
 *
 * 8. `/record/get-pool/{uid}`（B19）**不保证有意义**：Phira 服务端的 RKS/B19
 *    计算已经停摆（实测抽样 10 位今天仍在游玩的玩家，bestPool 最新一条全部
 *    停在 2023 ~ 2026-03），2026 年后注册的账号从一开始就是空的。
 *    ⇒ 必须能优雅降级，并且**如实告诉用户**这不是他们的问题。
 *
 * 9. `accuracy` 是 **0–1 小数**，展示前 ×100。`/record/query/` 返回的却
 *    混着 score(整数分) 与 accuracy(小数)，别搞混。
 *
 * 10. `/user/{id}` 对不存在的 UID 返回 `{"code":"INVALID_INPUT"}` 而**不是 404**
 *     —— 判断 `j.id != null`，不要判断 r.ok。
 *
 * 11. 文件 CDN 没有 CORS，浏览器**必然**下载失败（见 docs/ARCHITECTURE.md）。
 *     这不是 bug，是 Phira 的服务端配置。
 * ────────────────────────────────────────────────────────────── */

export class PhiraError extends Error {
  constructor(msg, status, path) {
    super(msg);
    this.name = 'PhiraError';
    this.status = status;
    this.path = path;
  }
}

const DEFAULT_TIMEOUT = 15000;

/* 带超时 + 一次退避重试的取数。
   只重试「值得重试」的失败：超时 / 网络错误 / 5xx / 429。
   4xx（除 429）说明请求本身有问题，重试只是浪费用户时间。 */
async function phGet(path, opts) {
  const o = opts || {};
  const timeout = o.timeout || DEFAULT_TIMEOUT;
  const tries = o.retries == null ? 1 : o.retries;
  let last = null;
  for (let attempt = 0; attempt <= tries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 500 * attempt));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(PHIRA_API + path, {
        signal: ctl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      const err = new PhiraError('Phira API ' + r.status, r.status, path);
      if (!(r.status === 429 || r.status >= 500)) throw err;
      last = err;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof PhiraError && !(e.status === 429 || e.status >= 500)) throw e;
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last || new PhiraError('Phira API 不可用', 0, path);
}

const qs = (o) => Object.entries(o)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

/* ══════════════════════════════════════════════════════════════
 * 用户
 * ══════════════════════════════════════════════════════════════ */

/** 按用户名搜索，**返回全部候选**（不替用户挑）。
 *  ⚠ 绝不返回 results[0] —— 重名/相似名极常见（实测搜 huamei 能搜出
 *     huameisang 等一串），盲取会让用户看到**别人的成绩**却以为是自己的。
 *     这正是「我玩了很多但检测不到」最可能的根因。 */
export async function findUsers(name, limit) {
  const j = await phGet('/user?' + qs({ search: name, page: 1 }));
  const list = (j && j.results) || [];
  return list.slice(0, limit || 20);
}

/** UID 直查。不存在时 Phira 返回 `{code:"INVALID_INPUT"}` 而不是 404。 */
export async function getUser(id) {
  const j = await phGet('/user/' + Number(id));
  return (j && j.id != null) ? j : null;
}

/** 输入既可以是 UID 也可以是用户名。
 *  返回 {users:[...]} —— 单数命中也是数组，调用方统一按"让用户确认"处理。 */
export async function resolveUser(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) throw new PhiraError('先填用户名或 UID', 0, '');
  if (/^\d{1,12}$/.test(s)) {
    const u = await getUser(s);
    if (!u) throw new PhiraError('没有 UID 为 ' + s + ' 的用户', 0, '');
    return [u];
  }
  const users = await findUsers(s);
  if (!users.length) throw new PhiraError('没找到「' + s + '」（区分大小写，试试完整 ID）', 0, '');
  /* 完全同名的排前面 —— 只是排序方便点击，**不是替用户决定** */
  const low = s.toLowerCase();
  return users.slice().sort((a, b) => {
    const ea = String(a.name).toLowerCase() === low ? 0 : 1;
    const eb = String(b.name).toLowerCase() === low ? 0 : 1;
    return ea - eb || (+b.rks || 0) - (+a.rks || 0);
  });
}

/** 账号总览：numRecords / avgAccuracy。
 *  ⚠ 这是**唯一**能证明「这个号玩了很多」的数据（接口层面拿不到全部成绩列表）。 */
export async function getUserStats(id) {
  return await phGet('/user/' + Number(id) + '/stats').catch(() => null);
}

/** Best19。可能为空或停在很久以前 —— 调用方必须能接住（见陷阱 8）。 */
export async function getBestPool(id) {
  return await phGet('/record/get-pool/' + Number(id)).catch(() => null);
}

/* ══════════════════════════════════════════════════════════════
 * 成绩
 * ══════════════════════════════════════════════════════════════ */

/** 最近成绩。
 *  @param player  UID（必填）
 *  @param chart   可选 —— **填了就返回该谱的全部记录**（不受 20 条限制）
 *  @param order   'time'(最旧优先) | '-time'(最新优先，默认)
 *  @returns {records, capped}  capped=true 表示撞上了 20 条硬上限 */
export async function getRecords(player, opts) {
  const o = opts || {};
  const j = await phGet('/record?' + qs({ player, chart: o.chart, order: o.order }));
  const records = Array.isArray(j) ? j : [];
  /* 只有"不按谱面过滤"时才可能撞上限 —— 撞了就必须告诉用户 */
  const capped = o.chart == null && records.length >= 20;
  return { records, capped };
}

/** 某谱的全服记录（分页有效，30/页，按 score 降序）。
 *  @returns {records, count, page, pageNum} */
export async function getChartRecords(chartId, opts) {
  const o = opts || {};
  const page = o.page == null ? 0 : o.page;
  const pageNum = o.pageNum || 30;
  const j = await phGet('/record/query/' + Number(chartId) + '?' + qs({ page, pageNum }));
  return {
    records: (j && j.results) || [],
    count: (j && j.count) || 0,
    page, pageNum,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 谱面
 * ══════════════════════════════════════════════════════════════ */

export async function searchCharts(q, opts) {
  const o = opts || {};
  const j = await phGet('/chart?' + qs({ search: q, pageNum: o.pageNum || 30, page: o.page || 1 }));
  if (Array.isArray(j)) return { charts: j, count: j.length };
  return { charts: (j && j.results) || [], count: (j && j.count) || 0 };
}

/** 批量详情（比逐个拉快一个量级）。失败返回 null，调用方可降级成逐个拉。 */
export async function getCharts(ids) {
  const list = (ids || []).map(Number).filter(n => n > 0);
  if (!list.length) return {};
  const j = await phGet('/chart/multi-get?' + qs({ ids: list.join(',') })).catch(() => null);
  if (!Array.isArray(j)) return null;
  const map = {};
  for (const c of j) if (c && c.id != null) map[c.id] = c;
  return map;
}

/** 某个谱师的作品。
 *  「谱师」没有独立接口（陷阱 3），只能借 `/chart?search=` 再自己过滤。
 *  做法：翻若干页，把 charter **精确匹配**的挑出来；同时把"仅模糊命中"的
 *  单独返回，让用户能看出区别（否则「搜 Kevin 出来一堆不相干的谱」很困惑）。
 *  @param name      谱师名
 *  @param maxPages  最多翻几页（每页 30）—— 防止高产谱师把网络打爆
 */
export async function getCharterCharts(name, opts) {
  const o = opts || {};
  const want = String(name || '').trim();
  if (!want) return { exact: [], fuzzy: [], scanned: 0, truncated: false };
  const maxPages = Math.max(1, o.maxPages || 6);
  const low = want.toLowerCase();
  const exact = [], fuzzy = [];
  let scanned = 0, truncated = false;
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    let r;
    try { r = await searchCharts(want, { page, pageNum: 30 }); }
    catch (e) { if (page === 1) throw e; break; }
    scanned += r.charts.length;
    for (const c of r.charts) {
      if (c == null || c.id == null || seen.has(c.id)) continue;
      seen.add(c.id);
      const ch = String(c.charter || '').trim();
      if (ch.toLowerCase() === low) exact.push(c);
      else if (ch.toLowerCase().includes(low)) fuzzy.push(c);
    }
    /* 翻到底了（没有下一页）或已经超过 count 就停 */
    if (!r.charts.length || scanned >= r.count) break;
    if (page === maxPages && scanned < r.count) truncated = true;
  }
  const byDiff = (a, b) => (+b.difficulty || 0) - (+a.difficulty || 0);
  return { exact: exact.sort(byDiff), fuzzy: fuzzy.sort(byDiff), scanned, truncated };
}
