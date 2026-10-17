#!/usr/bin/env node
/* ============================================================
 * tools/preflight.mjs —— 本地推送闸门（pre-push 调用）
 * ============================================================
 * 跑两件事，任何失败都返回非 0：
 *   1. review-gate.mjs —— 静态审计（凭据/版本/白名单/SQL/禁用模式/workflow）
 *   2. npm run check  —— 15 项离线检查（单测/文档/版本/资源）
 *
 * 浏览器 E2E 不在本地钩子里跑（要 Chrome + 起服务，太慢且环境不稳）；
 * 它由 CI 的 audit workflow 负责。钩子只是"别把明显坏的东西推出去"，
 * 真正的权威仍是 main 上的分支保护 + 必需检查。
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd) => {
  console.log('\n$ ' + [cmd, ...args].join(' '));
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\n[preflight] FAIL: ' + [cmd, ...args].join(' '));
    process.exit(r.status || 1);
  }
};

run('node', ['tools/review-gate.mjs'], WEB);
/* Windows 下 npm 是 .cmd，spawnSync 不能直接执行；用 cmd.exe /c 调，避免
   shell:true 带来的参数拼接告警（DEP0190）。 */
if (process.platform === 'win32') {
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run check'], WEB);
} else {
  run('npm', ['run', 'check'], WEB);
}
console.log('\n[preflight] 全部通过 ✓ — 可以推送（CI 仍会再跑一遍全量审计）');
