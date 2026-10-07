/* ============================================================
 * tools/warm-cache.mjs —— 批量预热共享定数缓存
 * ============================================================
 * 【为什么要它】
 *   页面的价值取决于「搜任何一张谱都能出定数」。空库时来的人看到
 *   「定数缓存 15 张」就走了 —— 所以推广前必须先把库填起来。
 *
 * 【填哪些】默认填 **金标集**：`type=0`（Ranked，计入 rks）+ `type=1`（Special），
 *   实测 581 + 50 = 631 张。这批就是玩家真正会在意定数的谱，
 *   比按创建时间乱抓一批有用得多。
 *
 * 【怎么填】
 *   直接复用服务端的复核链路 `lib/review.mjs → recompute()`：
 *   向 Phira 要文件地址 → 下载谱面包 → 用同一份引擎算 → 经
 *   `phm_put_chart()`（受凭据保护）落库。**没有任何客户端数值参与**。
 *
 * 【断点续跑】每次开始时先拉一遍已有的 chart_id，已缓存的直接跳过。
 *   中断了重跑即可，不会重复下载。
 *
 * ⚠ **改了引擎（ENGINE_VER 变了）之后，这个脚本帮不了你** ——
 *   它只填"库里还没有的谱"，而已有的行还停在旧算法的数值上。
 *   那种情况要跑：
 *       node tools/reconcile-cache.mjs --stale-only            # 先看有多少过期行
 *       node tools/reconcile-cache.mjs --recompute-stale --limit 9999
 *   这也是 engine_build 这一列存在的唯一理由：让"哪些行是旧算法算的"可查，
 *   而不是每次都全量重算一遍。
 *
 * 用法（在 phm-web/ 目录下）：
 *     node tools/warm-cache.mjs --limit 600
 *     node tools/warm-cache.mjs --dry-run            # 只看计划，不下载
 *     node tools/warm-cache.mjs --types 0 --limit 50 # 只填 Ranked
 *     node tools/warm-cache.mjs --include-popular    # additionally 补热门榜
 *
 * ⚠ 会下载约 7 GB 流量、跑 20~40 分钟。已刻意做成**串行**：
 *   并发下载对 Phira 不礼貌，且 analyzeChart 是同步计算，并发也压不出吞吐。
 * ============================================================ */
import { recompute } from '../lib/review.mjs';
import { dbPutChart, dbListChartIds, WRITE_SECRET } from '../lib/cloud.mjs';

const API = 'https://api.phira.cn';
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes('--' + name);

const LIMIT = Number(opt('limit', 600));
const TYPES = String(opt('types', '0,1')).split(',').map(s => s.trim()).filter(Boolean);
const DRY = flag('dry-run');
const INCLUDE_POPULAR = flag('include-popular');
const GAP_MS = Number(opt('gap', 120));      /* 两次写库之间的间隔 */
const PAGE_SIZE = 30;                        /* pageNum 上限就是 30，写 50 会 400 */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + stamp() + ']', ...a);

async function apiGet(pathAndQuery, timeoutMs = 40000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API + pathAndQuery, {
      signal: ctl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'PHM-Standard/warm-cache' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* 枚举金标集（`results` 才是正确的键名，官方文档写的 `result` 是错的） */
async function listGold() {
  const out = new Map();                        /* chart_id → 谱面摘要 */
  for (const type of TYPES) {
    const first = await apiGet(`/chart?pageNum=${PAGE_SIZE}&page=1&type=${type}`);
    const total = first.count || 0;
    const pages = Math.ceil(total / PAGE_SIZE);
    log(`type=${type}：共 ${total} 张，${pages} 页`);
    const take = (j) => {
      for (const c of (j.results || [])) {
        if (c && c.id && c.file) out.set(c.id, c);   /* 没有 file 的谱算不了，直接跳过 */
      }
    };
    take(first);
    for (let p = 2; p <= pages; p++) {
      take(await apiGet(`/chart?pageNum=${PAGE_SIZE}&page=${p}&type=${type}`));
      await sleep(320);                            /* 对 Phira 客气一点 */
      if (p % 10 === 0) log(`  …枚举 ${p}/${pages} 页，已收 ${out.size} 张`);
    }
  }
  if (INCLUDE_POPULAR) {
    const pop = await apiGet('/chart/popular');
    const list = Array.isArray(pop) ? pop : (pop.results || []);
    for (const c of list) if (c && c.id && c.file) out.set(c.id, c);
    log(`补热门榜 ${list.length} 条，去重后合计 ${out.size} 张`);
  }
  return out;
}

/* ── main ── */
if (!WRITE_SECRET) {
  console.error('✗ 没有读到写入凭据（PHM_WRITE_SECRET 或 write-secret.txt）。');
  console.error('  批量任务必须能写库，否则白跑。先在 phm-web/ 下放好 write-secret.txt。');
  process.exit(1);
}

log('拉取已缓存的 chart_id …');
const cached = await dbListChartIds();
log(`库里已有 ${cached.size} 张`);

log('枚举金标集 …');
const gold = await listGold();

const missing = [...gold.values()].filter(c => !cached.has(c.id));
const todo = missing.slice(0, LIMIT);
log(`金标集 ${gold.size} 张 · 其中已缓存 ${gold.size - missing.length} 张 · 待处理 ${missing.length} 张`
  + (missing.length > LIMIT ? `（本次按 --limit 只做前 ${LIMIT} 张）` : ''));

if (DRY) {
  console.log('\n--dry-run：只列前 10 张，不下载\n');
  todo.slice(0, 10).forEach((c, i) =>
    console.log(`  ${i + 1}. #${c.id}  ${c.name}  ${c.level}  标称 ${(+(c.difficulty || 0)).toFixed(2)}`));
  console.log(`\n共 ${todo.length} 张待处理。去掉 --dry-run 即开始。`);
  process.exit(0);
}
if (!todo.length) { log('没有待处理的谱面，收工。'); process.exit(0); }

const started = Date.now();
let done = 0, failed = 0, idx = 0;
const failures = [];

for (const c of todo) {
  idx++;
  const tag = `[${String(idx).padStart(4)}/${todo.length}]`;
  try {
    const row = await recompute(c.id);            /* 下载 → 用同一份引擎复算 */
    const wr = await dbPutChart(row);
    if (!wr.ok) throw new Error('写库失败 ' + (wr.fail[0] || ''));
    done++;
    if (idx % 10 === 0 || idx === todo.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = idx / elapsed;
      const eta = Math.round((todo.length - idx) / rate / 60);
      log(`${tag} ✓ ${String(row.name).slice(0, 22)}  ref=${row.ref_const}  `
        + `| 成功 ${done} 失败 ${failed} | ${rate.toFixed(2)}/s  ETA ${eta}m`);
    }
  } catch (e) {
    failed++;
    const msg = String((e && e.message) || e).slice(0, 120);
    failures.push({ chart_id: c.id, name: c.name, error: msg });
    log(`${tag} ✗ #${c.id} ${String(c.name).slice(0, 20)} — ${msg}`);
  }
  await sleep(GAP_MS);
}

const mins = Math.round((Date.now() - started) / 60000);
console.log('\n──────── 完成 ────────');
console.log(`成功 ${done} · 失败 ${failed} · 用时 ${mins} 分钟`);
if (failures.length) {
  console.log('\n失败明细（前 20 条；失败的谱下次重跑会自动重试）：');
  failures.slice(0, 20).forEach(f => console.log(`  #${f.chart_id} ${f.name} — ${f.error}`));
}
const after = await dbListChartIds();
console.log(`\n库里现在共 ${after.size} 张定数缓存。`);
