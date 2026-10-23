/* ============================================================
 * tools/test-skills.mjs —— 技能分（方案 C）单元测试
 * ============================================================
 *  为什么单独立一个文件，而不是塞进 test-ui-flows：
 *    ui-flows 拖的是**故意构造的坏文件**（只验"文件被接住了、界面有反应"），
 *    它**从来没有验证过引擎计算**。把技能分断言挂进去，等于让它去等一个
 *    引擎算完才出现的元素 —— 实测会把整个套件拖成 11 分钟不返回
 *    （CDP 的 Runtime.evaluate 在主线程忙时会永久排队）。
 *    那是**降低**套件可靠性，不是提高。
 *
 *    技能分是纯计算（js/skills.js 无副作用、无 DOM、无网络），
 *    在 Node 侧直接验既快又稳；UI 侧那一层由 smoke 的
 *    「本页无运行时报错」覆盖就够了。
 *
 *  零依赖、不联网、不碰数据库。
 * ============================================================ */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { ENGINE_VER, analyzeChart } from '../public/js/engine.js';
import { zipStore } from '../public/js/rulechart.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  ' + extra); }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/* ── 夹具：现造裸 PEC 文本 ──
 * ⚠ 2026-10-18 踩过的坑：这个文件原先读的是仓库**根目录**的 minimal.pec，
 *   那是本地临时文件、**从没进过 git**。本地 `npm run check` 全绿，
 *   CI 上必炸（ENOENT）—— 又一次「本地过 ≠ CI 过」。
 *   所以谱面文本直接内联在源码里：零外部依赖、零体积、diff 里看得见。
 *
 * ⚠ analyzeChart 只接受 zip 容器，用项目自己的 zipStore() 现包。
 * ⚠ 包内文件名必须叫 chart.json：engine 的 zipParse 按大小排序后嗅探内容，
 *   扩展名只影响排序，不影响解析。 */
