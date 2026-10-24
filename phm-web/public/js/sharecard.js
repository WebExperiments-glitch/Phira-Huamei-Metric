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

import { drawQrBadge } from './qr.js?v=V0.22.2.2';

const AMBER = '#e8a33d', BLUE = '#5aa2e8', GREEN = '#4cc38a';
const FG = '#e6edf3', FG2 = '#9aa7b4', FG3 = '#6b7684', LINE = '#2a313c', CARD = '#161b22';
const SITE = 'phm.app.workbuddy.host';

const FONT = '"Microsoft YaHei","PingFang SC",system-ui,-apple-system,sans-serif';

/** 卡片上二维码要编码的地址。
 *  ⚠ 必须落到一个**具体页面**：首页对看图的人没有信息量，
 *    详情形（/chart/<id>）才是"他刚看到的那个人/那张谱"。
 *    没有 id 时退回首页 —— 但那是兜底，不是常态。 */
function qrUrlOf(d) {
  if (d && d.url) return String(d.url);
  if (d && d.uid) return 'https://' + SITE + '/user?uid=' + encodeURIComponent(d.uid);
  return 'https://' + SITE + '/';
}

/* 文案：中英两套。X 的观众看不懂「参考定数」四个字。 */
const COPY = {
  zh: {
    tag: 'Phira / Phigros 谱面难度参考',
    ref: '参考定数 · 社区共识', ps: 'PS 负荷', official: 'Phira 标称', dev: '偏差',
    refOff: '官谱标度', refOffNote: '（同样的算法，参照集换成 1,037 张 Phigros 官谱）',
    nps: '每秒物量', notes: '物量', hold: '长条占比', charter: '谱师',
    range: '不确定范围',
    footnote: '8 维特征 + 9,508 张社区谱 k-NN（社区共识）· 纯浏览器内计算 · 谱面文件不上传',
    site: '不判定「虚标」，只给数字和它的不确定度',
    /* ── 玩家成绩卡 ── */
    pTag: '玩家成绩卡',
    pRks: 'P.H.M. RKS',
    pRksNote: '用我们的参考定数重算',
    pSiteRks: 'Phira 官方 RKS',
    pSiteNote: '站点自己给的数字',
    pCover: '覆盖谱面',
    pCoverNote: '其中 {n} 张用上我们的定数',
    pCoverAll: '全部用上我们的定数',
    pTop: '贡献最大的谱面',
    pColChart: '曲目', pColLv: '定数', pColAcc: '准确率', pColSr: '单曲',
    pFrom: '定数来源：P.H.M.（该谱无我们定数时退回 Phira 标称）',
    pWhy: '为什么和官方不一样：官方 RKS 的分母固定 20，样本不足时会被压低；这里按实际条数平均。',
    pNoData: '没有足够的成绩来算 RKS',
  },
  en: {
    tag: 'An auditable difficulty reference for Phira charts',
    ref: 'Reference · community', ps: 'Load (PS)', official: 'Phira rated', dev: 'Drift',
    refOff: 'Official scale', refOffNote: ' (same method, reference set = 1,037 Phigros official charts)',
    nps: 'Notes/s', notes: 'Notes', hold: 'Holds', charter: 'Charter',
    range: 'range',
    footnote: '8 features + k-NN over 9,508 community charts · runs in your browser · charts never uploaded',
    site: 'We do not call anything mis-rated. We publish numbers and their uncertainty.',
    pTag: 'Player card',
    pRks: 'P.H.M. RKS',
    pRksNote: 'recomputed with our constants',
    pSiteRks: 'Phira RKS',
    pSiteNote: 'the number the site gives',
    pCover: 'Charts used',
    pCoverNote: '{n} of them use our constant',
    pCoverAll: 'all of them use our constant',
    pTop: 'Biggest contributors',
    pColChart: 'Chart', pColLv: 'Const', pColAcc: 'Accuracy', pColSr: 'Single',
    pFrom: 'Constant source: P.H.M. (falls back to the Phira level when we have none)',
    pWhy: 'Why it differs: the official RKS always divides by 20, so it reads low when you have few records. We divide by the number actually used.',
    pNoData: 'Not enough plays to compute a RKS',
  },
};

