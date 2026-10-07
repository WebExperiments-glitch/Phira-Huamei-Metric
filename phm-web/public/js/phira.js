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
 * 2. ⚠ `/chart?search=` 同时匹配 **name + charter + description** 三个字段，
 *    三者混在一起无法区分（见第 20 条）。
 *    ⇒ 想要"某谱师的作品"，用 `?uploader=`（第 18 条），不要靠这个。
 *
 * 3. `/chart?charter=` / `?author=` / `?userId=` 这类参数**不存在**（返回全量 9691 条，
 *    静默忽略而不是报错）。⇒ 别指望服务端按谱师**文本**过滤。
 *    ⚠ 但 `?uploader={数字 id}` 存在且有效 —— 见第 18 条。
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
 *
 * ── 2026-10-07 补测：把 /record 家族剩下的端点全试了一遍 ──────────────
 *
 * 12. ⚠️ `/record/query/{chartId}` 返回的是 `{count, results}` **对象**，
 *     不是数组！`count` 是**真实总数**（实测 chart 6766 → 15632 条）。
 *     两个参数陷阱：`page` 是 **1-based**（`page=0` 不报错，但 results 为空，
 *     count 照样有值 —— 只看 results 会以为"这张谱没人打过"）；
 *     `pageNum` **上限 30**，31 及以上直接
 *     `INVALID_INPUT: Too many entities in one page`。
 *     ⇒ 这是本站唯一能拿到"某谱全服记录"的端点（`/user` 页在用）。
 *
 * 13. ✅ `/record/list15/{chartId}` 给该谱的 **TOP15**（带 `best: true` /
 *     `best_std` 标记），**无需认证**，且 id 是 **chart id 不是 player id**。
 *     目前产品里没用它 —— 拿来做"这张谱的顶尖成绩"或难度校准都是现成的。
 *
 * 14. ❌ `/record/best/{chartId}` **需要登录**（实测返回
 *     `{"code":"UNAUTHENTICATED"}`）。公开工具用不了 —— 我们没有、也不该要
 *     用户的 Phira 凭据。别在这上面浪费时间。
 *
 * 15. `/record?player=` 的 `pageNum` **与 `page` 一样无效**（此前只测过 page，
 *     这次补测：`pageNum=100` 仍返回同样那 20 条 id）。见第 4 条。
 *
 * 16. 速率限制：实测连续 24 次请求**零个 429**，但单次响应约 1.5~2.0s。
 *     ⇒ 遍历要"礼貌"：低并发（≤5）+ 缓存，别拿它当免费的计算资源刷。
 *
 * 17. 「按谱逐个查」能捞回多少？实测 UID 2（375 次游玩）：
 *     `/record?player=2` 只给 20 条 / 17 张谱；抽 25 张 Ranked 谱逐张查，
 *     多发现 1 张"最近 20 条里没有"的谱 ⇒ **确实有效**，但成本约 2s/张，
 *     想覆盖全部上架谱（631 张）得跑几分钟。适合做成**按需**的深度分析，
 *     不适合默认加载。
 *
 * ── 2026-10-07 补测：谱师搜索的真正解法 ────────────────────────────
 *
 * 18. ✅✅ `/chart?uploader={uid}` 是**服务端精确过滤**，不是被忽略的参数！
 *     实测 `uploader=257272` → `{"count":2,"results":[…]}`，两条记录的
 *     uploader 字段都等于 257272；`uploader=999999999` → `{"count":0,"results":[]}`；
 *     抽样 5695 → 5 张、5775 → 1 张，`count` 与 `results.length` 自洽。
 *     ⇒ 这条推翻了本文件里"陷阱 3"的悲观结论（`charter=`/`author=` 确实不存在，
 *       但 `uploader=` 存在）。**这是「按谱师查作品」的正解**。
 *     ⚠ `uploader` 是**用户 id**，不是 charter 文本 —— 所以要两步：
 *       `/user?search={名}` 拿 id → `/chart?uploader={id}` 拿作品。
 *     ⚠ 不能和 `search=` 组合：`uploader=257272&search=x` 返回空响应体。
 *     ⚠ `pageNum` 上限同样是 30（`pageNum=100` 报 Too many entities）。
 *     ⚠ 实测个人谱师的作品数是个位数到几十 —— 别为"上千张"做过度设计，
 *       真出现超大 count 是异常，`getAllChartsByUploader` 的 maxPages 会兜住。
 *
 * 19. ⚠ `/user?search=` 是**子串**匹配且**忽略 page**：实测
 *     `search=平方秒` 的第 1 页与第 2 页返回完全相同的 3 条。
 *     ⇒ 用户搜索只能拿到"一页候选"，不能枚举 —— 恰好够用（让用户点选）。
 *     ⚠ 中文近形字会搜不到：作者本体是「平方秒**和**立方吨」(id 257272)，
 *       搜「平方秒**与**立方吨」只返回 2 个**同名仿号**，搜「平方秒」才找到本体。
 *       ⇒ 页面上必须把候选**全列出来**，并且允许用户换更短的词。
 *
 * 20. ⚠ `/chart?search=` 匹配 **name + charter + description 三个字段**。
 *     实测搜「平方」返回 59 条，绝大多数是**别人的谱面描述里写了他的感谢名单**
 *     （例：`Eviternity` 的 description 写着「特别感谢b站@平方秒与立方吨」）。
 *     ⇒ 把 search 命中一律当成"他的作品"是错的；必须按字段分类展示。
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
        /* ⚠ **必须 no-store。**
           api.phira.cn 的响应**一个缓存头都不带**（实测：没有 Cache-Control、
           没有 ETag、没有 Last-Modified，只有 CF-Cache-Status: DYNAMIC）。
           这种"裸响应"在浏览器里属于启发式缓存的地带 —— 一旦命中，
           用户看到的就是**几小时前的旧成绩**，而且刷新页面也没用
           （缓存键是 URL，两次刷新是同一个 URL）。
           成绩必须实时，所以这里显式关掉缓存，由我们自己在内存里控制复用。 */
        cache: 'no-store',
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

