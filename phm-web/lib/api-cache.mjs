/* ============================================================
 * lib/api-cache.mjs —— 结果级内存缓存（只给"几乎不变"的端点）
 * ============================================================
 * 【为什么需要】
 *   数据库在 AWS 新加坡，服务在北京 —— 每查一次库付 ~190ms 跨境往返。
 *   `/stats`、`/reference`、`/behavior` 这些结果**几分钟都不变一次**，
 *   却每次都要跨境跑一趟。缓存命中时直接返回，连库都不碰。
 *
 * 【为什么内存缓存能生效】
 *   之前以为部署是"一请求一进程"，缓存会立刻失效。
 *   实际观察 /meta 的 load 窗口：连续请求时 window 会累积到 7 条 ——
 *   说明**进程是复用的**（空闲才回收）。所以进程存活期间的缓存有效。
 *   冷启动后缓存为空，只是退化成"第一次要查库"，不会更慢。
 *
 * 【缓存什么，不缓存什么】
 *   缓存：结果是"全站统计/静态参照表"的端点 —— 变了也没人在意晚 30 秒
 *   不缓存：/charts（用户要看最新）、/file（二进制，走流式）、任何带身份的数据
 *
 * 【一致性】
 *   TTL 到期即失效，没有主动失效（数据源变动频繁到需要主动失效的，
 *   就不该进这张表）。加 ?nocache=1 可强制穿透，排障用。
 * ============================================================ */

const MAX_ENTRIES = 200;   /* 防参数组合爆炸把内存吃光（limit/offset 组合很多） */
const store = new Map();   /* key -> { at, ttl, data } */

function now() { return Date.now(); }

export function cacheGet(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (now() - e.at > e.ttl) { store.delete(key); return undefined; }
  return e.data;
}

export function cacheSet(key, data, ttl) {
  /* 超上限先删最旧的（Map 保持插入顺序）—— O(1)，不需要 LRU 链表 */
  if (store.size >= MAX_ENTRIES) {
    const first = store.keys().next();
    if (!first.done) store.delete(first.value);
  }
  store.set(key, { at: now(), ttl, data });
}

export function cacheStats() {
  let live = 0;
  const t = now();
  for (const e of store.values()) if (t - e.at <= e.ttl) live += 1;
  return { entries: store.size, live };
}

export function cacheClear() { store.clear(); }

/* 哪些端点可以缓存、多久。
   ⚠ 白名单而不是黑名单：新增端点默认**不缓存**，避免不小心把
     带用户身份的数据缓存了发给别人。 */
export const CACHEABLE = {
  '/stats': 60_000,
  '/reference': 30_000,
  '/behavior': 30_000,
  '/discrepancy': 60_000,
  '/engines': 300_000,     /* 引擎权重清单，几乎不变 */
};

/* 高阶封装：把"查缓存 → 未命中就执行 → 写回"压成一次调用。
   放这里而不是 api-routes 里，是为了让路由文件只留一行 —— 它已经 900 行了。 */
export async function withCache(url, endpoint, fn) {
  const ttl = CACHEABLE[endpoint];
  const bypass = /[?&]nocache=1/.test(String(url || ''));
  const key = ttl && !bypass ? endpoint + String(url || '') : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit !== undefined) return { data: hit, hit: true, cached: true };
  }
  const data = await fn();
  if (key) cacheSet(key, data, ttl);
  return { data, hit: false, cached: Boolean(key) };
}
