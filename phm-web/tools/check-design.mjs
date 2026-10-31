#!/usr/bin/env node
/* ============================================================
 * tools/check-design.mjs —— 设计系统的「令牌纪律」审计
 * ============================================================
 * 【为什么需要它】
 *   已有的两道闸门各有盲区，而 bug 正好都从盲区里漏出去：
 *
 *     lint-slop 的硬编码颜色规则 → 只匹配 **6 位 hex**，且
 *       `public/css/base.css` **整文件豁免**（因为它是令牌定义处）。
 *       于是：
 *         · `.pill.amber { border-color: rgba(232,163,61,.4) }` 溜了
 *           （rgba 不被匹配，而且那是**旧的**琥珀 #e8a33d 的 rgb）
 *         · `.btn.primary:hover { background: #f7bd5a }` 溜了
 *           （base.css 整文件豁免）
 *
 *     check-contrast 只算**令牌之间的静态配对**（brand on bg、brand-ink on brand…）。
 *       它算的是「主按钮平时」的对比度，算不到「主按钮**悬停时**」——
 *       而浅色主题的悬停恰好把文字压到 1.70:1。
 *
 *   所以本文件补三件事：
 *     1) `var(--x)` 引用了**没定义**的变量（`--font-mono` 就是这样静默失效的）
 *     2) **令牌块之外**的字面色（hex / rgba）—— 双主题必然漏改一半
 *     3) `:hover` 规则里的字面色 —— 悬停态最容易绕开令牌
 *
 * 【判定口径】
 *   · 「令牌块」= 文件里 `:root { ... }` 与 `:root[data-theme="light"] { ... }`
 *     这两段。其余位置出现字面色都算违规（那里应该写 var(--x)）。
 *   · 自包含文件（404 / phm-api / 分享卡 / OG 图）豁免：它们必须能离线
 *     独立渲染，不可能依赖站点令牌。与 lint-slop 的豁免表保持一致。
 *
 * 用法：node tools/check-design.mjs [--json]
 * 退出码 0 = 通过。
 * ============================================================ */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSON_OUT = process.argv.includes('--json');

/* ── 自包含文件：必须自带整套色值，豁免 ──
   与 tools/lint-slop.mjs 的 COLOR_OK 保持一致（改一处要同步另一处）。 */
const STANDALONE = [
  /^public\/404\.html$/,
  /^public\/phm-api\.html$/,
  /^public\/js\/sharecard\.js$/,
  /^tools\/make-og\.mjs$/,
  /* API 文档的代码块是**固定暗色语法高亮区**（不跟随主题），
     和 lint-slop 的豁免表一致。 */
  /^public\/css\/api\.css$/,
  /* 邮件模板：Gmail 会丢掉 CSS 变量，颜色只能写字面值（见 lib/mail-tpl.mjs 注释） */
  /^lib\/mail-tpl\.mjs$/,
  /* 写谱关闭时的说明页：必须在「写谱链路已经坏了」时也能显示，
     所以不引任何外链样式，拿不到 CSS 变量 —— 与 404 错误页同理。
     两边豁免表必须同步（lint-slop 里也有一条）。 */
  /^lib\/write-scope\.mjs$/,
];

/* ── 运行期由 JS 写入的自定义属性（静态扫不到定义处） ── */
const RUNTIME_VARS = new Set([
  '--mv-i',       /* js/motion.js：stagger 序号 */
  '_',            /* 占位，防止误报 */
]);

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.test(name)) out.push(p);
  }
  return out;
}
const FILES = [
  ...walk(path.join(ROOT, 'public'), /\.(css|html)$/),
  ...walk(path.join(ROOT, 'lib'), /\.mjs$/),
].map(p => ({ abs: p, rel: path.relative(ROOT, p).replace(/\\/g, '/') }));

const problems = [];
const add = (kind, file, line, msg, why) => problems.push({ kind, file, line, msg, why });

/* 行号：按偏移量算（给报告用，不是解析用） */
const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/* ══════════════════════════════════════════════════════════
 * 1) 收集令牌定义
 * ══════════════════════════════════════════════════════════
 * 只认 `:root` / `:root[data-theme=...]` 块里的 `--name:`。
 * `.phm-guard` 之类用到的局部变量不在此列 —— 这里只判断"有没有定义"，
 * 不判断"在哪一层可见"（CSS 变量是继承的，全局定义足够）。
 */
