#!/usr/bin/env node
/* ============================================================
 * tools/predeploy.mjs —— **发布前闸门**（部署前后各跑一次）
 * ============================================================
 * ⚠ 与 `tools/preflight.mjs` 不是一回事，别合并：
 *     preflight   = **推送**闸门（pre-push 钩子调），看源码与离线检查
 *     predeploy   = **发布**闸门（人调），看运行时契约 —— 库里函数在不在、
 *                   tag 打没打、线上跑的是不是这一版、白名单漏没漏
 *
 * 【为什么需要它】
 *   `npm run check` 管的是「代码对不对」，管不了「这次能不能发」。
 *   2026-10-20 的真实事故正好落在缝里：`db/api-v2/20.sql` 里 4 个 RPC
 *   **只写了 revoke、忘了 grant**，本地全绿、CI 全绿，直到部署前手工验一次
 *   才发现 `permission denied`。光有单测不够 —— 得有人在发布前真的去问一句
 *   「库里那些函数现在能用吗」。这个文件就是那句问话。
 *
 * 【三种结果，必须分开】
 *   ✅ 通过    ⚠ 跳过（环境缺东西，并**说明为什么**）    ❌ 失败（阻断发布）
 *   把"本机没数据库"当失败 → 人就会开始加 --force；
 *   把真失败当跳过 → 就是今天这个 bug。
 *
 * 【用法】
 *   node tools/predeploy.mjs          # 发布前：版本 / tag / 工作区 / 生成物 / 数据库
 *   node tools/predeploy.mjs --prod   # 部署后：额外复验生产域名
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = process.argv.includes('--prod');
const PROD_ORIGIN = 'https://phm.app.workbuddy.host';

let pass = 0, fail = 0, skip = 0;
const ok = (m, extra) => { pass++; console.log('  ✅ ' + m + (extra ? '  (' + extra + ')' : '')); };
const bad = (m, extra) => { fail++; console.log('  ❌ ' + m + (extra ? '  → ' + extra : '')); };
const warn = (m, extra) => { skip++; console.log('  ⚠ ' + m + (extra ? '  → ' + extra : '')); };

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const has = rel => fs.existsSync(path.join(ROOT, rel));
const git = args => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

const pkg = JSON.parse(read('package.json'));
const VER = 'V' + pkg.version;

/* ══════════════════════════════════════════════════════════
 * 1) 版本与 tag
 * ══════════════════════════════════════════════════════════ */
console.log('\n[1] 版本 / tag');
{
  const first = (read('CHANGELOG.md').match(/^\| `V(\d+\.\d+\.\d+\.\d+)`/m) || [])[1];
  if (!first) bad('CHANGELOG 里找不到版本行');
  else if ('V' + first !== VER) bad('CHANGELOG 首位与 package.json 不一致', 'CHANGELOG=' + first + ' pkg=' + pkg.version);
  else ok('CHANGELOG 首位 = package.json', VER);

  const meta = (read('public/index.html').match(/name="app-version" content="([^"]+)"/) || [])[1];
  if (meta !== VER) bad('index.html 的 app-version 与 package.json 不一致', String(meta));
  else ok('app-version = ' + VER);

  /* tag 是发布的"签名"：没有它，以后没人能说清线上是哪一版 */
  const want = 'v' + pkg.version;
  const here = git(['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean);
  if (!here.length) warn('HEAD 上没有 tag（发布前先 git tag -a ' + want + '）');
  else if (here.includes(want)) ok('HEAD 已打 tag', want);
  else bad('HEAD 上的 tag 与版本号不符', here.join(',') + ' ≠ ' + want);
}

/* ══════════════════════════════════════════════════════════
 * 2) 工作区 / 分支（发出去的东西必须就是仓库里的东西）
 * ══════════════════════════════════════════════════════════ */
console.log('\n[2] 工作区 / 分支');
{
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean);
  if (dirty.length) bad('有未提交改动 —— 部署上传的是磁盘内容，会和仓库不一致', dirty.slice(0, 3).join(' / '));
  else ok('工作区干净');

  const br = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (br !== 'main') warn('当前不在 main 上', br); else ok('在 main 上');

  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'refs/remotes/phm/main']) || git(['rev-parse', 'origin/main']);
  if (!remote) warn('拿不到远端 main（还没 fetch？）');
  else if (local !== remote) bad('本地 main 与远端不一致 —— 先 push / pull', local.slice(0, 7) + ' ≠ ' + remote.slice(0, 7));
  else ok('本地 main = 远端 main', local.slice(0, 7));
}

/* ══════════════════════════════════════════════════════════
 * 3) 生成物 / 迁移脚本
 * ══════════════════════════════════════════════════════════ */
console.log('\n[3] 生成物 / 迁移脚本');
{
  for (const [f, needle] of [['public/js/release.js', 'siteVer'], ['tools/golden-engine.json', 'engineVer']]) {
    if (!has(f)) { bad('缺生成物 ' + f); continue; }
    if (!read(f).includes(needle)) bad(f + ' 结构异常（找不到 ' + needle + '）');
    else ok(f + ' 可用');
  }
  ok('生成物与真源同步交由 npm run check（此处不重复判定，免得两处口径打架）');

  const dir = path.join(ROOT, 'db/api-v2');
  if (!fs.existsSync(dir)) warn('没有 db/api-v2 目录');
  else {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    ok('迁移脚本 ' + files.length + ' 份', files[files.length - 1]);
  }
}

