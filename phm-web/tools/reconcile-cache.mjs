#!/usr/bin/env node
/* ============================================================
 * tools/reconcile-cache.mjs —— 共享定数缓存的「对账」
 * ============================================================
 * 【它解决的是一条诚实清单上的缺口】
 *   docs/SECURITY.md「尚未解决」第 2 条：
 *   凭据门挡住的是**外部人**。如果凭据真的泄露、或者有人从公开仓库里读到它，
 *   写进去的假定数**不会被自动发现** —— 在此之前我们没有任何对账任务。
 *
 * 【对账做什么】
 *   抽样（或全量）重新下载谱面、跑一遍引擎，把结果与库里存的比。
 *   不一致的三种来源要分别对待：
 *     1. engine_build 过期  → 不是篡改，是算法换了。重算即可。
 *     2. 数值对不上但 build 相同 → 要么引擎有不确定性，要么**有人改过这行**。
 *     3. difficulty（Phira 标称值）变了 → 谱师改了标签，缓存该跟着更新。
 *
 * 【用法】
 *   node tools/reconcile-cache.mjs                 # 抽样 40 张对账（默认）
 *   node tools/reconcile-cache.mjs --sample 200
 *   node tools/reconcile-cache.mjs --all           # 全量（几百张要十几分钟）
 *   node tools/reconcile-cache.mjs --stale-only    # 只统计过期行，不下载
 *   node tools/reconcile-cache.mjs --fix           # 对不上的行就地重算回写
 *   node tools/reconcile-cache.mjs --recompute-stale --limit 700   # 重算全部过期行
 *
 * 【退出码】0 = 全部一致；1 = 发现漂移（可以挂到 cron / CI 上）
 *   —— 这是重点：它要能被**无人值守地跑**，而不是靠人记得手动看一眼。
 *
 * ⚠ 抽样是**确定性**的（按 chart_id 排序后等距取），不是随机：
 *   否则每次跑出来的结论都不一样，没法比较、也没法说「上周是对齐的」。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { recompute } from '../lib/review.mjs';
import { dbPutChart, dbListAll, dbListStale, WRITE_SECRET } from '../lib/cloud.mjs';
import { ENGINE_VER } from '../public/js/engine.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = n => args.includes('--' + n);

const SAMPLE = Number(opt('sample', 40));
const ALL = flag('all');
const FIX = flag('fix');
const STALE_ONLY = flag('stale-only');
const RECOMPUTE_STALE = flag('recompute-stale');
const LIMIT = Number(opt('limit', 100000));
const GAP_MS = Number(opt('gap', 120));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + st() + ']', ...a);

/* 数值容差。引擎是确定性的（纯计算、无随机、无浮点排序敏感性），
   所以理论上应当逐位相等。留一点余量只为了跨 Node 版本/libm 差异。 */
const TOL = { ref_const: 1e-6, ref_official: 1e-6, ps_score: 1e-4, nps: 1e-6, notes: 0, speed_peak: 0.01 };
const FIELDS = Object.keys(TOL);

