/* tools/inject-theme.mjs —— 把主题启动脚本铺到所有页面 / 校验是否漂移
 *
 * 用法：
 *   node tools/inject-theme.mjs          写盘（改所有 HTML 的 <head> 内联）
 *   node tools/inject-theme.mjs --check  只校验，不一致就退出码 1（进闸门）
 *   node tools/inject-theme.mjs --diff   打印每个页面的差异位置
 *
 * 【为什么要它】
 *   这段脚本必须在 <head> 同步执行（否则 FOUC），所以不能外链共享，
 *   只能内联。以前靠手工复制 → 26 个页面漂成 5 个版本（404 漏字体、
 *   settings 缺白名单校验）。
 *   现在：真源在 tools/theme-snippet.js，本脚本负责铺开与校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SNIPPET, RE } from './theme-snippet.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

const CHECK = process.argv.includes('--check');
const DIFF = process.argv.includes('--diff');

const files = fs.readdirSync(PUB).filter(f => f.endsWith('.html')).sort();
const want = `<script>${SNIPPET}</script>`;

let changed = 0, ok = 0, missing = 0;
const drifted = [];

for (const f of files) {
  const p = path.join(PUB, f);
  const src = fs.readFileSync(p, 'utf8');
  if (!RE.test(src)) {
    /* 没有这段脚本的页面（如 404 之外的特殊页）也要报出来，避免漏铺 */
    missing += 1;
    drifted.push(`${f}: 找不到主题启动脚本`);
    continue;
  }
  const got = RE.exec(src)[0];
  if (got === want) { ok += 1; continue; }

  if (CHECK) {
    const a = got.replace(/\s+/g, ' ').slice(0, 70);
    const b = want.replace(/\s+/g, ' ').slice(0, 70);
    drifted.push(`${f}: 与真源不一致${DIFF ? `\n      页面: ${a}…\n      真源: ${b}…` : ''}`);
    continue;
  }
  fs.writeFileSync(p, src.replace(RE, want));
  changed += 1;
}

if (CHECK) {
  if (drifted.length) {
    console.error(`  ✗ 主题脚本漂移 ${drifted.length} 处（真源：tools/theme-snippet.js）：`);
    for (const d of drifted) console.error('      ' + d);
    console.error('    修：node tools/inject-theme.mjs');
    process.exit(1);
  }
  console.log(`  ✓ ${ok} 个页面的主题脚本与真源一致`);
} else {
  console.log(`  已铺开：改写 ${changed} 个，已一致 ${ok} 个` + (missing ? `，缺脚本 ${missing} 个` : ''));
  for (const d of drifted) console.log('      ' + d);
}
