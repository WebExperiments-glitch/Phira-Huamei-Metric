#!/usr/bin/env node
/* ============================================================
 * tools/lint-docs.mjs —— 文档与代码同步检查
 * ============================================================
 * 防的是「代码加了页面/模块，文档还停在上一版」。
 * 检查四件事：
 *   1. 所有 Markdown 里的相对 *.md 链接都存在（死链 = 0）
 *   2. 版本号四处一致：CHANGELOG 表头 / package.json / release.js / 各页 meta
 *   3. ARCHITECTURE「站点结构」覆盖 public/ 下每个 html
 *   4. ARCHITECTURE 的 lib 分层表 + 开发 README 的目录地图覆盖每个模块
 * 退出码 0 = 通过，1 = 有失败。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
let pass = 0, fail = 0;
const bad = (msg) => { fail++; console.log('  ✗ ' + msg); };
const ok = (msg) => { pass++; if (process.env.VERBOSE) console.log('  ✓ ' + msg); };

const SKIP = new Set(['node_modules', '.git', '.workbuddy', 'data', 'charts', '_research',
  '_archive', '发布', 'phira-huamei', '_design-shots', '谱面数据包']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out); }
    else out.push(path.join(dir, e.name));
  }
  return out;
}

/* 1) Markdown 死链 */
console.log('[1] Markdown 相对链接');
{
  const mds = walk(REPO).filter(f => f.endsWith('.md'));
  let checked = 0;
  for (const f of mds) {
    const txt = fs.readFileSync(f, 'utf8');
    const re = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;
    let m;
    while ((m = re.exec(txt))) {
      if (/^https?:/i.test(m[1]) || m[1].includes('*')) continue;   /* 跳过外链与占位符 *.md */
      const target = path.resolve(path.dirname(f), m[1]);
      checked++;
      if (!fs.existsSync(target)) bad(`${path.relative(REPO, f)} -> ${m[1]} (missing)`);
      else ok('link ' + m[1]);
    }
  }
  if (checked === 0) bad('没有扫描到任何 md 链接（可能路径错了）');
}

/* 2) 版本号一致 */
console.log('[2] 版本号一致');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const m = changelog.match(/^\| `V([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)`/m);
  if (!m) bad('CHANGELOG.md 找不到四段版本号表头');
  else if (m[1] !== pkg.version) bad(`CHANGELOG ${m[1]} ≠ package.json ${pkg.version}`);
  else ok('CHANGELOG = package.json = ' + pkg.version);
  const release = fs.readFileSync(path.join(ROOT, 'public/js/release.js'), 'utf8');
  const rm = release.match(/"siteVer"\s*:\s*"V([0-9.]+)"/);
  if (!rm) bad('release.js 找不到 siteVer');
  else if (rm[1] !== pkg.version) bad(`release.js siteVer ${rm[1]} ≠ ${pkg.version}`);
  else ok('release.js = ' + pkg.version);
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
  for (const p of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'public', p), 'utf8');
    const mm = html.match(/name="app-version" content="V([0-9.]+)"/);
    if (!mm) { if (p !== 'privacy.html' && p !== 'terms.html') bad(`${p} 缺 app-version meta`); continue; }
    if (mm[1] !== pkg.version) bad(`${p} meta ${mm[1]} ≠ ${pkg.version}`);
    else ok(p);
  }
}

/* 3) ARCHITECTURE 站点表覆盖每个页面 */
console.log('[3] ARCHITECTURE 页面清单');
{
  const arch = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const start = arch.indexOf('## 站点结构');
  const end = arch.indexOf('\n## ', start + 2);
  const section = start >= 0 ? arch.slice(start, end < 0 ? undefined : end) : '';
  if (!section) bad('找不到「站点结构」一节');
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
  for (const p of pages) {
    if (!section.includes('`' + p + '`')) bad(`ARCHITECTURE 站点表缺 ${p}`);
    else ok(p);
  }
}

/* 4) lib / js 模块被文档覆盖 */
console.log('[4] 模块清单');
{
  const arch = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'docs/README.md'), 'utf8');
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
    if (!f.endsWith('.mjs')) continue;
    if (!arch.includes(f)) bad(`ARCHITECTURE 缺 lib/${f}`);
    else ok('lib/' + f);
  }
  const jsDir = path.join(ROOT, 'public/js');
  for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    if (!readme.includes(f)) bad(`docs/README 目录地图缺 public/js/${f}`);
    else ok('js/' + f);
  }
}

console.log('\n────────');
console.log(`文档同步检查：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
