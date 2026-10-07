/* ============================================================
 * /js/sharecard.js —— 谱面体检卡导出（分享用）
 * ============================================================
 * 【为什么需要】
 *   抖音里链接基本点不了，X 上光发一句「我做了个工具」也没人点。
 *   真正能跨平台传播的只有**图**：用户算完一张谱，导出这张卡发出去，
 *   卡上自带曲名、数字和域名 —— 每个用户就变成了分发节点。
 *
 * 【两种版式】
 *   wide  1200×630  → QQ 群/频道、B站动态、X 大图卡片
 *   tall  1080×1920 → 抖音/小红书竖屏
 *
 * 【设计约束】
 *   · 全程本地 canvas 绘制，**不加载任何外部图片** ——
 *     否则 canvas 会被污染，toBlob() 直接抛 SecurityError。
 *   · 不引入任何依赖（本站是零依赖项目）。
 *   · 数字必须可读：观众在手机上看的是缩略图，字号小等于没写。
 * ============================================================ */

const AMBER = '#e8a33d', BLUE = '#5aa2e8', GREEN = '#4cc38a';
const FG = '#e6edf3', FG2 = '#9aa7b4', FG3 = '#6b7684', LINE = '#2a313c', CARD = '#161b22';
const SITE = 'phm.app.workbuddy.host';

const FONT = '"Microsoft YaHei","PingFang SC",system-ui,-apple-system,sans-serif';

/* 文案：中英两套。X 的观众看不懂「参考定数」四个字。 */
const COPY = {
  zh: {
    tag: 'Phira / Phigros 谱面难度参考',
    ref: '参考定数', ps: 'PS 负荷', official: '标称定数', dev: '偏差',
    nps: '每秒物量', notes: '物量', hold: '长条占比', charter: '谱师',
    footnote: '5 维特征 + 1,037 张官谱 k-NN · 纯浏览器内计算 · 谱面文件不上传',
    site: '不判定「虚标」，只给数字和它的不确定度',
  },
  en: {
    tag: 'An auditable difficulty reference for Phira charts',
    ref: 'Reference', ps: 'Load (PS)', official: 'Rated', dev: 'Drift',
    nps: 'Notes/s', notes: 'Notes', hold: 'Holds', charter: 'Charter',
    footnote: '5 features + k-NN over 1,037 official charts · runs in your browser · charts never uploaded',
    site: 'We do not call anything mis-rated. We publish numbers and their uncertainty.',
  },
};

/* ── 数据适配：把两种来源归一成同一张卡要的东西 ── */

/** 搜索结果里的云端缓存行（/api/analyze 返回的 data） */
export function fromChartRow(row, extra) {
  const o = Object.assign({}, row, extra || {});
  return {
    name: o.name || '未知谱面',
    level: o.level || '',
    charter: o.charter || '',
    ref: num(o.ref_const),
    official: official(o.difficulty),
    ps: num(o.ps_score),
    nps: num(o.nps),
    notes: num(o.notes),
    hold: num(o.hold_ratio),
  };
}

/** 本机拖入解析的结果（engine.js 的 report） */
export function fromReport(r) {
  const f = r.feats || {}, kn = r.knn || {};
  return {
    name: r.name || r.label || '未知谱面',
    level: r.level || '',
    charter: r.charter || (f.charter || ''),
    ref: num(kn.ref),
    official: official(r.difficulty != null ? r.difficulty : f.difficulty),
    ps: num(r.ps && r.ps.total),
    nps: num(f.real_notes_per_second),
    notes: num(f.notes_real),
    hold: num(f.hold_ratio),
  };
}

const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
/* ⚠ Phira 上不少谱面的标称定数字段是 0（谱师没填）。
   直接拿来算偏差会得到「偏差 = 参考定数」这种荒唐结果（实测有 +16.8 的），
   还会污染统计。0 不是合法定数，一律当「无标称」。 */
const official = v => { const n = num(v); return (n != null && n > 0) ? n : null; };
const fx = (v, n) => v == null ? '—' : (+v).toFixed(n);

