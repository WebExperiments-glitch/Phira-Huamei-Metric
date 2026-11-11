/* lib/api-cache.mjs —— 结果级内存缓存（只给"几乎不变"的端点）
 *
 * 数据库在 AWS 新加坡、服务在北京，每查一次付 ~190ms 跨境。
 * /stats /reference /behavior 几分钟都不变一次，缓存命中就完全不碰库。
 *
 * 进程会复用（观察 /meta 的 load 窗口会累积），所以内存缓存有效；
 * 冷启动后退化成"第一次要查库"，不会更慢。
 *
 * 白名单而非黑名单：新端点默认**不缓存**，避免把带身份的数据缓存后发给别人。
 * TTL 到期即失效，无主动失效；`?nocache=1` 可强制穿透。
 */

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
