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
import { analyzeChart, loadChart, parsePec, isPecText, reportFromChart, knnReference,
  makeRefIndex, REF_DIMS, REF_OFFICIAL, ROW_LABELS, ENGINE_VER } from '../public/js/engine.js';
import { readFileSync } from 'node:fs';

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


/* ── 5. 参照集与 k-NN 的「结构性」断言 ──
   为什么这几条必须有：2026-10-07 改引擎时，同一类错误在**一天之内**犯了三次 ——
   参照侧与查询侧不在同一坐标系（原始 log 值去减 z-score），以及把「曲名」
   这个字符串当成特征去 log1p。两次都表现为「所有谱都返回同一个数字」，
   看起来像"模型很稳定"，实际是整个距离度量已经废了。
   下面每一条都是针对其中一种失效模式的哨兵。 */
console.log('\n[5] 参照集与 k-NN 结构');
{
  const D = REF_DIMS.length, LBL = ROW_LABELS;
  ok('REF_DIMS 有 8 维', D === 8, '得到 ' + D);
  ok('ROW_LABELS 与生成器一致（= 4）', LBL === 4, '得到 ' + LBL);
  ok('官谱参照非空', REF_OFFICIAL.length > 1000, '得到 ' + REF_OFFICIAL.length);
  ok('每行长度 = ROW_LABELS + 8',
    REF_OFFICIAL.every(r => r.length === LBL + D),
    '首行长度 ' + REF_OFFICIAL[0].length);
  ok('标签列类型正确（定数 number / 档位 number / 曲名 string）',
    REF_OFFICIAL.every(r => typeof r[0] === 'number' && typeof r[1] === 'number'
      && typeof r[2] === 'string'));
  ok('特征列全是有限非负数',
    REF_OFFICIAL.every(r => r.slice(LBL).every(v => typeof v === 'number' && isFinite(v) && v >= 0)));
  /* ⚠ 这一条直接对着「定数被舍入成 0」那个坑：0 会变成 z 空间里最远的负样本，
     一旦进邻居就把加权中位拽到 1~2 区间。 */
  ok('参照集里没有「定数 0」的行（四舍五入后判零的坑）',
    REF_OFFICIAL.every(r => r[0] > 0));

  const idx = makeRefIndex(REF_OFFICIAL);
  ok('makeRefIndex 返回 Z 矩阵', !!idx && Array.isArray(idx.Z));
  ok('Z 矩阵与行同宽同高',
    idx.Z.length === REF_OFFICIAL.length && idx.Z[0].length === D);
  /* Z 必须是**标准化后**的：逐列均值 ≈ 0、标准差 ≈ 1。
     如果哪天又有人把原始 log 值塞进 idx.Z，这两条会立刻挂。 */
  const colMean = [], colSd = [];
  for (let c = 0; c < D; c++) {
    let m = 0; for (const z of idx.Z) m += z[c] / idx.Z.length;
    let v = 0; for (const z of idx.Z) v += (z[c] - m) ** 2 / idx.Z.length;
    colMean.push(m); colSd.push(Math.sqrt(v));
  }
  ok('Z 各列均值 ≈ 0', colMean.every(x => Math.abs(x) < 1e-9), colMean.map(x => x.toFixed(3)).join(','));
  ok('Z 各列标准差 ≈ 1',
    colSd.every(s => s > 0.5 && s < 2), colSd.map(x => x.toFixed(3)).join(','));

  /* 拿参照集里某一行自己当查询 → 距离必须是 0，中点必须等于它自己的定数。
     这是「坐标系对齐」最强的一条断言：两侧不对齐时这个测试必然失败。 */
  const probeRow = REF_OFFICIAL[Math.floor(REF_OFFICIAL.length / 2)];
  const probeFeat = {};
  REF_DIMS.forEach((k, c) => { probeFeat[k] = probeRow[LBL + c]; });
  const self = knnReference(probeFeat, 0, REF_OFFICIAL, 'official');
  ok('用参照集自己的行去查 → 距离 0', self && self.d1 < 1e-9, 'd1=' + (self && self.d1));
  /* ⚠ 这条断言在 v0.5.0 换聚合方式时改过。
     旧聚合是「加权下中位」—— 输出必然是某个邻居的**原值**，
     所以自匹配能精确等于它自己的定数（那时这里断言 1e-9）。
     现在换成「加权截尾均值」，结果会落在邻居取值的**区间内**而不必是端点，
     所以断言改成两条更实在的：
       ① 结果落在邻居的取值范围内（没有外推、没有凭空造数）
       ② 结果离它自己的定数不远（最近的邻居就是它自己，权重最高）
     这两条一样能抓住"坐标系错位"（那会让结果飞到 1~2 区间）。 */
  const nearVals = null; /* 下面用 lo/hi 判区间 */
  ok('用参照集自己的行去查 → 结果落在邻居取值区间内',
    self && self.lo - 1e-9 <= self.ref && self.ref <= self.hi + 1e-9,
    'ref=' + (self && self.ref) + ' 区间 ' + (self && self.lo) + '–' + (self && self.hi));
  ok('用参照集自己的行去查 → 结果接近它自己的定数（≤1.0）',
    self && Math.abs(self.ref - probeRow[0]) <= 1.0,
    '得到 ' + (self && self.ref) + ' vs 自身 ' + probeRow[0]);
  ok('lo ≤ 中点 ≤ hi', self && self.lo <= self.ref + 1e-9 && self.ref <= self.hi + 1e-9);
  ok('档位与邻居一致（多数票）', self && self.tier === ['EZ', 'HD', 'IN', 'AT', 'SP'][probeRow[1]],
    '得到 ' + (self && self.tier));

  /* ★ 排除自身：这是「不让工具退化成橡皮图章」的那道闸。
     不排除时下一条会拿到与探头完全相同的定数（自匹配），排除后必须变。 */
  const selfWithId = knnReference(probeFeat, 0, REF_OFFICIAL, 'official', probeRow[3]);
  ok('excludeId 能生效（selfExcluded 标记）',
    probeRow[3] !== 0 ? (selfWithId && selfWithId.selfExcluded === true) : true,
    'excludeId=' + probeRow[3]);
}

