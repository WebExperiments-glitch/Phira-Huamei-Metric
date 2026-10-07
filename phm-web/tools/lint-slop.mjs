#!/usr/bin/env node
/* ============================================================
 * tools/lint-slop.mjs —— 屎山代码考核
 * ============================================================
 * 【为什么要单独一个"屎山"检查，而不是靠人盯】
 *   这个项目里已经踩过的坑，有一半是**同一类错误反复出现**：
 *     · 同一个值在多处各写一遍 → 改一处忘三处（版本号、键名、颜色）
 *     · 同一个能力在两处各实现一份 → 必然漂移（en.html vs i18n、两套玩家面板）
 *     · 一个模块被两种 URL 加载 → 两个实例、状态分裂
 *     · 用了"看起来能跑"的写法但语义是错的（`dark ? 'dark' : 'light'` 里
 *       dark 其实是字符串 'light'，永远为真）
 *   人盯不住这些，因为它们**不会报错**，只会在几周后以"莫名其妙"的形式爆出来。
 *
 * 【它检查什么】（每条规则都对应一次真实事故，不是凭空定的）
 *   1. 裸 localStorage —— 键名必须集中在 js/settings.js，别处不许自己写
 *   2. 硬编码颜色 —— 颜色必须走令牌，否则双主题必然漏掉某个角落
 *   3. 重复的函数定义 —— 同名函数出现在两个文件里，就是两份实现
 *   4. 模块 import 带 ?v= —— 会让同一模块变成两个实例（真踩过）
 *   5. 面向用户的 emoji —— 一眼就是"模板味"，且各系统渲染差别极大
 *   6. 文件行数 —— 超了说明该拆
 *   7. 导出了但没人 import —— 死接口
 *   8. TODO / FIXME 残留
 *   9. 生产代码里的 console.log
 *
 * 【怎么跑】
 *     node tools/lint-slop.mjs          # 人看
 *     node tools/lint-slop.mjs --json   # 机器读，可挂 CI
 *   退出码非 0 = 有问题。
 *
 * 【维护原则】
 *   加白名单时**必须写清楚为什么**。白名单是债，不是权限 ——
 *   每条都要能回答"这条例外凭什么成立"。
 * ============================================================ */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSON_OUT = process.argv.includes('--json');

/* ── 收集要检查的文件 ── */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(html|js|mjs|css)$/.test(name)) out.push(p);
  }
  return out;
}
const FILES = walk(path.join(ROOT, 'public')).concat(
  walk(path.join(ROOT, 'tools')),
  existsSync(path.join(ROOT, 'lib')) ? walk(path.join(ROOT, 'lib')) : [],
  [path.join(ROOT, 'server.mjs')].filter(existsSync),
).map(p => ({ abs: p, rel: path.relative(ROOT, p).replace(/\\/g, '/') }));

const problems = [];
const add = (rule, file, line, msg, why) => problems.push({ rule, file, line, msg, why });

/* ══════════════════════════════════════════════════════════════
 * 1) 裸 localStorage
 * ══════════════════════════════════════════════════════════════
 * 键名与默认值必须集中在 js/settings.js。散着写的后果：
 * 「A 页写了 B 页读不到」「同一个键两处默认值不一样」。
 */
