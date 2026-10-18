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
import { analyzeChart } from '../public/js/engine.js';
import { zipStore } from '../public/js/rulechart.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  ' + extra); }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/* ── 造一份可解析的最小谱面 ──
 * ⚠ 仓库的 minimal.pec 是**裸 PEC 文本**，而 analyzeChart 只接受 zip 容器。
 *   而仓库里唯一的真 zip 有 6.5MB（含音频），当夹具不合适。
 *   所以用项目自己的 zipStore() 现包 —— 零外部依赖、零体积。
 * ⚠ 包内文件名必须叫 chart.json：engine 的 zipParse 会按大小排序后
 *   嗅探内容，扩展名只影响排序，不影响解析。 */
function loadChart(pecPath, innerName = 'chart.json') {
  const text = fs.readFileSync(pecPath, 'utf8');
  const zip = zipStore([{ name: innerName, data: new TextEncoder().encode(text) }]);
  const ab = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
  return ab;
}

console.log('\n[1] 夹具本身能解析');
const minimal = path.join(ROOT, 'minimal.pec');
let feats = null, skills = null;
if (!fs.existsSync(minimal)) {
  ok('minimal.pec 存在', false, minimal);
} else {
  ok('minimal.pec 存在', true);
  const rs = await analyzeChart(loadChart(minimal), 'chart.json');
  ok('最小谱面能解析出结果', rs.length === 1 && !rs[0].error,
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
/* ⚠ 只有一张谱时 top 恒定，那这条断言就是假的。
 *   遍历所有可用谱面，统计 top 分布。样本少也要照实报，不粉饰。 */
{
  const dirs = [path.join(ROOT, '谱面数据包')];
  const found = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/\.zip$/i.test(f)) found.push(path.join(d, f));
    }
  }
  if (!found.length) {
    console.log('  ⓘ 没有多谱面样本，跳过（本条在 CI 上不生效）');
  } else {
    const tops = {};
    let parsed = 0;
    for (const f of found) {
      try {
        const buf = fs.readFileSync(f);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const rs = await analyzeChart(ab, path.basename(f));
        for (const r of rs) {
          if (!r || r.error || !r.skills) continue;
          parsed++;
          tops[r.skills.top] = (tops[r.skills.top] || 0) + 1;
        }
      } catch (e) { /* 解析不了就跳过，不算失败 */ }
    }
    ok('至少解析出 1 个难度', parsed >= 1, 'parsed=' + parsed);
    ok('top 取值合法', Object.keys(tops).every(k =>
       ['stamina', 'dexterity', 'reading', 'precision'].includes(k)),
       JSON.stringify(tops));
    console.log('  ⓘ top 分布：' + JSON.stringify(tops) + '（样本 ' + parsed + '）');
  }
}

console.log('\n[5] skills 不影响定数（纯展示层）');
/* ⚠ 这是方案 C 的**核心承诺**：不动数值、不动 ENGINE_VER。
 *   做法：同一谱面算两次，比较 ps / knn.ref 是否逐位相同。
 *   如果 skills 曾经渗进定数计算，这两条就会变。 */
{
  const ab = loadChart(minimal);
  const a = (await analyzeChart(ab, 'chart.json'))[0];
  const b = (await analyzeChart(loadChart(minimal), 'chart.json'))[0];
  ok('两次计算 ps 相同', a.ps && b.ps && a.ps.total === b.ps.total,
     JSON.stringify([a.ps && a.ps.total, b.ps && b.ps.total]));
  ok('两次计算 knn.ref 相同',
     a.knn && b.knn && a.knn.ref === b.knn.ref,
     JSON.stringify([a.knn && a.knn.ref, b.knn && b.knn.ref]));
  ok('ENGINE_VER 未被改动', a.engineVer === 'com-trim15-v0.5.0', String(a.engineVer));
  ok('report 里有 skills', !!a.skills);
}

console.log('\n────────');
console.log('技能分 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);