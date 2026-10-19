#!/usr/bin/env node
/* ============================================================
 * tools/review-gate.mjs —— 推送前静态审计（最硬的一道）
 * ============================================================
 * 只做「机器能绝对判定」的事；跑不起来 / 需要网络的测试交给 preflight/CI。
 * 任何一条 FAIL 都返回 1 —— 宁可挡住提交，也不让带纰漏的东西进 main。
 *
 * 覆盖：
 *   1. 禁止跟踪的凭据文件 / 密钥字面量 / 私钥 / 连接串
 *   2. .gitignore 必须覆盖本地敏感目录
 *   3. 版本号四处一致（package / versions.js / release.js / CHANGELOG）
 *   4. 所有 public/*.html 都在 server 白名单与干净 URL 里
 *   5. SQL 迁移必须有 RLS + REVOKE；函数必须 SECURITY DEFINER + p_secret
 *   6. 禁用 eval / new Function / 客户端 child_process / XFF 取值
 *   7. workflow 必须有 permissions，且不得用 pull_request_target
 *   8. 不允许把大文件（>2MB）提交进仓库
 *   9. 代码格式（git diff --check）
 * ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const fails = [];
const warns = [];
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => { fails.push(m); console.log('  FAIL ' + m); };
const warn = (m) => { warns.push(m); console.log('  warn ' + m); };
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

console.log('\n[review-gate] 1. 凭据与禁止跟踪的文件');
const tracked = sh('git', ['ls-files'], ROOT).split(/\r?\n/).filter(Boolean);
const forbiddenFile = [
  /(^|\/)\.env(\..*)?$/, /(^|\/)write-secret\.txt$/, /(^|\/)server-store\.json$/,
  /\.(pem|key|p12|pfx)$/i, /(^|\/)backups\//, /(^|\/)\.deepseek\//,
];
for (const f of tracked) {
  if (/(^|\/)\.env\.example$/.test(f)) continue;   // 模板，故意提交
  if (forbiddenFile.some((r) => r.test(f))) fail('禁止跟踪的文件：' + f);
}
const ignoreChecks = [
  ['phm-web/.env', '.env'],
  ['phm-web/write-secret.txt', 'write-secret.txt'],
  ['.deepseek/x', '.deepseek/'],
  ['backups/x', 'backups/'],
];
for (const [p, label] of ignoreChecks) {
  try { sh('git', ['check-ignore', '-q', p], ROOT); }
  catch { fail('.gitignore 没覆盖：' + label + '（' + p + '）'); }
}
ok('禁止跟踪清单 / .gitignore 检查完成');

const SECRETS = [
  [/sk-[0-9a-f]{32}\b/, '疑似 API Key（sk- + 32 hex）'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, '疑似 GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, '疑似 GitHub fine-grained token'],
  [/AKIA[0-9A-Z]{16}/, '疑似 AWS Access Key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/postgres(?:ql)?:\/\/[^\s:@]+:[^\s:@]+@/, '带密码的数据库连接串'],
  [/PHM_WRITE_SECRET\s*=\s*[A-Za-z0-9+/=]{16,}/, '硬编码写入凭据'],
];
const TEXT_EXT = /\.(mjs|js|json|html|css|md|ya?ml|py|sh|sql|txt|toml|ini)$/i;
let secretHits = 0;
for (const f of tracked) {
  if (!TEXT_EXT.test(f)) continue;
  if (/^phm-web\/public\/data\//.test(f)) continue;
  if (/^phm-web\/downloads\//.test(f)) continue;
  const abs = path.join(ROOT, f);
  let text = '';
  try {
    const st = fs.statSync(abs);
    if (st.size > 1_500_000) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  for (const [re, name] of SECRETS) {
    const m = re.exec(text);
    if (m) { secretHits++; fail('疑似密钥字面量（' + name + '）：' + f); break; }
  }
}
if (!secretHits) ok('已跟踪文本中未发现密钥字面量');

console.log('\n[review-gate] 2. 版本号一致性');
try {
  sh('python', ['tools/bump-version.py', '--check'], WEB);
  ok('bump-version --check 通过');
} catch (e) {
  fail('版本号不一致（python tools/bump-version.py --check）');
}
const pkg = JSON.parse(fs.readFileSync(path.join(WEB, 'package.json'), 'utf8'));
const ver = pkg.version;
const versions = fs.readFileSync(path.join(WEB, 'public/js/versions.js'), 'utf8');
const vTop = (versions.match(/v:\s*'V([0-9.]+)'/) || [])[1];
const release = fs.readFileSync(path.join(WEB, 'public/js/release.js'), 'utf8');
const rTop = (release.match(/"siteVer":\s*"V([0-9.]+)"/) || [])[1];
if (vTop !== ver) fail('versions.js 顶部版本 ' + vTop + ' ≠ package.json ' + ver);
else ok('versions.js 顶部 = package.json');
if (rTop !== ver) fail('release.js siteVer ' + rTop + ' ≠ package.json ' + ver);
else ok('release.js siteVer = package.json');
const changelog = fs.readFileSync(path.join(WEB, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes('| `V' + ver + '` |')) fail('CHANGELOG.md 缺少 V' + ver + ' 的行');
else ok('CHANGELOG.md 有当前版本行');

console.log('\n[review-gate] 3. 页面白名单 / 干净 URL');
const server = fs.readFileSync(path.join(WEB, 'server.mjs'), 'utf8');
const filesBlock = (server.match(/const PUBLIC_FILES = new Set\(\[([\s\S]*?)\]\);/ ) || [])[1] || '';
const publicFiles = new Set([...filesBlock.matchAll(/'([^']+\.html)'/g)].map((m) => m[1]));
/* ⚠ CLEAN 的真源在 `lib/pages.mjs`（V0.21.1.2 起，页面级 SEO 路由与它放一起）。
   硬编码只读 server.mjs 会让这道门**全页假失败** —— 实测挪走之后
   14 个页面同时报「没有干净 URL」，而它们全都有。
   所以按顺序找第一个有定义的文件，而不是认死一个路径。 */
