/* ============================================================
 * js/ui.js —— 全站共享的界面工具
 * ============================================================
 * 只放**多页共用**的东西：导航、转义、格式化、共享定数缓存读取、
 * P.H.M. RKS。各页自己的渲染逻辑留在各页里。
 *
 * 与 engine.js 的分工：engine.js 是纯计算（解析谱面→出定数），
 * 这个文件是纯展示（把数字变成字），两者都不碰对方的领域。
 * ============================================================ */

import { PHIRA_API } from './phira.js?v=V0.20.2.0';
import { t, applyStatic, onLangChange, currentLang, setLang } from './i18n.js?v=V0.20.2.0';

export { PHIRA_API, t, applyStatic, onLangChange, currentLang, setLang };

/* ── 版本号：唯一来源是各页 <head> 里的 <meta name="app-version"> ──
   页面版本与引擎版本是**两根轴**：APP_VER 是页面；ENGINE_VER 是算法，
   会作为 engine_build 写进数据库行。 */
export const APP_VER = (document.querySelector('meta[name="app-version"]') || {}).content || '—';

/* ── 导航 ──
   站点结构：
     /        落地页（这是什么、双标度怎么读、入口）
     /app     分析工作台（拖入谱面包 → 定数）
     /charter 谱师页（某个人的全部作品）
     /user    玩家页（成绩 / RKS / 最近游玩）
     /data    数据管理（全库分页浏览，只读）
     /settings 设置（上传偏好 / Phira 连接 / 本机存储）
   全部是**独立页面**而不是一个页面里的面板：面板方案下，链接没法直接
   指向"某人的成绩"，而分享链接恰恰是这个工具最主要的传播方式。 */
const NAV = [
  ['/', 'nav.home', 'home'],
  ['/app', 'nav.app', 'app'],
  ['/rulechart', 'nav.rulechart', 'rulechart'],
  ['/charter', 'nav.charter', 'charter'],
  ['/user', 'nav.user', 'user'],
  ['/data', 'nav.data', 'data'],
  ['/settings', 'nav.settings', 'settings'],
  ['/platform', 'nav.platform', 'platform'],
  /* 下载放最后 —— 它是一次性的动作，不是常来的页面。
     ⚠ 顺序就是**设置之后**，别往中间插：导航顺序是用户的空间记忆，
     挪一个位置会让所有人找错一次。 */
  ['/download', 'nav.download', 'download'],
];

/* 记住当前页 —— 语言一变要能自己重画（导航是 JS 生成的，静态替换覆盖不到） */
let _navActive = null;

/* ── 导航滚动后启用毛玻璃 ──
   用哨兵元素 + IntersectionObserver，而不是监听 scroll 每帧算位置
   （后者在长列表页会明显掉帧）。哨兵贴在文档最顶端，
   它一离开视口就说明页面滚了。 */
let _stickyWired = false;
function wireNavSticky() {
  if (_stickyWired) return;
  const nav = document.getElementById('nav');
  if (!nav) return;
  _stickyWired = true;
  const apply = on => nav.classList.toggle('stuck', on);
  try {
    const s = document.createElement('div');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none';
    document.body.insertBefore(s, document.body.firstChild);
    new IntersectionObserver(es => apply(!es[0].isIntersecting), { threshold: 0 }).observe(s);
  } catch (e) {
    apply(true);   /* 不支持就常驻毛玻璃，总比完全没有底好 */
  }
}

