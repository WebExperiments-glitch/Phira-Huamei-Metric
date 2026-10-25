#!/usr/bin/env node
/* ============================================================
 * tools/test-beat-time.mjs —— 拍 ↔ 秒 换算单测
 * ============================================================
 * 为什么值得单独测：这是**全链路唯一**的时间换算。它错一次，
 * 谱面上所有音符的落点、总时长、动画关键帧全部跟着错，而且
 * 没有任何一层会报错 —— 谱面「能导出来、能导入 Phira」，就是位置不对。
 *
 * 守两件事：
 *   ① 两个方向**严格互逆**（变速谱也要）
 *   ② 变速谱的分段语义是「BPMList[i] 管 [startTime_i, startTime_{i+1})」
 *      —— 旧版拿下一个 BPM 点的值算前一段，16 拍 @120 给成 5.33 秒（应为 8.00）
 * ============================================================ */
import { beatValue, toBeat, chartBeatToSec, chartSecToBeat } from '../public/js/beat-time.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const SINGLE = [{ bpm: 150, startTime: [0, 0, 1] }];
const VARY = [{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 180, startTime: [16, 0, 1] }];

/* 1. 单 BPM */
ok('150BPM：4 拍 = 1.6 秒', near(chartBeatToSec(4, SINGLE), 1.6), String(chartBeatToSec(4, SINGLE)));
ok('150BPM：24 秒 = 60 拍', near(chartSecToBeat(24, SINGLE), 60), String(chartSecToBeat(24, SINGLE)));

/* 2. 变速：分段语义 */
ok('变速：16 拍 @120 = 8.00 秒', near(chartBeatToSec(16, VARY), 8), String(chartBeatToSec(16, VARY)));
ok('变速：第 20 拍 = 8 + 4×60/180 = 9.333 秒',
  near(chartBeatToSec(20, VARY), 8 + 4 * 60 / 180, 1e-6), String(chartBeatToSec(20, VARY)));

/* 3. 双向互逆（含边界） */
let worst = 0, worstAt = null;
for (const [name, list] of [['单 BPM', SINGLE], ['变速', VARY]]) {
  for (const b of [0, 1, 7.5, 15.999, 16, 16.001, 23.99, 40, 60]) {
    if (name === '单 BPM' && b > 60) continue;
    const back = chartSecToBeat(chartBeatToSec(b, list), list);
    const d = Math.abs(back - b);
    if (d > worst) { worst = d; worstAt = `${name} beat=${b} → ${back}`; }
  }
}
ok('拍→秒→拍 互逆（最大误差 < 1e-6）', worst < 1e-6, `最大 ${worst.toExponential(2)} @ ${worstAt}`);

/* 4. 边界：0 秒 = 0 拍；负值不炸 */
ok('0 秒 = 0 拍', chartSecToBeat(0, SINGLE) === 0);
ok('0 拍 = 0 秒', chartBeatToSec(0, SINGLE) === 0);

/* 5. 拍的三元组 */
ok('toBeat(3) = [3,0,1]', JSON.stringify(toBeat(3)) === '[3,0,1]', JSON.stringify(toBeat(3)));
ok('toBeat(3.5) 往返 = 3.5', near(beatValue(toBeat(3.5)), 3.5), String(beatValue(toBeat(3.5))));
ok('toBeat(1/3) 往返误差 < 1e-3', Math.abs(beatValue(toBeat(1 / 3)) - 1 / 3) < 1e-3,
  String(beatValue(toBeat(1 / 3))));
ok('beatValue 吃数字', beatValue(2.25) === 2.25);

console.log('\n────────');
console.log('拍↔秒换算 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