const cleanSrc = ['lib/pages.mjs', 'server.mjs']
  .map(f => { try { return fs.readFileSync(path.join(WEB, f), 'utf8'); } catch (e) { return ''; } })
  .join('\n');
const cleanBlock = (cleanSrc.match(/const CLEAN = \{([\s\S]*?)\};/) || [])[1] || '';
const cleanTargets = new Set([...cleanBlock.matchAll(/'(\/[^']+)':\s*'([^']+\.html)'/g)].map((m) => m[2]));
/* 参数化路由：`/chart/<id>` 这类 URL 没法写成 `'/x': 'x.html'` 的固定映射，
   所以单独一张表。⚠ 表里的每一项都必须在 lib/pages.mjs 里真的被渲染，
   否则就是"声称有干净 URL 其实没有"。 */
const PARAM_ROUTES = { 'chart.html': '/chart/<id>' };
const pagesSrc = (() => { try { return fs.readFileSync(path.join(WEB, 'lib/pages.mjs'), 'utf8'); } catch (e) { return ''; } })();
for (const [f, url] of Object.entries(PARAM_ROUTES)) {
  if (!pagesSrc.includes("readTemplate('" + f + "')") && !pagesSrc.includes('readTemplate("' + f + '")')) {
    fail('PARAM_ROUTES 里的 ' + f + ' 声称走 ' + url + '，但 lib/pages.mjs 里没有渲染它');
  }
}
const topHtml = fs.readdirSync(path.join(WEB, 'public')).filter((f) => f.endsWith('.html'));
for (const f of topHtml) {
  if (!publicFiles.has(f)) fail('public/' + f + ' 不在 PUBLIC_FILES');
  if (!['404.html', 'index.html'].includes(f) && !cleanTargets.has(f) && !PARAM_ROUTES[f]) {
    fail('public/' + f + ' 没有干净 URL（CLEAN）');
  }
}
ok('public/*.html 全部在 PUBLIC_FILES' + (topHtml.length ? '（' + topHtml.length + ' 个）' : ''));
if (!/^\.\.?\//.test(sh('git', ['rev-parse', '--show-toplevel'], ROOT))) ok('仓库根正常');

console.log('\n[review-gate] 4. SQL 迁移安全');
const dbFiles = [];
(function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.sql')) dbFiles.push(p);
  }
})(path.join(WEB, 'db'));
for (const p of dbFiles) {
  /* 拆成单语句的文件只用于 MCP 逐条执行；整体安全属性由合并版 api-v1.sql 守。 */
  if (/[\\/]api-v[12][\\/]/.test(p)) continue;   /* 单语句拆分文件由合并版守 */
  const sql = fs.readFileSync(p, 'utf8');
  const tables = (sql.match(/create table/gi) || []).length;
  if (tables) {
    const rls = (sql.match(/enable row level security/gi) || []).length;
    const rev = (sql.match(/revoke all/gi) || []).length;
    if (rls < tables) fail(path.relative(ROOT, p) + '：' + tables + ' 张表只有 ' + rls + ' 条 RLS');
    if (rev < tables) fail(path.relative(ROOT, p) + '：' + tables + ' 张表只有 ' + rev + ' 条 REVOKE');
  }
  const fns = (sql.match(/create or replace function/gi) || []).length;
  const sec = (sql.match(/security definer/gi) || []).length;
  if (fns && sec < fns) fail(path.relative(ROOT, p) + '：' + fns + ' 个函数只有 ' + sec + ' 个 SECURITY DEFINER');
  if (fns && !/p_secret/.test(sql)) fail(path.relative(ROOT, p) + '：函数没有 p_secret 校验');
}
if (!dbFiles.length) warn('db/ 下没有 SQL 文件');
else ok('SQL 迁移检查完成（' + dbFiles.length + ' 个文件）');

