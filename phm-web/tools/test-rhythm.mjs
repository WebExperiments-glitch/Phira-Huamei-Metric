/* ============================================================
 * tools/test-rhythm.mjs —— 规则写谱三层（时间轴 / 事件选择 / 可玩性）单测
 * ============================================================
 * 全部纯函数，不联网、不解码音频 —— 直接喂合成数据。
 *
 * 【为什么这些断言值得存在】
 * 这三层修的是三种「看起来没问题，打起来不对」的毛病：
 *   A 音符不在拍上（0.47 / 0.94 拍）→ 玩家读不出来
 *   B 为了凑密度凭空造音符 → 谱面有一半是假的
 *   C 格式全合法但没法打（12 NPS 挤一个 x / 连续 40 个 90ms）
 * 这类问题**不会报错**，只会让谱面难听、难打。所以必须用断言钉住。
 * ============================================================ */
import {
  SUBDIVS, SUBDIV_COST_MS, buildGrid, secToBeat, beatToSec,
  quantizeOnsets, markTuplets, phraseBounds, quantizeReport, valueName,
} from '../public/js/rhythm.js';
import {
  scoreEvents, selectEvents, assignHands, assignNotes, selectionReport,
} from '../public/js/salience.js';
import { auditPlayability, gridDeviation, summaryOf } from '../public/js/playability.js';

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const G = s => console.log('\n【' + s + '】');

/* 统一用 120 BPM / 4 拍一小节 / 相位 0 —— 每拍 0.5 秒，好算 */
const GRID = buildGrid({ bpm: 120, offset: 0, duration: 60 });
const BS = GRID.beatSec;

/* ══════════════════════════════════════════════════════════════
 * A · 时间轴：拍网格 / 量化 / 三连音 / 乐句
 * ══════════════════════════════════════════════════════════════ */
G('A1 · 拍网格');
T('120 BPM → 每拍 0.5 秒', Math.abs(BS - 0.5) < 1e-9, String(BS));
T('4 拍一小节', GRID.beatsPerBar === 4, String(GRID.beatsPerBar));
T('相位落在 [0, 每拍) 内', GRID.offsetSec >= 0 && GRID.offsetSec < BS, String(GRID.offsetSec));
T('等效包围：负相位被折算成正的',
  buildGrid({ bpm: 120, offset: -0.25, duration: 10 }).offsetSec >= 0,
  String(buildGrid({ bpm: 120, offset: -0.25, duration: 10 }).offsetSec));
T('拍号 ↔ 秒 互逆',
  Math.abs(secToBeat(beatToSec(7.3, GRID), GRID) - 7.3) < 1e-9);
T('网格覆盖到最后（末尾两拍也算上了）', GRID.totalBeats >= 121, String(GRID.totalBeats));

G('A2 · 量化：整拍 / 半拍 / 三连音');
/* ⚠ 这里的入参是**秒**（audio-analysis 给的 onset 就是秒）。
   早先按拍写过，于是 2.5 秒 = 第 5 拍，看起来"落在整拍上"——
   测试自己错了，实现是对的。 */
const q = (times, opts) => quantizeOnsets(times.map(t => ({ time: t, strength: 0.8, layer: 'drum' })), GRID, opts);
const qExact = q([2.0, 2.5, 3.0]);          /* 第 4 / 5 / 6 拍 */
T('整拍上的音落在 1/1 网格', qExact.every(e => e.subdiv === 1), JSON.stringify(qExact.map(e => e.value)));
T('整拍偏差为 0', qExact.every(e => Math.abs(e.devMs) < 1e-6), JSON.stringify(qExact.map(e => e.devMs)));

const qHalf = q([2.25, 2.75]);               /* 第 4.5 / 5.5 拍 */
T('半拍上的音落在 1/2 网格', qHalf.every(e => e.subdiv === 2), JSON.stringify(qHalf.map(e => e.value)));

/* ★ 这是 A 层最核心的一条：三连音不能被压成半拍 */
const qTrip = q([2.0 + BS / 3, 2.0 + BS * 2 / 3]);   /* 第 4+1/3 与 4+2/3 拍 */
T('★ 三连音落在 1/3 网格（不是被压成 1/2）',
  qTrip.every(e => e.subdiv === 3), JSON.stringify(qTrip.map(e => e.value)));
