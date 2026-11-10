/* tools/patch-codebase-search.mjs —— 给 mcp-codebase-search 补上 .mjs / .cjs 支持
 *
 * 跑法：node tools/patch-codebase-search.mjs
 *
 * 【为什么需要】
 *   这个工具的语言映射表只认 .js / .jsx / .py / .ts / .tsx。而我们后端
 *   98 个文件全是 .mjs —— 第一次索引时 80 个 .mjs 被当成"不支持"跳过，
 *   只索引到 9 个文件 19 个 chunk，等于白装。
 *
 *   .mjs 和 .js 在 tree-sitter 眼里是**同一套语法**，只是模块语义不同，
 *   所以加两行映射就能索引，不需要改解析器。
 *
 * 【为什么是脚本而不是手改】
 *   改的是 node_modules 里的全局包。`npm update -g` 一跑就没了。
 *   脚本可以重复执行（幂等），改完的版本号会记在输出里。
 *   ⚠ 升级这个包之后必须重跑本脚本，否则 .mjs 会再次被跳过。
 *
 * 【风险】
 *   改第三方包 = 升级时被覆盖（可接受，有脚本）。不涉及逻辑，只加两个键。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/* 找到全局包的真实位置（不硬编码 node 版本号 —— 升级 node 后路径会变） */
function findPkg() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const p = path.join(root, '@teknologika', 'mcp-codebase-search');
    if (fs.existsSync(p)) return p;
  } catch { /* 忽略 */ }
  return null;
}

const PKG = findPkg();
if (!PKG) {
  console.error('  ✗ 找不到 @teknologika/mcp-codebase-search，先执行：npm i -g @teknologika/mcp-codebase-search');
  process.exit(1);
}

const TARGET = path.join(PKG, 'dist', 'domains', 'parsing', 'language-detection.service.js');
if (!fs.existsSync(TARGET)) {
  console.error('  ✗ 找不到语言映射文件：' + TARGET);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');
if (src.includes("'.mjs': 'javascript'")) {
  console.log('  ✓ 已打过补丁（.mjs / .cjs 都在），无需重复');
  process.exit(0);
}

/* 在 '.jsx': 'javascript', 之后插入两行，保持缩进一致 */
const anchor = /(\n\s*)'\.jsx':\s*'javascript',/;
if (!anchor.test(src)) {
  console.error('  ✗ 找不到锚点（\'\.jsx\': \'javascript\',）—— 包结构变了，需要人工看');
  process.exit(1);
}
const m = anchor.exec(src);
src = src.replace(anchor, `${m[0]}${m[1]}'.mjs': 'javascript',${m[1]}'.cjs': 'javascript',`);

/* 备份一次，方便回滚 */
const bak = TARGET + '.orig';
if (!fs.existsSync(bak)) fs.copyFileSync(TARGET, bak);

fs.writeFileSync(TARGET, src);
console.log('  ✓ 已加入 .mjs / .cjs → javascript 映射');
console.log('    文件：' + TARGET);
console.log('    备份：' + bak);
console.log('  ⚠ npm update -g 之后要重跑本脚本');