const LS_OK = new Set([
  'public/js/settings.js',        // 真源，本来就该在这里读写
  'tools/verify-pages.mjs',       // 测试：故意塞外部键，验证"清空不误伤"
  'tools/smoke-page.mjs',
  /* 这个工具**通过 CDP 在页面里**设 phm_lang，用来模拟"用户之前选过英文"。
     它不是应用代码，不经过 settings.js，也不可能 —— 它跑在 Node 侧。 */
  'tools/check-i18n-page.mjs',
]);
for (const f of FILES) {
  if (LS_OK.has(f.rel)) continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  /* 主题防闪烁脚本是**唯一**的例外：它必须同步跑在 <head> 里，
     早于任何模块加载，所以不可能走 settings.js。它的键名有专门的一致性检查。 */
  const isThemeBoot = /phm_theme/.test(lines.join('\n')) && f.rel.endsWith('.html');
  let inBlock = false;   /* 块注释可能跨行，行首不一定带 * */
  lines.forEach((l, i) => {
    if (isThemeBoot && /phm_theme/.test(l)) return;
    const t = l.trim();
    const opens = /\/\*/.test(l) && !/\*\//.test(l);
    const isComment = inBlock || opens || t.startsWith('//') || t.startsWith('*') ||
                      t.startsWith('/*') || t.startsWith('<!--');
    if (opens) inBlock = true;
    if (/\*\//.test(l)) inBlock = false;
    if (isComment) return;
    const m = /localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(/.exec(l);
    if (m) add('裸-localStorage', f.rel, i + 1,
      `直接调用了 localStorage.${m[1]}()` ,
      '键名与默认值应集中在 js/settings.js；散着写必然出现「A 页写 B 页读不到」');
  });
}

/* ══════════════════════════════════════════════════════════════
 * 2) 硬编码颜色
 * ══════════════════════════════════════════════════════════════
 * 颜色只该在令牌里定义一次（css/base.css、css/docs.css 的 :root），
 * 别处一律 var(--x)。否则深/浅两套主题一定会漏掉某个角落。
 */
const COLOR_OK = [
  /^public\/css\/(base|docs)\.css$/,     // 令牌的定义处
  /* 404 错误页**必须自包含**：它连不上任何东西时也得能正常显示，
     所以宁愿自带一套最小令牌。改 base.css 的令牌时要同步这里。 */
  /^public\/404\.html$/,
  /^tools\/make-og\.mjs$/,               // 生成分享图（离屏渲染，不走 CSS 主题）
  /^public\/js\/sharecard\.js$/,         // 同上：导出的是图片，颜色必须写死
];
const COLOR_OK_INLINE = [
  /data:image\/svg\+xml/,                // favicon 的 data URI，只能是字面色
  /name="theme-color"/,                  // <meta theme-color> **不支持 CSS 变量**，只能写字面值
  /^\s*\*/, /^\s*\/\*/, /^\s*\/\//,      // 注释
];
for (const f of FILES) {
  if (COLOR_OK.some(r => r.test(f.rel))) continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (COLOR_OK_INLINE.some(r => r.test(l))) return;
    const m = /#[0-9a-fA-F]{6}\b/.exec(l);
    if (m) add('硬编码颜色', f.rel, i + 1, `出现字面色 ${m[0]}`,
      '颜色必须走令牌（var(--x)）：双主题下漏改一处就是一个显眼的 bug');
  });
}

/* ══════════════════════════════════════════════════════════════
 * 3) 重复的函数定义
 * ══════════════════════════════════════════════════════════════
 * 同名顶层函数出现在两个文件里 = 两份实现。项目里真实发生过：
 * 玩家面板与 /user 页各有一套 pfRender/pfSearch，改一处不会同步另一处。
 */
const FN_OK = new Set([
  /* 每个页面各有自己的 render() —— 渲染各自的 DOM，不是同一实现的两份。 */
  'render',
  /* 下面两个是**跨运行环境**的同名实现：浏览器侧（app.html）与 Node 侧
     （lib/refstore.mjs 读文件、lib/review.mjs 用 Node 的 fetch）。
     它们不可能共用一份代码，不是"实现漂移"。 */
  'loadRefCom',
  'fetchTO',
]);
const fnSeen = new Map();
for (const f of FILES) {
  if (!/\.(js|mjs|html)$/.test(f.rel)) continue;
  if (f.rel.startsWith('tools/')) continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(l);
    if (!m) return;
    const name = m[1];
    if (!fnSeen.has(name)) fnSeen.set(name, []);
    fnSeen.get(name).push({ file: f.rel, line: i + 1 });
  });
}
const FN_KNOWN_DEBT = new Set([
  /* ⚠ 已知债（登记在此，不静默）：同一个"读定数缓存"的功能有两份实现 ——
     app.html 走云 SDK（cloudDB 直连数据库），js/ui.js 走本站 /api/charts。
     两者数据通道不同，不是复制粘贴，但**对外行为应当一致**。
     出路：app.html 也改成走 /api/charts（那个通道不需要登录、更稳），
     然后删掉它自己那份。 */
  'loadChartCache',
]);
for (const [name, hits] of fnSeen) {
  const files = [...new Set(hits.map(h => h.file))];
  if (files.length > 1 && !FN_OK.has(name) && !FN_KNOWN_DEBT.has(name)) {
    add('重复函数定义', files.join(' + '), hits[0].line,
      `函数 ${name}() 在 ${files.length} 个文件里各定义了一份`,
      '两份实现必然漂移；应该抽到公共模块（js/ui.js / js/settings.js 等）里');
  }
}

