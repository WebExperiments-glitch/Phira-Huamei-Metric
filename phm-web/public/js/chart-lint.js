/* ============================================================
 * js/chart-lint.js —— 谱面体检器（RPE / Phigros 口径）
 * ============================================================
 * 【为什么要有这个】
 *   让 LLM 写谱，最大的问题不是"写不出"，是**写出来没法判断对错**。
 *   没有校验器，人只能肉眼看 → 生成退化成抽卡。
 *   有了它，就可以让模型「写 → 查 → 改 → 再查」，这才是 agent 工作流。
 *
 * 【设计参照】
 *   `SakuyaInazaki/aimai-chartmaker` 的 `tools/chart_check`（MIT）是 maimai 口径，
 *   七层：语法 / 手序 / 配置 / 密度 / 采音 / 深度 / 外部规则。
 *   这里按 **Phigros 的物理约束**重写，不是照搬：
 *     · maimai 是 8 轨环形，手序问题是"左右手够不够得着"
 *     · Phigros 是 2D 平面 + 判定线，问题是"同刻双押的 x 间距"和"跨越幅度"
 *
 * 【⚠ 采音层不在本文件】
 *   那需要音频的 onset 网格（js/audio-analysis.js），本文件只吃谱面 JSON。
 *   分开的好处：校验器可以离线跑、可以单测、可以在没有音频时也给结论。
 *
 * 【输入】chart-geom.js 的 extractGeometry() 输出（已含 notes/lines/duration）
 * 【输出】{ ok, errors[], warnings[], stats, grade }
 * ============================================================ */

const LANE_HALF = 675;

/**
 * @param {object} geom   extractGeometry() 的返回值
 * @param {object} [opts]
 *   opts.refNps   {p50,p90}  同难度档的 NPS 参考（可选，来自 β 分档统计）
 *   opts.minGap   同刻双押的最小 x 间距（默认 120，约 9% 屏宽）
 *   opts.maxJump  相邻音符的最大 x 跨度（默认 900，跨越 2/3 屏）
 */
