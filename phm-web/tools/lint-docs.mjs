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
    /* retired.html 是服务端模板：版本号由 lib/retired.mjs 替换 __APP_VER__ 后送出，
       文件里那个占位符不是真版本号，所以这里放过它（lint-slop 的同名豁免同理）。 */
    if (!mm) {
      if (p !== 'privacy.html' && p !== 'terms.html' && p !== 'retired.html') {
        bad(`${p} 缺 app-version meta`);
      }
      continue;
    }
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

/* 5) README 的「目录结构」树里列的路径必须真实存在
   ────────────────────────────────────────────────────────────
   【为什么加这条】README 里的「目录结构」是最容易腐烂的一节：
   文件改名（phm/P.H.M..html → phm/PHM-Standard.html）之后，
   那一行还写着旧名字，读的人双击打开会「文件不存在」。
   之前的死链检查只管 *.md 链接，管不到这种纯文本树。

   做法：把 README「## 目录结构」代码块里的树按缩进还原成路径，逐个查存在性。
   ⚠ 少数目录是**按需生成 / 不入库**的（data/charts/ 是 31GB 语料，
     _research/ 是本地调研素材），它们在仓库里本来就不存在 —— 列入忽略表。 */
console.log('[5] README 目录结构树');
{
  const IGNORED = new Set([
    'data/charts', 'data/.stages', 'data/_backup_before_consolidate',
    '_research', 'reports', 'phm/gui/data', 'phira-huamei', '发布',
  ]);
  const readmePath = path.join(REPO, 'README.md');
  if (!fs.existsSync(readmePath)) {
    bad('找不到根 README.md');
  } else {
    const md = fs.readFileSync(readmePath, 'utf8');
    const s = md.indexOf('## 目录结构');
    const e = s >= 0 ? md.indexOf('\n## ', s + 2) : -1;
    const section = s >= 0 ? md.slice(s, e < 0 ? undefined : e) : '';
    if (!section) {
      bad('README 找不到「## 目录结构」一节');
    } else {
      const fence = section.match(/```[\s\S]*?```/);
      if (!fence) {
        bad('README「目录结构」里没有代码块');
      } else {
        const stack = [];          /* 每层的目录名 */
        let entries = 0;
        for (const line of fence[0].split('\n')) {
          const m = line.match(/^([\s│]*)(?:├──|└──)\s+(.+?)\s*$/);
          if (!m) continue;
          /* 缩进单位 = 4 列（"│   " 或 "    "）。
             ⚠ 别把 │ 剔掉再数长度 —— 剔掉后每层都变成 0，
               层级全塌成一级，路径就只剩文件名（这个坑踩过一次）。 */
          const level = Math.floor(m[1].length / 4);
          const name = m[2];
          /* 树里形如 "core.py    #   注释" 要去掉行尾注释 */
          const clean = name.split('#')[0].trim();
          if (!clean) continue;
          stack.length = level;
          const isDir = clean.endsWith('/');
          const seg = isDir ? clean.slice(0, -1) : clean;
          stack.push(seg);
          const rel = stack.join('/');
          entries++;
          if (IGNORED.has(rel) || IGNORED.has(rel.split('/')[0])) continue;
          if (/[（(]/.test(seg)) continue;             /* 树里的说明性条目 */
          const abs = path.join(REPO, rel);
          if (!fs.existsSync(abs)) bad(`README 目录树列了不存在的路径：${rel}`);
          else ok('tree ' + rel);
        }
        if (entries === 0) bad('README 目录树里没解析出任何条目（格式变了？）');
      }
    }
  }
}

/* 6) 旧文件名黑名单：改名过的东西不该再被文档引用
   ────────────────────────────────────────────────────────────
   【为什么】phm/P.H.M..html 改名为 phm/PHM-Standard.html 之后，
   README 和若干文档里还留着旧名字。改名时没人发现，因为没有检查会看它。
   规则：改名要同时把旧名字登记进这张表（并在文档里换掉），
   以后谁再写回旧名字，检查会当场报出来。 */
console.log('[6] 旧文件名黑名单');
{
  const STALE = [
    { name: 'P.H.M..html', reason: '单文件 GUI 已改名为 phm/PHM-Standard.html' },
  ];
  /* 只查「当前文档」：docs/历史/ 里的旧记录保留原样是**故意的** */
  const isCurrent = f => {
    const rel = path.relative(REPO, f);
    if (rel === 'README.md') return true;
    if (rel.startsWith('phm-web' + path.sep + 'docs' + path.sep)) return true;
    if (rel.startsWith('docs' + path.sep)) return !rel.includes(path.sep + '历史' + path.sep);
    return false;
  };
  const files = walk(REPO).filter(f => f.endsWith('.md')).filter(isCurrent);
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const s of STALE) {
      if (txt.includes(s.name)) bad(`${path.relative(REPO, f)} 还在用旧名 ${s.name}（${s.reason}）`);
      else ok('no ' + s.name);
    }
  }
}

console.log('\n────────');
console.log(`文档同步检查：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
