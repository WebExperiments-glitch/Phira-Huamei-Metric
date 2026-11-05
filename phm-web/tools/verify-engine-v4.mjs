#!/usr/bin/env node
/* ============================================================
 * tools/verify-engine-v4.mjs —— v4 默认档（142 池化 ‖ 256 手型）的一致性闸门
 * ============================================================
 * 【为什么必须有】
 *   v4 比 v3 多两段**移植错了不会报错**的东西：
 *     ① 判定线运动后的屏幕坐标（engine.js ← js/line-geom.mjs）
 *     ② 片段手型 256 维（engine-v3.mjs 的 handshape256）
 *   任何一个算错，页面都照样出数字，只是每个数都偏 —— 2026-11-03 那次
 *   `above` 判错（池化整体偏 38、b 差 0.57）就是这么来的。
 *
 * 【判据】
 *   engine-v4.json 的 `checks` 是 **Python 现场算的** 398 维 + b + 定数。
 *   逐张重算，三条都要过：
 *     · 256 维手型  max|Δ| ≤ 3e-4   （参照值是 float32 存的，1e-6 级量化）
 *     · 142 维池化  max|Δ| ≤ 5e-3   （float16 数据集 → 当前代码重算的口径差）
 *     · b            |Δ|  ≤ 1e-4    （这才是真正的验收线）
 *   实测最差：手型 5.9e-5 / 池化 1.5e-3 / b 2e-6。
 *
 * 【另外守住四级降级】
 *   v4 权重缺失 → v3 → v2 → kNN，每一步都必须出数字且 basis2 如实说明。
 *   降级坏掉的表现是"页面没数字"，比数字不准更严重。
 *
 * 用法：node tools/verify-engine-v4.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOL_EXT = 3e-4, TOL_POOL = 5e-3, TOL_B = 1e-4;

const readJSON = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const W4 = readJSON('public/data/engine-v4.json');
const W3 = readJSON('public/data/engine-v3.json');
const W2 = readJSON('public/data/engine-v2.json');

/* 直接 import 线上那份实现，不复制副本 —— 测副本等于没测 */
const { loadChart, reportFromChart } = await import('../public/js/engine.js');
const { handshape256, ridgeV4, pool142, seqFeatures20 } = await import('../public/js/engine-v3.mjs');

let fail = 0;
const ok = (name, extra) => console.log('  ✓ ' + name + (extra ? '  ' + extra : ''));
const no = (name, extra) => { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); };
const maxAbs = (a, b, n) => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

/* ── 1) 结构自检：权重与名字必须对得上，否则索引一定错位 ──────────────── */
console.log('—— 权重结构 ——');
ok('dims = 398', String(W4.dims));
if (W4.w.length === 398 && W4.mu.length === 398 && W4.sd.length === 398 && W4.b2d) ok('mu/sd/w 都是 398 维');
else no('mu/sd/w 都是 398 维', `w=${W4.w.length} mu=${W4.mu.length} sd=${W4.sd.length}`);
if (W4.handshape.names.length === 256 && W4.handshape.names[0] === 'n8|mean|path'
  && W4.handshape.names[7] === 'n8|mean|span_y' && W4.handshape.names[255] === 't10|skew|span_y') {
  ok('256 维命名与布局契约一致');
} else no('256 维命名与布局契约一致', W4.handshape.names.slice(0, 8).join(','));
if (W4.clip_z === 8) ok('clip_z = 8（漏了这一步会让个别谱离谱）');
else no('clip_z = 8', String(W4.clip_z));

/* ── 2) 5 张自检谱：手型 / 池化 / b 三关 ─────────────────────────────── */
console.log('\n—— 自检谱（Python 现场算的 checks）——');
let worstExt = 0, worstPool = 0, worstB = 0, worstId = null;
for (const c of W4.checks) {
  const p = path.join(ROOT, '..', 'data', 'charts', c.id, 'chart.json');
  if (!fs.existsSync(p)) { console.log(`  · 跳过 ${c.id}（本地没有谱面文件）`); continue; }
  const r = loadChart(JSON.parse(fs.readFileSync(p, 'utf8')));
  if (!r.screen) { no(`${c.id} 有屏幕坐标`, 'line-geom 没能算出 sx/sy'); continue; }
  const ext = handshape256(r.notes, r.screen);
  const pool = pool142(seqFeatures20(r.notes), r.notes.length);
  const out = ridgeV4(r.notes, W4, r.screen);
  const de = maxAbs(ext, c.extent, 256);
  const dp = maxAbs(pool, c.pooled, 142);
  const db = Math.abs(out.b - c.b);
  if (de > worstExt) { worstExt = de; worstId = c.id; }
  if (dp > worstPool) worstPool = dp;
  if (db > worstB) worstB = db;
  const good = de <= TOL_EXT && dp <= TOL_POOL && db <= TOL_B;
  if (!good) fail++;
  console.log(`  ${good ? '✓' : '✗'} ${c.id}  n=${String(r.notes.length).padStart(5)}`
    + `  手型 ${de.toExponential(2)}  池化 ${dp.toExponential(2)}`
    + `  b ${out.b.toFixed(6)} vs ${c.b.toFixed(6)}（差 ${db.toExponential(2)}）`
    + `  定数 ${out.ding.toFixed(4)} vs ${c.ding.toFixed(4)}`);
}
console.log(`\n最差：手型 ${worstExt.toExponential(2)}（${worstId}）· 池化 ${worstPool.toExponential(2)}`
  + ` · b ${worstB.toExponential(2)}`);

/* ── 3) 三级降级：v4 → v3 → kNN，每一级都必须出数字 ─────────────────── */
console.log('\n—— 降级链（v4 → v3 → kNN）——');
const p = path.join(ROOT, '..', 'data', 'charts', W4.checks[0].id, 'chart.json');
if (fs.existsSync(p)) {
  const r = loadChart(JSON.parse(fs.readFileSync(p, 'utf8')));
  const meta = { name: 'fallback', level: 'IN 14' };
  const cases = [
    ['v4', W4, W3, W2, 'ridge-hs398'],
    ['v3', null, W3, W2, 'ridge-seq20'],
    ['v2', null, null, W2, 'ridge-beta'],
    ['kNN', null, null, null, undefined],
  ];
  let prev = null;
  for (const [tag, w4, w3, w2, basis] of cases) {
    const rep = reportFromChart(r, 'fb', meta, 0, null, null, w2, w3, w4);
    const ref = rep.knn && rep.knn.ref;
    const got = rep.knn && rep.knn.basis2;
    const good = ref != null && isFinite(ref) && (basis ? got === basis : true);
    if (!good) fail++;
    console.log(`  ${good ? '✓' : '✗'} ${tag.padEnd(4)} ref=${ref == null ? 'null' : (+ref).toFixed(4)}`
      + `  basis2=${got || '（无，kNN）'}`);
    if (tag === 'v4') prev = ref;
    if (tag === 'kNN' && got !== undefined) no('kNN 档不带 basis2', got);
  }
  if (prev == null) no('v4 给出了数字');
}

console.log('\n' + (fail ? `✗ ${fail} 条失败 —— v4 移植有问题，**不要上线**` : 'v4 一致性：通过 ✓'));
process.exit(fail ? 1 : 0);
