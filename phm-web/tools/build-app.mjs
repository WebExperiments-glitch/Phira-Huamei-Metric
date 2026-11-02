#!/usr/bin/env node
/* ============================================================
 * tools/build-app.mjs —— 造一份「新站」构建目录（全功能）
 * ============================================================
 * 【为什么需要它】
 *   同一份代码要跑两个站：
 *     · 腾讯那块 = **静态指路牌**（仓库根目录带着 `.static-only` 标记）
 *     · 新站     = **全功能**（要连 Neon，见 lib/db-pg.mjs）
 *   部署工具上传的是**整个目录**，所以我不能靠环境变量区分，只能靠「目录里
 *   有没有那个标记文件」。这个脚本把需要的文件复制到 `build-app/`，
 *   并**删掉标记**，于是那份目录就是全功能站。
 *
 * 【为什么是"复制"而不是"临时删标记"】
 *   临时删标记 = 忘了改回来，下一次部署腾讯那块就把账号/成绩/API 全打开了，
 *   而那边的库已经死了 —— 用户点进去看到 503。宁可多复制一份。
 *
 * 【用法】
 *   node tools/build-app.mjs          # 产出 build-app/
 *   node tools/build-app.mjs --clean  # 先清掉旧的
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build-app');

/* 运行期真正需要的（tools/ 与 db/ 只给开发用，不进构建产物）。 */
/* ⚠ `api/` 只有 openapi.json，但 server.mjs 启动时**同步读**它（第 395 行左右），
   漏了它进程起不来 —— 实测第一次就栽在这，报错只说 ENOENT，不说是哪个环节要的。 */
const NEED = ['server.mjs', 'package.json', 'lib', 'public', 'api', 'node_modules', '.env'];
/* 可选：存在才带 */
const OPTIONAL = ['downloads', 'write-secret.txt'];

if (process.argv.includes('--clean') && fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('已清掉 build-app/');
}

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const item of NEED) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.error('缺必需项：' + item + '（' + (item === 'node_modules' ? '先 npm i pg' : '目录不对？') + '）');
    process.exit(1);
  }
  fs.cpSync(src, path.join(OUT, item), { recursive: true });
  n++;
}
for (const item of OPTIONAL) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) { fs.cpSync(src, path.join(OUT, item), { recursive: true }); n++; }
}

/* ★ 关键一步：平台只放行 443，裸 TCP 到 5432 连不上 → 强制走 HTTPS SQL 端点。
   ⚠ 这行必须写在**构建脚本**里，不能靠人记得往 .env 加：
     2026-10-23 重建产物时它就丢了一次，表现是"站点活着但所有接口 502"，
     而且日志里只会看到连接超时，不会告诉你"少了这个配置"。 */
const envOut = path.join(OUT, '.env');
if (fs.existsSync(envOut)) {
  let e = fs.readFileSync(envOut, 'utf8');
  if (!/^PHM_DB_TRANSPORT=/m.test(e)) {
    /* ⚠ 用数组 join 拼多行，不要在字符串里写真实换行 ——
       这次就是被 heredoc/转义坑了一次：`'\n# 注释'` 变成了跨行字符串字面量，
       整个文件语法错误。多行内容一律走数组。 */
    e = e.replace(/\s*$/, '') + [
      '',
      '# 平台不放行 5432，走 Neon 的 HTTPS SQL 端点（443）',
      'PHM_DB_TRANSPORT=http',
      '',
    ].join('\n');
    fs.writeFileSync(envOut, e);
    console.log('  · 已补 PHM_DB_TRANSPORT=http（平台出网限制）');
  }
}

/* ★ 关键一步：构建产物**没有** .static-only → 全功能 */
const flag = path.join(OUT, '.static-only');
if (fs.existsSync(flag)) fs.rmSync(flag);
/* 仓库根那个标记如果被复制进来了（不会，因为它不在 NEED 里），这里再兜一次 */
console.log('构建完成：' + OUT);
console.log('  · .static-only ' + (fs.existsSync(flag) ? '仍在（异常）' : '已移除 → 全功能模式'));
console.log('  · 共复制 ' + n + ' 项');
console.log('\n⚠ 部署前确认 .env 里有 PHM_NEON_URL（否则 dbFetch 会走早已停用的旧端点）');
