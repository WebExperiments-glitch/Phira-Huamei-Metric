/* 生成 public/js/release.js —— 下载页用的构建元数据。
 *
 * 【为什么不手写】
 *   大小 / sha256 / 客户端版本 这三样**手抄必错**：换一次构建就全过期，
 *   而错误的 sha256 比没有 sha256 更糟 —— 用户照着校验会对不上，
 *   然后合理地怀疑包被投毒。所以一律从**实际文件**算出来。
 *
 * 【真源】
 *   · 二进制   → downloads/phira-huamei.exe
 *   · 客户端版本 → phira-huamei/phira/src/client.rs 的 HUAMEI_CLIENT_VER
 *   · 站点版本 → package.json 的 version
 *
 * 用法：
 *   node tools/gen-release.mjs           生成/更新 public/js/release.js
 *   node tools/gen-release.mjs --check   只校验是否同步（不写文件），不同步则退出码 1
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'downloads', 'phira-huamei.exe');
const CLIENT_RS = join(ROOT, '..', 'phira-huamei', 'phira', 'src', 'client.rs');
const OUT = join(ROOT, 'public', 'js', 'release.js');
const CHECK = process.argv.includes('--check');

if (!existsSync(EXE)) {
  console.error('❌ 找不到二进制：' + EXE);
  console.error('   先构建：cd ../phira-huamei && cargo +nightly-2026-01-01 build --release \\');
  console.error('           --no-default-features --bin phira-main');
  console.error('   再复制到 downloads/phira-huamei.exe');
  process.exit(1);
}

const buf = readFileSync(EXE);
const bytes = statSync(EXE).size;
if (bytes !== buf.length) { console.error('❌ 文件在读取期间变了，重跑一次'); process.exit(1); }
const sha256 = createHash('sha256').update(buf).digest('hex');

/* 客户端版本：从 Rust 源码里抠。别在这里再抄一份字面量 —— 两处必然漂移。 */
let clientVer = '';
try {
  const rs = readFileSync(CLIENT_RS, 'utf8');
  const m = rs.match(/pub\s+const\s+HUAMEI_CLIENT_VER\s*:\s*&str\s*=\s*"([^"]+)"/);
  if (m) clientVer = m[1];
} catch { /* 客户端仓库不在旁边（例如只部署前端）→ 退化为空，下面会处理 */ }

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const siteVer = 'V' + pkg.version;

/* 「构建日期」取二进制的 mtime —— 不是「生成这份元数据的日期」。
   后者会让「没重新构建却重新生成」看起来像发了新版本。 */
const d = new Date(statSync(EXE).mtimeMs);
const built = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
function humanSize(n) {
  let i = 0, v = n;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + SIZE_UNITS[i];
}

/* ⚠ 客户端版本抠不到时**不静默** —— 页面上会显示 "—"，
   但更要紧的是生成时得提醒：那通常意味着 checkout 不完整。 */
if (!clientVer) console.warn('⚠ 未能从 client.rs 读到 HUAMEI_CLIENT_VER（页面上会显示 —）');

const body = `/* ============================================================
 * js/release.js —— 下载页的构建元数据
 * ============================================================
 * ⚠ **本文件由 tools/gen-release.mjs 生成，不要手改**（改了会被 --check 判红）。
 *   大小与 sha256 是从 downloads/phira-huamei.exe **实际算出来**的，
 *   客户端版本从 phira-huamei/phira/src/client.rs 抠出来 ——
 *   手抄这三样必然过期，而过期的 sha256 会让用户合理地怀疑包被投毒。
 * ============================================================ */

export const RELEASE = ${JSON.stringify({
  siteVer,
  clientVer,
  built,
  file: 'phira-huamei.exe',
  url: '/download/phira-huamei.exe',
  bytes,
  size: humanSize(bytes),
  sha256,
  source: 'https://github.com/WebExperiments-glitch/Phira-Huamei-Metric',
}, null, 2)};
`;

if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur === body) { console.log('✓ public/js/release.js 与二进制同步（' + humanSize(bytes) + ' / ' + sha256.slice(0, 16) + '…）'); process.exit(0); }
  console.error('✗ public/js/release.js 与 downloads/phira-huamei.exe 不同步');
  console.error('  跑：node tools/gen-release.mjs');
  process.exit(1);
}

writeFileSync(OUT, body);
console.log('✓ 写入 public/js/release.js');
console.log('  客户端版本 : ' + (clientVer || '—'));
console.log('  站点版本   : ' + siteVer);
console.log('  大小 / 哈希: ' + humanSize(bytes) + ' / ' + sha256.slice(0, 16) + '…');
console.log('  构建日期   : ' + built);