/* ══════════════════════════════════════════════════════════
 * 4) 数据库：必需的 RPC 真的存在、且权限开着
 * ────────────────────────────────────────────────────────────
 * ⚠ 用**错误密钥**探：只看函数在不在，不产生任何写入。
 *   三种失败长得完全不同，必须分开判：
 *     PGRST202 / Could not find the function → **迁移没执行**
 *     permission denied                      → **revoke 了但忘了 grant**
 *     unauthorized writer (42501)            → ✅ 这是**期望**结果（函数在、有权限、密钥错被拒）
 * ══════════════════════════════════════════════════════════ */
console.log('\n[4] 数据库契约（迁移是否真的执行过）');
{
  const REQUIRED = [
    ['hm_profile_get', { p_sub: '0' }, '档案读取 GET /api/hm/profile'],
    ['hm_touch', { p_sub: '0', p_email: null }, '活跃计数 POST /api/hm/touch'],
    ['hm_status_put', { p_rows: [] }, '状态历史写入（/status 30 天视图）'],
    ['hm_status_get', { p_since: 0 }, '状态历史读取（/status 30 天视图）'],
  ];
  let mod = null;
  try { mod = await import('../lib/cloud.mjs'); } catch (_) { mod = null; }
  const secret = mod && mod.WRITE_SECRET;
  if (!secret) {
    warn('本机没有写入凭据，跳过数据库检查（CI / 新克隆的正常情况）');
  } else {
    for (const [fn, args, why] of REQUIRED) {
      const body = JSON.stringify(Object.assign({ p_secret: 'predeploy-probe' }, args));
      const r = await mod.dbFetch('/rpc/' + fn, { method: 'POST', body }, 15000, 4096);
      const text = String(r.body || r.error || '');
      if (/PGRST202|Could not find the function|does not exist/i.test(text)) {
        bad(fn + ' 在库里不存在（迁移没执行）', why);
      } else if (/permission denied/i.test(text)) {
        bad(fn + ' 权限没开（revoke 了但忘了 grant）', why);
      } else if (/unauthorized writer/i.test(text)) {
        ok(fn + ' 存在且可调', why);
      } else if (/25P02|timeout|ECONN/i.test(text)) {
        warn(fn + ' 探测时上游抖动', text.slice(0, 60));
      } else {
        bad(fn + ' 行为异常', text.slice(0, 90));
      }
    }
  }
}

/* ══════════════════════════════════════════════════════════
 * 5) 生产域名复验（--prod）
 * ══════════════════════════════════════════════════════════ */
if (PROD) {
  console.log('\n[5] 生产域名复验 ' + PROD_ORIGIN);
  const get = async p => {
    try {
      const r = await fetch(PROD_ORIGIN + p, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      const text = await r.text().catch(() => '');
      return { status: r.status, text };
    } catch (e) { return { err: String(e && e.message || e).slice(0, 90) }; }
  };

  /* ⚠ `/chart` 是**参数路由**（`/chart/<id>`），裸路径本来就 404 —— 用真实 id 探。 */
  for (const p of ['/', '/app', '/chart/1', '/status', '/packs', '/settings', '/platform', '/developers']) {
    const r = await get(p);
    if (r.status === 200) ok(p + ' 200'); else bad(p + ' 不是 200', r.err || String(r.status));
  }

  const home = await get('/');
  const live = (home.text || '').match(/name="app-version" content="([^"]+)"/);
  if (!live) bad('线上首页读不到 app-version');
  else if (live[1] !== VER) bad('线上版本与本地不一致（部署没生效或缓存）', '线上 ' + live[1] + ' ≠ ' + VER);
  else ok('线上版本 = ' + VER);

  const meta = await get('/api/v1/meta');
  let mj = null; try { mj = JSON.parse(meta.text); } catch (_) {}
  if (!mj || !mj.service) bad('/api/v1/meta 读不到 service');
  else if (mj.service !== pkg.version) bad('/api/v1/meta 的 service 与 package.json 不一致', mj.service);
  else ok('/api/v1/meta service = ' + mj.service);

  /* 白名单：**只要不是 2xx/3xx 就是安全**。
     ⚠ 别写成「必须 404」—— 线上前面还有一层平台网关，它会对 `.git/`、`/db/`
     这类路径直接回 **403**（比我们的 404 更早一步）。两种都不是泄露。
     判据应该是「拿得到内容吗」，不是「状态码是不是恰好 404」。 */
  for (const p of ['/server.mjs', '/lib/cloud.mjs', '/write-secret.txt', '/db/api-v2/20.sql', '/.git/config']) {
    const r = await get(p);
    if (r.status === 404) ok(p + ' 正确 404（本站白名单）');
    else if (r.status === 403) ok(p + ' 403（平台网关拦截，同样拿不到内容）');
    else bad(p + ' 竟然可达（' + r.status + '）', '源码 / 凭据泄露');
  }

  /* 部署后最常见的整体故障是"匿名 API 全部 401" */
  const anon = await get('/api/v1/charts?size=1');
  if (anon.status === 200) ok('匿名 API 仍 200');
  else bad('匿名 API 不可用', String(anon.status));
}

console.log('\n────────');
console.log(`通过 ${pass} · 跳过 ${skip} · 失败 ${fail}` + (PROD ? '（含生产复验）' : ''));
if (fail) {
  console.log('\n❌ 不要发布。每条 ❌ 都对应一个「线上会坏」的具体点。');
  process.exit(1);
}
console.log('\n✅ 可以发布' + (PROD ? '（生产复验通过）' : ' — 部署后再跑一次 --prod'));
