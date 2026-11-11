/* tools/crawl-incremental.mjs —— Phira 增量补抓
 *
 * 用法：
 *   node tools/crawl-incremental.mjs --list          只重扫 regular 列表（326 页）
 *   node tools/crawl-incremental.mjs --ids           只补最新 id 段
 *   node tools/crawl-incremental.mjs --all           两样都做
 *   node tools/crawl-incremental.mjs --verify 50     抽样验证本地数据是否还有效
 *   node tools/crawl-incremental.mjs --dry           只报告会抓什么，不发请求
 *
 * ── 为什么是 4 并发，不是 32 ──────────────────────────────
 *   Phira 是公益服务（Cloudflare 后面是小团队）。32 并发等于每秒 32 个请求，
 *   对它是小型 DoS；而 326 页用 4 并发只要 3 分钟，用 32 也省不下 2 分钟。
 *   省两分钟换别人服务器挨打、换我们被 CF 封 IP —— 不划算。
 *   32 线程留给本地处理（解析、特征、写库），那里没有第三方受影响。
 *
 * ── 反推出来的 API 事实（2026-11-11 实测）──────────────────
 *   GET /chart?page=N     只返回 tags 含 regular 的谱，326 页封顶（count=9758）
 *   GET /chart?tag=/uid=  **所有筛选参数都被忽略**，永远返回同一批
 *   GET /chart/{id}       任何类都能取（troll/plain 也能）
 *   所以：非 regular 的谱只能靠 id 逐个补，列表拿不到。
 *
 * ── 断点续传 ────────────────────────────────────────────
 *   每页抓完立刻追加到 data/crawl/list-incremental.jsonl 并记进度到 .state.json。
 *   中断后重跑会从断点继续，不会重复请求已完成的页。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
/* ⚠ 数据目录在**项目根**（D:/自研AI 生成谱面/data/crawl），不在 phm-web 里 ——
   ROOT 是 phm-web/，所以要往上一级。 */
const CRAWL = path.resolve(ROOT, '..', 'data', 'crawl');
const OUT_LIST = path.join(CRAWL, 'list-incremental.jsonl');
const OUT_IDS = path.join(CRAWL, 'ids-incremental.jsonl');
const STATE = path.join(CRAWL, '.state.json');

const API = 'https://api.phira.cn';
const CONC = Number(process.env.PHM_CONC || 16);   /* 用户指定 16；遇 429 会自动降到 4 */
const JITTER_MS = [300, 600]; /* 并发高就把间隔拉长，否则等于几十 req/s 的洪水 */
let BACKOFF = 1;               /* 命中 429 后放大，所有 worker 共享 */
const RETRY = 2;
const PAGE_SIZE = 30;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep((JITTER_MS[0] + Math.random() * (JITTER_MS[1] - JITTER_MS[0])) * BACKOFF);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(CRAWL, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function loadIds(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.id) set.add(Number(o.id)); } catch { /* 跳过坏行 */ }
  }
  return set;
}

