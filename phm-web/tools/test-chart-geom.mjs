#!/usr/bin/env node
/* ============================================================
 * tools/test-chart-geom.mjs —— 几何层音符类型回归测试
 * ============================================================
 * 守 2026-10-25 用户在真实使用中发现的那条：
 *   chart-geom 把每个音符压成 `type: 'hold' | 'tap'`（绘图只关心有没有尾巴），
 *   而体检拿 `type` 当类型统计 → Flick/Drag 全被并进 Tap，
 *   一张「Tap 84 / Hold 12 / Drag 12 / Flick 12」的谱被报成「tap 84 / hold 12」。
 *   模型据此以为生成器吞了类型，白查两轮。
 * 判据：`type` 保持两档（绘图依赖），`kind` 必须是真实类型。
 * ============================================================ */
import { extractGeometry } from '../public/js/chart-geom.js';
import { lintChart } from '../public/js/chart-lint.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

/* 最小 RPE v160：一行四类音符各 3 个，上下方交替 */
function mkChart() {
  const notes = [];
  const add = (beat, type, above) => notes.push({
    type, above, alpha: 255, isFake: 0, positionX: (beat - 2) * 40, size: 1, speed: 1,
    startTime: beat, endTime: type === 2 ? beat + 0.5 : beat, yOffset: 0,
  });
  let b = 2;
  let i = 0;
  for (const t of [1, 2, 3, 4]) {
    for (let k = 0; k < 3; k++) { add(b, t, i % 2); b += 0.5; i++; }
  }
  return {
    formatVersion: 3, offset: 0,
    BPMList: [{ bpm: 120, startTime: [0, 0, 1] }],
    META: { name: 'kind-test', duration: 20 },
    judgeLineList: [{ Group: 0, eventLayers: [], notes, numOfNotes: notes.length }],
  };
}

const g = extractGeometry(mkChart());
/* ⚠ 音符在顶层的 g.notes —— g.lines 只有事件轨道 */
const notes = g.notes;

ok('音符数 = 12', notes.length === 12, String(notes.length));
ok('kind 保留真实类型（每类 3 个，顺序不变）',
  JSON.stringify(notes.map((n) => n.kind)) === JSON.stringify(['tap','tap','tap','hold','hold','hold','flick','flick','flick','drag','drag','drag']),
  JSON.stringify(notes.map((n) => n.kind)));
ok('type 仍是两档（绘图依赖，不能动）',
  notes.every((n) => n.type === 'tap' || n.type === 'hold'));
ok('above 交替为真', notes.filter((n) => n.above).length === 6,
  String(notes.filter((n) => n.above).length));

const rep = lintChart(g, {});
const t = rep.stats.types || {};
ok('体检 types 数出 drag', t.drag === 3, JSON.stringify(t));
ok('体检 types 数出 flick', t.flick === 3, JSON.stringify(t));
ok('体检 types 数出 tap/hold', t.tap === 3 && t.hold === 3, JSON.stringify(t));

/* ── 纵向：用户说的「这TM就是1D谱子」──
   只有 positionX 的谱，判定线 y 不动 → 全在一条直线上。
   体检要能**量出来并报警**，否则模型永远不知道自己交了一张 1D。 */
function mkWithY(ys, lineCount = 1) {
  const notes = [];
  for (let i = 0; i < 60; i++) {
    notes.push({ type: 1, above: 1, alpha: 255, isFake: 0, positionX: (i % 5) * 60 - 150,
      size: 1, speed: 1, startTime: [2 + i * 0.25, 0, 1], endTime: [2 + i * 0.25, 0, 1], yOffset: 0 });
  }
  const mkLayer = (li) => {
    const moveYEvents = [];
    for (let k = 0; k < ys.length - 1; k++) {
      moveYEvents.push({
        startTime: [2 + k * 8, 0, 1], endTime: [2 + (k + 1) * 8, 0, 1],
        start: ys[k] + li * 150, end: ys[k + 1] + li * 150, easingType: 6, bezier: 0, bezierPoints: [0, 0, 0, 0],
      });
    }
    return [{ moveXEvents: [], moveYEvents, rotateEvents: [], alphaEvents: [], speedEvents: [] }];
  };
  const list = [];
  for (let li = 0; li < lineCount; li++) {
    /* 音符平均分到各条线；单线时全在第一根 */
    const mine = notes.filter((_, i) => i % lineCount === li);
    list.push({ Group: 0, eventLayers: mkLayer(li), notes: mine, numOfNotes: mine.length });
  }
  return {
    formatVersion: 3, offset: 0, BPMList: [{ bpm: 120, startTime: [0, 0, 1] }],
    META: { name: 'y-test', duration: 20 },
    judgeLineList: list,
  };
}

const flat = lintChart(extractGeometry(mkWithY([0, 0, 0])), {});
ok('★ 单线 + 线不动 → 判「纵向」', (flat.warnings || []).some((w) => w.layer === '纵向'),
  JSON.stringify((flat.warnings || []).map((w) => w.layer)));
ok('纵向跨度 ≈ 0', Math.abs((flat.stats.lineYSpan ?? 0)) < 1, String(flat.stats.lineYSpan));

/* ⚠ 单线**即使上下走**仍然是 1D —— 任一时刻只有一个 y。
   这条是 2026-10-25 用户实测「判定线动了，但是还是 1D」的判据。 */
const moving1 = lintChart(extractGeometry(mkWithY([-200, 180, -120], 1)), {});
ok('★ 单线 + 上下走 → 仍判「纵向」（1D）',
  (moving1.warnings || []).some((w) => w.layer === '纵向'),
  JSON.stringify((moving1.warnings || []).map((w) => w.layer)));
ok('单线上下走时纵向跨度 > 300', (moving1.stats.lineYSpan ?? 0) > 300, String(moving1.stats.lineYSpan));

/* 多线才是二维的来源（真实谱面中位 14 条线承载音符） */
const multi = lintChart(extractGeometry(mkWithY([0, 0, 0], 5)), {});
ok('★ 5 条线承载音符 → 不再判「纵向」',
  !(multi.warnings || []).some((w) => w.layer === '纵向'),
  JSON.stringify((multi.warnings || []).map((w) => w.layer)));

console.log('\n────────');
console.log('几何层音符类型 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
