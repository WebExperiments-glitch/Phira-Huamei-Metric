#!/usr/bin/env node
/* ============================================================
 * tools/lint-hygiene.mjs —— 仓库卫生（对标 Rust 的 `tidy`）
 * ============================================================
 * 【为什么单独一个】
 *   `lint-slop` 管「看起来能跑但其实错了」的写法；
 *   `lint-docs` 管文档与代码同步；
 *   这里管**不涉及语义、但会持续腐坏**的东西：空行末尾的空白、制表符、
 *   换行符混用、以及「本地跑了但 CI 没跑」的检查。
 *
 * 【对标】rust-lang 的 tidy 干的就是这一类：license 头、字母序、行长、
 *   行尾空白、tab、依赖黑名单。我们不需要 license 头（单一作者），
 *   但**行尾空白 / tab / 换行符**这三样必须管 —— 它们会让 diff 变脏，
 *   而且 CRLF/LF 混用在这个项目上已经出过事（2026-10 多次）。
 *
 * 【最值钱的一条：本地 ↔ CI 一致性】
 *   `npm run check` 是本地的总闸。如果某个检查只存在于本地、CI 里没跑，
 *   那它就是「本机绿、合并后没人守」—— 这个项目吃过这种亏
 *   （限流单测在本地被跳过、CI 上真跑才红）。
 *   所以：check.mjs 里 node 调的每个 tool，必须在某个 workflow 里也出现。
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

let pass = 0;
let fail = 0;
const bad = (msg) => { fail++; console.log('  ✗ ' + msg); };
const ok = (msg) => { pass++; if (process.env.VERBOSE) console.log('  ✓ ' + msg); };

/* ── 取版本库里跟踪的文本文件 ──
   ⚠ 用 git 拿清单，不要自己 walk：node_modules / build-app / downloads 都不该进检查。 */
function trackedFiles() {
  try {
    const out = execSync('git ls-files -z', { cwd: REPO, encoding: 'buffer', maxBuffer: 64 << 20 });
    return out.toString('utf8').split('\0').filter(Boolean)
      .map(p => path.join(REPO, p))
      .filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
  } catch (e) {
    console.log('  · 不是 git 仓库或 git 不可用，跳过（' + e.message.slice(0, 60) + '）');
    return [];
  }
}

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.yml', '.yaml',
  '.sql', '.py', '.txt', '.toml', '.sh', '.gitignore', '.gitattributes',
]);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.woff', '.ttf', '.otf', '.zip', '.pez', '.exe', '.gz', '.br']);

const files = trackedFiles().filter(f => {
  const ext = path.extname(f).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (ext) return TEXT_EXT.has(ext);
  return true;   /* 无扩展名（.gitignore / .env.example 之类）当文本 */
});