/* 「不确定范围」文案：20 个参照官谱的定数跨度。没有就不印。 */
function rangeOf(d, L) {
  if (d.lo == null || d.hi == null) return null;
  return L.range + ' ' + (+d.lo).toFixed(1) + '–' + (+d.hi).toFixed(1);
}

/* ── 数据适配：把两种来源归一成同一张卡要的东西 ── */

/** 搜索结果里的云端缓存行（/api/analyze 返回的 data） */
export function fromChartRow(row, extra) {
  const o = Object.assign({}, row, extra || {});
  return {
    name: o.name || '未知谱面',
    level: o.level || '',
    charter: o.charter || '',
    ref: num(o.ref_const),
    /* 官谱标度：与 Phigros 官方一致的绝对标度。双标度之一，
       卡片上必须出现 —— 只印一个数看起来像结论，两个数才是信息。 */
    refOfficial: num(o.ref_official),
    official: official(o.difficulty),
    ps: num(o.ps_score),
    nps: num(o.nps),
    notes: num(o.notes),
    hold: num(o.hold_ratio),
  };
}

/** 玩家成绩（/user 页的 pm 结果 + 玩家对象）→ 卡片输入。
 *
 *  ⚠ 卡片上必须**同时**印我们的 RKS 和站点给的 RKS。
 *    只印一个数字，观众无从判断这是「我们的算法」还是「官方值」，
 *    截图传开之后就会被当成官方数据引用 —— 那是错的。
 *
 *  ⚠ 定数来源要逐条标注（src: 'phm' | 'phira'）：
 *    不是每张谱都有我们的定数（新谱、冷门谱还没算过），
 *    混着用却不说明，等于把「部分准确」说成「全部准确」。 */