/* ══════════════════════════════════════════════════════════════
 * 4) 模块 import 带查询串（会造成"两个模块实例"）
 * ══════════════════════════════════════════════════════════════
 * 真事故：页面用 /js/i18n.js?v=… 引用，模块内部却用 ./i18n.js —
 * 浏览器当成两个模块，状态分裂（设置页切了语言，导航不跟着变）。
 * 例外：engine.js 与 data/*.json 只在单一位置引入，带 ?v= 是有意的。
 */
const VER_OK = /(engine\.js|ref-official\.js|ref-com\.json)/;
for (const f of FILES) {
  if (!/\.html$/.test(f.rel)) continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    /* 只看 import / 模块加载，不看 <link>（CSS 无实例问题） */
    if (!/import\s*\(|^\s*import\s/.test(l)) return;
    if (!/\.js\?v=/.test(l)) return;
    if (VER_OK.test(l)) return;
    add('模块带版本串', f.rel, i + 1, l.trim().slice(0, 80),
      '模块之间必须共用同一实例；带 ?v= 会让同一文件被当成两个模块，状态分裂');
  });
}

/* ══════════════════════════════════════════════════════════════
 * 5) 面向用户的 emoji
 * ══════════════════════════════════════════════════════════════
 * 用户对"模板味"很敏感，emoji 是其中最重的信号之一；
 * 而且它在不同系统上渲染差别极大，一套设计会被它带歪。
 * 注释里随便用（那是给人看的），**渲染出来的文本**里不许有。
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/u;   /* 只盯彩色 emoji：⚠/✅/✕ 属排版记号，专业界面普遍在用 */
const EMOJI_OK_FILES = [
  /* 分享图生成器：卡面文案本来就是设计的一部分，且是离屏渲染 */
  /^tools\/make-og\.mjs$/,
];
/* 行内豁免：注释行、以及只出现在 title 属性里的（那是给鼠标悬停看的提示文本） */
const EMOJI_OK_INLINE = [
  /^\s*[*\/]/,
  /title="[^"]*"/,
];
for (const f of FILES) {
  if (!/\.(html|js|mjs)$/.test(f.rel)) continue;
  if (EMOJI_OK_FILES.some(r => r.test(f.rel))) continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    if (t.startsWith('<!--') || t.endsWith('-->') || t.includes('-->')) return;   // HTML 注释
    if (EMOJI_OK_INLINE.some(r => r.test(l))) return;
    if (EMOJI_RE.test(l)) {
      add('界面 emoji', f.rel, i + 1, t.slice(0, 70),
        'emoji 是"模板味"最重的信号，且各系统渲染不一致；用内联 SVG 或纯文字代替');
    }
  });
}

/* ══════════════════════════════════════════════════════════════
 * 6) 文件行数
 * ══════════════════════════════════════════════════════════════
 * 超了说明该拆。app.html 曾到 2338 行（里面还藏着 429 行死代码）——
 * 那么长的文件，没人能保证改动不误伤。
 */
const SIZE_LIMIT = { page: 2200, module: 900, css: 700 };
for (const f of FILES) {
  const n = readFileSync(f.abs, 'utf8').split('\n').length;
  const kind = f.rel.endsWith('.html') ? 'page'
    : f.rel.endsWith('.css') ? 'css' : 'module';
  const lim = SIZE_LIMIT[kind];
  if (n > lim) {
    add('文件过长', f.rel, n, `${n} 行（上限 ${lim}）`,
      '过长的文件没人能保证改动不误伤 —— 该按职责拆开了');
  }
}

/* ══════════════════════════════════════════════════════════════
 * 7) 导出了但全站没人 import
 * ══════════════════════════════════════════════════════════════
 * 死接口比死代码更隐蔽：它看起来"是给外面用的"。
 */
const allText = FILES.map(f => ({ rel: f.rel, s: readFileSync(f.abs, 'utf8') }));
/* 接口层模块（settings / i18n / ui / phira / sharecard）的导出**就是**对外接口，
   被外部按需取用是正常的，不该按"没人用就是死接口"来判。
   要盯的是**实现模块**（engine.js）里的死导出。 */
const IFACE_MODULES = /^public\/js\/(settings|i18n|ui|phira|sharecard)\.js$/;
for (const f of FILES) {
  if (!/^public\/js\/[\w-]+\.js$/.test(f.rel)) continue;
  if (IFACE_MODULES.test(f.rel)) continue;
  const s = readFileSync(f.abs, 'utf8');
  const re = /^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    const used = allText.some(o => o.rel !== f.rel &&
      new RegExp('\\b' + name + '\\b').test(o.s));
    if (!used) {
      const line = s.slice(0, m.index).split('\n').length;
      add('未使用的导出', f.rel, line, `export ${name} 全站无人 import`,
        '导出了就表示"这是给外面用的"，但没人用 = 死接口，读者会误以为它在被依赖');
    }
  }
}