/** ⭐ 某个账号**上传**的谱面（服务端精确过滤）。
 *
 *  这是「按谱师查作品」的正解 —— 见陷阱 18。
 *  为什么不用 `/chart?search=` 翻页筛 charter：
 *    ① charter 是**自由文本**，谱师常把团队名写进去（他的谱 charter 写
 *       `SqrtSecond Chart Team`，而不是自己的名字），文本比对必然漏；
 *    ② search 还命中 description，混进大量"别人的谱面感谢了他"的噪声；
 *    ③ 翻页最多只能覆盖 Phira 结果集的前若干页，穷举不现实。
 *  而 `uploader` 是**结构化外键**，一条 SQL 就精确了。
 *
 *  ⚠ 只能单账号、不能与 `search=` 组合（组合返回空响应）。
 *  ⚠ 语义是"谁**上传**的"，不等于"charter 字段写了谁" —— 团队号代传、
 *    谱面转让都会让两者不一致。所以页面上仍然要保留 charter 那条路径兜底。
 */
export async function getChartsByUploader(uid, opts) {
  const o = opts || {};
  const page = Math.max(1, o.page || 1);
  const pageNum = Math.min(30, Math.max(1, o.pageNum || 30));
  const j = await phGet('/chart?' + qs({ uploader: Number(uid), page, pageNum }));
  if (Array.isArray(j)) return { charts: j, count: j.length, page, pageNum, pages: 1 };
  const charts = (j && j.results) || [];
  const count = (j && j.count) || 0;
  return { charts, count, page, pageNum, pages: Math.max(1, Math.ceil(count / pageNum)) };
}

/** 拉某个账号上传的**全部**谱面（自动翻页）。
 *  @param onProgress ({page, pages, got, count}) 每页回调一次
 *  @param maxPages 保险丝 —— 30 × 10 = 300 张，个人谱师远够；再多就是异常了 */
export async function getAllChartsByUploader(uid, opts) {
  const o = opts || {};
  const maxPages = Math.max(1, o.maxPages || 10);
  const pageNum = Math.min(30, Math.max(1, o.pageNum || 30));
  const out = [];
  let count = 0, pages = 1, done = 0;
  for (let page = 1; page <= maxPages; page++) {
    let r;
    try { r = await getChartsByUploader(uid, { page, pageNum }); }
    catch (e) { if (page === 1) throw e; break; }   /* 第一页就失败 = 真失败；后续失败 = 拿到多少算多少 */
    count = r.count; pages = r.pages;
    for (const c of r.charts) out.push(c);
    done = page;
    if (typeof o.onProgress === 'function') o.onProgress({ page, pages, got: out.length, count });
    if (!r.charts.length || page >= pages) break;
  }
  const byDiff = (a, b) => (+b.difficulty || 0) - (+a.difficulty || 0);
  return { charts: out.sort(byDiff), count, pages, lastPage: done, truncated: done < pages };
}

/** 给账号候选排序 —— 只**排序**，绝不替用户选。
 *  权重：同名 > 前缀相同 > 名字更短（更可能是本体）> RKS 高（更可能是活跃号）。
 *  理由：实测「平方秒和立方吨」有 2 个同名仿号（`平方秒与立方吨` / `…吨.`），
 *  盲取第一个会把用户带到**别人的档案**上 —— 这正是"我搜不到我自己"的来源。 */