export function renderNav(active) {
  if (active) _navActive = active;
  const el = document.getElementById('nav');
  if (!el) return;
  el.className = 'nav';
  el.innerHTML = '<a class="brand" href="/">P.<b>H</b>.M.</a>'
    + '<div class="links">' + NAV.map(([href, key, act]) =>
      '<a href="' + href + '"' + (act === _navActive ? ' class="on"' : '') + '>' + t(key) + '</a>'
    ).join('') + '</div>'
    + '<div class="spacer"></div>'
    /* GitHub 放顶栏右侧（2026-10-17 评审：站内的仓库入口原来只挂在某些页面的
       底部/中段，同一份链接散在好几处）。放在版本号前面 —— 版本号是**状态**，
       永远在最右，别被链接挤走。 */
    + '<a class="ghlink" href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric"'
    + ' target="_blank" rel="noopener" aria-label="GitHub" title="GitHub · Phira-Huamei-Metric">'
    + '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">'
    + '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>'
    + '</svg></a>'
    /* 版本号带 beta 标记 —— 见 docs/ARCHITECTURE.md「版本策略」：
       beta 期间版本连续增长；等确认没有已知问题后**归零**成 V0.1 并去掉标记。 */
    + '<span class="ver">' + esc(APP_VER) + ' beta</span>';
  wireNavSticky();
}

onLangChange(function () { renderNav(); });

/* ══════════════════════════════════════════════════════════════
 * 格式化
 * ══════════════════════════════════════════════════════════════ */

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 整数千分位。**全站数字一律走这里**，不要各处 toLocaleString / 手写逗号 ——
   评审抓到的「9,508 与 9508 并存」就是这么来的：文案里写了逗号，
   而 JS 渲染的数字是原样插入的。
   ⚠ 只用于**数量**。年份（2026）、UID（257272）、谱面 id、版本号、十六进制色值
     一律不加分隔符 —— 加了反而看不懂。 */
const _nf = new Intl.NumberFormat('zh-CN');
/* 日语检测：假名（平假名 + 片假名）出现即认为是日文标题。
   ⚠ 纯汉字标题判不出来（中日共用汉字），那种保持 zh —— 判错比不判更糟。 */
const KANA_RE = /[぀-ヿ]/;

/** 给页面里渲染出来的「名字」打上 lang="ja"。
 *  背景：页面语言是 zh-Hans，日文标题里的假名会走中文字体的回退，
 *  字重和拉丁字母对不上。标一下 lang，CSS 里的 :lang(ja) 就会换栈。
 *  用法：页面每次 render() 之后调 `markJa(容器)`，别逐处手写 ——
 *  漏一处就会出现"有的曲名正常、有的发虚"。 */
export function markJa(root) {
  const scope = root || document;
  scope.querySelectorAll('h1, h2, h3, .nm, td.nm, .cand .nm').forEach(function (el) {
    const s = el.textContent || '';
    if (KANA_RE.test(s)) el.setAttribute('lang', 'ja');
    else el.removeAttribute('lang');
  });
}

export function fmtInt(v) {
  if (v == null || !isFinite(+v)) return '—';
  return _nf.format(Math.round(+v));
}

export function f1(v) { return v == null || !isFinite(+v) ? '—' : (+v).toFixed(1); }
export function f2(v) { return v == null || !isFinite(+v) ? '—' : (+v).toFixed(2); }
export function pct(v, d) { return v == null || !isFinite(+v) ? '—' : (+v).toFixed(d == null ? 2 : d) + '%'; }

/** 难度标签 → 两三个字母的档位（"IN Lv.15" → "IN"）。
 *  归一失败返回 "?" —— 宁可说不认识，也不猜。 */
export function lvTag(level) {
  const m = /(?<![A-Za-z])(EZ|HD|IN|AT|SP)(?![A-Za-z])/i.exec(String(level || ''));
  return m ? m[1].toUpperCase() : '?';
}
/* 档位配色走令牌 —— 深浅主题下自动切换；写死字面色会让浅色主题里的
   徽标对比度失衡（这几个色是照深底挑的）。
   ⚠ app.html 里还留着一份同样的表（本页不走 ui.js 的模块作用域），改这里要同步那边。 */
export const TIER_COLOR = {
  EZ: 'var(--ok)', HD: 'var(--info)', IN: 'var(--brand)', AT: 'var(--err)', SP: 'var(--purple)',
};
export function tierColor(t) { return TIER_COLOR[t] || 'var(--fg2)'; }

/** unix 秒 或 ISO 串 → 本地日期。
 *  ⚠ 实测 Phira 的 `time` 是 **ISO 字符串**（"2026-08-13T17:59:40.402402Z"），
 *    不是 unix 秒。直接 `new Date(t * 1000)` 会得到 Invalid Date。 */
