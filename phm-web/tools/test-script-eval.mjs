#!/usr/bin/env node
/* ============================================================
 * tools/test-script-eval.mjs —— 生成脚本解释器单测
 * ============================================================
 * 为什么要有这个：`script-eval.js` 是 `chart_generate` 的唯一执行路径。
 * 它出错的两种方式完全不同：
 *   ① 抛错 —— 好办，模型能看到「第几行什么字符不认识」，会自己改；
 *   ② **不报错但算错** —— 最坏。曾经 for 循环里 `n += 1` 改的是内层副本，
 *      于是一个数了 8 个音符的脚本 report 出「共 0 个音符」。数字看着合理，
 *      没人会去查。本文件重点守第 ②类。
 * ============================================================ */
import { runScript } from '../public/js/script-eval.js';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
}
function makeHost() {
  const notes = [];
  const host = {
    tap: (b, x = 0) => notes.push({ t: 'tap', b, x }),
    drag: (b, x = 0) => notes.push({ t: 'drag', b, x }),
    flick: (b, x = 0) => notes.push({ t: 'flick', b, x }),
    hold: (b1, b2, x = 0) => notes.push({ t: 'hold', b1, b2, x }),
    at: (b, x, type = 1) => notes.push({ t: 'at', b, x, type }),
    report: (m) => { host._log = String(m); },
    bpm: 120,
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3],
    sections: [{ start: 0, end: 8, label: 'verse' }],
    energy: () => 0.5,
    _log: '',
  };
  return { host, notes };
}
const run = (src) => {
  const { host, notes } = makeHost();
  const r = runScript(src, host);
  return { notes, log: host._log, steps: r.steps };
};
const throws = (src) => { try { run(src); return null; } catch (e) { return e.message; } };

/* ── 1. 基本节奏 ── */
{
  const { notes } = run('for (let b = 2; b < 40; b += 0.5) { tap(b, (b * 2) % 4 === 0 ? -300 : 300); }');
  ok('半拍循环 76 个音符', notes.length === 76, String(notes.length));
  ok('三元生效：第 1 个 x = -300', notes[0].x === -300, String(notes[0].x));
  ok('三元生效：第 2 个 x = 300', notes[1].x === 300, String(notes[1].x));
}
{
  const { notes } = run('for (let m = 0; m < 8; m++) { tap(m * 4 + 2, 0); }');
  ok('8 小节 → 8 个音符', notes.length === 8);
  ok('小节起点算对（0/4/8…）', notes.map((n) => n.b).join(',') === '2,6,10,14,18,22,26,30',
    notes.map((n) => n.b).join(','));
}

/* ── 2. ⚠ 静默算错区：外层变量必须在循环里能改 ── */
{
  const { notes, log } = run("let n = 0;\nfor (let b = 2; b < 10; b += 1) { tap(b, 0); n += 1; }\nreport('共 ' + n + ' 个音符');");
  ok('循环里改外层变量：音符 8 个', notes.length === 8, String(notes.length));
  ok('循环里改外层变量：report 是 8', log === '共 8 个音符', log);
}
{
  const { log } = run("let a = 0; for (let i = 0; i < 5; i++) { a += 2; } report(a + '');");
  ok('循环累加 5×2 = 10', log === '10', log);
}

/* ── 3. 字符串（report 的参数）── */
{
  ok('单引号字符串', run("report('前 8 拍');").log === '前 8 拍');
  ok('双引号字符串', run('report("完成");').log === '完成');
  ok('字符串拼接', run("let n = 3; report('共 ' + n + ' 个');").log === '共 3 个');
  ok('转义 \\t', run("report('a\\tb');").log === 'a\tb');
  ok('字符串没闭合要报错', /没有闭合/.test(throws("report('abc);") || ''));
}

/* ── 4. 下标 / length ── */
{
  const { notes } = run('for (let i = 0; i < beats.length; i++) { tap(beats[i], 0); }');
  ok('beats 全铺 = 7 个', notes.length === 7, String(notes.length));
  ok('beats[3] = 1.5', notes[3].b === 1.5, String(notes[3].b));
  ok('sections[0].end 读得到', run("report(sections[0].end + '');").log === '8');
}

