/* ============================================================
 * js/chartfiles-core.mjs —— 谱面资源的**纯函数层**（文件名 / 清洗 / 搜索）
 * ============================================================
 * 【核心原则：一字节都不经过我们的服务器】
 *   曲绘 / 音乐 / chart.json 全部在**浏览器里**直接从
 *   Phira 的 CDN 取，服务器只传字符串。
 *
 *   反过来的做法（服务器拉了再转发）看着简单，实际有三个问题：
 *     ① 我们的出口 IP 替全网用户去扒Phira —— 白送流量还挨骂
 *     ② 音频动辄几 MB，服务器带宽被白烧光
 *     ③ Phira 的 DMCA / Terms 明确限制再分发
 *   所以这里**只做拼装**，不做搬运。
 *
 * 【.pez 是什么】
 *   Phira 的谱面包 = 一个 zip，里面必须有 chart.json。
 *   归档了所有版本，所以名字带日期（chart-2026-10-18.pez）——
 *   同一个谱面今天打的和上周打的应该并存，而不是互相覆盖。
 *
 * 【⚠ 为什么这个文件在 public/js/ 而不是 lib/】
 *   白名单里 lib/ **不发给浏览器**（那是服务端代码，
 *   而且 module-level import 了 cloud.mjs，拿出去等于泄露）。
 *   所以纯函数部分必须放在前端可达的位置 ——
 *   但它不含任何服务端依赖，放public 是安全的。
 *   真有共享需求时的正确做法是「逻辑写一份、两端各自导出入口」，
 *   而不是把 lib 开放给浏览器。
 * ============================================================ */

/* ── 文件类型识别 ──
 * ⚠ 不能只看扩展名：Phira 的 chart 文件直链通常**没有扩展名**
 *   （就是个 UUID），只能靠内容嗅探。
 *   实测：.pez 直链返回的 content-type 是
 *   application/octet-stream 或 zip，读前两个字节最可靠。 */
export const FILE_KINDS = [
  { key: 'chart',label: 'chart.json',zh: '谱面',   en: 'Chart' },
  { key: 'audio',  label: '音频',       zh: '音频',   en: 'Audio' },
  { key: 'illust', label: '曲绘',       zh: '曲绘',   en: 'Illustration' },
  { key: 'preview', label: '预览视频',  zh: '预览',   en: 'Preview' },
];

/* 谱面文件本身 = 一个 .pez（zip）包。
 * ⚠ 拉下来之后**要重新打包**再给用户，不是原样转发 ——
 *   原因见下面 buildPez 的注释。 */
export function kindOf(url, type) {
  const u = String(url || '');
  /* Phira 音频直链常带 .mp3 / .ogg */
  if (/\.mp3(\?|$)/i.test(u)) return 'audio';
  if (/\.(ogg|wav|flac)(\?|$)/i.test(u)) return 'audio';
  if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(u)) return 'illust';
  if (/\.(mp4|webm)(\?|$)/i.test(u)) return 'preview';
  if (/\.json(\?|$)/i.test(u)) return 'chart';
  /* 无扩展名 → 靠字段位置判断（调用方给hint） */
  return type || 'chart';
}

/* ── 安全文件名 ──
 * ⚠ 谱名来自用户提交，可能含 / \ : * ? " < > | 和控制字符。
 *   直接拼进下载文件名会：写坏路径、变成目录穿越、
 *   或在 Windows 上触发「文件名非法」。
 *   一律替换掉，不抛异常 —— 一个奇怪的名字不该让整页失败。 */
export function safeFileName(name, fallback = 'chart') {
  const cleaned = String(name == null ? '' : name)
    /* 控制字符先去掉（它们在文件名里完全非法且不可见） */
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\x00-\x1f\x7f]/g, '')
    /* Windows 保留字符 + 文件系统分隔符 */
    .replace(/[<>:"/\\|?*]/g, '-')
    /* 结尾的点和空格在 Windows 上会被静默去掉，导致「名字莫名变了」 */
    .replace(/[. ]+$/g, '')
    /* Windows 保留设备名（CON / PRN / AUX…） */
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i, '_$1')
    .trim();
  return cleaned || fallback;
}

/* ⚠ 长度也要限制：Windows 路径上限 260，
 *   谱名 + 日期 + 后缀超过 ~180 就会在某些机器上失败。 */
export const MAX_NAME_LEN = 120;
export function clipName(name, fallback = 'chart') {
  const s = safeFileName(name, fallback);
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) : s;
}

/* ── .pez 包内的路径 ──
 * Phira 读包时按「大小排序后嗅探内容」找 chart.json，
 * 所以包内的**目录结构不重要**，文件名重要。
 * ⚠ 统一放根目录、命名 chart.json —— 这是最保险的形态，
 *   跟官方包一致，不去发明别的布局。 */
export const PEZ_CHART_ENTRY = 'chart.json';

/* ── 版本化的包名 ──
 * ⚠ 必须带日期：官方归档把每个版本都留着，
 *   用户同一天打两次也该是两份不同的文件（内容可能变了）。 */
export function pezFileName(chartName, date = new Date()) {
  const d = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return clipName(chartName) + '-' + d + '.pez';
}

/* ── 元数据里的「我有什么」 ──
 * ⚠ 上游给的字段是空的很多（illustrator 经常没填）。
 *   空字符串和「没有」在 UI 上要能区分 —— 用 null 而不是 ''。 */