export function when(t) {
  if (t == null || t === '') return '—';
  const d = (typeof t === 'number' || /^\d+$/.test(String(t)))
    ? new Date(Number(t) * 1000)
    : new Date(t);
  if (isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
  if (days < 0) return ymd;
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return days + ' 天前';
  return ymd;
}


/* ══════════════════════════════════════════════════════════════
 * 「数据缺失」的展示 —— 别只给一个 ? 或 —
 * ══════════════════════════════════════════════════════════════
 * 【为什么值得单独写】
 *   实测反馈：查分页面上满屏的 "?" 和 "—"。对第一次来的人，
 *   一个孤零零的问号读起来是「这网站坏了吧」，而真相是
 *   「Phira 上这一栏本身就是自由文本、这位谱师没按规范写」。
 *   同一个事实，换个说法就能从"像坏了"变成"说明白了"。
 *   所以：**能确定原因的就说原因，不能确定的就说"未标注"，尽量不用符号。 */

/** 档位徽标。识别不出来显示「未标注」而不是 "?"。 */
export function tierBadge(level, opts) {
  const o = opts || {};
  const tg = lvTag(level);
  if (tg === '?') {
    return '<span class="pill" title="' + esc(t('tier.unmarked.tip')) + '"'
      + ' style="font-size:10.5px;padding:0 5px">' + esc(t('tier.unmarked')) + '</span>';
  }
  return '<span class="tier" style="background:' + tierColor(tg) + '">' + tg + '</span>';
}

/** 准度展示。缺失时给出**原因**，不用横杠。 */
export function accCell(v) {
  if (v == null || !isFinite(+v)) {
    return '<span class="dim2" title="' + esc(t('cell.acc.none.tip')) + '">' + esc(t('cell.acc.none')) + '</span>';
  }
  return pct(v, 2);
}

/** 标称定数展示。0 / 空 / 离群都算「没标」。 */
export function constCell(d) {
  const n = +d;
  if (!(n > 0)) {
    return '<span class="dim2" title="' + esc(t('cell.const.none.tip')) + '">' + esc(t('cell.const.none')) + '</span>';
  }
  if (n > 20) {
    return '<span class="dim2" title="' + esc(t('cell.const.odd.tip')) + '">' + f2(n) + '?</span>';
  }
  return f2(n);
}

/* ══════════════════════════════════════════════════════════════
 * 术语表 —— 小白友好
 * ══════════════════════════════════════════════════════════════
 * 反馈里最集中的一条：「官谱标度 / B19 / RKS / p99 这些黑话像天书」。
 * 做法不是把术语删掉（内行需要它们），而是**每个术语第一次出现时能点开看**。
 * 这份表被 /app、/charter、/user 共用，所以放在这里而不是各页复制一份。
 *
 * ⚠ 文案本身在 js/i18n/common.js 的 gloss.* 里（中英并排），这里只留**顺序**
 *   —— 顺序是结构，不是文案；以前把中文字面量写在这里，等于每个术语都
 *   没法翻译。 */
export const GLOSS_KEYS = [
  'consensus', 'official', 'range', 'ps', 'nominal', 'rks', 'b19', 'p99', 'cross',
];

export function glossaryHTML(idPrefix) {
  const pid = idPrefix || 'g';
  void pid;      /* 保留形参：调用方已经传了，改签名会牵动三处调用 */
  return '<details class="gloss"><summary>'
    + esc(t('gloss.summary', { n: GLOSS_KEYS.length })) + '</summary>'
    + '<dl>' + GLOSS_KEYS.map(k =>
        '<dt>' + esc(t('gloss.' + k + '.t')) + '</dt><dd>' + t('gloss.' + k + '.d') + '</dd>').join('')
    + '</dl></details>';
}

/* ══════════════════════════════════════════════════════════════
 * 分页组件 —— 全站共用
 * ══════════════════════════════════════════════════════════════
 * 三处都需要它：数据管理页要翻全库、谱师页要翻全部作品、
 * 单谱成绩要翻全服记录。各写一份必然长成三个样子，所以抽到这里。
 *
 * @param {object} o
 *   o.page / o.pages / o.total / o.pageSize
 *   o.sizes   可选：每页条数选项，给了就渲染选择器
 * 用 wirePager(el, onGo, onSize) 接线。
 */
export function pagerHTML(o) {
  const page = Math.max(1, o.page || 1);
  const pages = Math.max(1, o.pages || 1);
  const total = o.total == null ? null : o.total;
  const size = o.pageSize || 50;
  const from = total == null ? null : (total === 0 ? 0 : (page - 1) * size + 1);
  const to = total == null ? null : Math.min(total, page * size);

  /* 页码窗口：首尾 + 当前±2，中间用 … 省略。
     否则 649 行 / 每页 10 条 = 65 个页码，工具栏直接被撑爆。 */
  const nums = [];
  const push = v => { if (v >= 1 && v <= pages && !nums.includes(v)) nums.push(v); };
  push(1);
  for (let p = page - 2; p <= page + 2; p++) push(p);
  push(pages);
  nums.sort((a, b) => a - b);
  const seq = [];
  let prev = 0;
  for (const v of nums) { if (v - prev > 1) seq.push('…'); seq.push(v); prev = v; }

  const btn = (label, target, dis, title) =>
    '<button class="pg" type="button" data-go="' + target + '"'
    + (dis ? ' disabled' : '') + (title ? ' title="' + title + '"' : '') + '>' + label + '</button>';

  return '<div class="pager">'
    + '<div class="pginfo">'
    + (total == null
        ? t('pg.page', { n: page })
        : t('pg.range', { a: from, b: to, c: total, p: page, q: pages }))
    + '</div>'
    + '<div class="pgbtns">'
    + btn('‹', page - 1, page <= 1, t('pg.prev'))
    + seq.map(v => v === '…'
        ? '<span class="pgecl">…</span>'
        : '<button class="pg' + (v === page ? ' on' : '') + '" type="button" data-go="' + v + '">' + v + '</button>'
      ).join('')
    + btn('›', page + 1, page >= pages, t('pg.next'))
    + '</div>'
    + (o.sizes && o.sizes.length
        ? '<select class="pgsel" id="pgsize">'
          + o.sizes.map(x => '<option value="' + x + '"' + (x === size ? ' selected' : '') + '>'
            + esc(t('pg.per', { n: x })) + '</option>').join('')
          + '</select>'
        : '')
    + '</div>';
}

/** 给 pagerHTML 渲染出来的按钮接线。页面重渲染时旧监听会随元素一起丢掉，无需解绑。 */
export function wirePager(root, onGo, onSize) {
  if (!root) return;
  root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    const v = parseInt(b.getAttribute('data-go'), 10);
    if (v > 0) onGo(v);
  }));
  const sel = root.querySelector('#pgsize');
  if (sel && onSize) sel.addEventListener('change', () => onSize(parseInt(sel.value, 10)));
}