const DEFINED = new Set();
const ROOT_BLOCK_RE = /:root(?:\[[^\]]*\])?\s*\{([\s\S]*?)\n\}/g;
for (const f of FILES) {
  if (!/\.css$/.test(f.rel)) continue;
  const src = readFileSync(f.abs, 'utf8');
  let m;
  ROOT_BLOCK_RE.lastIndex = 0;
  while ((m = ROOT_BLOCK_RE.exec(src))) {
    for (const d of m[1].matchAll(/--([\w-]+)\s*:/g)) DEFINED.add('--' + d[1]);
  }
}
/* ui-kit.css 的 :root 没换行（`:root {\n  /* ... *\/\n  --fs-1: 14px;`）——
   上面的正则要求 `\n}` 收尾，能覆盖。但保险起见再扫一遍全文件的
   `--name:` 定义。
   ⚠ 必须同时扫 html —— 各页面的 `<style>` 里有组件级局部变量
     （app.html 的 `.meter{--min:0;--max:20;…}`）。只扫 .css 会把它们
     误报成"未定义"。 */
for (const f of FILES) {
  if (!/\.(css|html)$/.test(f.rel)) continue;
  const src = readFileSync(f.abs, 'utf8');
  /* ⚠ 匹配 `{` / `;` / 引号 之后的定义，覆盖三类：
       · 组件内局部变量：`.meter{--min:0;--max:20;…}`
       · JS 写进内联样式的：`style="--g1:1.20;--g2:2.40"`（渲染时才存在）
       · 正常 :root 定义（行首）
     早先只匹配行首，把前两类全误报成"未定义"。 */
  for (const d of src.matchAll(/[;{"']\s*--([\w-]+)\s*:/g)) DEFINED.add('--' + d[1]);
  for (const d of src.matchAll(/(?:^|\n)\s*--([\w-]+)\s*:/g)) DEFINED.add('--' + d[1]);
}
for (const v of RUNTIME_VARS) DEFINED.add(v);

/* ══════════════════════════════════════════════════════════
 * 2) 未定义的 var(--x)
 * ══════════════════════════════════════════════════════════ */
for (const f of FILES) {
  if (!/\.(css|html|mjs)$/.test(f.rel)) continue;
  if (STANDALONE.some(r => r.test(f.rel))) continue;
  const src = readFileSync(f.abs, 'utf8');
  for (const m of src.matchAll(/var\(\s*--([\w-]+)/g)) {
    const name = '--' + m[1];
    if (DEFINED.has(name)) continue;
    /* 处在另一个 var() 的**兜底参数位**（`var(--a, var(--b))`）不算错 ——
       那整条就是"给没定义的变量留的后路"。 */
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    if (/,\s*$/.test(before)) continue;
    /* 带兜底值的 var(--x, fallback) 也不算错 —— 那是有意的降级 */
    const tail = src.slice(m.index, m.index + 120);
    if (/^var\(\s*--[\w-]+\s*,/.test(tail)) continue;
    add('未定义的变量', f.rel, lineAt(src, m.index), `var(${name}) 没有定义`,
      'CSS 变量未定义时整条声明被丢弃、不报错 —— 效果"写了但没生效"，只能靠这种静态扫发现');
  }
}

/* ══════════════════════════════════════════════════════════
 * 3) 令牌块之外的字面色
 * ══════════════════════════════════════════════════════════
 * 做法：把 `:root { }` / `:root[data-theme=] { }` 两段**挖掉**，剩下的
 * 部分里出现的 hex / rgba 都算「令牌之外」。挖掉而不是整文件豁免，
 * 是因为 base.css 里恰恰是令牌块**外面**的几行写死了颜色。
 */
const hexRe = /#[0-9a-fA-F]{6}\b/g;
const rgbaRe = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/g;

for (const f of FILES) {
  if (!/\.(css|html|mjs)$/.test(f.rel)) continue;
  if (STANDALONE.some(r => r.test(f.rel))) continue;

  const src = readFileSync(f.abs, 'utf8');
  /* 注释先全去掉（注释里的示例色值不是违规） */
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  /* 挖掉令牌块（保留换行，行号不变） */
  const stripped = noComment.replace(/:root(?:\[[^\]]*\])?\s*\{[\s\S]*?\n\}/g,
    m => m.replace(/[^\n]/g, ' '));

  for (const re of [hexRe, rgbaRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) {
      const line = lineAt(stripped, m.index);
      const text = src.split('\n')[line - 1] || '';
      /* 豁免：data URI（favicon / 噪点纹理）、meta theme-color、行内 SVG */
      if (/data:image\/svg\+xml|name="theme-color"|url\(["']?data:/.test(text)) continue;
      /* 豁免：JS 里的兜底值（`getPropertyValue('--line') || '#ddd'`）——
         那是"令牌读不到时的最后一道保险"，不是主题色定义。 */
      if (/\|\|\s*['"]/.test(text)) continue;
      /* 豁免：纯黑半透明 —— 遮罩层（.scrim / modal-backdrop）与阴影
         在两个主题下都用纯黑，属于**结构性**颜色，不是需要跟着主题走的色。
         它们的透明度才是设计参数，而透明度不在这里的检查范围。 */
      if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*[\d.]+\s*)?\)/.test(m[0])) continue;
      /* 豁免：透明度 0 / 全透明 —— 那是在"擦掉"，不是在定义颜色 */
      if (/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0(?:\.0+)?\s*\)/.test(m[0])) continue;
      add('令牌外的颜色', f.rel, line, m[0] + '   ← ' + text.trim().slice(0, 78),
        '色值只该在 :root 里定义一次；写在别处，双主题必然漏掉其中一个');
    }
  }
}

/* ══════════════════════════════════════════════════════════
 * 4) :hover 规则里的字面色
 * ══════════════════════════════════════════════════════════
 * 这是 2026-10-21 那个 1.70:1 bug 的直接防线：悬停态绕开令牌写成
 * 字面色时，浅色主题会拿到"深色主题的值"，对比度当场崩掉。
 * 单独列出来，是因为它比"别处写了字面色"严重得多 —— 悬停是必经路径。
 */
for (const f of FILES) {
  if (!/\.(css|html)$/.test(f.rel)) continue;
  if (STANDALONE.some(r => r.test(f.rel))) continue;
  const src = readFileSync(f.abs, 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  const stripped = noComment.replace(/:root(?:\[[^\]]*\])?\s*\{[\s\S]*?\n\}/g,
    m => m.replace(/[^\n]/g, ' '));

  /* 扫「含 :hover 的选择器 { ... }」块 */
  const ruleRe = /([^{}\n][^{}]*?:hover[^{}]*?)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(stripped))) {
    const decl = m[2];
    const sel = m[1].trim().slice(0, 70);
    const colorDecl = decl.match(/(?:^|;)\s*(background|background-color|color|border-color)\s*:\s*([^;]+)/g);
    if (!colorDecl) continue;
    for (const d of colorDecl) {
      if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(d)) continue;
      add('悬停态写死颜色', f.rel, lineAt(stripped, m.index), sel + ' → ' + d.trim().slice(0, 60),
        '悬停是必经路径：这里写死深色主题的值，浅色主题下文字会看不清楚（实测 1.70:1）');
    }
  }
}

/* ══════════════════════════════════════════════════════════
 * 输出
 * ══════════════════════════════════════════════════════════ */
if (JSON_OUT) {
  console.log(JSON.stringify({ problems, count: problems.length, definedVars: DEFINED.size }, null, 2));
} else {
  const byKind = new Map();
  for (const p of problems) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p);
  }
  if (!problems.length) {
    console.log('\n设计令牌审计：通过 ✓（' + DEFINED.size + ' 个令牌，0 处违规）\n');
  } else {
    for (const [kind, list] of byKind) {
      console.log('\n【' + kind + '】' + list.length + ' 处');
      console.log('  为什么有这条规则：' + list[0].why);
      for (const p of list) console.log('  · ' + p.file + ':' + p.line + '  ' + p.msg);
    }
    console.log('\n────────\n设计令牌审计：发现 ' + problems.length + ' 个问题\n');
  }
}
process.exit(problems.length ? 1 : 0);