console.log('\n【1】行尾空白 / 制表符 / 换行符');
{
  /* ⚠ 换行符不能看工作区 —— Windows 上 `core.autocrlf=true` 会把 LF 转成 CRLF，
     工作区「有 CRLF」是**正常**的。要判的是**仓库里存的**是什么。
     `git ls-files --eol` 正好给这个：`i/lf w/crlf` 表示仓库存 LF、工作区 CRLF。 */
  let eolBad = 0;
  if (fs.existsSync(path.join(REPO, '.git'))) {
    try {
      const out = execSync('git ls-files --eol', { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const m = /^i\/(\S+)\s+w\/(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const [, idx, , file] = m;
        if (idx === 'none' || idx === '-text' || idx === 'binary') continue;
        if (/\.(png|jpe?g|webp|ico|woff2?|ttf|otf|zip|pez|exe|gz)$/i.test(file)) continue;
        if (path.basename(file) === 'LICENSE') continue;   /* 第三方原文，不动 */
        if (idx === 'mixed') { bad(file + ' 在仓库里就是混合换行（i/mixed）'), eolBad++; }
        else if (idx === 'crlf') { bad(file + ' 在仓库里存的是 CRLF'), eolBad++; }
      }
    } catch (e) {
      console.log('  · git ls-files --eol 不可用，跳过换行检查');
    }
  }
  if (!eolBad) ok('仓库里所有文本文件都是 LF');

  /* 行尾空白 / tab 看工作区即可（与换行符无关） */
  let wsBad = 0;
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    if (/public\/data\/ref-.*\.json$/.test(rel)) continue;   /* 生成物，长长的一行行 */
    const lines = txt.split(/\r?\n/);
    let trail = 0;
    let tabs = 0;
    for (const l of lines) {
      if (/[ \t]+$/.test(l)) trail++;
      if (/^\t/.test(l)) tabs++;
    }
    if (trail) { bad(rel + ' 有 ' + trail + ' 行行尾空白'); wsBad++; }
    if (tabs) { bad(rel + ' 有 ' + tabs + ' 行用制表符缩进'); wsBad++; }
  }
  if (!wsBad) ok('没有行尾空白 / 制表符缩进');
}

console.log('\n【2】本地检查 ↔ CI 覆盖');
{
  /* check.mjs 里 `node tools/x.mjs` 形式的调用 */
  let src = '';
  try { src = fs.readFileSync(path.join(ROOT, 'tools', 'check.mjs'), 'utf8'); } catch { /* 没有就不查 */ }
  const called = new Set();
  for (const m of src.matchAll(/node\s+(tools\/[\w.-]+\.mjs)/g)) called.add(m[1]);

  let ci = '';
  const wfDir = path.join(REPO, '.github', 'workflows');
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      ci += fs.readFileSync(path.join(wfDir, f), 'utf8');
    }
  }
  /* ⚠ check.mjs 自己就是一个总闸：CI 只要跑 `npm run check`，里面的全都覆盖了。
     所以判据是「CI 有没有跑 check.mjs」，而不是逐个工具去比对。 */
  const runsCheck = /npm run check|node tools\/check\.mjs/.test(ci);
  if (!runsCheck) bad('CI 没有跑 check.mjs —— 本地总闸在 CI 上等于不存在');
  else ok('CI 跑 check.mjs（覆盖 ' + called.size + ' 个本地工具）');

  /* 反向：CI 跑了但 check.mjs 没纳入的独立工具 —— 这类是「只在 CI 上红」，
     本地永远发现不了，是另一种假绿。 */
  const ciOnly = [];
  for (const m of ci.matchAll(/node\s+(tools\/[\w.-]+\.mjs)/g)) {
    const t = m[1];
    if (t === 'tools/check.mjs') continue;
    if (called.has(t)) continue;
    if (!ciOnly.includes(t)) ciOnly.push(t);
  }
  if (ciOnly.length) console.log('  · 只在 CI 跑（本地总闸不含）：' + ciOnly.join(', '));
  else ok('CI 没有独立于 check.mjs 的工具');
}

console.log('\n【3】.gitattributes（换行符归一的唯一办法）');
{
  const ga = path.join(REPO, '.gitattributes');
  if (!fs.existsSync(ga)) bad('缺少 .gitattributes —— 换行符会随平台漂移');
  else {
    const t = fs.readFileSync(ga, 'utf8');
    if (!/eol=lf/.test(t)) bad('.gitattributes 没有 eol=lf');
    else ok('.gitattributes 有 eol=lf');
  }
}

console.log('\n【4】package.json engines 与 CI 的 node 版本');
{
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* noop */ }
  if (!pkg) bad('读不到 package.json');
  else if (!pkg.engines || !pkg.engines.node) bad('package.json 没有 engines.node —— 本机与 CI 的 node 版本会悄悄分叉（实测本机 22 / CI 24）');
  else ok('engines.node = ' + pkg.engines.node);
}

console.log('\n────────');
console.log('仓库卫生：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