/* ══════════════════════════════════════════════════════════════
 * 共享定数缓存（本站自己的数据，不是 Phira 的）
 * ══════════════════════════════════════════════════════════════ */

const _cache = new Map();          /* chart_id → { ref_const, ref_official, ... } */

/* 服务端 /api/charts?ids= 一次最多吃 **60** 个（见 server.mjs 的 .slice(0,60)）。
   ⚠ 这里必须 ≤ 那个上限 —— 以前这里写的是 200，多出来的 140 个 id
   服务端**不报错、直接丢**，响应里没有它们，于是那些谱永远显示"未算"。 */
const IDS_PER_REQ = 50;

/** 批量读本站定数缓存（只读、便宜、60/分/IP）。返回 Map。
 *
 *  ⚠ 失败时**不要把 id 记成 null**。以前 catch 里给整批 id 写 null，
 *    而 `missing` 的判据是 `!_cache.has(id)` —— 一旦写进 null 就再也不会重试，
 *    一次网络抖动会让这一批谱**在整个会话里**都显示"没有定数"。
 *    现在失败就是不写缓存，下次调用会重新请求。 */
export async function loadChartCache(ids) {
  const want = [...new Set((ids || []).map(Number).filter(n => n > 0))];
  const missing = want.filter(id => !_cache.has(id));
  for (let i = 0; i < missing.length; i += IDS_PER_REQ) {
    const chunk = missing.slice(i, i + IDS_PER_REQ);
    try {
      const r = await fetch('/api/charts?ids=' + chunk.join(','));
      if (!r.ok) continue;                 /* 失败 → 不落缓存，留给下次重试 */
      const j = await r.json();
      const rows = (j && (j.charts || j.rows || j)) || {};
      /* 请求成功时，**库里确实没有**的行才记 null —— 那是真结论，可以缓存 */
      for (const id of chunk) _cache.set(id, rows[id] || null);
    } catch (e) {
      /* 网络/解析失败：什么都不记（下次会重试） */
    }
  }
  const out = new Map();
  for (const id of want) out.set(id, _cache.get(id) || null);
  return out;
}
export function cachedRow(id) { return _cache.get(Number(id)) || null; }

