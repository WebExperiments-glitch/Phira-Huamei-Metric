/* ============================================================
 * lib/db-pg.mjs —— 用 `pg` 直连 Postgres，但对外保持 PostgREST 的调用形状
 * ============================================================
 * 【为什么要有这一层】
 *   站点原来是靠 CloudBase 提供的 PostgREST 端点（`/rpc/x`、`/table?col=eq.v`）。
 *   换成 Neon 之后没有那个端点了 —— 但**业务代码一行都不想动**：
 *   `lib/` 下 7 个模块 + `tools/` 下 5 个脚本，全都在用 `dbFetch('/rpc/…')`。
 *
 *   所以这一层的任务很窄：**把 PostgREST 的那点语法翻译成 SQL**。
 *   只翻译代码里真实用到的子集（见下面的 SUPPORTED），不做通用实现 ——
 *   多写的那部分没人测，等于埋雷。
 *
 * 【为什么不用 Neon 的 Data API】
 *   它确实是 PostgREST 兼容的，换 `DB.base` 就行，成本最低。但它在 Beta，
 *   而且多一层跳转就多一个能坏的地方 —— 这次出事就是因为"平台的一个行为
 *   变化能让整条链路断"。直连 Postgres 的话，Postgres 本身就是标准。
 *
 * 【为什么是动态 import】
 *   项目一直零运行期依赖。只有显式切到 pg 驱动时才需要 `pg`，
 *   所以不在模块顶层 import —— 否则没装 pg 的环境连启动都起不来。
 * ============================================================ */

/* 代码里真实出现的算子（grep 出来的全集，不是"应该支持"的清单）：
     eq.  in.(  order=  limit=  select=  offset=  gte.  lte.
   ⚠ 加新算子要同时加测试，否则就是个没人验证过的分支。 */
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

let POOL = null;
let POOL_URL = '';
let READY = null;      /* 建池 + 预热合成的**单个** promise，见 ready() */

/* ⚠ 用 createRequire 而不是 `await import('pg')`：
   ESM 的解析**不看 NODE_PATH**，而 CJS 的 require 看。更重要的是——它按
   `import.meta.url` 从**本项目**的 node_modules 找，正是我们要的语义
   （谁部署谁装依赖，不去猜全局装在哪）。 */
import { createRequire } from 'node:module';
const requireLocal = createRequire(import.meta.url);

/** 懒加载连接池。`pg` 只在真的走这条路时才需要。 */
async function pool(url) {
  if (POOL && POOL_URL === url) return POOL;
  let Pool;
  try {
    ({ Pool } = requireLocal('pg'));
  } catch (e) {
    throw new Error('走 pg 驱动需要安装 pg（在 phm-web 下 npm i pg）。当前部署没带 node_modules，见 lib/db-pg.mjs 顶部。');
  }
  /* ⚠ numeric(int8) 默认被 node-postgres 解析成**字符串**（防止精度丢失），
     而 PostgREST 回的是 JSON 数字。不改的话缓存行里的 difficulty/ref_const 全变成
     "12.3" 这种字符串，前端一做算术就得到 NaN —— 而且不报错，只是数字全错。
     int8 也一样（chart_id 是 bigint）。这两个都在 2^53 以内，转 Number 是安全的。 */
  const { types } = requireLocal('pg');
  types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));   /* numeric */
  types.setTypeParser(20, v => (v === null ? null : Number(v)));         /* int8   */

  POOL = new Pool({
    connectionString: url,
    /* 8 条：限流那条路径会**并发**打几十个计数请求（anti-abuse 的突发），
       4 条连接时它们排长队，冷启动叠加排队会撞 8s 超时 → 掉进 fail-open。
       8 条仍在 Neon 免费档的钳制之内，且不会因为空闲被大量回收。 */
    max: 8,
    idleTimeoutMillis: 30_000,
    /* ⚠ 30 秒，不是 10 秒：Neon 免费档**空闲 5 分钟就把 compute 缩到零**，
       下一个请求要等它唤醒。实测首次唤醒 10~13 秒（不是文档说的几百毫秒），
       10 秒的连接超时会让"部署后第一个访客"直接吃一个 504。 */
    connectionTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: true },
  });
  /* 池里的连接被上游掐断时不许把进程带走 —— 记一条，下一句自己重连 */
  POOL.on('error', (e) => console.error('[db-pg] 空闲连接出错（已忽略）：', e.message));
  POOL_URL = url;
  return POOL;
}

/** 函数参数名缓存：`hm_put_chart(p_secret, p_row)` → ['p_secret','p_row'] */
const ARG_CACHE = new Map();