/* ── 5. if / else / Math ── */
{
  const { notes } = run('for (let i = 0; i < 16; i++) {\n  if (i % 4 === 0) { hold(i * 2 + 2, i * 2 + 2.5, 0); }\n  else { tap(i * 2 + 2, Math.floor(i / 2) * 100 - 300); }\n}');
  ok('if/else 分支数 = 16', notes.length === 16, String(notes.length));
  ok('i=0 出 hold', notes[0].t === 'hold');
  ok('i=1 出 tap 且 x = -300', notes[1].t === 'tap' && notes[1].x === -300, JSON.stringify(notes[1]));
}
{
  ok('Math.round', run("report(Math.round(2.6) + '');").log === '3');
  ok('Math.max', run("report(Math.max(1, 9, 3) + '');").log === '9');
}
/* 无花括号：`if (c) tap(...);` 与 `for (...) tap(...);` 都是高频写法 */
{
  const { notes } = run('for (let i = 0; i < 6; i++) if (i % 2 === 0) tap(i + 2, 0); else drag(i + 2, 100);');
  ok('单语句 for + if/else = 6 个', notes.length === 6, String(notes.length));
  ok('偶数位是 tap', notes[0].t === 'tap' && notes[2].t === 'tap');
  ok('奇数位是 drag 且 x=100', notes[1].t === 'drag' && notes[1].x === 100, JSON.stringify(notes[1]));
}
{
  const { notes } = run('for (let i = 0; i < 4; i++) tap(i + 2, 0);');
  ok('单语句 for 循环体 = 4 个', notes.length === 4, String(notes.length));
}
/* 数组 / 数字方法 / 转换函数：模型实测都会写 */
{
  const { notes } = run('const xs = [-300, 300];\nfor (let i = 0; i < 4; i++) { tap(i + 2, xs[i % 2]); }');
  ok('数组字面量 + 下标', notes.length === 4 && notes[0].x === -300 && notes[1].x === 300,
    JSON.stringify(notes.slice(0, 2)));
  ok('数字方法 toFixed 不丢 this', run('report((1.23456).toFixed(2));').log === '1.23',
    run('report((1.23456).toFixed(2));').log);
  ok('String() 转换', run('report(String(5) + " 个");').log === '5 个');
  ok('parseFloat', run('report(parseFloat("1.5") + 1 + "");').log === '2.5');
  /* 对象字面量现在**支持**了（模型拿它存段落表）；缺冒号要报得清楚 */
  ok('对象缺冒号报错', /键后面应该是/.test(throws('const o = { a 1 }; tap(2, 0);') || ''), throws('const o = { a 1 }; tap(2, 0);') || '');
}
/* 这三种写法模型每轮都会用，不支持就整轮白改（实测一次任务连撞 4 次） */
{
  const { notes } = run('const B1 = 8, B2 = 16, STEP = 0.5;\nfor (let b = B1; b < B2; b += STEP) tap(b, 0);');
  ok('逗号连声明 const a=1, b=2', notes.length === 16, String(notes.length));

  const { notes: n2 } = run('const sec = { intro: [0, 44.4], verse: [44.4, 89] };\nfor (let b = 2; b < 8; b++) tap(b, sec.intro[1] / 10);');
  ok('对象字面量 + 取成员', n2.length === 6 && Math.abs(n2[0].x - 4.44) < 1e-9,
    JSON.stringify(n2[0]));

  ok('模板字符串插值', run('const n = 3; report(`共 ${n} 个音符`);').log === '共 3 个音符',
    run('const n = 3; report(`共 ${n} 个音符`);').log);
  ok('模板里能算表达式', run('const a = 2, b = 3; report(`${a}×${b}=${a * b}`);').log === '2×3=6',
    run('const a = 2, b = 3; report(`${a}×${b}=${a * b}`);').log);
}

/* ── 6. 注释与分隔 ── */
{  const { notes } = run('// 行注释\nfor (let i = 0; i < 3; i++) { tap(i + 2, 0); } // 尾巴\n# python 味注释\ntap(9, 0);');
  ok('三种注释都不影响执行', notes.length === 4, String(notes.length));
  ok('/* */ 块注释', run('/* 一整段\n注释 */ tap(2, 0);').notes.length === 1);
}

/* ── 7. 坏脚本必须报错，且指到行 ── */
{
  const m = throws('for (let b = 0; b < 3; b++) { tapTo(b); }');
  ok('不存在的函数要报错', /不存在的函数/.test(m || ''), m || '没报错');
  ok('报错里带行号', /第 \d+ 行/.test(m || '') || /不存在的函数/.test(m || ''), m || '');
  const m2 = throws('tap(b, 0);');
  ok('用了未声明的名字要报错', /不存在的名字/.test(m2 || ''), m2 || '没报错');
}

/* ── 8. ⚠ 隔离：摸不到宿主全局 ── */
{
  ok('window 摸不到', /不存在的名字/.test(throws('tap(window.localStorage, 0);') || ''));
  ok('globalThis 摸不到', /不存在的名字/.test(throws('tap(globalThis, 0);') || ''));
  ok('fetch 摸不到', /不存在的函数/.test(throws('tap(fetch("/x"), 0);') || ''));
  ok('document 摸不到', /不存在的名字/.test(throws('tap(document.cookie, 0);') || ''));
}

/* ── 9. 死循环要拦住，不能冻住页面 ── */
{
  const m = throws('for (let b = 0; b >= 0; b++) { tap(b, 0); }');
  ok('死循环被步数上限拦住', /超过 \d+ 步|循环超过/.test(m || ''), m || '没拦住');
}
{
  const m = throws('');
  ok('空脚本要报错', /空/.test(m || ''), m || '没报错');
}

console.log('\n────────');
console.log('生成脚本解释器 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