/** 取用于 RKS 的定数：**优先本站算的**（用谱面结构算的，比谱师自报准），
 *  退到 Phira 标称。两者都没有返回 null。 */
export function bestConst(chartId, info) {
  const row = cachedRow(chartId);
  const mine = row && row.ref_const != null ? +row.ref_const : null;
  if (mine != null && mine >= 1 && mine <= 20) return { lv: mine, src: 'phm' };
  const off = info && info.difficulty != null ? +info.difficulty : null;
  if (off != null && off >= 1 && off <= 20) return { lv: off, src: 'phira' };
  return null;
}

/* ══════════════════════════════════════════════════════════════
 * P.H.M. RKS —— Phira 官方 RKS/B19 停更后的替代值
 * ══════════════════════════════════════════════════════════════
 * 公式与 Phigros 官方一致（用老玩家 bestPool 反推验证过：
 * 「内部定数 ÷ 标称定数」比值中位 1.0000）：
 *     单曲 rks = ((acc − 55) / 45)² × 定数      （acc < 70 记 0）
 *     总   rks = (Σ 前 19 条 + φ位) / 20
 *
 * ⚠ 它**不是**官方 RKS 的复现：官方分母固定 20，样本不足时会被压低；
 *   而我们的样本受「只能拿最近 20 条」限制，所以这个值大概率**偏低**。
 *   页面必须如实标注，不要当成"官方值"卖给用户。
 */
export function phmRks(rows) {
  const items = [];
  for (const r of rows || []) {
    const info = r.info || {};
    const lvInfo = bestConst(r.chart, info);
    if (!lvInfo) continue;                       /* 定数缺失/离群（谱师乱填）→ 跳过 */
    const name = info.name || ('谱面 #' + r.chart);
    /* B19 模式：Phira 已经给好单曲 rks，不重算（重算会因为定数被改过而有偏差） */
    if (r.rks != null && r.acc == null && r.accuracy == null) {
      items.push({ lv: lvInfo.lv, acc: null, sr: +r.rks, name, src: lvInfo.src, chart: r.chart });
      continue;
    }
    const acc = accOf(r);
    if (acc == null || acc < 70) continue;
    const k = (acc - 55) / 45;
    items.push({ lv: lvInfo.lv, acc, sr: k * k * lvInfo.lv, name, src: lvInfo.src, chart: r.chart });
  }
  if (!items.length) return null;
  items.sort((a, b) => b.sr - a.sr);
  const top = items.slice(0, 19);
  const phi = items.filter(x => x.acc != null && x.acc >= 100)
    .sort((a, b) => b.lv - a.lv)[0] || null;
  let sum = 0; for (const x of top) sum += x.sr;
  const bonus = phi ? phi.lv : 0;
  const cnt = top.length + (phi && !top.includes(phi) ? 0 : 0);
  return {
    items, top, phi, sum, bonus,
    n: top.length,
    official: (sum + bonus) / 20,          /* 官方 ÷20 口径：样本不足时会偏低 */
    fair: top.length ? (sum + bonus) / (top.length + (phi ? 1 : 0)) : 0,  /* 按实际条数平均 */
    phmN: items.filter(x => x.src === 'phm').length,
    phiraN: items.filter(x => x.src === 'phira').length,
    _cnt: cnt,
  };
}