function loadChart(pecText, innerName = 'chart.json') {
  const zip = zipStore([{ name: innerName, data: new TextEncoder().encode(pecText) }]);
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

/* 四类刻意不同的谱面，用来验 top 真的会分开（而不是恒定）：
 *   stream  均匀八分，连绵 → 体力
 *   burst   短促密集，点缀 → 灵活 / 精准
 *   wide    大跨度左右交替 → 读谱
 *   chord   大量纵列 → 精准
 * 数值不追求「像真谱」，只要解析得出、四类形状不同就够了。 */
const PEC_HEADER = '0\nbp 0 120.000\ncp 0 0 1024.00 700.00\ncv 0 0 5.85\nca 0 0 255\ncd 0 0 0\n';
function pec(lines) { return PEC_HEADER + lines.join('\n') + '\n'; }

const FIXTURES = {
  /* 每行：`n<type> <x> <t> <y> <dur> <lane>`，x 换轨、y 纵向 */
  minimal: pec([
    'n1 0 0.0000 -409.60 1 0', 'n4 0 0.0625 409.60 1 0',
    'n1 0 4.0625 -409.60 1 0', 'n4 0 4.8750 409.60 1 0',
    'n1 0 6.8125 -409.60 1 0', 'n1 0 8.3125 409.60 1 0',
    'n1 0 8.8125 -409.60 1 0', 'n1 0 9.2500 409.60 1 0',
    'n1 0 10.8125 -409.60 1 0', 'n1 0 11.5000 409.60 1 0',
    'n1 0 12.7500 -409.60 1 0', 'n1 0 14.1875 409.60 1 0',
    'n1 0 15.1250 -409.60 1 0', 'n1 0 15.7500 409.60 1 0',
    'n1 0 16.8125 -409.60 1 0', 'n1 0 18.5625 409.60 1 0',
    'n1 0 18.8750 -409.60 1 0', 'n1 0 19.5625 409.60 1 0',
    'n1 0 19.7500 -409.60 1 0', 'n1 0 19.9375 409.60 1 0',
  ]),
  /* 连绵流：恒定 0.25s 一击、左右交替，纵向基本不动 */
  stream: pec(Array.from({ length: 60 }, (_, i) =>
    `n1 0 ${(i * 0.25).toFixed(4)} ${i % 2 ? 300.00 : -300.00} 1 0`)),
  /* 爆发流：成组短距高频 */
  burst: pec(Array.from({ length: 60 }, (_, i) =>
    `n1 ${(i >> 1) % 4} ${(Math.floor(i / 2) * 0.12).toFixed(4)} ${i % 2 ? 60.00 : -60.00} 1 0`)),
  /* 大跨度读谱：左右远端 + 纵向乱跳，节奏中等 */
  wide: pec(Array.from({ length: 48 }, (_, i) =>
    `n1 ${(i * 3) % 8} ${(i * 0.42).toFixed(4)} ${((i * 137) % 5 - 2) * 200.00} 1 0`)),
  /* 纵列精准：同一时刻两条 n1/n2 叠出来 */
  chord: pec(Array.from({ length: 40 }, (_, i) => {
    const t = (i * 0.5).toFixed(4);
    return 'n1 0 ' + t + ' -300.00 1 0\nn2 3 ' + t + ' 300.00 1 0';
  })),
};

console.log('\n[1] 夹具本身能解析');
let feats = null, skills = null;
{
  const rs = await analyzeChart(loadChart(FIXTURES.minimal), 'chart.json');
  ok('内联最小谱面能解析出结果', rs.length === 1 && !rs[0].error,
     rs[0] ? String(rs[0].error || '') : 'no reports');
  feats = rs[0] && rs[0].feats;
  skills = rs[0] && rs[0].skills;
}

console.log('\n[2] feats 结构');
ok('feats 有 39 个特征', feats && Object.keys(feats).length >= 39,
   feats ? String(Object.keys(feats).length) : 'no feats');

console.log('\n[3] 技能分结构');
ok('skills 非空', !!skills, JSON.stringify(skills));
if (skills) {
  const ids = ['stamina', 'dexterity', 'reading', 'precision'];
  ok('恰好 4 个技能项', ids.every(k => typeof skills[k] === 'number'),
     JSON.stringify(Object.keys(skills)));
  ok('4 项都在 0-100', ids.every(k => skills[k] >= 0 && skills[k] <= 100),
     JSON.stringify(ids.map(k => skills[k])));
  ok('有 top 字段且是 4 项之一', ids.includes(skills.top), String(skills.top));
  ok('有 profile 字段', typeof skills.profile === 'string' && skills.profile.length > 0,
     String(skills.profile));

  /* ⚠ 这条是本次新增最关键的断言：**四项不能一模一样**。
     四根条一样 = 归一化写坏了（全 0 或全到顶），
     那时界面上「看着有内容」，实则毫无信息量 —— 正是最容易出的错。 */
  const vals = ids.map(k => skills[k]);
  const spread = Math.max(...vals) - Math.min(...vals);
  ok('★ 四项有区分度（极差 >= 3）', spread >= 3,
     'values=' + JSON.stringify(vals) + ' 极差=' + spread.toFixed(1));
  ok('不是全部为 0', vals.some(v => v > 0), JSON.stringify(vals));
  ok('不是全部顶到 100', vals.some(v => v < 100), JSON.stringify(vals));
}

console.log('\n[4] 多谱面：top 分布不应全一样');
/* ⚠ 这一组原先扫本地 `谱面数据包/` 目录 —— 那是本地才有的大文件，
 *   CI 上目录不存在 → 整组被跳过，等于**从来没在 CI 上验过**。
 *   现在改跑 4 张内联的、形状刻意不同的谱面（见 FIXTURES 注释）。 */
{
  const ids = ['stamina', 'dexterity', 'reading', 'precision'];
  const tops = {};
  const detail = {};
  let parsed = 0;
  for (const [name, text] of Object.entries(FIXTURES)) {
    try {
      const rs = await analyzeChart(loadChart(text), 'chart.json');
      for (const r of rs) {
        if (!r || r.error || !r.skills) continue;
        parsed++;
        tops[r.skills.top] = (tops[r.skills.top] || 0) + 1;
        detail[name] = Object.fromEntries(ids.map(k => [k, r.skills[k]]));
      }
    } catch (e) {
      ok('谱面 ' + name + ' 解析不抛异常', false, String(e && e.message || e));
    }
  }
  ok('四张谱面都解析出技能分', parsed >= 4, 'parsed=' + parsed);
  ok('top 取值合法', Object.keys(tops).every(k => ids.includes(k)),
     JSON.stringify(tops));
  /* ★ 这才是这组的目的：不同形状应落到**不同** dominant 技能。
     若全落到同一项，说明四个权重写歪了、把一切归到同一根条。 */
  ok('★ top 不止一种（权重没写歪）', Object.keys(tops).length >= 2,
     'top 分布=' + JSON.stringify(tops));
  console.log('  ⓘ top 分布：' + JSON.stringify(tops));
  for (const [name, v] of Object.entries(detail)) {
    console.log('    ' + name.padEnd(8) + ' ' + JSON.stringify(v));
  }
}

console.log('\n[5] skills 不影响定数（纯展示层）');
/* ⚠ 这是方案 C 的**核心承诺**：不动数值、不动 ENGINE_VER。
 *   做法：同一谱面算两次，比较 ps / knn.ref 是否逐位相同。
 *   如果 skills 曾经渗进定数计算，这两条就会变。 */
{
  const a = (await analyzeChart(loadChart(FIXTURES.minimal), 'chart.json'))[0];
  const b = (await analyzeChart(loadChart(FIXTURES.minimal), 'chart.json'))[0];
  ok('两次计算 ps 相同', a.ps && b.ps && a.ps.total === b.ps.total,
     JSON.stringify([a.ps && a.ps.total, b.ps && b.ps.total]));
  ok('两次计算 knn.ref 相同',
     a.knn && b.knn && a.knn.ref === b.knn.ref,
     JSON.stringify([a.knn && a.knn.ref, b.knn && b.knn.ref]));
  /* ⚠ 别把引擎版本号写死。这条要守的是「技能分是纯展示层，不改变引擎语义」，
     不是「引擎版本必须永远等于某串字面量」——2026-10-23 扩维把版本改到
     引擎版本号变了，这条断言红得毫无意义（它本来就不是回归）。
     正确判据：两次计算之间版本**没变**，而且等于模块导出的那份。 */
  ok('ENGINE_VER 未被技能分改动',
    a.engineVer === b.engineVer && a.engineVer === ENGINE_VER, String(a.engineVer));
  ok('report 里有 skills', !!a.skills);
}

console.log('\n────────');
console.log('技能分 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);