T('★ 三连音的时间点确实是 4+1/3 与 4+2/3 拍',
  Math.abs(qTrip[0].beat - (4 + 1 / 3)) < 1e-6 && Math.abs(qTrip[1].beat - (4 + 2 / 3)) < 1e-6,
  JSON.stringify(qTrip.map(e => +e.beat.toFixed(4))));

/* 复杂度代价：半拍上的音不该被拉到 1/3 网格上（偏差更小但读谱更贵） */
T('★ 半拍优先读作 1/2（复杂度代价压过了更小偏差的诱因）',
  q([2.25])[0].subdiv === 2, JSON.stringify(q([2.25]).map(e => e.value)));

const q6 = q([2.0 + BS / 6, 2.0 + BS * 5 / 6]);
T('六连音落在 1/6 网格', q6.every(e => e.subdiv === 6), JSON.stringify(q6.map(e => e.value)));

G('A3 · 量化：边界与丢弃');
/* 2.0 + 0.21 秒 = 第 4.42 拍：离最近的格（1/8 的 4.375）也有 22.5ms，
   而 1/4 网格要偏 210ms —— 超出 95ms 容差，必须丢。 */
const qFar = q([2.0 + 0.21]);
T('★ 偏太远的不硬吸，标为 off-grid', qFar[0].dropped === true, JSON.stringify(qFar[0].value));
T('被丢的置信度为 0', qFar[0].conf === 0, String(qFar[0].conf));
T('容差内的偏差仍然保留',
  q([2.0 + 0.06]).every(e => !e.dropped), JSON.stringify(q([2.0 + 0.06]).map(e => e.devMs)));
T('置信度随偏差下降',
  q([2.0])[0].conf > q([2.0 + 0.06])[0].conf,
  q([2.0])[0].conf.toFixed(3) + ' vs ' + q([2.0 + 0.06])[0].conf.toFixed(3));

G('A4 · 三连音分组标记');
/* 连续三个 1/3：4+1/3、4+2/3、5.0（即 2.0+BS/3、2.0+2BS/3、2.5） */
const trip3 = q([2.0 + BS / 3, 2.0 + BS * 2 / 3, 2.5]);
markTuplets(trip3);
T('连续 3 个 1/3 被标成三连音组', trip3.filter(e => e.tuplet === 3).length === 3,
  JSON.stringify(trip3.map(e => e.value + '/' + (e.tuplet || '-'))));
const single = q([2.25]); markTuplets(single);
T('孤立的 1/2 不会被标成三连音', !single[0].tuplet, JSON.stringify(single[0].tuplet || null));

G('A5 · 量化报告');
const rep = quantizeReport([].concat(qExact, qFar));
T('报告里有输入 / 保留 / 丢弃数', rep.input === 4 && rep.kept === 3 && rep.dropped === 1,
  JSON.stringify({ i: rep.input, k: rep.kept, d: rep.dropped }));
T('平均偏差是数字', Number.isFinite(rep.meanDevMs), String(rep.meanDevMs));
T('按时值统计有 1/1', rep.byValue['1/1'] === 3, JSON.stringify(rep.byValue));
T('valueName 是给人看的', valueName(3) === '1/3' && valueName(6) === '1/6');

G('A6 · 乐句边界');
const phrases = phraseBounds(GRID, [
  { startSec: 0, endSec: 10, energy: 0.4 },
  { startSec: 10, endSec: 20, energy: 0.9 },
], { phraseBars: 4, duration: 60 });
T('乐句非空', phrases.length > 0, String(phrases.length));
T('第一个乐句从第 0 拍起', Math.abs(phrases[0].startBeat) < 1e-6, String(phrases[0].startBeat));
T('乐句连续、不重叠',
  phrases.every((p, i) => i === 0 || Math.abs(p.startBeat - phrases[i - 1].endBeat) < 1e-6),
  JSON.stringify(phrases.slice(0, 3).map(p => [p.startBeat, p.endBeat])));
T('段落边界被吸到小节线（整 4 拍）',
  phrases.some(p => p.kind === 'section' && p.startBeat % 4 === 0),
  JSON.stringify(phrases.map(p => p.kind + '@' + p.startBeat).slice(0, 5)));