export function lintChart(geom, opts = {}) {
  const errors = [];
  const warnings = [];
  const notes = geom && geom.notes ? geom.notes : [];

  if (!notes.length) {
    return { ok: false, grade: 'F', errors: [{ layer: '语法', msg: '解析出 0 个音符' }],
             warnings: [], stats: {} };
  }

  /* ⚠ 阈值**从数据标定**，不是拍脑袋（113 张真人谱，36,926 处双押 / 83,533 处相邻跨度）：
       双押间距  p0.5 = 0  p1 = 0  p5 = 0  中位 338
       相邻跨度  p50 = 270  p95 = 741  p99 = 878  p99.9 = 1071  最大 5000

     第一版拿 `minGap = 120` 判「同刻双押手指打架」——**错的**。
     真人谱里 5% 以上的同刻双押 x **完全重合**（间距 0），这是正常写法
     （同一判定位置的双押、tap+drag 叠放）。那条判据会把每一张真人谱都报错。
     → 已删除。数据说这不是问题，就不要凭直觉立规矩。

     跨度阈值抬到 1100（高于真人谱 p99.9），只抓真正的离群值。 */
  const maxJump = opts.maxJump ?? 1100;
  const dur = Math.max(0.001, geom.duration || (notes[notes.length - 1].t || 0));

  /* ── 第 1 层：语法 / 结构 ──
     只查**必然导致游戏里出问题**的，不查风格。 */
  let lastT = -1;
  let outOfRange = 0;
  let nanField = 0;
  for (const n of notes) {
    if (!isFinite(n.t) || !isFinite(n.x)) { nanField++; continue; }
    if (n.t < lastT - 1e-6) errors.push({ layer: '语法', msg: `音符时间非单调（${n.t.toFixed(3)} < ${lastT.toFixed(3)}）` });
    lastT = Math.max(lastT, n.t);
    if (Math.abs(n.x) > LANE_HALF) outOfRange++;
  }
  if (nanField) errors.push({ layer: '语法', msg: `${nanField} 个音符的时间或 x 不是有限数` });
  if (outOfRange) warnings.push({ layer: '语法', msg: `${outOfRange} 个音符的 x 超出 ±675（游戏里会被裁掉）` });

  /* ── 第 2 层：密度 ──
     不看"总体 NPS"，看**曲线形状**。一张全程均密的谱是平的，没有呼吸。 */
  const win = 2.0;                       /* 2 秒窗，够看出段落起伏 */
  const curve = [];
  for (let t = 0; t < dur; t += win) {
    const c = notes.filter(n => n.t >= t && n.t < t + win).length / win;
    curve.push(c);
  }
  const nps = notes.length / dur;
  const peak = curve.length ? Math.max(...curve) : 0;
  const p50 = curve.length ? quantile(curve, 0.5) : 0;

  /* 五段形状：开头/前半中/中/后半中/结尾 */
  const seg = (a, b) => {
    const s = notes.filter(n => n.t >= dur * a && n.t < dur * b);
    return s.length / Math.max(0.001, dur * (b - a));
  };
  const shape = [seg(0, 0.15), seg(0.15, 0.4), seg(0.4, 0.6), seg(0.6, 0.85), seg(0.85, 1)];

  /* 后半比前半：<1 表示越打越松（常见于没写完的谱） */
  const backHalf = seg(0.5, 1) / Math.max(1e-6, seg(0, 0.5));

  if (nps < 1.5) errors.push({ layer: '密度', msg: `整体 NPS ${nps.toFixed(2)} 过低，谱面几乎是空的` });
  if (peak > 30) warnings.push({ layer: '密度', msg: `峰值 NPS ${peak.toFixed(1)}，超出人类稳定击打范围` });
  if (backHalf < 0.55) warnings.push({ layer: '密度', msg: `后半/前半 = ${backHalf.toFixed(2)}，越打越空 —— 常见于生成中断或没写完` });
  if (p50 > 0 && peak / p50 > 6) warnings.push({ layer: '密度', msg: `峰均比 ${(peak / p50).toFixed(1)}，起伏过猛（可能是采音扎堆）` });

  /* ── 第 3 层：配置（音符类型构成）──
     全是 tap 的谱通常"能玩但单调"；全 drag 则是灾难。
     ⚠ 按 `kind` 统计，不是 `type` —— 后者只有 hold/tap 两档（给绘图用的），
       拿它统计会把 Flick/Drag 并进 Tap，报出一张根本不存在的"单调谱"。 */
  const typeCount = {};
  for (const n of notes) {
    const k = n.kind || n.type;
    typeCount[k] = (typeCount[k] || 0) + 1;
  }
  const tapRatio = (typeCount.tap || 0) / notes.length;
  const holdRatio = (typeCount.hold || 0) / notes.length;
  const aboveRatio = notes.filter(n => n.above).length / notes.length;

  if (tapRatio > 0.98) warnings.push({ layer: '配置', msg: '99% 以上是 Tap —— 没有任何长条/滑键，配置单调' });
  if (holdRatio > 0.5) warnings.push({ layer: '配置', msg: `长条占比 ${(holdRatio * 100).toFixed(0)}%，过高` });
  if (aboveRatio > 0.995) warnings.push({ layer: '配置', msg: '全在判定线上方，没有下方音符' });

  /* ── 第 3.5 层：纵向表现（2026-10-25 用户实测「这TM就是1D谱子」）──
     Phigros 的音符**贴在判定线上**，所以「谱面有没有高度」= 「判定线会不会上下走」。
     只改 positionX 的谱，玩起来就是一条直线 —— 看起来像 1D，不像谱。
     这里拿几何层逐音符时刻取判定线 y，量出纵向跨度。
     ⚠ 判据用**跨度**不是"有没有 moveY 事件"：写一堆 ±5px 的抖动也是没动。 */
  let yMin = Infinity, yMax = -Infinity, ySample = 0;
  for (const n of notes) {
    const ln = geom.lines ? geom.lines[n.line ?? 0] : null;
    if (!ln || typeof ln.at !== 'function') continue;
    const y = ln.at(n.t).y;
    if (!Number.isFinite(y)) continue;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    ySample++;
  }
  const ySpan = ySample ? +(yMax - yMin).toFixed(1) : 0;
  /* ⚠ 真正的「1D」判据不是线动没动，是**几条线在承载音符**。
     Phigros 的音符永远贴在它那条线上；只有一条线，任何瞬间都只有一个 y，
     把线移来移去也只是"整体平移"，玩起来仍是一条横线。
     实测 184 份真实谱面：判定线数中位 27，其中承载音符的线中位 **14**。 */
  const usedLines = new Set(notes.map((n) => n.line ?? 0)).size;
  if (notes.length >= 60 && usedLines < 3) {
    warnings.push({
      layer: '纵向',
      msg: `只有 ${usedLines} 条判定线承载音符（真实谱面中位 14 条）—— `
        + '单一判定线上所有音符共用一个 y，看起来就是一条直线（1D）。'
        + '用 addLine(y, rot) 建线、sel(i) 切线，把音符分到不同高度的线上。',
    });
  }
  /* 阈值：8 秒以上、音符过百的谱，纵向跨度不到 120px 就是"平的"。
     短谱面/极简谱不判 —— 一屏内十几秒的练习谱本来就该老实待着。 */
  if (ySample && dur >= 8 && notes.length >= 40 && ySpan < 120) {
    warnings.push({
      layer: '纵向',
      msg: `判定线纵向跨度只有 ${Math.round(ySpan)}px（基准 ±450）—— `
        + '音符只靠 positionX 铺开，玩起来是一条直线（1D）。'
        + '用 my() 让线在段落之间换高度，落差至少 ±150。',
    });
  }

  /* ── 第 4 层：手序（Phigros 口径）──
     Phigros 没有"左右手"概念，真正的问题是：
       · 同一时刻两个音符挤在一起 → 手指打架（尤其触屏）
       · 相邻音符横向跨度太大 → 够不着
     ⚠ 这是**近似判断**，不是严格的人体工学模型。 */
  const byTime = new Map();
  for (const n of notes) {
    const k = Math.round(n.t * 1000);        /* 毫秒对齐，1ms 内算同刻 */
    if (!byTime.has(k)) byTime.set(k, []);
    byTime.get(k).push(n);
  }
  /* 同刻和弦只**计数**，不判优劣 —— 见上面阈值那段说明 */
  let multi = 0;
  for (const arr of byTime.values()) if (arr.length >= 2) multi++;
  const chordRatio = multi / Math.max(1, notes.length);

  let jumps = 0;
  for (let i = 1; i < notes.length; i++) {
    const dt = notes[i].t - notes[i - 1].t;
    if (dt > 0.5) continue;                  /* 间隔够长，跳多远都行 */
    if (Math.abs(notes[i].x - notes[i - 1].x) > maxJump) jumps++;
  }
  if (jumps) warnings.push({ layer: '手序', msg: `${jumps} 处 0.5 秒内横向跨度 > ${maxJump}（够不着）` });

  /* ── 第 5 层：深度（与参考分布对照）──
     ⚠ 这一层需要外部传入参考数据。没有就跳过，**不要瞎猜**。 */
  if (opts.refNps && opts.refNps.p50) {
    const r = nps / opts.refNps.p50;
    if (r < 0.5) warnings.push({ layer: '深度', msg: `NPS 只有同档参考的 ${(r * 100).toFixed(0)}%，写得太浅` });
    if (r > 2) warnings.push({ layer: '深度', msg: `NPS 是同档参考的 ${(r * 100).toFixed(0)}%，可能虚标` });
  }

  /* ── 评分：按错误/警告数量给个粗档，方便 agent 判断要不要重写 ──
     ⚠ 这不是"谱面质量分"，是"能不能过关"的信号。 */
  const grade = errors.length ? 'F'
    : warnings.length > 6 ? 'C'
    : warnings.length > 2 ? 'B'
    : 'A';

  return {
    ok: errors.length === 0,
    grade,
    errors,
    warnings,
    stats: {
      notes: notes.length,
      duration: +dur.toFixed(2),
      nps: +nps.toFixed(2),
      peakNps: +peak.toFixed(2),
      shape: shape.map(v => +v.toFixed(2)),
      backHalf: +backHalf.toFixed(2),
      types: typeCount,
      tapRatio: +tapRatio.toFixed(3),
      holdRatio: +holdRatio.toFixed(3),
      aboveRatio: +aboveRatio.toFixed(3),
      chordCount: multi,
      chordRatio: +chordRatio.toFixed(3),
      bigJumps: jumps,
      /* 纵向：判定线 y 的跨度。0 = 一条直线，就是用户说的「1D 谱」 */
      lineYSpan: ySpan,
    },
  };
}

function quantile(arr, q) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))] || 0;
}