/* ── 6. 社区参照集（本地生成物，缺失时跳过）── */
console.log('\n[6] 社区参照集 ref-com.json');
{
  let refCom = null;
  try {
    refCom = JSON.parse(readFileSync(new URL('../public/data/ref-com.json', import.meta.url), 'utf8'));
  } catch (e) {
    console.log('  · 跳过（读不到 public/data/ref-com.json）—— 先跑 tools/gen-ref.mjs');
  }
  if (refCom) {
    ok('版本号与引擎同代', refCom.v === 'V0.4.0', '得到 ' + refCom.v);
    ok('维度定义与引擎一致',
      JSON.stringify(refCom.dims) === JSON.stringify(REF_DIMS));
    ok('labels 与引擎一致', refCom.labels === ROW_LABELS);
    ok('规模 ≥ 9000 张', refCom.rows.length >= 9000, '得到 ' + refCom.rows.length);
    ok('每行长度 = ROW_LABELS + 8', refCom.rows.every(r => r.length === ROW_LABELS + 8));
    ok('社区谱都有 chart_id（排除自身要用）',
      refCom.rows.every(r => Number.isInteger(r[3]) && r[3] > 0));
    ok('没有「定数 0」的行', refCom.rows.every(r => r[0] > 0));
    /* 两个参照集的**分布差异**是这个设计的立足点，缩了就该重新想 */
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const mOff = med(REF_OFFICIAL.map(r => r[0])), mCom = med(refCom.rows.map(r => r[0]));
    ok('社区谱定数中位确实高于官谱（分布不同的证据）', mCom > mOff + 2,
      `社区 ${mCom} vs 官谱 ${mOff}`);
  }
}

/* ── 7. 端到端：reportFromChart 必须给出双标度 ── */
console.log('\n[7] 双标度输出');
{
  const j = { BPMList: [{ startTime: [0, 0, 1], bpm: 180 }], judgeLineList: [{ notes: [] }] };
  for (let i = 0; i < 400; i++) {
    j.judgeLineList[0].notes.push({
      startTime: [i, 0, 4], type: (i % 7 === 0) ? 2 : 1, positionX: (i % 8) * 100 - 350,
    });
  }
  const r = reportFromChart(loadChart(j), 'synth.json', { name: '合成谱' }, 0, null);
  ok('report.engineVer 与 ENGINE_VER 一致', r.engineVer === ENGINE_VER, '得到 ' + r.engineVer);
  ok('有 knn（主结果）', !!r.knn && r.knn.ref != null);
  ok('有 knnOff（官谱标度）', !!r.knnOff && r.knnOff.ref != null);
  ok('主结果 basis = official（未传社区参照时的降级）',
    r.knn.basis === 'official', '得到 ' + r.knn.basis);
  ok('双标度都是有限数',
    isFinite(r.knn.ref) && isFinite(r.knnOff.ref),
    r.knn.ref + ' / ' + r.knnOff.ref);
}

console.log('\n────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (!NET) console.log('（加 --net 可额外跑真实谱面基线比对）');
process.exit(fail ? 1 : 0);