async function argNames(p, tableOrFn) {
  if (ARG_CACHE.has(tableOrFn)) return ARG_CACHE.get(tableOrFn);
  const r = await p.query(
    `select coalesce(array_agg(a.argname order by a.ord) filter (where a.argname is not null), '{}') as names
       from pg_proc f
       join pg_namespace n on n.oid = f.pronamespace
       left join lateral unnest(f.proargnames) with ordinality a(argname, ord) on true
      where n.nspname = 'public' and f.proname = $1
      group by f.oid
      limit 1`, [tableOrFn]);
  /* ⚠ 必须区分两件事，它们看起来一样：
       · 查不到行      → **函数不存在**（返回 null）
       · 有行但名字为空 → **函数无参**（返回 []，拼成 fn()）
     第一版把两者都当成"不存在"，于是 phm_stats() 永远调不到 —— 而它明明在。
     （空数组还会被 array_agg 变成 {NULL}，所以要 filter 掉 null。） */
  if (!r.rows.length) { ARG_CACHE.set(tableOrFn, null); return null; }
  const names = (r.rows[0].names || []).filter(n => n != null && n !== '');
  ARG_CACHE.set(tableOrFn, names);
  return names;
}

/** 带取消的超时。返回 `{ promise, cancel }` —— 成功路径必须 cancel，否则计时器白跑。 */
function raceTimeout(ms) {
  let timer = null;
  const promise = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('db timeout'), { code: 'TIMEOUT' })), ms);
    if (timer.unref) timer.unref();
  });
  /* ⚠ 挂一个空 catch：`Promise.race` 只会"用"最先落定的那个，
     输的那一个如果不接，它的 rejection 就变成未处理 —— 进程直接退出。 */
  promise.catch(() => {});
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/** 把 PostgREST 的查询串翻译成 WHERE 子句 + 参数。 */
function buildWhere(params, startIdx = 1) {
  const where = [];
  const vals = [];
  let i = startIdx;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const dot = v.indexOf('.');
    if (dot < 0) continue;
    const op = v.slice(0, dot);
    const raw = v.slice(dot + 1);
    if (op === 'in') {
      /* PostgREST 的写法：in.(1,2,3)；带引号的元素（"a,b"）这里不支持 —— 代码里没出现过 */
      const list = raw.replace(/^\(|\)$/g, '').split(',').filter(x => x !== '');
      if (!list.length) { where.push('false'); continue; }
      where.push(`${quoteIdent(k)} = any($${i}::text[])`);
      vals.push(list);
      i++;
      continue;
    }
    if (!OPS[op]) continue;   /* 不认识的算子直接忽略，别拼出语法错 */
    where.push(`${quoteIdent(k)} ${OPS[op]} $${i}`);
    vals.push(raw);
    i++;
  }
  return { sql: where.length ? ' where ' + where.join(' and ') : '', vals, nextIdx: i };
}

/** 标识符白名单：只允许 [a-z0-9_]，双引号包起来。防的是把用户输入拼进列名。 */
function quoteIdent(s) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error('非法标识符：' + s);
  return '"' + s + '"';
}

function buildOrder(raw) {
  if (!raw) return '';
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean).map(seg => {
    const [col, ...rest] = seg.split('.');
    const dir = rest.some(r => r.toLowerCase() === 'desc') ? 'desc' : 'asc';
    return quoteIdent(col) + ' ' + dir;
  });
  return parts.length ? ' order by ' + parts.join(', ') : '';
}

function statusFor(e) {
  /* 尽量给出"像 HTTP"的状态，让调用方原来的判断（429 / 23505 / 42501）继续成立 */
  if (e.code === '42501') return 401;
  if (e.code === '23505') return 409;
  if (e.code === 'P0001' || e.code === 'P0002') return 400;
  if (/timeout|ECONN|ETIMEDOUT/i.test(e.message || '')) return 504;
  return 500;
}

/**
 * 造一个和 `cloud.mjs` 的 dbFetch **同签名同返回**的函数。
 * @param {string} url 连接串（运行期用池化端点即可）
 */