/* ══════════════════════════════════════════════════════════════
 * 7.5) 敏感文件必须被 .gitignore 覆盖
 * ══════════════════════════════════════════════════════════════
 * 这条防的不是"现在泄露了"，而是"**哪天有人手滑**"。
 * write-secret.txt 是 phm_charts / phm_scores 的唯一写权限；
 * 仓库是公开的，`git add .` 一下就等于把写权限交给所有人。
 * 光靠"记得别提交"不是防线，是运气。
 */
const MUST_IGNORE = [
  'write-secret.txt',      // 定数缓存的写入凭据
  '.phm-write-secret',     // 同一凭据的备选文件名
  '.env',                  // 环境变量入口（真值放这里）
  'server-store.json',     // 运行时状态：限流计数等，会随运行变化，不该入库
];
{
  const gi = existsSync(path.join(ROOT, '.gitignore'))
    ? readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
  const lines = gi.split('\n').map(l => l.trim());
  for (const f of MUST_IGNORE) {
    if (!lines.includes(f)) {
      add('敏感文件未忽略', '.gitignore', 0, `${f} 不在 .gitignore 里`,
        '仓库是公开的：`git add .` 一下就可能把凭据或运行时状态提交上去');
    }
  }
  /* 反向检查：.env.example 是模板，**必须**能提交（它是给人看的说明书） */
  if (lines.includes('.env.example')) {
    add('模板被误忽略', '.gitignore', 0, '.env.example 被忽略了（它应该被提交）',
      '它是给人看的格式说明，不含真值；忽略它等于让接手的人不知道要配哪些变量');
  }
}

/* ══════════════════════════════════════════════════════════════
 * 8) TODO / FIXME 残留   9) 生产代码里的 console.log
 * ══════════════════════════════════════════════════════════════ */
for (const f of FILES) {
  if (f.rel === 'tools/lint-slop.mjs') continue;   // 它自己就含这两个词（作为规则定义）
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/\b(TODO|FIXME|XXX)\b/.test(l) && !/^\s*(\*|\/\/)/.test(l)) {
      add('未完成标记', f.rel, i + 1, l.trim().slice(0, 70),
        'TODO/FIXME 会一直躺在那里；要么现在做，要么登记进文档的待办清单');
    }
  });
}
/* console.log 只允许在 server 的启动横幅与 tools/ 下 */
for (const f of FILES) {
  if (f.rel.startsWith('tools/') || f.rel === 'public/js/i18n.js') continue;
  const lines = readFileSync(f.abs, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/^\s*(\*|\/\/)/.test(l)) return;
    if (!/console\.log\s*\(/.test(l)) return;
    if (f.rel === 'server.mjs' && /listening|写入凭据|\[phm\]/.test(l)) return;  // 启动横幅
    if (f.rel.startsWith('lib/') && /\[phm\]/.test(l)) return;   // 启动诊断：凭据来源必须能看见
    add('残留 console.log', f.rel, i + 1, l.trim().slice(0, 70),
      '生产代码里的调试输出会泄漏内部结构，也是"没收拾干净"的标志');
  });
}

/* ══════════════════════════════════════════════════════════════
 * 输出
 * ══════════════════════════════════════════════════════════════ */
if (JSON_OUT) {
  console.log(JSON.stringify({ problems, count: problems.length }, null, 2));
} else {
  const byRule = new Map();
  for (const p of problems) {
    if (!byRule.has(p.rule)) byRule.set(p.rule, []);
    byRule.get(p.rule).push(p);
  }
  if (!problems.length) {
    console.log('\n屎山考核：通过 ✓ 没有发现问题\n');
  } else {
    for (const [rule, list] of byRule) {
      console.log(`\n【${rule}】${list.length} 处`);
      console.log(`  为什么有这条规则：${list[0].why}`);
      for (const p of list.slice(0, 12)) {
        console.log(`  · ${p.file}:${p.line}  ${p.msg}`);
      }
      if (list.length > 12) console.log(`  … 还有 ${list.length - 12} 处`);
    }
    console.log(`\n────────\n屎山考核：发现 ${problems.length} 个问题\n`);
  }
}
process.exit(problems.length ? 1 : 0);
