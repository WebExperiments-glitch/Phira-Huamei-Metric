#!/usr/bin/env node
/* ============================================================
 * tools/lint-i18n.mjs —— 双语完整性专项检查
 * ============================================================
 * 【为什么必须有这个文件】
 *   2026-10-07 用户反馈：「点页脚的 English 之后，整页还是中文」。
 *   根因不是某个词漏翻，而是**半翻译状态没人能发现** ——
 *   i18n 基础设施上线了，但绝大多数页面的文案还是硬编码中文，
 *   没有任何检查会因此报错。页面"能跑"，所以谁也不知道。
 *
 *   这个检查把「有没有翻全」变成**可判定**的：
 *     · 页面里引用的词条，字典里必须真的存在（中英都要）
 *     · 同一分片里 zh / en 的键集合必须一致
 *     · js/i18n/ 下的分片必须在 js/i18n.js 里登记过（忘了登记 = 白翻）
 *     · 反向查：字典里的词条有没有人真的在用（僵尸词条）
 *
 * 【为什么不用无头浏览器查残留中文】
 *   DOM 上的中文分不清「漏翻」和「数据」。曲名、谱师名、用户名本来就
 *   是中文，靠渲染结果判定必然误报。改成查**词条引用**就精确了：
 *   源码里出现的每一个 i18n key 都必须在字典里，这是确定性的。
 *   （渲染层面的抽查另有 tools/verify-i18n-page.mjs。）
 *
 * 用法：node tools/lint-i18n.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const DICT_DIR = path.join(PUB, 'js', 'i18n');

let bad = 0;
const err = m => { bad++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

/* ── 1) 收集分片 ───────────────────────────────────────────── */
const fragFiles = fs.readdirSync(DICT_DIR).filter(f => f.endsWith('.js')).sort();
if (!fragFiles.length) { console.error('找不到任何字典分片'); process.exit(2); }

const frags = new Map();          /* name → {zh, en} */
for (const f of fragFiles) {
  const name = f.replace(/\.js$/, '');
  const mod = await import(url.pathToFileURL(path.join(DICT_DIR, f)).href);
  const d = mod.default;
  if (!d || typeof d !== 'object' || !d.zh || !d.en) {
    err('分片 ' + f + ' 没有导出 { zh: {...}, en: {...} }');
    continue;
  }
  frags.set(name, d);
}

/* ── 2) 分片必须在 i18n.js 里登记 ─────────────────────────── */
console.log('\n[1] 分片登记');
const i18nSrc = fs.readFileSync(path.join(PUB, 'js', 'i18n.js'), 'utf8');
for (const name of frags.keys()) {
  const re = new RegExp("\\bimport\\s+" + name.replace(/[$]/g, '\\$') + "\\s+from\\s+'\\./i18n/" + name + "\\.js'");
  if (!re.test(i18nSrc)) err('分片 i18n/' + name + '.js 没有被 js/i18n.js import —— 等于没翻');
}
/* 也不能 import 了却忘了进 FRAGMENTS 数组 */
const arrBody = (i18nSrc.match(/const FRAGMENTS = \[([\s\S]*?)\];/) || [])[1] || '';
for (const name of frags.keys()) {
  if (!new RegExp('\\b' + name + '\\b').test(arrBody)) {
    err('分片 ' + name + ' 没进 js/i18n.js 的 FRAGMENTS 数组 —— import 了也不会被合并');
  }
}
if (!bad) ok(fragFiles.length + ' 个分片全部已登记');

/* ── 3) zh / en 键集合一致 + 合并出总字典 ─────────────────── */
console.log('\n[2] zh / en 对称');
const DICT = { zh: {}, en: {} };
const OWNER = {};
let pairs = 0;
for (const [name, d] of frags) {
  const zk = Object.keys(d.zh).sort();
  const ek = Object.keys(d.en).sort();
  const onlyZh = zk.filter(k => !(k in d.en));
  const onlyEn = ek.filter(k => !(k in d.zh));
  if (onlyZh.length) err(name + '：只有中文没有英文 → ' + onlyZh.slice(0, 8).join(', ') + (onlyZh.length > 8 ? ' …' : ''));
  if (onlyEn.length) err(name + '：只有英文没有中文 → ' + onlyEn.slice(0, 8).join(', ') + (onlyEn.length > 8 ? ' …' : ''));
  pairs += zk.length;
  for (const k of zk) {
    if (OWNER[k] && OWNER[k] !== name) err('词条「' + k + '」被 ' + OWNER[k] + ' 和 ' + name + ' 重复定义（合并时后者会静默覆盖前者）');
    OWNER[k] = name;
    DICT.zh[k] = d.zh[k];
    if (k in d.en) DICT.en[k] = d.en[k];
  }
}
if (!bad) ok(pairs + ' 条词条，中英一一对称，无重复');

/* ── 4) 源码引用的 key 必须存在 ───────────────────────────── */
console.log('\n[3] 源码引用');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n' || !p.endsWith(path.join('js', 'i18n'))) walk(p); }
    else if (/\.(html|js)$/.test(e.name)) files.push(p);
  }
})(PUB);