/* ── 绘制工具 ── */
function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function text(c, s, x, y, { size = 24, color = FG, weight = 400, align = 'left', font = FONT } = {}) {
  c.font = weight + ' ' + size + 'px ' + font;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'alphabetic';
  c.fillText(String(s), x, y);
  return c.measureText(String(s)).width;
}
/* 曲名可能很长：按字符贪心折行，最多 maxLines 行，超出再加省略号。
   竖版必须折行 —— 抖音上曲名被截一半等于这张图白做了。 */
function wrapLines(c, s, maxW, maxLines, setFont) {
  setFont(c);
  s = String(s || '');
  const chars = [...s];
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const test = cur + chars[i];
    if (c.measureText(test).width > maxW && cur) {
      out.push(cur);
      cur = chars[i];
      if (out.length === maxLines) break;
    } else cur = test;
  }
  if (out.length < maxLines && cur) out.push(cur);
  /* 还有没放下的 → 最后一行换成省略号结尾 */
  const used = out.join('').length;
  if (used < chars.length && out.length === maxLines) {
    let last = out[maxLines - 1];
    while (last && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    out[maxLines - 1] = last + '…';
  }
  return out;
}

/* ── 版式：横屏 1200×630 ── */
function drawWide(c, d, L) {
  const W = 1200, H = 630;
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
  /* 两块纯色装饰（不用渐变 —— 与站点风格一致，也更抗压缩） */
  c.globalAlpha = 0.10; c.fillStyle = AMBER;
  c.beginPath(); c.arc(1120, 40, 300, 0, 7); c.fill();
  c.fillStyle = BLUE;
  c.beginPath(); c.arc(60, 620, 240, 0, 7); c.fill();
  c.globalAlpha = 1;

  const P = 64;
  text(c, 'P.H.M.', P, 108, { size: 46, weight: 500, color: AMBER });
  const bw = text(c, ' Standard', P + 152, 108, { size: 46, weight: 500 });
  text(c, L.tag, P, 146, { size: 22, color: FG2 });

  /* 曲名 */
  const nameW = 1120 - P;
  const nm = wrapLines(c, d.name, nameW, 1, cc => { cc.font = '500 54px ' + FONT; })[0];
  text(c, nm, P, 240, { size: 54, weight: 500 });

  const meta = [d.level, d.charter && (L.charter + ' ' + d.charter)].filter(Boolean).join('   ·   ');
  if (meta) text(c, meta, P, 282, { size: 24, color: FG2 });

  /* 数字条 */
  const y = 340, h = 168;
  c.fillStyle = CARD; rr(c, P, y, 1120 - P * 2, h, 18); c.fill();
  c.strokeStyle = LINE; c.lineWidth = 1; c.stroke();

  const dev = (d.ref != null && d.official != null) ? +(d.ref - d.official).toFixed(2) : null;
  const cells = [
    { k: L.ref, v: fx(d.ref, 2), col: AMBER, big: 66 },
    { k: L.ps, v: fx(d.ps, 2), col: BLUE, big: 46 },
    { k: L.official, v: fx(d.official, 2), col: FG2, big: 46 },
    { k: L.dev, v: dev == null ? '—' : (dev > 0 ? '+' : '') + dev.toFixed(2), col: dev == null ? FG3 : (dev >= 0 ? AMBER : BLUE), big: 46 },
  ];
  const colW = (1120 - P * 2) / 4;
  cells.forEach((cell, i) => {
    const cx = P + colW * i + 34;
    text(c, cell.k, cx, y + 46, { size: 20, color: FG3 });
    text(c, cell.v, cx, y + 118, { size: cell.big, weight: 500, color: cell.col });
    if (i) { c.strokeStyle = LINE; c.beginPath(); c.moveTo(P + colW * i, y + 30); c.lineTo(P + colW * i, y + h - 30); c.stroke(); }
  });

  /* 底部 */
  text(c, L.footnote, P, 566, { size: 20, color: FG3 });
  text(c, SITE, 1120 - P, 566, { size: 24, weight: 500, color: BLUE, align: 'right' });
}

