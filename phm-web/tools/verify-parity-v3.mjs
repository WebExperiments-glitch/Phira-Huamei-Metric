#!/usr/bin/env node
/* ============================================================
 * tools/verify-parity-v3.mjs —— 服务端复算 ↔ 浏览器路径 的定数一致性闸门
 * ============================================================
 * 【这条闸门防的是什么】
 *   引擎换了算法，但**某一条调用路径忘了传新权重** —— 这类事故不会报错，
 *   只会让两处显示两个数。今年已经犯过两次：
 *     · 2026-11-02：analyzeChart 从不透传 opts.weightsV2 → 「换成岭回归」从未生效；
 *     · 2026-11-04：服务端 recompute 只传了 v2 → 页面是 v3、API/缓存是 v2。
 *   两次的共同点是「单元测试全绿、页面照常出数字」，只有把**两条路径并排算一遍**
 *   才看得见。所以这个脚本不做别的，就做这一件事。
 *
 * 【怎么做到不联网、不碰数据库】
 *   · 谱面用 public/js/rulechart.js 现场合成（固定 seed，可复现），不读 data/；
 *   · 只 stub 掉 Phira 的两个 HTTP 端点（谱面元数据 + 谱面文件），
 *     其余全部走**真实代码**：lib/review.mjs 的 recompute() → analyzeChart()。
 *     ⚠ 直接调 recompute 而不是复制它的参数，才能拦住「recompute 里漏传」。
 *   · 「浏览器路径」按 app.html 的调用方式重演：自己 fs 读权重与参照集
 *     （等价于浏览器 fetch 那两个文件），**不借用 refstore** —— 否则读取器
 *     坏了这条闸门也跟着坏，等于没测。
 *
 * 【判据】
 *   定数差 > 0.05 级即失败（与 verify-engine-v3 同阈值：模型 MAE 0.44 的 1/9，
 *   低于用户可感知阈值，但足以拦住「退回 v2」这种量级的偏差）。
 *   另外必须断言服务端返回的 basis 就是 ridge-seq20 —— 差值为 0 但两边都用 v2
 *   也算失败（那正是今天要防的那个 bug）。
 *
 * 用法：node tools/verify-parity-v3.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJSON = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

let bad = 0;
const ok = (name, extra) => { console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); };
const no = (name, extra) => { bad++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); };

/* ── 1) 合成一张谱（固定 seed，任何机器上都是同一张） ───────────────── */
const { buildChart, buildPez } = await import('../public/js/rulechart.js');
const { chart, stats } = buildChart({
  bpm: 168, duration: 75, difficulty: 'expert', lanes: 4, density: 1.15,
  name: 'Parity Fixture', artist: 'P.H.M.', charter: 'verify-parity-v3', seed: 'parity-v3',
});
const { pez } = buildPez(chart, { audio: null, audioName: 'unused.wav' });
const PEZ = pez.buffer.slice(pez.byteOffset, pez.byteOffset + pez.byteLength);
console.log('[fixture] ' + stats.notes + ' notes · ' + stats.bpm + ' BPM · ' + (PEZ.byteLength / 1024).toFixed(1) + ' KB');

/* ── 2) 只 stub Phira 的两个端点，其余走真实实现 ───────────────────── */
const CHART_ID = 990001;
const fakeInfo = {
  id: CHART_ID, name: 'Parity Fixture', level: 'IN 14', difficulty: 14.0,
  charter: 'verify-parity-v3', file: 'https://phira.5wyxi.com/files/parity.pez',
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf('api.phira.cn/chart/') >= 0) {
    return { ok: true, status: 200, json: async () => fakeInfo,
      headers: { get: () => null }, text: async () => JSON.stringify(fakeInfo) };
  }
  if (u.indexOf('phira.5wyxi.com/files/') >= 0) {
    return { ok: true, status: 200,
      headers: { get: h => String(h).toLowerCase() === 'content-length' ? String(PEZ.byteLength) : null },
      arrayBuffer: async () => PEZ, text: async () => '' };
  }
  throw new Error('闸门不允许联网：' + u);
};

/* ── 3) 服务端路径：真的调 recompute（= /api/analyze 未命中缓存时走的那条） ── */
const { recompute } = await import('../lib/review.mjs');
let trusted;
try { trusted = await recompute(CHART_ID); }
catch (e) { no('服务端复算能跑通', e.message); }
globalThis.fetch = realFetch;
if (!trusted) { console.log('\n✗ 服务端路径失败，后续比对跳过'); process.exit(1); }

/* ── 4) 浏览器路径：按 app.html 的调用方式重演（参数自己从文件读） ───── */
const { analyzeChart } = await import('../public/js/engine.js');
const refCom = readJSON('public/data/ref-com.json').rows;
const wV2 = readJSON('public/data/engine-v2.json');
const wV3 = readJSON('public/data/engine-v3.json');
if (!Array.isArray(wV3.w) || wV3.w.length !== 142) {
  no('engine-v3.json 是 142 维', 'len=' + (wV3.w && wV3.w.length));
}
const reports = await analyzeChart(PEZ, 'parity.pez',
  { refCom, weightsV2: wV2, weightsV3: wV3 });
const rep = reports.find(x => !x.error);
if (!rep) { no('浏览器路径能跑通', (reports[0] && reports[0].error) || '无报告'); process.exit(1); }

const browserRef = rep.knn && rep.knn.ref;
const v2Only = (await analyzeChart(PEZ, 'parity.pez', { refCom, weightsV2: wV2, weightsV3: null }))
  .find(x => !x.error);
const v2Ref = v2Only && v2Only.knn && v2Only.knn.ref;

console.log('[服务端] ref_const=' + trusted.ref_const + '  basis=' + trusted.basis
  + '  ref_official=' + trusted.ref_official);
console.log('[浏览器] ref=' + (browserRef == null ? 'null' : browserRef.toFixed(4))
  + '  basis2=' + (rep.knn.basis2 || 'knn') + '  n20=' + rep.knn.n20);
console.log('[仅 v2]  ref=' + (v2Ref == null ? 'null' : v2Ref.toFixed(4)) + '（仅供对照，不是判据）');

const diff = (browserRef != null && trusted.ref_const != null)
  ? Math.abs(browserRef - trusted.ref_const) : null;

/* ── 5) 判据 ─────────────────────────────────────────────────────── */
if (trusted.basis === 'ridge-seq20') ok('服务端 basis 是 ridge-seq20');
else no('服务端 basis 是 ridge-seq20', '当前 ' + trusted.basis);

if (rep.knn.basis2 === 'ridge-seq20') ok('浏览器 basis2 是 ridge-seq20');
else no('浏览器 basis2 是 ridge-seq20', '当前 ' + (rep.knn.basis2 || 'knn'));

if (diff == null) no('两边都给出了定数', 'server=' + trusted.ref_const + ' browser=' + browserRef);
else if (diff <= 0.05) ok('两侧定数一致（|Δ|=' + diff.toFixed(4) + ' ≤ 0.05）');
else no('两侧定数一致', '|Δ|=' + diff.toFixed(4) + ' > 0.05 —— 有一条路径没用 v3');

if (!(trusted.ref_const > 1 && trusted.ref_const < 25)) no('服务端定数落在合理范围', String(trusted.ref_const));

console.log('\n' + (bad ? '✗ ' + bad + ' 条失败' : '✓ 服务端与浏览器路径一致'));
process.exit(bad ? 1 : 0);
