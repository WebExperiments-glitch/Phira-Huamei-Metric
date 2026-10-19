/* ============================================================
 * tools/test-chartfiles.mjs —— 谱面包纯函数层单测（不联网）
 * ============================================================
 * 直接 import 真模块public/js/chartfiles-core.mjs。
 *
 * 【为什么这些断言值得存在】
 * 2026-10-18 踩过一个**看起来像上游故障**的坑：
 *   那个 `-` 是字面连字符，于是每个 UUID 都被抹掉中间的横杠
 *   → 直链全404 → 曲绘不显示、chart 与音乐也下不来。
 *   表现是「Phira 没有曲绘」，真因是「我们自己把 URL 改了」。
 *   下面第2 组就是它的回归测试。
 * ============================================================ */
import {
  safeFileName, clipName, pezFileName, cleanChart, searchText,
  illustProxy, kindOf, FILE_KINDS, fileListOf,
} from '../public/js/chartfiles-core.mjs';

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const G = s => console.log('\n【' + s + '】');

const UUID = 'd1724a92-987e-4353-b5e4-5bf3c3065a07';
const CDN = 'https://phira.5wyxi.com/files/';

/* ── 1. 文件名安全 ── */
G('1 · 文件名');
T('普通名字原样保留', safeFileName('Last Dance') === 'Last Dance', safeFileName('Last Dance'));
T('路径分隔符被替换（防目录穿越）',
  !/[\\/]/.test(safeFileName('../../etc/passwd')), safeFileName('../../etc/passwd'));
T('Windows 非法字符被替换',
  !/[<>:"/\\|?*]/.test(safeFileName('a<b>c:d"e/f\\g|h?i*j')), safeFileName('a<b>c:d"e/f\\g|h?i*j'));
T('控制字符被去掉', !/[\x00-\x1f]/.test(safeFileName('a\u0000b\u0007c')), JSON.stringify(safeFileName('a\u0000b\u0007c')));
T('结尾的点与空格被去掉（Windows 不允许）',
  !/[. ]$/.test(safeFileName('name. ')), JSON.stringify(safeFileName('name. ')));
T('保留设备名被加前缀（CON/PRN/AUX 会是设备）',
  /^_/.test(safeFileName('CON')), safeFileName('CON'));
T('空串走fallback', safeFileName('', 'chart') === 'chart', safeFileName('', 'chart'));
T('clipName 限长 120', clipName('x'.repeat(300)).length <= 120, String(clipName('x'.repeat(300)).length));
T('pez 文件名带日期且以 .pez 结尾',
  /^Last Dance-\d{4}-\d{2}-\d{2}\.pez$/.test(pezFileName('Last Dance', new Date(2026, 9, 18))),
  pezFileName('Last Dance', new Date(2026, 9, 18)));
T('不传日期时用今天（不会抛）',
  /\.pez$/.test(pezFileName('X')), pezFileName('X'));

/* ── 2. ⚠ 回归：零宽字符清洗不许吃掉连字符 ── */
G('2 · 直链不被改坏（2026-10-18 事故回归）');
const c1 = cleanChart({ id: 1, name: 'x', illustration: CDN + UUID });
T('曲绘 UUID 里的连字符完好',
  c1.illustration === CDN + UUID, c1.illustration);
T('下载直链（file）同样完好',
  cleanChart({ file: CDN + UUID }).file === CDN + UUID,
  cleanChart({ file: CDN + UUID }).file);
T('UUID 长度仍是 36（含 4 个横杠）',
  (c1.illustration.match(/-/g) || []).length === 4, c1.illustration);
T('展示地址指向我们的代理且带完整 UUID',
  c1.illustView === '/api/phira-illust/' + UUID, c1.illustView);
T('零宽字符仍被清掉（这才是 tidy 的本职）',
  cleanChart({ name: 'A\u200bB\ufeffC' }).name === 'ABC',
  JSON.stringify(cleanChart({ name: 'A\u200bB\ufeffC' }).name));

/* — 4. (曲名 / 搜索) */
G('4 · 搜索能命中玩家昵称');
const c2 = cleanChart({
  id: 2, name: '无名', level: 'AT Lv.16', charter: 'zyrf',
  composer: 'Xomu', illustrator: 'Tiv', description: 'B站：@无限光 ASA',
  tags: ['regular'],
});
T('昵称在 description 里也能搜到', searchText(c2).includes('无限光'), searchText(c2));
T('谱师名可搜', searchText(c2).includes('zyrf'));
T('曲名可搜', searchText(c2).includes('无名'));
T('tags 可搜', searchText(c2).includes('regular'));
T('空对象不炸', searchText(null) === '');

/* ── 5. 文件种类 ── */
G('5 · 文件种类识别');
T('.mp3 → audio', kindOf('https://x/a.mp3') === 'audio');
T('.ogg → audio', kindOf('https://x/a.ogg') === 'audio');
T('.png → illust', kindOf('https://x/a.png') === 'illust');
T('.webp → illust', kindOf('https://x/a.webp') === 'illust');
T('.mp4 → preview', kindOf('https://x/a.mp4') === 'preview');
T('无扩展名时按 hint', kindOf('https://x/uuid', 'chart') === 'chart');
T('FILE_KINDS 有 4 种', FILE_KINDS.length === 4, String(FILE_KINDS.length));
T('四种 key 是 chart/audio/illust/preview',
  FILE_KINDS.map(k => k.key).sort().join(',') === 'audio,chart,illust,preview');

/* ── 6. fileListOf ── */
G('6 · 可下载文件清单');
const c3 = cleanChart({
  id: 3, name: 'A', illustration: CDN + UUID, file: CDN + UUID, preview: CDN + UUID,
});
const list = fileListOf(c3);
/* ⚠ 只有 3 项是对的：音频没有现成直链（上游 chart 对象里没有 audioUrl），
     打包时才临时走 /music?chart=<id>。写成 4 反而是把 bug 当成规范。 */
T('列出 3 项（曲绘/预览/谱面；音频无直链不入清单）', list.length === 3, String(list.length));
T('清单里没有音频', !list.some(x => x.kind === 'audio'));
T('每项都有 kind 与 url', list.every(x => x.kind && x.url));
T('音频没有直链时不出现在清单里',
  !fileListOf(cleanChart({ id: 4, name: 'B' })).some(x => x.kind === 'audio'));
T('上游没给的文件不会被编造出来',
  fileListOf(cleanChart({ id: 5, name: 'C' })).every(x => /^https:\/\//.test(x.url)));

console.log('\n────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);