export function rankUserCands(users, name) {
  const low = String(name || '').trim().toLowerCase();
  const score = u => {
    const n = String(u.name || '').toLowerCase();
    let s = 0;
    if (n === low) s -= 1000;                       /* 完全同名，排最前 */
    if (n.startsWith(low)) s -= 200;                /* 前缀命中 */
    s += Math.abs(n.length - low.length) * 3;       /* 长度越接近越像 */
    if (!u.avatar) s += 40;                         /* 无头像的多半是小号/仿号 */
    s -= Math.min(30, (+u.rks || 0));               /* 活跃号优先 */
    if (u.bio) s -= 10;
    return s;
  };
  return (users || []).slice().sort((a, b) => score(a) - score(b));
}

/** 按谱师名扫**一页**搜索结果，并把结果按**命中字段**分三类。
 *
 *  为什么必须分：`/chart?search=` 匹配 name + charter + description（第 20 条）。
 *  实测搜「平方」59 条里，绝大多数是**别人的谱面描述里感谢了他**，
 *  一条都不是他的作品。三者混在一起看，用户会以为"搜到了"其实全是噪声。
 *
 *  @returns {exact, fuzzy, mentioned, scanned, count, page, pageNum, pages}
 *    exact     —— charter 字段与搜索词**完全相同**（最可能是本人/本团队）
 *    fuzzy     —— charter 字段**包含**搜索词（团队名、带后缀的写法）
 *    mentioned —— 只有 description（或曲名）提到，charter 完全不含 ⇒ **不是他的作品**
 */
export async function getCharterPage(name, opts) {
  const o = opts || {};
  const want = String(name || '').trim();
  const page = Math.max(1, o.page || 1);
  const pageNum = Math.min(30, Math.max(1, o.pageNum || 30));
  if (!want) return { exact: [], fuzzy: [], mentioned: [], count: 0, page, pageNum, pages: 1, scanned: 0 };
  const r = await searchCharts(want, { page, pageNum });
  const low = want.toLowerCase();
  const exact = [], fuzzy = [], mentioned = [];
  for (const c of r.charts) {
    if (c == null || c.id == null) continue;
    const ch = String(c.charter || '').trim().toLowerCase();
    if (ch === low) exact.push(c);
    else if (ch.includes(low)) fuzzy.push(c);
    else mentioned.push(c);      /* 命中的只能是 description / name */
  }
  return { exact, fuzzy, mentioned, count: r.count, page, pageNum,
           scanned: r.charts.length,
           pages: Math.max(1, Math.ceil(r.count / pageNum)) };
}

/** 连扫多页 `/chart?search=`，把命中按**字段来源**分三类（见 getCharterPage）。
 *  ⚠ 会真的打很多次 Phira 接口 —— 所以 maxPages 默认只给 10，
 *    并且由调用方决定要不要继续（不替用户做"扫 67 页"这种决定）。
 *  ⚠ 这条路是**兜底**，不是主路径 —— 主路径是 `getAllChartsByUploader`。 */
export async function scanCharter(name, opts) {
  const o = opts || {};
  const from = Math.max(1, o.fromPage || 1);
  const maxPages = Math.max(1, o.maxPages || 10);
  const pageNum = Math.min(30, Math.max(1, o.pageNum || 30));
  const seen = new Set(o.seen || []);
  const exact = [], fuzzy = [], mentioned = [];
  let count = 0, pages = 1, done = 0;

  for (let page = from; page < from + maxPages; page++) {
    let r;
    try { r = await getCharterPage(name, { page, pageNum }); }
    catch (e) { if (page === from) throw e; break; }
    count = r.count; pages = r.pages;
    const push = (arr, c) => { if (!seen.has(c.id)) { seen.add(c.id); arr.push(c); } };
    for (const c of r.exact) push(exact, c);
    for (const c of r.fuzzy) push(fuzzy, c);
    for (const c of r.mentioned) push(mentioned, c);
    done = page;
    if (typeof o.onProgress === 'function') {
      o.onProgress({ page, pages, count, exact: exact.length, fuzzy: fuzzy.length, mentioned: mentioned.length });
    }
    if (!r.scanned || page >= pages) break;      /* 已经到底 */
    if (o.signal && o.signal.aborted) break;
  }
  const byDiff = (a, b) => (+b.difficulty || 0) - (+a.difficulty || 0);
  return { exact: exact.sort(byDiff), fuzzy: fuzzy.sort(byDiff), mentioned: mentioned.sort(byDiff),
           count, pages, lastPage: done, seen: [...seen],
           truncated: done < pages };
}