async function main() {
  log('引擎版本 ' + ENGINE_VER);

  /* ── 模式 A：只看过期行，不下载 ── */
  const stale = await dbListStale(ENGINE_VER);
  if (stale === null) { console.error('✗ 读不到数据库'); return 2; }
  console.log(`\n过期行（engine_build ≠ ${ENGINE_VER}）: ${stale.length} 行`);
  if (stale.length) {
    const byBuild = {};
    for (const r of stale) byBuild[r.engine_build || '(NULL/旧版)'] = (byBuild[r.engine_build || '(NULL/旧版)'] || 0) + 1;
    for (const k in byBuild) console.log(`   ${k}  ×  ${byBuild[k]}`);
  }

  if (STALE_ONLY) return stale.length ? 1 : 0;

  /* ── 模式 B：重算全部过期行 ── */
  if (RECOMPUTE_STALE) {
    if (!WRITE_SECRET) { console.error('✗ 需要写入凭据（PHM_WRITE_SECRET / write-secret.txt）'); return 2; }
    const todo = stale.slice(0, LIMIT);
    if (!todo.length) { log('没有过期行，无需重算。'); return 0; }
    log(`开始重算 ${todo.length} 行 …`);
    let ok = 0, bad = 0, n = 0;
    for (const r of todo) {
      n++;
      try {
        const row = await recompute(r.chart_id);
        const wr = await dbPutChart(row);
        if (!wr.ok) throw new Error('写库失败 ' + (wr.fail[0] || ''));
        ok++;
        if (n % 10 === 0 || n === todo.length) log(`[${n}/${todo.length}] ✓ 成功 ${ok} 失败 ${bad}`);
      } catch (e) {
        bad++;
        if (bad <= 15) log(`  ✗ #${r.chart_id} ${String(r.name || '').slice(0, 20)} — ${String(e.message || e).slice(0, 100)}`);
      }
      await sleep(GAP_MS);
    }
    console.log(`\n重算完成：成功 ${ok} · 失败 ${bad}`);
    const left = await dbListStale(ENGINE_VER);
    console.log(`剩余过期行：${left ? left.length : '?'}`);
    return bad ? 1 : 0;
  }

  /* ── 模式 C：对账 —— 重算并与库里存的值逐字段比 ── */
  const all = await dbListAll();
  if (all === null) { console.error('✗ 读不到缓存'); return 2; }
  if (!all.length) { log('缓存是空的，没什么可对账的。'); return 0; }

  /* 确定性抽样：按 chart_id 排序后等距取 */
  const sorted = all.slice().sort((a, b) => a.chart_id - b.chart_id);
  const pick = [];
  if (ALL) pick.push(...sorted);
  else {
    const step = Math.max(1, Math.floor(sorted.length / SAMPLE));
    for (let i = 0; i < sorted.length && pick.length < SAMPLE; i += step) pick.push(sorted[i]);
  }
  log(`缓存共 ${all.length} 行 · 本次对账 ${pick.length} 行（${ALL ? '全量' : '确定性等距抽样'}）`);

  const drift = [], missing = [], errors = [], staleHit = [];
  let n = 0;
  for (const r of pick) {
    n++;
    try {
      const fresh = await recompute(r.chart_id);
      /* 1) 过期算法 —— 不是篡改，但也要报出来 */
      if (r.engine_build !== ENGINE_VER) staleHit.push(r.chart_id);
      /* 2) 逐字段比 */
      const bad = [];
      for (const k of FIELDS) {
        const a = r[k] == null ? null : +r[k];
        const b = fresh[k] == null ? null : +fresh[k];
        if (a == null && b == null) continue;
        if (a == null || b == null || Math.abs(a - b) > TOL[k]) bad.push({ k, cached: a, fresh: b });
      }
      /* 3) 标称定数（Phira 官方值）变了 —— 谱师改过标签 */
      const offA = r.difficulty == null ? null : +r.difficulty;
      const offB = fresh.difficulty == null ? null : +fresh.difficulty;
      if (offA != null && offB != null && Math.abs(offA - offB) > 0.001) {
        bad.push({ k: 'difficulty(标称)', cached: offA, fresh: offB });
      }
      if (bad.length) drift.push({ id: r.chart_id, name: r.name, bad, cachedBuild: r.engine_build });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 90);
      if (/没有可下载|404|已下架|no file/i.test(msg)) missing.push({ id: r.chart_id, name: r.name, msg });
      else errors.push({ id: r.chart_id, name: r.name, msg });
    }
    if (n % 10 === 0 || n === pick.length) log(`[${n}/${pick.length}] 漂移 ${drift.length} · 下架 ${missing.length} · 出错 ${errors.length}`);
    await sleep(GAP_MS);
  }

  /* ── 报告 ── */
  console.log('\n──────── 对账结果 ────────');
  console.log(`抽查            ${pick.length}`);
  console.log(`一致            ${pick.length - drift.length - missing.length - errors.length}`);
  console.log(`数值漂移 ⚠      ${drift.length}`);
  console.log(`谱面已下架      ${missing.length}`);
  console.log(`网络/解析出错   ${errors.length}`);
  console.log(`其中 engine_build 过期（旧算法）: ${staleHit.length}`);

  if (drift.length) {
    console.log('\n漂移明细（最多 25 条）：');
    for (const d of drift.slice(0, 25)) {
      console.log(`  #${d.id} ${String(d.name || '').slice(0, 24)}  [build=${d.cachedBuild || 'NULL'}]`);
      for (const b of d.bad) {
        console.log(`      ${b.k}: 库里 ${b.cached}  ≠  重算 ${b.fresh}`);
      }
    }
    console.log('\n⚠ 数值对不上有两种可能：');
    console.log('   a) engine_build 是旧版 → 只是算法换了，跑 --recompute-stale 重算即可；');
    console.log('   b) engine_build 已经是当前版却仍对不上 → **有人改过这一行**，需要人工看。');
  }
  if (missing.length) {
    console.log('\n已下架的谱（前 10）：');
    for (const m of missing.slice(0, 10)) console.log(`  #${m.id} ${String(m.name || '').slice(0, 24)} — ${m.msg}`);
  }
  if (errors.length) {
    console.log('\n出错（前 10）：');
    for (const e of errors.slice(0, 10)) console.log(`  #${e.id} ${String(e.name || '').slice(0, 24)} — ${e.msg}`);
  }

  /* ── 可选：把对不上的行就地重算回写 ── */
  if (FIX && drift.length) {
    if (!WRITE_SECRET) { console.error('✗ --fix 需要写入凭据'); return 2; }
    log(`\n--fix：回写 ${drift.length} 行 …`);
    let ok = 0, bad = 0;
    for (const d of drift) {
      try {
        const row = await recompute(d.id);
        const wr = await dbPutChart(row);
        if (!wr.ok) throw new Error(wr.fail[0] || '写库失败');
        ok++;
      } catch (e) { bad++; log(`  ✗ #${d.id} ${String(e.message || e).slice(0, 80)}`); }
      await sleep(GAP_MS);
    }
    console.log(`回写完成：成功 ${ok} · 失败 ${bad}`);
    return bad ? 1 : 0;
  }

  /* 退出码：只要发现「当前 build 却对不上」就返回 1 —— 那是真的可能被改过 */
  const realDrift = drift.filter(d => d.cachedBuild === ENGINE_VER).length;
  if (realDrift) {
    console.log(`\n✗ 发现 ${realDrift} 行在当前引擎版本下仍然对不上 —— 需要人工核查。`);
    return 1;
  }
  if (drift.length) {
    console.log(`\n△ ${drift.length} 行漂移全部来自旧引擎版本，属预期。跑 --recompute-stale 收敛。`);
    return 0;
  }
  console.log('\n✓ 全部一致。');
  return 0;
}

const code = await main();
process.exit(code);
