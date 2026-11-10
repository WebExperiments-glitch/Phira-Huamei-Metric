/* ============================================================
 * lib/routes.mjs —— 路由表的**单一真源**
 * ============================================================
 * 【为什么需要它】
 *   原来三处各写一份"这个端点是干什么的"：
 *     ① api-routes.mjs 里 18 个 `p === '/xxx'` 分支
 *     ② api-load.mjs 里用正则猜成本档（/^\/(charters|players)\// → expensive）
 *     ③ openapi.json 里再写一遍路径与 scope
 *   加一个端点要改三处，漏一处就出现"新端点是 cheap 档，被打时不被降级"这种
 *   只有出事才发现的 bug。
 *
 * 【本文件负责什么】
 *   · 路径 → { scope, cost, note } 的唯一映射
 *   · 供 api-load 判断成本档，供 api-routes 判断是否需要鉴权
 *   不负责：handler 的实现在哪（那还在 api-routes，下次迁移再说）
 *
 * 【为什么先只做这一半】
 *   把 18 个内联分支的 handler 搬进独立文件是**行为改动**，风险高；
 *   而"元信息集中"是**纯新增**，接错了立刻能在 check 里看出来。
 *   先做零风险的一半，剩下的一半等这一步稳了再动。
 *
 * 【cost 的含义】
 *   cheap     纯本地数据 / 常量，不碰数据库 → 压力下永不放弃
 *   normal    单次查库
 *   expensive 打上游（Phira）或跑引擎 → 压力下最先牺牲
 * ============================================================ */

/* scope: null = 公开只读，不需要任何身份；'admin' = 仅管理员 */
export const ROUTES = [
  /* ── 元信息 / 探针：全部 cheap ── */
  { m: 'GET', p: '/meta', cost: 'cheap', scope: null },
  { m: 'GET', p: '/openapi.json', cost: 'cheap', scope: null },
  { m: 'GET', p: '/versions', cost: 'cheap', scope: null },
  { m: 'GET', p: '/status', cost: 'cheap', scope: null },
  { m: 'GET', p: '/incidents', cost: 'cheap', scope: null },
  { m: 'GET', p: '/health', cost: 'cheap', scope: null },
  { m: 'GET', p: '/engines', cost: 'cheap', scope: null },
  { m: 'GET', p: '/engines/:id', cost: 'cheap', scope: null },
  { m: 'GET', p: '/reference', cost: 'cheap', scope: null },
  { m: 'GET', p: '/behavior', cost: 'cheap', scope: null },
  { m: 'GET', p: '/analyses/probe', cost: 'cheap', scope: null },

  /* ── 单次查库：normal ── */
  { m: 'GET', p: '/charts', cost: 'normal', scope: 'charts:read' },
  { m: 'GET', p: '/charts/:chart_id', cost: 'normal', scope: 'charts:read' },
  { m: 'GET', p: '/stats', cost: 'normal', scope: 'charts:read' },
  { m: 'GET', p: '/discrepancy', cost: 'normal', scope: 'charts:read' },
  { m: 'GET', p: '/usage', cost: 'normal', scope: 'usage:read' },
  { m: 'GET', p: '/keys', cost: 'normal', scope: 'usage:read' },
  { m: 'POST', p: '/keys', cost: 'normal', scope: 'usage:read' },
  { m: 'PATCH', p: '/keys/:id', cost: 'normal', scope: 'usage:read' },
  { m: 'DELETE', p: '/keys/:id', cost: 'normal', scope: 'usage:read' },
  { m: 'POST', p: '/keys/:id/rotate', cost: 'normal', scope: 'usage:read' },

  /* ── 打上游 / 跑引擎：expensive ── */
  { m: 'GET', p: '/charters/:uid', cost: 'expensive', scope: 'charts:read' },
  { m: 'GET', p: '/players/:uid', cost: 'expensive', scope: 'charts:read' },
  /* 上游文件中转：浏览器直连 CDN 因缺 CORS 头必然失败（见 lib/api-files.mjs）。
     算 expensive —— 它要拿我们的出口带宽去换上游文件。 */
  { m: 'GET', p: '/file', cost: 'expensive', scope: 'charts:read' },
  { m: 'POST', p: '/analyses', cost: 'expensive', scope: 'analyses:write' },

  /* ── 管理台：不走 gateApi，列出来是为了"所有端点都在表里" ── */
  { m: 'GET', p: '/admin/state', cost: 'cheap', scope: 'admin' },
  { m: 'POST', p: '/admin/set-admin2', cost: 'normal', scope: 'admin' },
  { m: 'GET', p: '/admin/keys', cost: 'normal', scope: 'admin' },
  { m: 'GET', p: '/admin/requests', cost: 'normal', scope: 'admin' },
  { m: 'GET', p: '/admin/endpoints', cost: 'normal', scope: 'admin' },
  { m: 'POST', p: '/admin/plan', cost: 'normal', scope: 'admin' },
  { m: 'POST', p: '/admin/decide', cost: 'normal', scope: 'admin' },
];

/* 把 '/charts/22681' 归一到 '/charts/:id'，便于查表 */
function normalize(p) {
  const s = String(p || '').split('?')[0].replace(/\/+$/, '');
  return s.replace(/\/charts\/\d+$/, '/charts/:chart_id')
    .replace(/\/charters\/[^/]+$/, '/charters/:uid')
    .replace(/\/players\/[^/]+$/, '/players/:uid')
    .replace(/\/engines\/[^/]+$/, '/engines/:id')
    .replace(/\/keys\/[^/]+\/rotate$/, '/keys/:id/rotate')
    .replace(/\/keys\/[^/]+$/, '/keys/:id');
}

const INDEX = new Map();
for (const r of ROUTES) INDEX.set(r.m + ' ' + r.p, r);

/* 查表。找不到时返回 null —— 调用方决定 404 还是按默认处理。 */
export function routeOf(method, path) {
  return INDEX.get(String(method || 'GET').toUpperCase() + ' ' + normalize(path)) || null;
}

/* 成本档。查不到按 normal —— 比默认 expensive 安全（不会被无谓牺牲），
   比默认 cheap 保守（不会给未知端点上"永不放弃"的特权）。 */
export function costOfPath(path, method = 'GET') {
  const r = routeOf(method, path);
  return r ? r.cost : 'normal';
}

/* 声明了这个 scope 就必须持 Key；null 表示公开 */
export function scopeOfPath(path, method = 'GET') {
  const r = routeOf(method, path);
  return r ? r.scope : null;
}