/* ══════════════════════════════════════════════════════════════
 * B · 音乐事件选择
 * ══════════════════════════════════════════════════════════════ */
G('B1 · 显著性打分');
const mk = (beat, layer, strength, subdiv) => {
  const sd = subdiv || 1;
  const bi = beat - Math.floor(beat);
  return {
    beat, bar: Math.floor(beat / 4), beatInBar: bi,
    subdiv: sd, sub: Math.round(bi * sd),
    devMs: 0, cost: 0, value: valueName(sd),
    strength, layer, conf: strength, dropped: false,
  };
};
const strong = mk(4, 'drum', 0.95, 1);       /* 小节头 + 鼓 + 强 */
const weak = mk(5.25, 'onset', 0.35, 4);     /* 十六分 + 混合 onset + 弱 */
const sc = scoreEvents([strong, weak], GRID, { phrases });
T('★ 小节头的鼓点显著高于十六分的弱 onset',
  strong.salience > weak.salience + 0.15,
  strong.salience.toFixed(3) + ' vs ' + weak.salience.toFixed(3));
T('分数在 0..1 内', sc.every(e => e.salience >= 0 && e.salience <= 1));
T('打分给出了可解释的因子', !!strong.salienceWhy && strong.salienceWhy.beatWeight === 1,
  JSON.stringify(strong.salienceWhy));

G('B2 · 选择：绝不凭空造音符');
const many = [];
for (let b = 4; b < 8; b += 0.5) many.push(mk(b, 'drum', 0.9, 2));
const scoredMany = scoreEvents(many, GRID, { phrases });
const selBig = selectEvents(scoredMany, { targetNotes: 100, minSalience: 0.3 });
T('★ 候选不足时不补齐：要 100 只给候选数',
  selBig.picked.length === many.length && selBig.picked.length < 100,
  selBig.picked.length + ' / target 100');
T('★ 如实报告 shortfall', selBig.shortfall === 100 - many.length, String(selBig.shortfall));
T('选择结果按时间排序',
  selBig.picked.every((e, i) => i === 0 || e.beat >= selBig.picked[i - 1].beat));

const selSmall = selectEvents(scoredMany, { targetNotes: 3, minSalience: 0.3 });
T('目标小于候选时按分数取前 N', selSmall.picked.length === 3, String(selSmall.picked.length));
T('取的是分数最高的那些',
  Math.min.apply(null, selSmall.picked.map(e => e.salience))
    >= Math.max.apply(null, selBig.picked.filter(e => !selSmall.picked.includes(e)).map(e => e.salience)) - 1e-9);

/* 阈值这条用的是「最弱的声音 + 最细的格子 + 最不可信的层」——
   三个不利因素叠满，分数必须掉到 0.30 以下。
   ⚠ 早先只把 strength 调低、格子放在小节头，结果靠小节头权重
     仍然过了线（0.57）。那说明 beatWeight 与细分脱钩了：
     **小节头上的 1/8 噪声不该和整拍鼓点同权。** 已在实现里修掉。 */
const weakOnes = [mk(4, 'onset', 0.03, 8), mk(5, 'onset', 0.03, 8)];
scoreEvents(weakOnes, GRID, { phrases });
T('极弱 + 最细格子 + 混合层的分数够低',
  weakOnes.every(e => e.salience < 0.30), JSON.stringify(weakOnes.map(e => +e.salience.toFixed(3))));
const selThresh = selectEvents(weakOnes, { targetNotes: 10, minSalience: 0.30 });
T('★ 低于阈值的全被拒（宁可少给）', selThresh.picked.length === 0, String(selThresh.picked.length));
T('被拒数量有报告', selThresh.rejectedByThreshold === 2, String(selThresh.rejectedByThreshold));

G('B3 · 判定线映射');
const band = [];
for (let b = 4; b < 8; b += 0.5) band.push(mk(b, 'drum', 0.9, 2));
scoreEvents(band, GRID, { phrases });
assignHands(band, { maxSameSide: 3 });
T('每个事件都分到了手', band.every(e => e.hand === 'L' || e.hand === 'R'));
let runMax = 0, r = null, n = 0;
for (const e of band) { n = e.hand === r ? n + 1 : 1; r = e.hand; if (n > runMax) runMax = n; }
T('★ 同侧连续不超过 maxSameSide', runMax <= 3, String(runMax));
T('左右手都用上了', band.some(e => e.hand === 'L') && band.some(e => e.hand === 'R'));

