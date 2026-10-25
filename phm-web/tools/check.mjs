#!/usr/bin/env node
/* ============================================================
 * tools/check.mjs —— 一条命令跑完全部「不需要浏览器」的检查
 * ============================================================
 * 本地和 CI 共用同一份清单：CI 不另写一套，避免"本地绿、CI 红"。
 * 浏览器测试（smoke / verify-pages / ui-flows / api-routes）需要
 * 启动服务 + Chrome，放在 .github/workflows/e2e.yml 里夜间跑。
 *
 * 跑法：
 *   cd phm-web && npm run check
 * 环境：
 *   CI 里没有 write-secret.txt，workflow 会注入一个**假的** PHM_WRITE_SECRET，
 *   只为让签/验凭证的单测能跑；它不是生产凭据。
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.platform === 'win32' ? 'python' : 'python3';

/* 顺序：先便宜、先核心。任何一步失败都继续跑完，最后统一汇报。 */
const STEPS = [
  ['语法：server.mjs', 'node', ['--check', 'server.mjs']],
  ['语法：engine.js', 'node', ['--check', 'public/js/engine.js']],
  ['引擎回归（45 条）', 'node', ['tools/verify-engine.mjs']],
  ['引擎数值金标', 'node', ['tools/golden-engine.mjs']],
  ['参照集与真源同步', 'node', ['tools/gen-ref.mjs', '--check']],
  ['限流单测（73 条；真实 DB 路径另跑 PHM_TEST_DB=1）', 'node', ['tools/test-ratelimit.mjs']],
  ['贡献凭证单测（11 条）', 'node', ['tools/test-contribute-ticket.mjs']],
  ['API Key 单测（8 条）', 'node', ['tools/test-api-keys.mjs']],
  ['OpenAPI 契约', 'node', ['tools/lint-openapi.mjs']],
  ['规则写谱单测（28 条）', 'node', ['tools/test-rulechart.mjs']],
  ['技能分单测（17 条）', 'node', ['tools/test-skills.mjs']],
  ['状态探测单测（46 条）', 'node', ['tools/test-status.mjs']],
  ['谱面包纯函数单测（33 条）', 'node', ['tools/test-chartfiles.mjs']],
  ['规则写谱三层单测（65 条）', 'node', ['tools/test-rhythm.mjs']],
  ['生成脚本解释器单测（45 条；**不用 eval**，守「不报错但算错」那类）', 'node', ['tools/test-script-eval.mjs']],
  ['导出字段单测（11 条；守 Phira 打不开 —— 缺 visibleTime）', 'node', ['tools/test-pez-export.mjs']],
  ['音频容器单测（20 条；守 Phira 报 unsupported codec）', 'node', ['tools/test-audio-sniff.mjs']],
  ['拍↔秒换算单测（11 条；全链路唯一时间真源）', 'node', ['tools/test-beat-time.mjs']],
  ['几何层音符类型单测（12 条；守 Flick/Drag 被并进 Tap）', 'node', ['tools/test-chart-geom.mjs']],
  ['宿主状态序列化单测（7 条；守音频字节被塞进系统提示）', 'node', ['tools/test-agent-context.mjs']],
  ['账号单测', 'node', ['tools/test-hm-accounts.mjs']],
  ['账号门面单测（79 条）', 'node', ['tools/test-auth.mjs']],
  ['兜底层单测（9 条）', 'node', ['tools/test-resilience.mjs']],
  ['成绩校验单测', 'node', ['tools/test-hm-validate.mjs']],
  ['双语完整性', 'node', ['tools/lint-i18n.mjs']],
  ['屎山考核', 'node', ['tools/lint-slop.mjs']],
  ['配色对比度', 'node', ['tools/check-contrast.mjs']],
  ['设计令牌纪律（未定义变量 / 令牌外颜色 / 悬停态写死颜色）', 'node', ['tools/check-design.mjs']],
  ['文档与代码同步', 'node', ['tools/lint-docs.mjs']],
  ['仓库卫生（对标 Rust tidy）', 'node', ['tools/lint-hygiene.mjs']],
  ['拼写（对标 typos-cli）', 'node', ['tools/lint-typos.mjs']],
  ['版本号四处一致', PY, ['tools/bump-version.py', '--check']],
];

let failed = 0;
const failures = [];
for (const [name, cmd, args] of STEPS) {
  console.log('\n──────── ' + name + ' ────────');
  const r = spawnSync(cmd, args, { cwd: DIR, stdio: 'inherit', env: process.env });
  if (r.error) {
    failed++; failures.push(name + ' (' + r.error.message + ')');
  } else if (r.status !== 0) {
    failed++; failures.push(name);
  }
}

console.log('\n════════════════════════════════');
if (failed === 0) {
  console.log('全部检查通过 ✓（' + STEPS.length + ' 项）');
  console.log('浏览器测试另跑：node tools/smoke-page.mjs <base> / verify-pages / test-ui-flows / test-api-routes');
  process.exit(0);
}
console.log('检查失败：' + failed + ' / ' + STEPS.length + ' 项');
for (const f of failures) console.log('  ✗ ' + f);
process.exit(1);
