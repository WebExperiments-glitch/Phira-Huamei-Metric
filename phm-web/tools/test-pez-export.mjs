#!/usr/bin/env node
/* ============================================================
 * tools/test-pez-export.mjs —— 导出必须能被 Phira 打开
 * ============================================================
 * 2026-10-25 用户实测：导入报
 *   `JSON 解析失败 / missing field 'visibleTime' at line 381 column 9`
 * —— 包能下载、能解压、音频也在，**就是 Phira 不认**。
 * 这类 bug 最难受：每一步都"成功"，只有最终用户打不开。
 *
 * 判据不是"我们觉得对"，而是对齐 `data/charts/<id>/chart.json`
 * （爬虫抓下来的真实谱面，Phira 本来就能打开）的字段集。
 * ============================================================ */
import { normalizeForPhira } from '../public/js/rulechart.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

/* 一份"我们自己生成器会产出"的谱面：字段是最小集，故意不带 visibleTime */
const mk = () => ({
  formatVersion: 3, offset: 0, judgeLineGroup: ['Default'],
  BPMList: [{ bpm: 150, startTime: [0, 0, 1] }],
  META: { RPEVersion: 160, background: 'background.png', charter: 'x', composer: 'y',
    illustration: '', id: 't1', level: 'IN Lv.9', name: 't', offset: 0, song: 'a.wav', duration: 10 },
  judgeLineList: [{
    Group: 0, Name: 'Default', Texture: 'line.png', anchor: [0.5, 0.5],
    eventLayers: [{
      moveXEvents: [{ startTime: [0, 0, 1], endTime: [4, 0, 1], start: -500, end: 0,
        easingType: 16, bezier: 0, bezierPoints: [0, 0, 0, 0] }],
      moveYEvents: [], rotateEvents: [], alphaEvents: [], speedEvents: [],
    }],
    father: -1, isCover: 1, numOfNotes: 1, zOrder: 0,
    notes: [{ above: 1, alpha: 255, endTime: [4, 0, 1], isFake: 0, positionX: 0,
      size: 1, speed: 1, startTime: [4, 0, 1], type: 1, yOffset: 0 }],
  }],
});

/* 真实谱面（data/charts/1000）里这些字段一个不少 —— Phira 认得它 */
const REAL_NOTE_KEYS = ['above', 'alpha', 'endTime', 'isFake', 'positionX', 'size',
  'speed', 'startTime', 'type', 'visibleTime', 'yOffset'];
const REAL_EVENT_KEYS = ['bezier', 'bezierPoints', 'easingLeft', 'easingRight',
  'easingType', 'end', 'endTime', 'linkgroup', 'start', 'startTime'];
const REAL_LINE_KEYS = ['Group', 'Name', 'Texture', 'alphaControl', 'bpmfactor',
  'eventLayers', 'father', 'isCover', 'notes', 'numOfNotes', 'posControl',
  'sizeControl', 'skewControl', 'yControl', 'zOrder'];

const src = mk();
const out = normalizeForPhira(src);
const ln = out.judgeLineList[0];

ok('音符有 visibleTime', ln.notes[0].visibleTime === 999999, String(ln.notes[0].visibleTime));
ok('音符字段齐（对齐真实谱面）',
  REAL_NOTE_KEYS.every((k) => k in ln.notes[0]),
  REAL_NOTE_KEYS.filter((k) => !(k in ln.notes[0])).join(','));

const ev = ln.eventLayers[0].moveXEvents[0];
ok('事件字段齐（easingLeft/Right、linkgroup）',
  REAL_EVENT_KEYS.every((k) => k in ev),
  REAL_EVENT_KEYS.filter((k) => !(k in ev)).join(','));

ok('判定线 control 字段齐',
  REAL_LINE_KEYS.every((k) => k in ln),
  REAL_LINE_KEYS.filter((k) => !(k in ln)).join(','));

ok('alphaControl 形状对（两段，x:0 与 x:9999999）',
  ln.alphaControl.length === 2 && ln.alphaControl[0].x === 0 && ln.alphaControl[1].x === 9999999,
  JSON.stringify(ln.alphaControl));

/* ⚠ 必须深拷贝：调用方后面还要拿这张谱继续改（chart_patch / 再导出） */
ok('不改动传入的谱面', src.judgeLineList[0].notes[0].visibleTime === undefined);
ok('补出来的新字段不与传入对象共享引用', ln.notes[0] !== src.judgeLineList[0].notes[0]);

/* 已经有值的不能覆盖 */
const withVal = mk();
withVal.judgeLineList[0].notes[0].visibleTime = 6;
withVal.judgeLineList[0].bpmfactor = 2;
const out2 = normalizeForPhira(withVal);
ok('已有的 visibleTime 不被覆盖', out2.judgeLineList[0].notes[0].visibleTime === 6);
ok('已有的 bpmfactor 不被覆盖', out2.judgeLineList[0].bpmfactor === 2);

/* 多判定线 / 空谱面不能炸 */
const multi = mk();
multi.judgeLineList.push(JSON.parse(JSON.stringify(multi.judgeLineList[0])));
ok('多判定线全部补齐',
  normalizeForPhira(multi).judgeLineList.every((l) => l.notes[0].visibleTime === 999999));
ok('空谱面不炸', normalizeForPhira({ judgeLineList: [] }).judgeLineList.length === 0);

console.log('\n────────');
console.log('导出字段 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
