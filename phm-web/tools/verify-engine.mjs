/* ============================================================
 * tools/verify-engine.mjs —— 引擎回归测试
 * ============================================================
 * 【为什么需要】文档里写了两年的「语法检查 ≠ 功能验证」，但一直只有一句
 *   「改完记得手动跑一张谱面」。历史上正是因此出过事故：编辑时吃掉 `=>` 的 `>`
 *   （`en=({...})` 是合法语法，`node --check` 查不出来），线上所有谱面解析失败。
 *
 * 【怎么跑】
 *     node tools/verify-engine.mjs            # 离线自测（不联网，秒级）
 *     node tools/verify-engine.mjs --net      # 额外拉真实谱面做基线比对
 *
 * 退出码非 0 表示失败 —— 可以直接接进 CI 或 pre-commit。
 * ============================================================ */
import { analyzeChart, loadChart, parsePec, isPecText } from '../public/js/engine.js';

const NET = process.argv.includes('--net');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
};
const near = (a, b, tol) => Math.abs(+a - +b) <= tol;

/* ── 1. PEC 识别与解析（不联网，纯字符串）── */
console.log('\n[1] PEC 解析（合成用例）');
{
  const txt = [
    '175',                        /* 首行 = offset + 175，应被忽略 */
    'bp 0.000 120.000',
    'n1 0 0.000 0.000 1 0',
    'n1 0 0.500 480.000 1 0',
    'n2 0 1.000 2.000 -480.000 1 0',   /* Hold：多一个「结束拍数」 */
    'n3 0 2.000 0.000 1 0',
    'n4 0 3.000 0.000 1 0',
  ].join('\n');
  ok('isPecText 认出 PEC', isPecText(txt));
  ok('isPecText 拒绝 info.yml', !isPecText('name: x\ncharter: y'));
  const r = parsePec(txt);
  ok('音符数 = 5', r.notes.length === 5, '得到 ' + r.notes.length);
  ok('Hold 被记为 type 2（不是被当成假音符丢掉）',
    r.real.filter(n => n.type === 2).length === 1);
  ok('没有假音符', r.real.length === 5, '得到 ' + r.real.length);
  ok('bpm = 120', r.bpm === 120, '得到 ' + r.bpm);
  ok('时长 = 1.5s（一拍 0.5s）', near(r.dur, 1.5, 1e-6), '得到 ' + r.dur);
  ok('判定线数 = 1', r.nlines === 1, '得到 ' + r.nlines);
  /* x 是 ±1024 空间 → 换算到 RPE 的 ±675 */
  const x480 = r.real.find(n => Math.abs(n.x) > 1).x;
  ok('x 已换算到 RPE 量纲（480 × 675/1024 ≈ 316.4）',
    near(Math.abs(x480), 316.4, 0.5), '得到 ' + x480.toFixed(2));
  /* n2 的 x 必须取 a[4]（不是 a[3] 的结束拍数） */
  ok('Hold 的 x 取对了字段（不是结束拍数）',
    near(Math.abs(r.real.find(n => n.type === 2).x), 316.4, 0.5));
}

/* ── 2. RPE 解析（合成用例）── */
console.log('\n[2] RPE 解析（合成用例）');
{
  const j = {
    BPMList: [{ startTime: [0, 0, 1], bpm: 120 }],
    judgeLineList: [{ notes: [
      { startTime: [0, 0, 1], type: 1, positionX: 0 },
      { startTime: [1, 0, 1], type: 2, positionX: 100 },
    ] }],
  };
  const r = loadChart(j);
  ok('音符数 = 2', r.notes.length === 2, '得到 ' + r.notes.length);
  ok('时长 = 0.5s', near(r.dur, 0.5, 1e-6), '得到 ' + r.dur);
  ok('判定线数 = 1', r.nlines === 1, '得到 ' + r.nlines);
}

/* ── 3. 「内容嗅探」而不是「按后缀名」── */
console.log('\n[3] 文件选择：按内容嗅探');
{
  /* 构造一个「文件名叫 .json、内容其实是 PEC」的最小 zip（就是 Re:PhiEdit
     导出旧格式时的真实情况，也是当初 131 张谱算不出来的根因）。
     这里不造真 zip，改为直接验证判据本身。 */
  const pecInJson = '30\r\nbp 0.000 170.000\r\nn1 0 5.000 480.000 1 0';
  ok('内容像 PEC 就按 PEC 认（与文件名无关）', isPecText(pecInJson));
  ok('真正的 JSON 不会被误判成 PEC', !isPecText('{"judgeLineList": []}'));
}

/* ── 4. 真实谱面基线（联网，可选）── */
if (NET) {
  console.log('\n[4] 真实谱面基线比对（联网）');
  /* 期望值来自服务端已复核入库的数据 —— 改动引擎后如果这里挂了，
     说明线上所有已缓存定数都失效了，必须重新预热。 */
  const CASES = [
    { id: 22681, fmt: 'RPE', ref: 16.6, ps: 10.3291, nps: 8.8599, notes: 1702 },
    { id: 47579, fmt: 'RPE', ref: 15.3, ps: 9.7016, nps: 6.6937, notes: 1137 },
    { id: 80490, fmt: 'RPE', ref: 14.6, ps: 8.1158, notes: 1000 },
    { id: 8597, fmt: 'PEC', ref: 15.6, notes: 1125, holds: 108 },
    { id: 47497, fmt: 'PEC', ref: 17.1, notes: 3000 },
  ];
  for (const c of CASES) {
    try {
      const info = await (await fetch('https://api.phira.cn/chart/' + c.id)).json();
      const buf = await (await fetch(info.file)).arrayBuffer();
      const rs = await analyzeChart(buf, info.name + '.pez');
      const r = rs.find(x => !x.error);
      if (!r) { ok(`#${c.id} ${c.fmt} 能解析`, false, rs[0] && rs[0].error); continue; }
      const tag = `#${c.id} ${String(info.name).slice(0, 18)} [${c.fmt}]`;
      ok(tag + ' 参考定数 ≈ ' + c.ref, near(r.knn.ref, c.ref, 0.05), '得到 ' + (+r.knn.ref).toFixed(4));
      if (c.ps != null) ok(tag + ' PS ≈ ' + c.ps, near(r.ps.total, c.ps, 0.02));
      if (c.nps != null) ok(tag + ' NPS ≈ ' + c.nps, near(r.feats.real_notes_per_second, c.nps, 0.005));
      ok(tag + ' 物量 = ' + c.notes, r.feats.notes_real === c.notes,
        '得到 ' + r.feats.notes_real);
      if (c.holds != null) ok(tag + ' Hold 数 = ' + c.holds,
        Math.round(r.feats.hold_ratio * r.feats.notes_real) === c.holds,
        '得到 ' + Math.round(r.feats.hold_ratio * r.feats.notes_real));
    } catch (e) {
      ok(`#${c.id} 拉取/解析`, false, String(e.message || e));
    }
  }
}

console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (!NET) console.log('（加 --net 可额外跑真实谱面基线比对）');
process.exit(fail ? 1 : 0);