/* 只认「看起来像词条名」的字面量：至少一个点、小写段。
   ⚠ 段里**允许下划线**（`dt.col.chart_id` 这种）—— 早先漏了 `_`，
      于是带下划线的词条全被误判成"没人用"。
   这样也能自然排除 closest('button') / querySelector('a') 这类
   以 `t(` 结尾的方法调用误报。 */
/* ⚠ 段里要允许**下划线与驼峰**（`dt.col.chart_id`、`set.store.phiraName`）——
   早先只写 `[a-z0-9_]`，带大写字母的词条全被误判成"没人用"。 */
const SEG = '[a-z][a-zA-Z0-9_]*';
const KEY_RE = new RegExp(
  `(?<![\\w.$])t\\(\\s*(?:'(${SEG}(?:\\.${SEG})+)'|"(${SEG}(?:\\.${SEG})+)")`, 'g');
const ATTR_RE = /data-i18n(?:-html|-ph|-title)?="([^"]+)"/g;
/* 还有一类引用是**间接**的，靠 `t('x')` 抓不到：
     ['diff', 'ch.sort.diff'].map(([k, l]) => t(l))
     t(currentLang() === 'zh' ? 'foot.lang' : 'foot.lang.back')
   所以再补一条宽松规则：**任何**看起来像词条名的字符串字面量都算引用。
   宁可漏报僵尸词条，也不要误报 —— 误报会让人开始忽略这个检查。 */
const LIT_RE = new RegExp(`'(${SEG}(?:\\.${SEG}){1,4})'`, 'g');
const used = new Map();     /* key → Set(相对路径) */
const addUse = (k, rel) => { if (!used.has(k)) used.set(k, new Set()); used.get(k).add(rel); };

for (const p of files) {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  if (rel.startsWith('public/js/i18n/')) continue;    /* 字典自己不算引用 */
  if (/public\/js\/i18n\.js$/.test(rel)) continue;    /* 合并器不算 */
  const s = fs.readFileSync(p, 'utf8');
  let m;
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(s))) addUse(m[1] || m[2], rel);
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) addUse(m[1], rel);
  LIT_RE.lastIndex = 0;
  while ((m = LIT_RE.exec(s))) {
    if (m[1] in DICT.zh) addUse(m[1], rel);          /* 只认字典里真实存在的 */
  }
}

const missingZh = [], missingEn = [];
for (const [k, where] of used) {
  if (!(k in DICT.zh)) missingZh.push(k + ' @ ' + [...where].join(','));
  else if (!(k in DICT.en)) missingEn.push(k + ' @ ' + [...where].join(','));
}
if (missingZh.length) { err('源码引用但字典里没有（中文都会显示成 key 本身）：'); missingZh.forEach(x => console.log('      ' + x)); }
if (missingEn.length) { err('有中文没英文：'); missingEn.forEach(x => console.log('      ' + x)); }
if (!missingZh.length && !missingEn.length) ok(used.size + ' 个被引用的词条全部存在（中英齐全）');

/* ── 5) 僵尸词条（字典里有、谁都没用）─────────────────────── */
console.log('\n[4] 僵尸词条');
/* 排除两类正常情况：
   ① 动态拼出来的 key（如 t('gloss.' + k + '.t')）—— 前缀匹配即可
   ② 被 settings.js 的 LABELS 当作键名引用的 set.store.* */
const dynamicPrefixes = [...i18nSrc.matchAll(/t\(\s*'([a-z][a-z0-9]*\.)'\s*\+/g)].map(m => m[1]);
for (const p of files) {
  const s = fs.readFileSync(p, 'utf8');
  for (const m of s.matchAll(/t\(\s*'([a-z][a-z0-9]*\.)'\s*\+/g)) dynamicPrefixes.push(m[1]);
}
const settingsSrc = fs.readFileSync(path.join(PUB, 'js', 'settings.js'), 'utf8');
for (const m of settingsSrc.matchAll(/'(set\.[a-z0-9.]+)'/g)) addUse(m[1], 'public/js/settings.js (LABELS)');

const dead = [];
for (const k of Object.keys(DICT.zh)) {
  if (used.has(k)) continue;
  if (dynamicPrefixes.some(p => k.startsWith(p))) continue;
  dead.push(k);
}
if (dead.length) {
  console.log('  ⚠ ' + dead.length + ' 条词条没有任何地方引用（可能是翻完忘了接，也可能是删代码留下的）:');
  dead.slice(0, 30).forEach(k => console.log('      ' + k + '  [' + (OWNER[k] || '?') + ']'));
  if (dead.length > 30) console.log('      …');
} else ok('无僵尸词条');

/* ── 汇总 ─────────────────────────────────────────────────── */
console.log('\n' + (bad ? '✗ ' + bad + ' 个问题' : '✓ 双语检查全部通过')
  + '（' + fragFiles.length + ' 个分片 / ' + pairs + ' 条词条 / ' + used.size + ' 处引用）');
process.exit(bad ? 1 : 0);
