#!/usr/bin/env node
/* ============================================================
 * tools/check-contrast.mjs —— 配色对比度校验（WCAG 2.1）
 * ============================================================
 * 【为什么要有这个文件】
 *   改配色时"看着还行"是靠不住的：浅色主题里把亮琥珀当正文色，
 *   肉眼觉得"挺亮"，实际对比度只有 3.4:1，远低于 AA 的 4.5。
 *   而这类问题**只在特定底色 + 特定字号**下暴露，靠人工看不出。
 *   AI 给的配色方案也一律是**估值**——必须真的算一遍才算数。
 *
 * 【两种用法】
 *   1) 校验**当前**配色（默认，读 public/css/base.css 的令牌）
 *        node tools/check-contrast.mjs
 *   2) 校验**待落地的方案**（先算再改，避免改完才发现不过）
 *        node tools/check-contrast.mjs tools/palette-proposal.json
 *
 *   proposal.json 形如：
 *        { "dark": { "bg": "#0e0d0b", "fg": "#efebe4", ... },
 *          "light": { ... } }
 *
 * 【判定标准】按**用途**分级，不是一刀切：
 *   正文 / 小标签   4.5 : 1   （AA 正常文字；11.5px 的标签也算正常文字）
 *   大标题 / 次要色  3.0 : 1   （AA large，≥18.66px 粗体或 ≥24px）
 *   占位符 / 装饰    3.0 : 1   （非文本对比度下限）
 *   色块上的文字     4.5 : 1
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ── 色彩解析：hex / rgb() / rgba() ──────────────────────────
 * ⚠ rgba 必须能在**合成到某个底之后**再算对比度。半透明文字色
 *   （虽然本站没用）如果不合成，算出来的数字是没有意义的。 */
function parse(c) {
  const s = String(c).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error('认不出的颜色值: ' + s);
}
/** 把带 alpha 的颜色合成到背景上 */
function over(fg, bg) {
  if (fg.a >= 1) return fg;
  return { r: fg.r * fg.a + bg.r * (1 - fg.a),
           g: fg.g * fg.a + bg.g * (1 - fg.a),
           b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}
/** WCAG 2.1 相对亮度 */
function lum(c) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
/** WCAG 2.1 对比度 */
function ratio(fgRaw, bgRaw) {
  const bg = parse(bgRaw);
  const fg = over(parse(fgRaw), bg);
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ── 要在哪些配对上判定 ──────────────────────────────────────
 * 阈值按**实际用途**给。写清用途比写清数字重要 —— 后来的人才知道
 * 为什么这个要 4.5 而那个 3.0 就够。 */
const PAIRS = [
  /* 文字层级 · 底是画布 */
  ['fg',    'bg',   4.5, '正文'],
  ['fg2',   'bg',   4.5, '次要文字'],
  ['fg3',   'bg',   4.5, '弱化文字 / 11.5px 小标签 ← 最容易被忽略的一档'],
  ['fg4',   'bg',   3.0, '占位符 / 极弱'],
  /* 文字层级 · 底是卡片（卡片比画布亮，深色下对比度会掉） */
  ['fg',    'card', 4.5, '卡片正文'],
  ['fg2',   'card', 4.5, '卡片次要文字'],
  ['fg3',   'card', 4.5, '卡片小标签'],
  /* 主色 */
  ['brand',     'bg',   4.5, '主色当文字用（结果区那个大数字）'],
  ['brand',     'card', 4.5, '主色在卡片上'],
  ['brand-ink', 'brand', 4.5, '主色底按钮上的文字'],
  ['on-color',  'brand', 4.5, '压在主色块上的文字（徽标）'],
  /* 链接：是正文文字，按 4.5 卡 */
  ['link', 'bg',   4.5, '正文里的链接'],
  ['link', 'card', 4.5, '卡片里的链接'],
  /* ⚠ 只给大字号用的明亮主色 —— 门槛是 3.0（AA large，≥24px），
     因为大字的笔画粗、对比需求低。**别拿它当正文色**，小字会过不了。 */
  ['brand-bright', 'bg',   3.0, '大字号专用主色（结果区 54px 数字）'],
  ['brand-bright', 'card', 3.0, '大字号专用主色（卡片上）'],
  /* 语义色 —— 都会当文字用，一律 4.5 */
  ['ok',   'bg', 4.5, '成功'],
  ['warn', 'bg', 4.5, '警告'],
  ['err',  'bg', 4.5, '错误'],
  ['info', 'bg', 4.5, '信息'],
  /* 图表四系列（当线条/色块用，非文字 → 3.0） */
  ['density', 'bg', 3.0, '图表 · 密度'],
  ['pattern', 'bg', 3.0, '图表 · 结构'],
  ['coord',   'bg', 3.0, '图表 · 协调'],
  ['stamina', 'bg', 3.0, '图表 · 持续'],
];

/* ── 从 base.css 读令牌 ───────────────────────────────────── */
function readTokens(css) {
  const grab = re => {
    const m = re.exec(css);
    if (!m) return null;
    const out = {};
    for (const t of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[t[1]] = t[2].trim();
    return out;
  };
  return {
    dark: grab(/:root\s*\{([\s\S]*?)\n\}/),
    light: grab(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/),
  };
}

/* ── 跑 ───────────────────────────────────────────────────── */
const arg = process.argv[2];
let tokens, label;
if (arg) {
  tokens = JSON.parse(fs.readFileSync(arg, 'utf8'));
  label = '待落地方案 ' + path.basename(arg);
} else {
  tokens = readTokens(fs.readFileSync(path.join(ROOT, 'public', 'css', 'base.css'), 'utf8'));
  label = '当前 public/css/base.css';
}

console.log('\n配色对比度校验（WCAG 2.1） · ' + label);
let bad = 0, warn = 0;
for (const theme of ['dark', 'light']) {
  const T = tokens[theme];
  if (!T) { console.log('\n[' + theme + '] 找不到令牌，跳过'); continue; }
  console.log('\n[' + theme + ']');
  for (const [fg, bg, need, use] of PAIRS) {
    if (!(fg in T) || !(bg in T)) continue;
    const r = ratio(T[fg], T[bg]);
    const ok = r >= need;
    if (!ok) bad++;
    const lvl = r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA-large' : '不达标';
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + (fg + ' on ' + bg).padEnd(17)
      + r.toFixed(2).padStart(6) + '  ≥' + need.toFixed(1).padStart(4)
      + '  ' + lvl.padEnd(9) + use);
  }
}

console.log('\n────────');
console.log(bad ? '✗ ' + bad + ' 处不达标' : '✓ 全部达标（' + PAIRS.length * 2 + ' 对）');
process.exit(bad ? 1 : 0);