async function getJson(p, attempt = 0) {
  try {
    const r = await fetch(API + p, {
      headers: { 'user-agent': 'phm-research/1 (difficulty reference; contact via site)' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429) {                     /* 被限流就让路，别硬冲 */
      BACKOFF = Math.min(BACKOFF * 3, 12);      /* 全局降速：所有 worker 一起慢下来 */
      const wait = 4000 * (attempt + 1);
      console.warn('  · 429 → 全局减速 x' + BACKOFF + '，等 ' + wait + 'ms');
      await sleep(wait);
      if (attempt < RETRY) return getJson(p, attempt + 1);
      return null;
    }
    if (!r.ok) return { __status: r.status };
    return await r.json();
  } catch (e) {
    if (attempt < RETRY) { await sleep(1000 * (attempt + 1)); return getJson(p, attempt + 1); }
    return { __error: String(e && e.message || e) };
  }
}

/* ── 1) regular 列表重扫 ─────────────────────────────── */
async function crawlList() {
  const st = loadState();
  /* ⚠ 必须把**主库**也算进 seen。只读增量文件的话，每次都会把已有谱当新增写一遍
     （2026-11-11 实测：报了"新增 9068"，合并时才发现 9703 条是重复的）。 */
  const seen = new Set([
    ...loadIds(path.join(CRAWL, 'charts.jsonl')),
    ...loadIds(OUT_LIST),
  ]);
  const startPage = has('--restart') ? 1 : (st.listPage || 1);
  console.log('  列表重扫：从第 ' + startPage + ' 页开始（已有 ' + seen.size + ' 条增量）');

  let page = startPage, added = 0, empty = 0, count = null;
  const out = fs.createWriteStream(OUT_LIST, { flags: 'a' });

  /* 固定 4 个 worker 拉同一个页码队列 —— 比"一批 4 个"更快，且并发恒定 */
  const queue = [];
  let next = page;
  const TOTAL_MAX = 400;   /* 兜底：326 页封顶，留点余量 */

  const worker = async () => {
    while (true) {
      if (queue.length === 0 && next > TOTAL_MAX) return;
      let p = queue.shift();
      if (p === undefined) {
        if (next > TOTAL_MAX) return;
        p = next++;
        if (count !== null && p * PAGE_SIZE > count + PAGE_SIZE) return;
      }
      const d = await getJson('/chart?page=' + p);
      await jitter();
      if (!d || d.__error || d.__status) { empty++; continue; }
      if (count === null && typeof d.count === 'number') {
        count = d.count;
        console.log('  API count = ' + count + '（约 ' + Math.ceil(count / PAGE_SIZE) + ' 页）');
      }
      const rows = d.results || [];
      if (rows.length === 0) { empty++; if (empty > 6) return; continue; }
      empty = 0;
      for (const row of rows) {
        const id = Number(row.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.write(JSON.stringify(row) + '\n');
        added++;
      }
      st.listPage = Math.max(st.listPage || 1, p + 1);
      if (p % 25 === 0) { saveState(st); console.log('  已到第 ' + p + ' 页，新增 ' + added + ' 条'); }
    }
  };

  await Promise.all(Array.from({ length: CONC }, worker));
  out.end();
  st.listPage = TOTAL_MAX + 1;
  saveState(st);
  console.log('  列表重扫完成：新增 ' + added + ' 条 → ' + path.relative(ROOT, OUT_LIST));
}

/* ── 2) 最新 id 段 ──────────────────────────────────── */
async function crawlIds() {
  /* 先问第一页拿当前最大 id（一个请求） */
  const head = await getJson('/chart?page=1');
  const maxRemote = Math.max(...((head && head.results) || []).map((x) => Number(x.id) || 0));
  const localMax = Math.max(...loadIds(path.join(CRAWL, 'charts.jsonl')), ...loadIds(path.join(CRAWL, 'list-incremental.jsonl')));
  console.log('  本地最大 id ' + localMax + ' → 远端可见最大 ' + maxRemote);

  const from = Number(val('--from')) || (localMax - 200);   /* 往回退 200 号，补漏 */
  const to = Number(val('--to')) || (maxRemote + 200);
  console.log('  id 段 ' + from + ' … ' + to + '（' + (to - from + 1) + ' 个号，预计 404 居多）');

  const known = loadIds(path.join(CRAWL, 'charts.jsonl'));
  const done = loadIds(OUT_IDS);
  const out = fs.createWriteStream(OUT_IDS, { flags: 'a' });

  let next = from, found = 0, miss = 0;
  const worker = async () => {
    while (true) {
      const id = next++;
      if (id > to) return;
      if (known.has(id) || done.has(id)) { miss++; continue; }
      const d = await getJson('/chart/' + id);
      await jitter();
      if (!d || d.__error || d.__status) { miss++; continue; }
      out.write(JSON.stringify(d) + '\n');
      done.add(id); found++;
      if (found % 20 === 0) console.log('  已补 ' + found + ' 条（扫到 id ' + id + '）');
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  out.end();
  console.log('  id 段完成：新增 ' + found + ' 条，跳过/未命中 ' + miss + ' → ' + path.relative(ROOT, OUT_IDS));
}

/* ── 3) 抽样验证本地数据是否还有效 ───────────────────── */
async function verify(n) {
  const all = [...loadIds(path.join(CRAWL, 'charts.jsonl'))];
  const sample = [];
  for (let i = 0; i < Math.min(n, all.length); i++) {
    sample.push(all[Math.floor(Math.random() * all.length)]);
  }
  let ok = 0, gone = 0, err = 0;
  for (const id of sample) {
    const d = await getJson('/chart/' + id);
    await jitter();
    if (!d) { err++; continue; }
    if (d.__status === 404) gone++;
    else if (d.__status) err++;
    else ok++;
  }
  console.log('  抽样 ' + sample.length + ' 条：有效 ' + ok + ' / 已失效 ' + gone + ' / 出错 ' + err);
  console.log('  失效率 ' + (gone / sample.length * 100).toFixed(1) + '%');
}

/* ── 入口 ── */
if (has('--dry')) {
  console.log('  [dry] 会做：');
  console.log('   · regular 列表 1..326 页，' + CONC + ' 并发，jitter ' + JITTER_MS.join('-') + 'ms');
  console.log('   · 最新 id 段，' + CONC + ' 并发');
  console.log('   · 不发任何请求');
} else if (has('--verify')) {
  await verify(Number(val('--verify')) || 30);
} else if (has('--list')) {
  await crawlList();
} else if (has('--ids')) {
  await crawlIds();
} else if (has('--all')) {
  await crawlList();
  await crawlIds();
} else {
  console.log('用法：--list | --ids | --all | --verify <n> | --dry [--restart] [--from N] [--to N]');
}