console.log('\n[review-gate] 5. 禁用模式');
const codeFiles = tracked.filter((f) => /\.(mjs|js|html)$/.test(f) && !/public\/js\/(i18n|versions|release|ref-|.*\.min\.)/.test(f));
for (const f of codeFiles) {
  if (f === 'phm-web/tools/review-gate.mjs') continue;   /* 扫描器自身包含这些模式串 */
  const abs = path.join(ROOT, f);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  if (/\beval\s*\(/.test(text)) fail(f + ' 使用了 eval()');
  if (/new\s+Function\s*\(/.test(text)) fail(f + ' 使用了 new Function()');
  if (f.startsWith('phm-web/public/') && /child_process/.test(text)) fail(f + ' 客户端代码引用了 child_process');
  if (/req\.headers\s*\[\s*['"]x-forwarded-for['"]\s*\]/.test(text)) fail(f + ' 读取 X-Forwarded-For 做限流键');
  if (/req\.headers\.x-forwarded-for/i.test(text)) fail(f + ' 读取 X-Forwarded-For 做限流键');
}
ok('禁用模式检查完成');

console.log('\n[review-gate] 6. workflow 安全');
const wfDir = path.join(ROOT, '.github/workflows');
if (fs.existsSync(wfDir)) {
  for (const f of fs.readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const y = fs.readFileSync(path.join(wfDir, f), 'utf8');
    if (!/^permissions:/m.test(y)) fail('.github/workflows/' + f + ' 没有顶层 permissions');
    if (/pull_request_target/.test(y)) fail('.github/workflows/' + f + ' 使用了 pull_request_target');
  }
}
ok('workflow 检查完成');

console.log('\n[review-gate] 7. 大文件 / 空白错误');
const BIG_OK = [
  /^data\/(official|community)\.jsonl$/,
  /^data\/charts\/manifest\.jsonl$/,
];
for (const f of tracked) {
  if (BIG_OK.some((r) => r.test(f))) continue;
  try {
    const st = fs.statSync(path.join(ROOT, f));
    if (st.size > 2 * 1024 * 1024) fail('跟踪了 >2MB 的文件：' + f + '（' + (st.size / 1048576).toFixed(1) + 'MB）');
  } catch {}
}
try { sh('git', ['diff', '--check'], ROOT); } catch { fail('工作区有空白错误（git diff --check）'); }
try { sh('git', ['diff', '--cached', '--check'], ROOT); } catch { fail('暂存区有空白错误（git diff --cached --check）'); }
ok('大文件 / 空白检查完成');

console.log('\n────────────────────────────');
if (warns.length) console.log('warn: ' + warns.length + ' 条（不阻塞）');
if (fails.length) {
  console.log('review-gate: FAIL ' + fails.length + ' 条');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('review-gate: 全部通过 ✓');