/* ── 版式：竖屏 1080×1920（抖音 / 小红书）── */
function drawTall(c, d, L) {
  const W = 1080, H = 1920;
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
  c.globalAlpha = 0.10; c.fillStyle = AMBER;
  c.beginPath(); c.arc(1020, 60, 420, 0, 7); c.fill();
  c.globalAlpha = 1;

  const P = 84;
  text(c, 'P.H.M.', P, 190, { size: 72, weight: 500, color: AMBER });
  text(c, L.tag, P, 246, { size: 30, color: FG2 });

  /* 曲名：允许两行。抖音上曲名被截一半，这张图就白做了。 */
  const nameW = W - P * 2;
  const lines = wrapLines(c, d.name, nameW, 2, cc => { cc.font = '500 74px ' + FONT; });
  lines.forEach((ln, i) => text(c, ln, P, 430 + i * 92, { size: 74, weight: 500 }));
  const metaY = 430 + lines.length * 92 + 40;
  const meta = [d.level, d.charter && (L.charter + ' ' + d.charter)].filter(Boolean).join('   ·   ');
  if (meta) text(c, meta, P, metaY, { size: 34, color: FG2 });

  /* 主数字：参考定数 */
  text(c, L.ref, P, metaY + 112, { size: 34, color: FG3 });
  text(c, fx(d.ref, 2), P, metaY + 268, { size: 168, weight: 500, color: AMBER });

  /* 次级数字两列 */
  const dev = (d.ref != null && d.official != null) ? +(d.ref - d.official).toFixed(2) : null;
  const rows = [
    [L.ps, fx(d.ps, 2), BLUE],
    [L.official, fx(d.official, 2), FG2],
    [L.dev, dev == null ? '—' : (dev > 0 ? '+' : '') + dev.toFixed(2), dev == null ? FG3 : (dev >= 0 ? AMBER : BLUE)],
    [L.nps, fx(d.nps, 2), FG],
  ];
  const boxH = 132, boxW = (W - P * 2 - 24) / 2;
  const gridY = metaY + 330;
  rows.forEach((r, i) => {
    const bx = P + (i % 2) * (boxW + 24), by = gridY + Math.floor(i / 2) * (boxH + 24);
    c.fillStyle = CARD; rr(c, bx, by, boxW, boxH, 16); c.fill();
    c.strokeStyle = LINE; c.lineWidth = 1; c.stroke();
    text(c, r[0], bx + 28, by + 48, { size: 26, color: FG3 });
    text(c, r[1], bx + 28, by + 106, { size: 52, weight: 500, color: r[2] });
  });

  /* 底部：抖音里链接点不了，域名必须够大够显眼。
     底部留约 250px 空白 —— 那是抖音播放页的 UI（文案/按钮）压着的地方。 */
  const urlY = gridY + (boxH + 24) * 2 + 82;
  c.fillStyle = CARD; rr(c, P, urlY, W - P * 2, 210, 18); c.fill();
  c.strokeStyle = LINE; c.stroke();
  text(c, '浏览器打开', P + 34, urlY + 72, { size: 28, color: FG3 });
  text(c, SITE, P + 34, urlY + 162, { size: 58, weight: 500, color: BLUE });
  text(c, L.footnote, P, urlY + 300, { size: 24, color: FG3 });
  text(c, L.site, P, urlY + 350, { size: 24, color: FG3 });
}

/* ── 对外：渲染成 Blob ── */
export async function renderCard(data, mode = 'wide', lang = 'zh') {
  /* 等字体就绪，否则首屏可能画成兜底字体（不同机器差很多） */
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const L = COPY[lang] || COPY.zh;
  const wide = mode !== 'tall';
  const cv = document.createElement('canvas');
  cv.width = wide ? 1200 : 1080;
  cv.height = wide ? 630 : 1920;
  const c = cv.getContext('2d');
  (wide ? drawWide : drawTall)(c, data, L);
  return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

function safeName(s) {
  return String(s || 'chart').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

/* ── 对外主入口：能分享就分享，不能就下载 ──
 * 移动端优先走系统分享面板（可以直接发到 X / 抖音），桌面端退回下载。 */
export async function exportCard(data, mode = 'wide', lang = 'zh') {
  const blob = await renderCard(data, mode, lang);
  if (!blob) throw new Error('图片生成失败');
  const file = new File([blob], 'PHM-' + safeName(data.name) + '.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'P.H.M. Standard', text: data.name });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';   /* 用户自己取消，不是错误 */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