assignNotes(band, { weights: { tap: .58, hold: .10, flick: .07, drag: .25 }, holds: [0.5, 1], beatSec: BS, rng: () => 0.99 });
T('左手 x 全在负半屏', band.filter(e => e.hand === 'L').every(e => e.x < 0),
  JSON.stringify(band.filter(e => e.hand === 'L').map(e => e.x).slice(0, 4)));
T('右手 x 全在正半屏', band.filter(e => e.hand === 'R').every(e => e.x > 0),
  JSON.stringify(band.filter(e => e.hand === 'R').map(e => e.x).slice(0, 4)));
T('每个音符都有类型', band.every(e => ['tap', 'hold', 'flick', 'drag'].includes(e.kind)),
  JSON.stringify(band.map(e => e.kind).slice(0, 6)));

const selRep = selectionReport(selSmall, selSmall.picked);
T('报告含 byKind / byHand / maxSameHand',
  selRep.byKind && selRep.byHand && selRep.maxSameHand != null, JSON.stringify(selRep).slice(0, 120));

/* ══════════════════════════════════════════════════════════════
 * C · 可玩性审计
 * ══════════════════════════════════════════════════════════════ */
G('C1 · 构造工具');
function chartOf(list, bpm) {
  const bb = bpm || 120;
  return {
    BPMList: [{ startTime: [0, 0, 1], bpm: bb }],
    META: { duration: 60, RPEVersion: 160 },
    judgeLineList: [{
      notes: list.map(n => ({
        startTime: n.s, endTime: n.e == null ? n.s : n.e,
        positionX: n.x == null ? -405 : n.x, type: n.t == null ? 1 : n.t,
        above: 1, alpha: 255, isFake: 0, size: 1, speed: 1, visibleTime: 999999, yOffset: 0,
      })),
    }],
  };
}
const F = b => [b, 0, 1];

G('C2 · 硬错误');
const conflict = auditPlayability(chartOf([
  { s: F(4), x: -405 }, { s: F(4), x: -405 },
]), { free: true, minGapBeats: 0.12, targetNps: 4 });
T('★ 同一只手同一时刻两个音 → error',
  conflict.errors.some(e => e.code === 'time-conflict'),
  JSON.stringify(conflict.errors.map(e => e.code)));
T('此时 ok=false', conflict.ok === false);

const chordy = auditPlayability(chartOf([
  { s: F(4), x: -405 }, { s: F(4), x: -202.5 }, { s: F(4), x: 202.5 }, { s: F(4), x: 405 },
]), { free: true, maxChord: 2 });
T('同拍 4 个音符 > maxChord 2 → error',
  chordy.errors.some(e => e.code === 'chord'), JSON.stringify(chordy.errors.map(e => e.code)));

const holdBad = auditPlayability(chartOf([
  { s: F(4), e: F(6), x: -405, t: 2 }, { s: F(5), x: -405 },
]), { free: true, minGapBeats: 0.12 });
T('长条中间又塞音符 → hold-overlap error',
  holdBad.errors.some(e => e.code === 'hold-overlap'),
  JSON.stringify(holdBad.errors.map(e => e.code)));

G('C3 · ★ 回归：free 模式也必须查同手间隔');
const freeClose = auditPlayability(chartOf([
  { s: F(4), x: -405 }, { s: F(4.02), x: -202.5 },
]), { free: true, minGapBeats: 0.12 });
T('★ free 模式下手太近被报出来（以前整条跳过）',
  freeClose.errors.length + freeClose.warnings.length > 0,
  JSON.stringify({ e: freeClose.errors.map(x => x.code), w: freeClose.warnings.map(x => x.code) }));

G('C4 · 警告：密度 / 连续负担 / 长串');
/* 0.2 秒内 16 个音（120BPM 下 0.4 拍）*/
const dense = [];
for (let i = 0; i < 16; i++) dense.push({ s: F(4 + i * 0.025), x: i % 2 ? -405 : 405 });
const denseAudit = auditPlayability(chartOf(dense), { free: true, minGapBeats: 0.01, targetNps: 4 });
T('★ 瞬时过密 → density-spike warn',
  denseAudit.warnings.some(w => w.code === 'density-spike'),
  JSON.stringify(denseAudit.warnings.map(w => w.code)));
