#!/usr/bin/env node
/* ============================================================
 * tools/test-write-scope.mjs —— 写谱链路的边界守卫
 * ============================================================
 * 2026-10-25 的决定：写谱**不拆站**，但也不再继续开发，
 * 只需要安静待着。它能不能安静待着，取决于三条硬约束：
 *
 *   1. 清单完整：磁盘上属于它的文件，必须在 WRITE_OWNED 里登记。
 *   2. 依赖单向：**主站文件不许 import 写谱文件**。
 *      （反例：rulechart.html 曾经顶部静态 import agent.js，
 *        agent.js 一有语法错整个规则写谱页白屏。）
 *   3. 开关可用：PHM_WRITE=off 时页面回说明页、接口 503。
 *
 * 这三条都是「不写测试就一定会被破坏」的那种约定。
 * ============================================================ */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRITE_OWNED, WRITE_MAY_USE, writeEnabled, CLOSED_PAGE } from '../lib/write-scope.mjs';

/* 项目根目录。⚠ 必须用 fileURLToPath —— URL.pathname 会把空格和中文
   百分号编码（"自研AI 生成谱面" → %E8%87%AA...），拿去 join 全都不存在，
   于是每条「文件存在吗」都变成假红。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

/* ── 1. 清单里的文件必须真实存在（防止清单腐烂）── */
const missing = WRITE_OWNED.filter((f) => !existsSync(join(ROOT, f)));
ok('清单里的文件都存在', missing.length === 0, missing.join(' , '));

/* ── 2. 磁盘上像是写谱的文件，必须在清单里 ──
   判据用**文件名约定**（agent-*、write-*），不猜内容：
   约定 + 守卫，比"自觉登记"可靠。 */
const scan = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'tmp') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { walk(abs); continue; }
    scan.push(relative(ROOT, abs).replace(/\\/g, '/'));
  }
};
for (const d of ['public/js', 'public', 'lib', 'tools', 'docs']) {
  if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
}
const looksWrite = scan.filter((f) => /(^|\/)(agent[-.]|write[-.]|i18n\/agent)|agent-routes|WRITE-LINK|send-test|e2e-export|bench-/.test(f));
const unlisted = looksWrite.filter((f) => !WRITE_OWNED.includes(f));
ok('磁盘上没有未登记的写谱文件', unlisted.length === 0, unlisted.join(' , '));

/* ── 3. 依赖单向：主站文件不许 import 写谱文件 ──
   写谱可以 import 主站（白名单），反过来不行。 */
const ownedSet = new Set(WRITE_OWNED);
const htmlAndJs = scan.filter((f) => /\.(html|js|mjs)$/.test(f)
  && f.startsWith('public/') || f === 'server.mjs' || f.startsWith('lib/'));
const offenders = [];
for (const f of htmlAndJs) {
  if (ownedSet.has(f) || f === 'lib/write-scope.mjs') continue;
  let src;
  try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  /* 只看**静态** import/script src：动态 import() 是允许的（那是按需加载，
     失败也不会让页面起不来）。 */
  const stats = [
    ...src.matchAll(/^\s*import\s[^\n]*?from\s+'([^']+)'/gm),
    ...src.matchAll(/<script[^>]+src="([^"]+)"/g),
  ].map((m) => m[1]);
  for (const spec of stats) {
    /* i18n 聚合是**例外**：js/i18n.js 必须同步 import 每个分片，
       否则 lint-i18n 会报「分片没人 import，等于没翻」。它是纯数据，
       出错概率远低于逻辑模块，所以这条放行并在这里写明原因。 */
    if (f === 'public/js/i18n.js' && spec.includes('i18n/agent.js')) continue;
    if (!/agent(-page|-runtime|-commands|-prompt)?\.js|write-page\.js|script-eval\.js|markdown\.js/.test(spec)) continue;
    offenders.push(f + ' → ' + spec);
  }
}
ok('主站没有静态依赖写谱模块', offenders.length === 0, offenders.join(' | '));

/* ── 4. 写谱引用的主站模块在白名单里（防止它悄悄依赖新东西）──
   ⚠ 动态 import 也算 —— 它一旦依赖了不该依赖的，主站重构就会牵连到它。 */
const outOfScope = [];
for (const f of WRITE_OWNED.filter((x) => x.endsWith('.js') || x.endsWith('.html'))) {
  const abs = join(ROOT, f);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/'(\.\.?\/[^']+?\.js)(?:\?v=[^']*)?'/g)) {
    const spec = m[1];
    /* 相对路径按**引用者所在目录**解析（./ui.js 出现在 public/js/ 下就是 public/js/ui.js）。
       ⚠ 以前用字符串 replace 猜前缀，猜错了就整片假红 —— 判据要算，不要猜。 */
    const asFile = posix.normalize(posix.join(dirname(f), spec));
    if (!WRITE_MAY_USE.includes(asFile) && !WRITE_OWNED.includes(asFile)) {
      outOfScope.push(f + ' → ' + asFile);
    }
  }
}
ok('写谱只引用白名单里的主站模块', outOfScope.length === 0, [...new Set(outOfScope)].join(' | '));

/* ── 5. 开关 ── */
ok('默认开启（不设环境变量）', writeEnabled({}) === true);
ok('PHM_WRITE=off 关闭', writeEnabled({ PHM_WRITE: 'off' }) === false);
ok('PHM_WRITE=0 关闭', writeEnabled({ PHM_WRITE: '0' }) === false);
ok('PHM_WRITE=OFF 大小写不敏感', writeEnabled({ PHM_WRITE: 'OFF' }) === false);
ok('PHM_WRITE=on 仍开启', writeEnabled({ PHM_WRITE: 'on' }) === true);
ok('空字符串不误判为关闭', writeEnabled({ PHM_WRITE: '' }) === true);

/* 说明页必须**自包含**：关闭的时候它就是唯一的页面，
   再依赖 ui.js / 外链样式，等于在最坏的时候要求一切正常。 */
ok('说明页没有外链脚本', !/<script/i.test(CLOSED_PAGE));
ok('说明页没有外链样式', !/<link\b/i.test(CLOSED_PAGE) && !/@import/.test(CLOSED_PAGE));
ok('说明页写明了怎么恢复', CLOSED_PAGE.includes('PHM_WRITE'));
ok('说明页给了回主站的路', CLOSED_PAGE.includes('href="/"'));

console.log('\n────────');
console.log('写谱边界 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