export function fileListOf(chart) {
  const out = [];
  if (chart && chart.file)    out.push({ kind: 'chart',   url: chart.file,        size: null });
  if (chart && chart.preview) out.push({ kind: 'preview', url: chart.preview,     size: null });
  if (chart && chart.illustration) out.push({ kind: 'illust', url: chart.illustration, size: null });
  return out;
}

/* ── 上游元数据的清洗 ──
 * ⚠ 直接把上游 JSON 丢给 innerHTML 就是 XSS：
 *   谱面 description 是**用户自由文本**，
 *   实测里就有 `<br>`、全角空格、还有零宽字符。
 *   所有字段一律转成受限的纯文本，标记交给渲染层。 */
/** 上游曲绘直链 → 我们的展示代理地址。
 *  ⚠ 只接受 `phira.5wyxi.com/files/<uuid>` 这个形状 ——
 *    上游是用户提交的内容，域名/path 都要钉死，
 *    免得哪天字段里塞进别的东西就被我们当图片抓回来。 */
export function illustProxy(url) {
  const m = /^https:\/\/phira\.5wyxi\.com\/files\/([0-9a-f-]{36})$/i.exec(String(url || ''));
  return m ? '/api/phira-illust/' + m[1] : '';
}

export function cleanChart(c) {
  if (!c || typeof c !== 'object') return null;
  /* ⚠ 零宽字符（BOM / ZWSP / ZWNJ…）肉眼看不见，但会污染搜索与文件名。
 *
 *   ⚠⚠ **绝对不能把 ASCII 连字符 `-` 放进这个字符类**。
 *   之前写的是 `/[-‍﻿]/g` —— 那里的 `-` 是**字面连字符**，
 *   于是每一个 UUID 都被抹成 32 位无连字符的串
 *   （`d1724a92-987e-4353-b5e4-5bf3c3065a07` → `d1724a92987e4353b5e45bf3c3065a07`），
 *   上游直链全部 404 —— 曲绘不显示、chart 与音乐也下不下来。
 *   **看起来像"上游没图"，实际是我们自己把 URL 改了。**
 *
 *   ⚠ URL 字段另外还要**整体校验**：直链必须是
 *   `https://phira.5wyxi.com/files/<uuid>` 这个形状才采信，
 *   否则一律当没有 —— 上游是用户可提交的内容，不能只靠"看起来像"。 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;
const tidy = v => (typeof v === 'string' ? v.replace(ZERO_WIDTH, '').trim() : v);

/** 直链校验：域名 + 路径形状都对才返回原样，否则空串。 */
function safeUrl(v) {
  const s = tidy(v);
  return /^https:\/\/phira\.5wyxi\.com\/files\/[0-9a-f-]{36}$/i.test(s) ? s : '';
}
  return {
    id: Number(c.id) || 0,
    name: tidy(c.name) || '(unnamed)',
    difficulty: typeof c.difficulty === 'number' ? c.difficulty : null,
    level: tidy(c.level) || '',
    charter: tidy(c.charter) || '',
    composer: tidy(c.composer) || '',
    illustrator: tidy(c.illustrator) || '',
    /* description 保留换行（谱师习惯分段写），但去掉 HTML */
    description: tidy(c.description) || '',
    tags: Array.isArray(c.tags) ? c.tags.filter(t => typeof t === 'string').slice(0, 12) : [],
    rating: typeof c.rating === 'number' ? c.rating : null,
    ratingCount: Number(c.ratingCount) || 0,
    rated: Number(c.ratingCount) > 0,
    reviewed: !!c.reviewed,
    stable: !!c.stable,
    ranked: !!c.ranked,
    created: tidy(c.created) || '',
    updated: tidy(c.updated) || '',
    chartUpdated: tidy(c.chartUpdated) || '',
    /* 下载用直链 —— 浏览器自己去 CDN 取（不走我们的代理，见 illustView） */
    file: safeUrl(c.file),
    preview: safeUrl(c.preview),
    illustration: safeUrl(c.illustration),
    /* ⚠ **展示**用的曲绘走我们的代理，不是上游直链。
       上游对一切文件都回 `application/octet-stream`，而浏览器有个
       ORB（Opaque Response Blocking）机制会因此**拒绝把响应交给解码器** ——
       症状是 `<img>` 静默失败、naturalWidth=0、控制台一句
       `net::ERR_BLOCKED_BY_ORB`，**真实用户也会这样**。
       代理只做一件事：把 Content-Type 改成 image/webp。
       （实测上游曲绘全是 WebP，magic 是 `RIFF....WEBP`。）
       为什么不改 download 的那两个：那些用户要的是**原件**，
       我们改名重编码等于篡改交付物。 */
    illustView: illustProxy(c.illustration),
  };
}

/* ── 搜索用的可搜索文本 ──
 * ⚠ 用户搜的多半是**玩家昵称**（「无限光」「ASA」），
 *   而那通常只出现在 description 或 tags 里，不在曲名里。
 *   只搜曲名会「明明有却搜不到」。 */
export function searchText(c) {
  if (!c) return '';
  return [c.name, c.charter, c.composer, c.illustrator, c.level,
    ...(c.tags || []), c.description]
    .filter(Boolean).join(' ').toLowerCase();
}