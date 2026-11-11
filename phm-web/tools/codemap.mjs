/* tools/codemap.mjs —— 生成/查询代码地图
 *
 * 用法：
 *   node tools/codemap.mjs              生成 docs/CODEMAP.md
 *   node tools/codemap.mjs --find 限流   按关键词查"该动哪个文件"
 *   node tools/codemap.mjs --check      校验地图是否过期（进闸门）
 *
 * 【为什么需要它】
 *   2026-11-10 实测：43,900 行 / 258 个 JS 文件。代理要改"限流"时只能 grep
 *   全库，命中几十处注释，再逐个打开 —— 这就是上下文被吃光的主因。
 *
 * 【为什么不做成向量检索 / mem0】
 *   搜了三轮，结论一致：跨会话记忆最有效的是**结构化文件 + 按需加载**
 *   （AGENTS.md 常驻 + MEMORY.md 累积 + 具体文档按需拉取），而不是
 *   再引入一个需要向量库和 API key 的检索服务。
 *   代理读文件是最稳的通道；给它一张**准确的目录**，比给它一个黑盒检索更好。
 *
 * 【为什么不手工维护】
 *   258 个文件，手工写必然漂。这里从源码头部注释自动抽取一句职责说明 ——
 *   头部注释本来就有（每个文件都写了"这个文件解决什么"），抽出来就是地图。
 *
 * 【闸门】--check 会比对"当前源码"与"已提交的地图"，不一致就红。
 *   这样加了文件却忘了更新地图，提交时会被拦住。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'CODEMAP.md');

/* 扫哪些目录 —— 只扫"人写的代码"，不扫产物与第三方 */
const TARGETS = [
  { dir: 'lib', kind: '后端' },
  { dir: 'public/js', kind: '前端' },
  { dir: 'public/js/ui', kind: '前端/UI' },
  { dir: 'public/js/i18n', kind: '前端/文案' },
  { dir: 'tools', kind: '工具/闸门' },
];
const SINGLE = [
  { file: 'server.mjs', kind: '入口' },
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p, acc); }
    else if (/\.(mjs|js)$/.test(name)) acc.push(p);
  }
  return acc;
}

/* 从头部注释抽一句职责：取第一个 /* 块里第一行非空、非分隔线的内容 */
function headline(src) {
  const m = src.match(/^\s*\/\*([\s\S]{0,1200}?)\*\//);
  if (!m) return '';
  const lines = m[1].split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').trim())
    .filter(l => l && !/^[=—─━]{4,}$/.test(l) && !/^[─═]{2,}/.test(l));
  const first = lines.find(l => !/^js\/|^tools\/|^lib\//.test(l)) || lines[0] || '';
  return first.replace(/^[0-9.\s]+/, '').slice(0, 60);
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const n of m[1].split(',')) {
      const v = n.trim().split(/\s+as\s+/).pop().trim();
      if (v) names.add(v);
    }
  }
  return [...names];
}

function collect() {
  const rows = [];
  for (const t of SINGLE) {
    const p = path.join(ROOT, t.file);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    rows.push({ kind: t.kind, rel: t.file, lines: src.split('\n').length, head: headline(src), exports: exportsOf(src) });
  }
  for (const t of TARGETS) {
    for (const p of walk(path.join(ROOT, t.dir))) {
      const src = fs.readFileSync(p, 'utf8');
      rows.push({
        kind: t.kind,
        rel: path.relative(ROOT, p).replace(/\\/g, '/'),
        lines: src.split('\n').length,
        head: headline(src),
        exports: exportsOf(src),
      });
    }
  }
  rows.sort((a, b) => b.lines - a.lines);
  return rows;
}

function render(rows) {
  const total = rows.reduce((s, r) => s + r.lines, 0);
  const byKind = new Map();
  for (const r of rows) {
    const k = byKind.get(r.kind) || { n: 0, lines: 0 };
    k.n += 1; k.lines += r.lines; byKind.set(r.kind, k);
  }

  const out = [];
  out.push('# 代码地图 · P.H.M.');
  out.push('');
  out.push('> **自动生成，不要手改**。改源码后跑 `node tools/codemap.mjs` 重新生成本文件；');
  out.push('> `npm run check` 会校验它有没有过期。');
  out.push('');
  out.push(`总计 **${rows.length}** 个文件 / **${total.toLocaleString('en-US')}** 行。`);
  out.push('');
  out.push('**代理怎么用它**：先在这里按职责找到目标文件，再打开那一个 —— '
    + '不要 grep 全库（258 个文件里关键词会命中几十处注释）。');
  out.push('');
  out.push('| 类别 | 文件数 | 行数 |');
  out.push('|---|---|---|');
  for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    out.push(`| ${k} | ${v.n} | ${v.lines.toLocaleString('en-US')} |`);
  }
  out.push('');
  out.push('## 全部文件（按行数降序）');
  out.push('');
  out.push('| 文件 | 行 | 职责 |');
  out.push('|---|---:|---|');
  for (const r of rows) {
    const exp = r.exports.length > 8
      ? r.exports.slice(0, 8).join(', ') + ' …'
      : r.exports.join(', ');
    const head = (r.head || '（无头部注释）');
    const cell = exp ? `${head}<br><sub>导出：${exp}</sub>` : head;
    out.push(`| \`${r.rel}\` | ${r.lines} | ${cell.replace(/\|/g, '\\|')} |`);
  }
  out.push('');
  return out.join('\n');
}

const rows = collect();
const text = render(rows);

const FIND = process.argv.indexOf('--find');
if (FIND >= 0) {
  const kw = String(process.argv[FIND + 1] || '').toLowerCase();
  if (!kw) { console.error('用法：node tools/codemap.mjs --find <关键词>'); process.exit(2); }
  const hit = rows.filter(r => (r.rel + ' ' + r.head + ' ' + r.exports.join(' ')).toLowerCase().includes(kw));
  console.log(`  命中 ${hit.length} 个文件（关键词「${kw}」）：`);
  for (const r of hit) console.log(`    ${String(r.lines).padStart(5)} 行  ${r.rel}\n           ${r.head}`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (old !== text) {
    console.error('  ✗ docs/CODEMAP.md 与源码不一致（加/删/改了文件？）');
    console.error('    修：node tools/codemap.mjs');
    process.exit(1);
  }
  console.log(`  ✓ 代码地图与源码一致（${rows.length} 个文件 / ${total2(rows)} 行）`);
  process.exit(0);
}

fs.writeFileSync(OUT, text);
console.log(`  已生成 docs/CODEMAP.md：${rows.length} 个文件 / ${total2(rows)} 行`);

function total2(rs) { return rs.reduce((s, r) => s + r.lines, 0).toLocaleString('en-US'); }