export function fromPlayer(player, rks, date) {
  const p = player || {}, r = rks || {};
  /* ⚠ 用**完整**列表算总数，只在最后截断给卡片用。
     早先直接 slice 之后再取 length，于是卡片上出现
     「覆盖谱面 12（其中 20 张用上我们的定数）」—— 12 < 20，自相矛盾。
     用户看到这种数字只会得出一个结论：这站的数不可信。 */
  const all = (r.items && r.items.length) ? r.items : (r.top || []);
  const items = all.slice(0, 12).map(x => ({
    name: x.name || ('#' + x.chart),
    lv: num(x.lv),
    acc: num(x.acc),
    sr: num(x.sr),
    src: x.src === 'phm' ? 'phm' : 'phira',
  }));
  return {
    name: p.name || ('UID ' + (p.id || '')),
    uid: p.id != null ? String(p.id) : '',
    rks: num(r.fair),
    /* 「÷20 口径」是我们对官方分母的复现，作为参考列一起印 */
    rksStrict: num(r.official),
    siteRks: num(p.rks) || null,
    items,
    n: all.length,
    phmN: num(r.phmN) || 0,
    phiraN: num(r.phiraN) || 0,
    date: date || '',
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
    /* 不确定范围：20 个参照官谱的定数跨度。
       卡片上必须带上它 —— 只印一个中点数字等于假装精确，
       而这张图会被发到群里、被谱师看到。 */
    lo: num(kn.lo), hi: num(kn.hi),
    refOfficial: num(r.knnOff && r.knnOff.ref),
    basis: kn.basis || 'official',
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
async function drawWide(c, d, L) {
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
  const y = 326, h = 142;
  c.fillStyle = CARD; rr(c, P, y, 1120 - P * 2, h, 18); c.fill();
  c.strokeStyle = LINE; c.lineWidth = 1; c.stroke();

  const dev = (d.ref != null && d.official != null) ? +(d.ref - d.official).toFixed(2) : null;
  const cells = [
    { k: L.ref, v: fx(d.ref, 2), col: AMBER, big: 62, sub: rangeOf(d, L) },
    { k: L.ps, v: fx(d.ps, 2), col: BLUE, big: 46 },
    { k: L.official, v: fx(d.official, 2), col: FG2, big: 46 },
    { k: L.dev, v: dev == null ? '—' : (dev > 0 ? '+' : '') + dev.toFixed(2), col: dev == null ? FG3 : (dev >= 0 ? AMBER : BLUE), big: 46 },
  ];
  const colW = (1120 - P * 2) / 4;
  cells.forEach((cell, i) => {
    const cx = P + colW * i + 34;
    text(c, cell.k, cx, y + 46, { size: 20, color: FG3 });
    text(c, cell.v, cx, y + 112, { size: cell.big, weight: 500, color: cell.col });
    if (cell.sub) text(c, cell.sub, cx, y + 128, { size: 15, color: FG3 });
    if (i) { c.strokeStyle = LINE; c.beginPath(); c.moveTo(P + colW * i, y + 30); c.lineTo(P + colW * i, y + h - 30); c.stroke(); }
  });

  /* 官谱标度对照行 —— 双标度里更"客观"的那一栏 */
  /* 右下角留给二维码：这里的文字一律截断到 QR_LEFT 之前，
     否则长文案会从码上穿过去（缩略图里最难看的一种）。
     ⚠ 二维码是**带静区**画的，所以文字要再往里收 20px。 */
  /* ⚠ 二维码尺寸不是"看着合适"就行，它有个硬下限：
     **每个模块至少 3–4 像素**，否则解码器（含手机相机）认不出来。
     29 模块的码 + 静区 ≈ 37 格，84px 只有 2.3px/模块 —— 实测扫不出来。
     132px 约 3.6px/模块，这是横版放得下的上限，所以把数字条压矮腾地方。 */
  const QS = 132, QPAD = 10;
  const qRight = 1120 - P;
  const qLeft = qRight - QS - QPAD * 2;
  const textMax = qLeft - P - 24;

  if (d.refOfficial != null) {
    const line = wrapLines(c, L.refOff + '  ' + fx(d.refOfficial, 2) + L.refOffNote,
      textMax, 1, cc => { cc.font = '400 19px ' + FONT; })[0];
    text(c, line, P, 496, { size: 19, color: FG3 });
  }
  /* 底部 */
  /* ⚠ 两段文字必须在同一行共存：先量出域名的宽度，再从 footnote 的可用宽度里扣掉。
     早先两段都截到 textMax，结果域名压住了 footnote 的后半句（截图一眼可见）。 */
  c.font = '500 22px ' + FONT;
  const siteW = c.measureText(SITE).width;
  const footMax = qLeft - 18 - siteW - 26 - P;
  const foot = wrapLines(c, L.footnote, Math.max(80, footMax), 1, cc => { cc.font = '400 20px ' + FONT; })[0];
  text(c, foot, P, 524, { size: 20, color: FG3 });
  text(c, SITE, qLeft - 18, 524, { size: 22, weight: 500, color: BLUE, align: 'right' });

  /* 二维码：右下角，白底板让它从深色卡片上"浮"起来 */
  await drawQrBadge(c, qrUrlOf(d), qLeft + QPAD, 478 + QPAD, QS,
    { light: '#ffffff', dark: '#0d1117' });
}

/* ── 版式：竖屏 1080×1920（抖音 / 小红书）── */
async function drawTall(c, d, L) {
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

  /* 主数字：参考定数。右侧并排印不确定范围 —— 竖版是发抖音的，
     只说一个中点数字最容易被截图拿去吵「你凭什么说我谱 11.6」。 */
  text(c, L.ref, P, metaY + 112, { size: 34, color: FG3 });
  text(c, fx(d.ref, 2), P, metaY + 268, { size: 168, weight: 500, color: AMBER });
  const rg = rangeOf(d, L);
  if (rg) text(c, rg, P + 430, metaY + 268, { size: 26, color: FG3 });
  if (d.refOfficial != null) {
    text(c, L.refOff + '  ' + fx(d.refOfficial, 2) + L.refOffNote, P, metaY + 312, { size: 24, color: FG3 });
  }

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
  /* 这个区块右侧放二维码（150px），文字一律收在它左边 */
  const TQS = 180, TQPAD = 10;
  const tqRight = W - P - 22;
  const tqLeft = tqRight - TQS - TQPAD * 2;
  const tMax = tqLeft - (P + 34) - 24;

  text(c, '浏览器打开', P + 34, urlY + 66, { size: 26, color: FG3 });
  const siteLine = wrapLines(c, SITE, tMax, 1, cc => { cc.font = '500 46px ' + FONT; })[0];
  text(c, siteLine, P + 34, urlY + 150, { size: 46, weight: 500, color: BLUE });
  await drawQrBadge(c, qrUrlOf(d), tqLeft + TQPAD, urlY + 22, TQS,
    { light: '#ffffff', dark: '#0d1117' });

  text(c, L.footnote, P, urlY + 300, { size: 24, color: FG3 });
  text(c, L.site, P, urlY + 350, { size: 24, color: FG3 });
}

/* ══════════════════════════════════════════════════════════════
 * 版式：玩家成绩卡
 * ══════════════════════════════════════════════════════════════
 * 与「谱面体检卡」的分工：
 *   体检卡回答「**这张谱**有多难」，玩家卡回答「**这个人**打得怎么样」。
 *   两张卡都印同一个域名，互为入口。
 *
 * ⚠ 三个必须出现在卡面上的东西（少一个这张图就会骗人）：
 *   ① P.H.M. RKS 与 Phira 官方 RKS **并排**，且各自标注来源
 *   ② 用了几张谱、其中几张用上我们的定数
 *   ③ 「为什么和官方不一样」的一句话解释
 *   截图传开之后没人会回来读网页，卡面就是全部上下文。
 */

/* 单行：曲名 + 定数 + 准确率 + 单曲 rks。两边版式共用。 */
function playerRow(c, it, L, x, y, w, big, hasAcc) {
  const fs = big ? 30 : 24;
  const fs2 = big ? 26 : 21;
  const lvW = big ? 96 : 82;
  const accW = big ? 170 : 140;
  const srW = big ? 130 : 108;

  /* 曲名：定宽折行会把表格挤乱，所以只截断 —— 卡片不是列表页 */
  const nameW = w - lvW - accW - srW;
  let nm = String(it.name || '');
  c.font = '400 ' + fs + 'px ' + FONT;
  while (nm && c.measureText(nm).width > nameW) nm = nm.slice(0, -1);
  if (nm !== String(it.name || '')) nm = nm.replace(/.$/, '') + '…';

  text(c, nm, x, y, { size: fs, color: FG });
  /* ⚠ 定数用**颜色**区分来源，不用额外的符号 ——
     早先试过在数字后面点一个小圆点，那东西会随列宽漂移、
     最后叠到隔壁的准确率上，看起来像渲染 bug。
     现在的约定：亮 = 我们的定数，暗 = 退回 Phira 标称，页脚说明一句。 */
  text(c, fx(it.lv, 2), x + nameW, y, { size: fs, color: it.src === 'phm' ? FG2 : FG3 });

  /* 准确率列是**可选**的：B19 池给的数据里没有 acc，
     这时候整列都不该出现（一列全是「—」会被读成加载失败）。 */
  if (hasAcc) {
    text(c, it.acc == null ? '—' : fx(it.acc, 2) + '%', x + nameW + lvW, y,
      { size: fs, color: it.acc != null && it.acc >= 100 ? AMBER : FG2 });
  }
  text(c, fx(it.sr, 2), x + w, y, { size: fs, weight: 500, color: it.sr == null ? FG3 : BLUE, align: 'right' });
}

/** 「其中 N 张用上我们的定数」/「全部用上」（N == 总数时）。
 *  ⚠ 覆盖数等于总数还说「其中 20 张（共 20 张）」读起来像漏了信息，
 *    而这张图是要发出去的，措辞含糊会被当成"数据不全"。 */
function coverNote(d, L) {
  if (!d.n) return '';
  if ((d.phmN || 0) >= d.n) return L.pCoverAll;
  return L.pCoverNote.replace('{n}', d.phmN || 0);
}

function playerHead(c, d, L, P, y, titleSize) {
  text(c, 'P.H.M.', P, y, { size: titleSize, weight: 500, color: AMBER });
  text(c, ' ' + L.pTag, P + titleSize * 3.3, y, { size: titleSize, weight: 500 });
  /* 玩家名。⚠ 超长名字会压到右侧装饰圆上，所以要截断而不是折行 ——
     这行只有一行的空间。 */
  const nmSize = Math.round(titleSize * 1.5);
  const nmY = y + titleSize + 48;
  let nm = String(d.name || '');
  c.font = '500 ' + nmSize + 'px ' + FONT;
  while (nm && c.measureText(nm).width > 660) nm = nm.slice(0, -1);
  if (nm !== String(d.name || '')) nm = nm.slice(0, -1) + '…';
  text(c, nm, P, nmY, { size: nmSize, weight: 500 });
  if (d.uid) {
    text(c, 'UID ' + d.uid + (d.date ? '   ·   ' + d.date : ''), P, nmY + 32,
      { size: Math.round(titleSize * 0.46), color: FG3 });
  }
}

/* ── 玩家卡 · 横屏 1200×630 ──
 * ⚠ 630 的高度比体检卡紧得多（那边只有 4 个数字，这边要放表）。
 *   分档时按**基线**算，不要按盒子算，否则最后一行一定会压到页脚：
 *     66 标题 / 152 名字 / 186 UID
 *     214–360 数字条
 *     392 表头 / 402 分隔线
 *     436 起 4 行，行距 34 → 最后一行 538
 *     580 / 606 两行页脚
 *   只放 4 行是有意的：这张图的用途是发群里让人来查，不是完整榜单。 */
async function drawPlayerWide(c, d, L) {
  const W = 1200, H = 630;
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
  c.globalAlpha = 0.07; c.fillStyle = AMBER;
  c.beginPath(); c.arc(1250, -40, 300, 0, 7); c.fill();
  c.globalAlpha = 1;

  const P = 64, TW = 1120 - P * 2;
  playerHead(c, d, L, P, 66, 38);

  /* 玩家卡上半部左边是名字、右边是空白（只有装饰圆），把码放这儿不挤占表格。
     ⚠ 放右下角会压住第 4 行 —— 630 的高度装不下"表 + 页脚 + 码"。 */
  await drawQrBadge(c, qrUrlOf(d), 1120 - P - 96, 26, 96,
    { light: '#ffffff', dark: '#0d1117' });

  /* 三个数字：我们的 RKS（大）/ 官方 / 覆盖 */
  const y = 214, h = 146;
  c.fillStyle = CARD; rr(c, P, y, TW, h, 18); c.fill();
  c.strokeStyle = LINE; c.lineWidth = 1; c.stroke();

  text(c, L.pRks, P + 32, y + 38, { size: 18, color: AMBER });
  text(c, fx(d.rks, 2), P + 32, y + 108, { size: 60, weight: 500, color: AMBER });
  text(c, L.pRksNote, P + 32, y + 132, { size: 14, color: FG3 });

  const colW = TW / 3;
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(P + colW, y + 26); c.lineTo(P + colW, y + h - 26); c.stroke();
  c.beginPath(); c.moveTo(P + colW * 2, y + 26); c.lineTo(P + colW * 2, y + h - 26); c.stroke();

  text(c, L.pSiteRks, P + colW + 28, y + 38, { size: 18, color: FG3 });
  text(c, d.siteRks == null ? '—' : fx(d.siteRks, 2), P + colW + 28, y + 108,
    { size: 46, weight: 500, color: FG2 });
  text(c, L.pSiteNote, P + colW + 28, y + 132, { size: 14, color: FG3 });

  text(c, L.pCover, P + colW * 2 + 28, y + 38, { size: 18, color: FG3 });
  text(c, String(d.n || 0), P + colW * 2 + 28, y + 108, { size: 46, weight: 500, color: BLUE });
  text(c, coverNote(d, L), P + colW * 2 + 28, y + 132, { size: 14, color: FG3 });

  /* 表格 */
  const items = (d.items || []).slice(0, 4);
  const hasAcc = items.some(x => x.acc != null);
  /* 列表宽度的分配：准确率列不存在时，把它的宽度让给曲名 */
  const lvW = 84, accW = hasAcc ? 150 : 0, srW = 112;

  /* ⚠ 表头必须用**与 playerRow 完全相同的列偏移**算出来。
     早先手写了一个「+8」的近似值，结果「定数」表头比数据右移了十几像素，
     看起来像两列错位 —— 这种小偏移在大屏上不明显，缩略图里最刺眼。 */
  const colLv = P + TW - accW - srW - lvW;
  text(c, L.pTop, P, 392, { size: 16, color: FG3 });
  text(c, L.pColLv, colLv, 392, { size: 14, color: FG3 });
  if (hasAcc) text(c, L.pColAcc, P + TW - srW - accW, 392, { size: 14, color: FG3 });
  text(c, L.pColSr, P + TW, 392, { size: 14, color: FG3, align: 'right' });

  c.strokeStyle = LINE; c.beginPath(); c.moveTo(P, 402); c.lineTo(P + TW, 402); c.stroke();

  items.forEach((it, i) => {
    playerRow(c, it, L, P, 436 + i * 34, TW, false, hasAcc);
  });

  /* 页脚两行：来源说明 + 域名 / 「为什么不一样」 */
  const f1 = L.pFrom, f2 = L.pWhy;
  text(c, f1, P, 580, { size: 15, color: FG3 });
  text(c, SITE, 1120 - P, 580, { size: 18, weight: 500, color: BLUE, align: 'right' });
  /* ⚠ 第二行必须截断：中文那句有 50 多个字，不截会从右边溢出画布 */
  c.font = '400 14px ' + FONT;
  let why = String(f2 || '');
  while (why && c.measureText(why).width > TW) why = why.slice(0, -1);
  if (why !== String(f2 || '')) why = why.slice(0, -1) + '…';
  text(c, why, P, 606, { size: 14, color: FG3 });
}

/* ── 玩家卡 · 竖屏 1080×1920 ── */
async function drawPlayerTall(c, d, L) {
  const W = 1080, H = 1920;
  c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
  c.globalAlpha = 0.10; c.fillStyle = AMBER;
  c.beginPath(); c.arc(1020, 60, 460, 0, 7); c.fill();
  c.globalAlpha = 1;

  const P = 84;
  playerHead(c, d, L, P, 170, 60);

  await drawQrBadge(c, qrUrlOf(d), W - P - 168, 108, 168,
    { light: '#ffffff', dark: '#0d1117' });

  /* 主数字：P.H.M. RKS，占满一屏宽度 */
  text(c, L.pRks, P, 470, { size: 36, color: FG3 });
  text(c, fx(d.rks, 2), P, 690, { size: 190, weight: 500, color: AMBER });
  text(c, L.pRksNote, P, 740, { size: 26, color: FG3 });

  /* 官方 vs 覆盖：并排两个小块 */
  const by = 800, bh = 180;
  const halfW = (W - P * 2 - 24) / 2;
  [[L.pSiteRks, d.siteRks == null ? '—' : fx(d.siteRks, 2), L.pSiteNote, FG2],
   [L.pCover, String(d.n || 0), L.pCoverNote.replace('{n}', d.phmN || 0), BLUE]].forEach((cell, i) => {
    const x = P + (halfW + 24) * i;
    c.fillStyle = CARD; rr(c, x, by, halfW, bh, 20); c.fill();
    c.strokeStyle = LINE; c.stroke();
    text(c, cell[0], x + 28, by + 48, { size: 24, color: FG3 });
    text(c, cell[1], x + 28, by + 124, { size: 60, weight: 500, color: cell[3] });
    text(c, i === 1 ? coverNote(d, L) : cell[2], x + 28, by + 158, { size: 19, color: FG3 });
  });

  /* Top 10 —— ⚠ 竖版也必须有**列头**：
     只画一堆「16.00  99.20%  15.00」而不说这三列是什么，
     观众得靠猜。横版有列头、竖版没有，是两套版式漂移出来的 bug。 */
  const tx = P, tw = W - P * 2;
  const items = (d.items || []).slice(0, 10);
  const hasAcc = items.some(x => x.acc != null);
  /* 与 playerRow(big=true) 用同一组列宽 */
  const lvW = 96, accW = 170, srW = 130;

  text(c, L.pTop, tx, 1074, { size: 28, color: FG3 });
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(tx, 1102); c.lineTo(tx + tw, 1102); c.stroke();

  text(c, L.pColLv, tx + tw - accW - srW - lvW, 1142, { size: 22, color: FG3 });
  if (hasAcc) text(c, L.pColAcc, tx + tw - srW - accW, 1142, { size: 22, color: FG3 });
  text(c, L.pColSr, tx + tw, 1142, { size: 22, color: FG3, align: 'right' });

  c.strokeStyle = LINE; c.beginPath(); c.moveTo(tx, 1160); c.lineTo(tx + tw, 1160); c.stroke();

  items.forEach((it, i) => {
    playerRow(c, it, L, tx, 1206 + i * 58, tw, true, hasAcc);
  });

  const fy = 1790;
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(tx, fy - 40); c.lineTo(tx + tw, fy - 40); c.stroke();
  text(c, L.pFrom, tx, fy, { size: 21, color: FG3 });
  text(c, L.pWhy, tx, fy + 34, { size: 19, color: FG3 });
  text(c, SITE, tx, fy + 92, { size: 30, weight: 500, color: BLUE });
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
  await (wide ? drawWide : drawTall)(c, data, L);
  return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

function safeName(s) {
  return String(s || 'chart').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

/* ── 玩家成绩卡：渲染成 Blob ── */
export async function renderPlayerCard(data, mode = 'wide', lang = 'zh') {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const L = COPY[lang] || COPY.zh;
  const wide = mode !== 'tall';
  const cv = document.createElement('canvas');
  cv.width = wide ? 1200 : 1080;
  cv.height = wide ? 630 : 1920;
  const c = cv.getContext('2d');
  await (wide ? drawPlayerWide : drawPlayerTall)(c, data, L);
  return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

/* ── 交付：能分享就分享，不能就下载 ──
 * 移动端优先走系统分享面板（可以直接发到 X / 抖音），桌面端退回下载。
 * ⚠ 两种卡片共用这一段 —— 各写一份必然漂移（分享失败时的兜底
 *   特别容易漏掉一边，那边就变成"点了没反应"）。 */
async function deliver(blob, baseName, title, text) {
  if (!blob) throw new Error('图片生成失败');
  const file = new File([blob], baseName, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
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

/* ── 对外主入口：谱面体检卡 ── */
export async function exportCard(data, mode = 'wide', lang = 'zh') {
  const blob = await renderCard(data, mode, lang);
  return deliver(blob, 'PHM-' + safeName(data.name) + '.png',
    'P.H.M. Standard', data.name);
}

/* ── 对外主入口：玩家成绩卡 ── */
export async function exportPlayerCard(data, mode = 'wide', lang = 'zh') {
  const blob = await renderPlayerCard(data, mode, lang);
  return deliver(blob, 'PHM-RKS-' + safeName(data.name) + '.png',
    'P.H.M. RKS', data.name);
}