export function makePgFetch(url) {
  /* 预热与真实请求**必须共用同一个 promise**。
     ⚠ 第一版是"后台预热 + 请求各连各的"，于是两个连接同时去唤醒已缩到零的
       Neon compute，其中一个被掐断（Connection terminated due to connection
       timeout），而恰好是测试里那条"跨进程仍被挡下"吃了这个坑 ——
       它看起来像限流失效，其实是连库失败后退回了内存限流。
     串成一条链之后：只连一次，请求等它，失败则下次重试。 */
  const ready = () => {
    if (!READY) {
      READY = (async () => {
        const p = await pool(url);
        await p.query('select 1');
        return p;
      })().catch((e) => {
        READY = null;                    /* 允许下一次重试 */
        throw e;
      });
    }
    return READY;
  };
  ready().catch(e => console.warn('[db-pg] 预热失败（下次请求会重试）：' + e.message));

  return async function pgFetch(pathAndQuery, init, timeoutMs = 15000, maxBody = 8192) {
    const t0 = Date.now();
    let p;
    try {
      p = await ready();
      const method = (init && init.method) || 'GET';
      const qIdx = pathAndQuery.indexOf('?');
      const path = qIdx < 0 ? pathAndQuery : pathAndQuery.slice(0, qIdx);
      const qs = qIdx < 0 ? '' : pathAndQuery.slice(qIdx + 1);
      const params = new URLSearchParams(qs);
      /* ⚠ 超时必须是**可取消**的。第一版写成裸 setTimeout + Promise.race，
         于是 race 结束后那个计时器照样会 reject —— 而那时已经没有 handler，
         Node 直接当 unhandledRejection 抛出去，**把进程打挂**。
         （这正是本项目遇到过的第三类事故形态：输的那一半没人接。） */
      const timeout = raceTimeout(timeoutMs);

      /* ── RPC：POST /rpc/<fn> ── */
      if (path.startsWith('/rpc/')) {
        const fn = path.slice(5);
        const body = init && init.body ? JSON.parse(init.body) : {};
        const names = await argNames(p, fn);
        if (names === null) throw Object.assign(new Error(`function ${fn} 不存在`), { code: '42883' });
        /* 按函数声明的参数顺序取值 —— 用 JSON 的键名对，不靠调用方保证顺序 */
        const args = names.map(n => (body[n] === undefined ? null : body[n]));
        const holes = names.filter(n => body[n] === undefined);
        if (holes.length) console.warn(`[db-pg] /rpc/${fn} 少传参数：${holes.join(',')}（按 null 处理）`);
        const sql = `select * from public.${quoteIdent(fn)}(${args.map((_, i) => '$' + (i + 1)).join(',')})`;
        let r;
        try { r = await Promise.race([p.query(sql, args), timeout.promise]); }
        finally { timeout.cancel(); }
        /* 标量返回（jsonb/text/int）时 PostgREST 直接把值当 body；
           只有一列且列名等于函数名 → 就是标量。setof 复合类型走 else（数组）。 */
        const one = r.fields.length === 1 && r.fields[0].name === fn;
        const payload = one ? (r.rows[0] ? r.rows[0][fn] : null) : r.rows;
        const txt = JSON.stringify(payload === undefined ? null : payload);
        return { ok: true, status: 200, body: txt.slice(0, maxBody) };
      }

      /* ── 表：GET /<table>?… ── */
      const table = path.replace(/^\//, '');
      if (method !== 'GET') throw Object.assign(new Error('只实现了 GET 与 /rpc。方法 ' + method + ' 未支持'), { code: 'P0001' });

      const select = params.get('select') || '*';
      const cols = select === '*' ? '*' : select.split(',').map(s => quoteIdent(s.trim())).join(', ');
      const { sql: whereSql, vals, nextIdx } = buildWhere(params);
      const order = buildOrder(params.get('order'));
      const limit = params.get('limit') ? Math.max(0, Math.min(100000, +params.get('limit'))) : null;
      const offset = params.get('offset') ? Math.max(0, +params.get('offset')) : 0;

      /* 分页要"总数"：PostgREST 靠 Prefer: count=exact + content-range 头。
         这里同样算一次 count，让上层分页逻辑原样可用。 */
      const wantCount = String((init && init.headers && (init.headers.Prefer || init.headers.prefer)) || '')
        .includes('count=exact');
      let contentRange;
      if (wantCount) {
        const ct = raceTimeout(timeoutMs);
        let c;
        try { c = await Promise.race([p.query(`select count(*)::int as n from ${quoteIdent(table)}${whereSql}`, vals), ct.promise]); }
        finally { ct.cancel(); }
        contentRange = `0-${Math.max(0, c.rows[0].n - 1)}/${c.rows[0].n}`;
      }

      let sql = `select ${cols} from ${quoteIdent(table)}${whereSql}${order}`;
      if (limit != null) sql += ` limit ${limit}`;
      if (offset) sql += ` offset ${offset}`;
      let r;
      try { r = await Promise.race([p.query(sql, vals), timeout.promise]); }
      finally { timeout.cancel(); }
      return { ok: true, status: 200, body: JSON.stringify(r.rows).slice(0, maxBody), contentRange };
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      console.warn(`[db-pg] ${pathAndQuery} 失败（${Date.now() - t0}ms）：${msg}`);
      /* ⚠ body 里保留 Postgres 原文：调用方靠 /23505|duplicate key/ 区分"邮箱已注册" */
      return { ok: false, status: statusFor(e), body: JSON.stringify({ code: e.code || 'ERROR', message: msg }) };
    }
  };
}