T('过密只是警告，不是硬错误（短爆发是合法写法）', denseAudit.ok === true,
  JSON.stringify(denseAudit.errors.map(e => e.code)));

/* 同侧连打 20 个 */
const sameSide = [];
for (let i = 0; i < 20; i++) sameSide.push({ s: F(4 + i * 0.5), x: -405 });
const sideAudit = auditPlayability(chartOf(sameSide), { free: true, minGapBeats: 0.3, maxSameSide: 8 });
T('★ 同侧连续 20 个 → same-hand-run warn',
  sideAudit.warnings.some(w => w.code === 'same-hand-run'),
  JSON.stringify(sideAudit.warnings.map(w => w.code)));
T('报告了最长同侧连击数', sideAudit.metrics.worstSameHandRun === 20,
  String(sideAudit.metrics.worstSameHandRun));

/* 连续 20 个 1/4 拍间隔（120BPM → 125ms）*/
const stream = [];
for (let i = 0; i < 20; i++) stream.push({ s: F(4 + i * 0.25), x: i % 2 ? -405 : 405 });
const streamAudit = auditPlayability(chartOf(stream), { free: true, minGapBeats: 0.2, targetNps: 4 });
T('★ 连续 20 个 1/4 拍 → long-stream warn',
  streamAudit.warnings.some(w => w.code === 'long-stream'),
  JSON.stringify(streamAudit.warnings.map(w => w.code)));

G('C5 · ★ 节奏可读性');
/* 全部落在 0.47 拍这种位置：每条都"在拍附近"，但谁都不在格子上 */
/* ⚠ 位置要选**真的偏**的地方。
   0.47 拍离 1/2 只差 0.03 拍（120BPM 下 15ms）—— 人耳能读，不算不可读；
   早先拿它当反例，是被自己写错的期望骗了。
   0.42 拍离最近的格（1/8 的 0.375）差 0.045 拍，超出 0.035 的容差。 */
const offGrid = [];
for (let i = 0; i < 12; i++) offGrid.push({ s: F(4 + i * 1 + 0.42), x: i % 2 ? -405 : 405 });
const readAudit = auditPlayability(chartOf(offGrid), { free: true, minGapBeats: 0.2 });
T('★ 音符全在 0.42 拍 → unreadable-rhythm warn',
  readAudit.warnings.some(w => w.code === 'unreadable-rhythm'),
  JSON.stringify(readAudit.warnings.map(w => w.code)));
T('报告了不可读比例', readAudit.metrics.offGridRatio > 0.9, String(readAudit.metrics.offGridRatio));

G('C6 · 干净谱面不误报');
const clean = [];
for (let i = 0; i < 16; i++) clean.push({ s: F(4 + i), x: i % 2 ? -405 : 405 });
const cleanAudit = auditPlayability(chartOf(clean), { free: true, minGapBeats: 0.3, targetNps: 1 });
T('★ 整拍交替的干净谱面：0 错误', cleanAudit.errors.length === 0,
  JSON.stringify(cleanAudit.errors.map(e => e.code)));
T('干净谱面也没有不可读警告',
  !cleanAudit.warnings.some(w => w.code === 'unreadable-rhythm'),
  JSON.stringify(cleanAudit.warnings.map(w => w.code)));
T('summaryOf 能给人话', /个音符/.test(summaryOf(cleanAudit)), summaryOf(cleanAudit));

G('C7 · 网格偏差工具');
T('整拍偏差 0', gridDeviation(4, 0.08) < 1e-9, String(gridDeviation(4, 0.08)));
T('半拍偏差 0', gridDeviation(4.5, 0.08) < 1e-9, String(gridDeviation(4.5, 0.08)));
T('三连音偏差 0', gridDeviation(4 + 1 / 3, 0.08) < 1e-9, String(gridDeviation(4 + 1 / 3, 0.08)));
T('0.42 拍偏差超出容差', gridDeviation(4.42, 0.035) > 0.035, String(gridDeviation(4.42, 0.035)));
T('0.47 拍其实很近（1/2 只差 0.03）',
  gridDeviation(4.47, 0.035) < 0.035, String(gridDeviation(4.47, 0.035)));

console.log('\n────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
