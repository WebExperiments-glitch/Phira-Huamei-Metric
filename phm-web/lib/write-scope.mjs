/* ============================================================
 * lib/write-scope.mjs —— 写谱链路的**边界**与**开关**
 * ============================================================
 * 【为什么有这个文件】
 *   2026-10-25 的决定：写谱（/write、/agent、/rulechart 里的 AI 面板）
 *   **不拆成独立站**，它是产品的一部分；但它也**不再继续开发**，
 *   只需要安静地待着。要做到这一点，靠的是三件事，不是靠自觉：
 *
 *   1. **边界清单**（WRITE_OWNED）：哪些文件属于它，写死在这里。
 *      新增文件不登记 → `tools/test-write-scope.mjs` 直接红。
 *      这条守的是「它别继续往里长」。
 *   2. **依赖单向**（WRITE_MAY_USE）：它可以用主站的东西，主站**不许**用它的。
 *      主站侧出现 `import ... from '.../agent.js'` 就报错 —— 今天 /rulechart
 *      那个静态 import 就是反例：agent.js 一坏，整页白屏。
 *   3. **一个开关**（PHM_WRITE=off）：出问题时不用回滚、不改代码，
 *      重启即关。关掉之后 `/write`、`/agent` 返回一张静态说明页，
 *      `/api/agent/*` 一律 503，主站其余部分完全不受影响。
 *
 * 【怎么开回来】
 *   删掉环境变量或设成 on，重启即可。默认就是 on，不做任何事也能正常用。
 * ============================================================ */

/** 写谱链路的自有文件（相对 phm-web/）。
 *  ⚠ 判断标准是「**只为它存在**的文件」，不是「它用到的文件」——
 *     `chart-lint.js` 主站也在用，所以它属于共享，不在这里。 */
export const WRITE_OWNED = [
  'public/write.html',
  'public/agent.html',
  'public/js/write-page.js',
  'public/js/agent-page.js',
  'public/js/agent.js',
  'public/js/agent-runtime.js',
  'public/js/agent-commands.js',
  'public/js/agent-prompt.js',
  'public/js/markdown.js',
  'public/js/script-eval.js',
  'public/js/i18n/agent.js',
  'lib/agent-routes.mjs',
  'lib/write-scope.mjs',
  'tools/test-agent-context.mjs',
  'tools/test-script-eval.mjs',
  'tools/test-write-scope.mjs',
  'tools/send-test.mjs',
  'tools/send-test-audio.mjs',
  'tools/e2e-export.mjs',
  'tools/bench-17.mjs',
  'tools/bench-tools.mjs',
  'tools/bench-stream.mjs',
  'docs/WRITE-LINK.md',
];

/** 写谱**可以**引用的主站模块（单向依赖白名单）。
 *  这些是主站资产，写谱只读不写；主站永远不反过来依赖写谱。 */
export const WRITE_MAY_USE = [
  'public/js/ui.js',
  'public/js/settings.js',
  'public/js/engine.js',
  'public/js/chart-lint.js',
  'public/js/chart-geom.js',
  'public/js/beat-time.js',
  'public/js/rulechart.js',
  'public/js/audio-analysis.js',
  'public/js/chartfiles.js',
  'public/js/guard.js',
  'public/js/motion.js',
  'lib/hm-accounts.mjs',
  'lib/phira-proxy.mjs',
];

/** 环境变量 PHM_WRITE=off / 0 / false 时关闭。默认开。 */
export function writeEnabled(env = {}) {
  const v = String(env.PHM_WRITE ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** 关闭时 `/write` 与 `/agent` 返回的静态页。
 *  ⚠ 刻意**不引任何脚本/样式**：它要在「写谱链路已经坏了」的时候也能显示，
 *    这时候再依赖 `ui.js` 之类的模块就是自找难看。 */
export const CLOSED_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>写谱功能已关闭 · P.H.M.</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F3EE;color:#1D1A16;
  font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
main{max-width:520px;padding:32px 28px;border:1px solid #E2DCD2;border-radius:14px;background:#FFFDF9}
h1{margin:0 0 6px;font-size:19px;font-weight:600}
p{margin:0 0 12px;color:#4A443C}
a{color:#7A4A00}
code{padding:1px 5px;border-radius:4px;background:#EFEBE4;font-size:13px}
/* 这个页面拿不到 base.css，所以只能自带一套最小配色；
   深色跟随系统即可，不需要跟随站点的手动主题开关（它读不到）。 */
@media (prefers-color-scheme: dark){
  body{background:#17140F;color:#EDE8DF}
  main{background:#1F1B15;border-color:#3A342B}
  p{color:#B9B2A6}
  a{color:#D9A257}
  code{background:#2A251E}
}
</style></head>
<body><main>
<h1>写谱功能当前已关闭</h1>
<p>这是<a href="/">P.H.M.</a>的一个实验性功能，出了问题可以单独关掉，
   不影响站点的其它部分（算定数、规则写谱、谱面分析都正常）。</p>
<p>需要恢复：去掉环境变量 <code>PHM_WRITE</code> 或设为 <code>on</code>，重启服务即可。</p>
<p><a href="/rulechart">去用规则写谱</a> · <a href="/app">去算定数</a></p>
</main></body></html>`;