/** 从一条 record 里取准确率百分比。accuracy 是 0–1 小数（陷阱 9）。 */
export function accOf(r) {
  if (r == null) return null;
  if (r.accuracy != null) {
    const a = +r.accuracy;
    /* 容错：有的端点给 0–1，有的给 0–100 */
    return a <= 1.5 ? a * 100 : a;
  }
  if (r.acc != null) {
    const a = +r.acc;
    return a <= 1.5 ? a * 100 : a;
  }
  return null;
}

/** RKS 说明。以前是一个常量字符串 —— 那样切语言时它不会变，
 *  所以改成**函数**：每次调用现取，语言一变内容就跟着变。 */
export function rksNote() { return t('rks.note'); }

/* ══════════════════════════════════════════════════════════════
 * 例子 / 最近查询的芯片行
 * ══════════════════════════════════════════════════════════════
 * 【为什么要有】
 *   空输入框 + 一句"请输入用户名"等于没给任何信息：用户还是不知道
 *   该填什么格式。给几个**可点的真实值**，第一下点击就出结果。
 *
 * ⚠ 内容有一半来自用户自己的输入历史（最近查询），所以必须逐个 esc()。
 *   这里返回的是 HTML 字符串、由页面 innerHTML 落地 —— 不转义就是 XSS。
 * ⚠ 点击一律走事件委托读 `data-v`，不要拼进 onclick：
 *   用户输入里出现单引号就能把属性打断。
 */
export function chipsHTML(items, label) {
  const list = (items || []).filter(function (x) { return typeof x === 'string' && x; });
  if (!list.length) return '';
  return (label ? '<span class="lbl">' + esc(label) + '</span>' : '')
    + list.map(function (v) {
      return '<button type="button" class="chip" data-v="' + esc(v) + '">' + esc(v) + '</button>';
    }).join('');
}

/** 给一个芯片容器接上委托。点击 → cb(value)。 */
export function wireChips(box, cb) {
  if (!box) return;
  box.addEventListener('click', function (e) {
    const el = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (!el || !box.contains(el)) return;
    const v = el.getAttribute('data-v');
    if (v) cb(v);
  });
}

/** 一行「最近查过 · 试试」芯片，含点击接线。
 *
 *  【为什么抽到 ui.js】
 *    查谱师 / 查玩家两页本来各写了一份 paintChips —— 逻辑一模一样，
 *    差异只有例子数组和点击后干什么。两份实现必然漂移
 *    （屎山考核里「重复函数定义」那条规则就是为这个设的）。
 *
 *  @param {HTMLElement|null} box  容器
 *  @param {object} o
 *          recent      最近查过的值（新的在前）
 *          examples    示例值
 *          labelRecent 「最近查过」的**已翻译**文字
 *          labelEx     「试试」的**已翻译**文字
 *          onPick      (value) => void
 *  @returns {() => void} 重画函数（改完记录 / 切语言时再调一次）
 */
export function chipRow(box, o) {
  const paint = function () {
    if (!box) return;
    const ex = o.examples || [];
    /* 例子和最近查过重复时只留一份 —— 同一句话出现两次会让人以为
       是两个不同的东西。 */
    const hist = (o.recent || []).filter(function (v) { return ex.indexOf(v) < 0; });
    box.innerHTML = chipsHTML(hist, o.labelRecent)
      + (hist.length ? '<span class="lbl" style="margin-left:2px">·</span>' : '')
      + chipsHTML(ex, o.labelEx);
  };
  wireChips(box, function (v) { if (o.onPick) o.onPick(v); });
  paint();
  return paint;
}
