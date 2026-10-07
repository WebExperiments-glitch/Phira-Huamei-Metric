/* ============================================================
 * js/ui.js —— 全站共享的界面工具
 * ============================================================
 * 只放**多页共用**的东西：导航、转义、格式化、共享定数缓存读取、
 * P.H.M. RKS。各页自己的渲染逻辑留在各页里。
 *
 * 与 engine.js 的分工：engine.js 是纯计算（解析谱面→出定数），
 * 这个文件是纯展示（把数字变成字），两者都不碰对方的领域。
 * ============================================================ */

import { PHIRA_API } from './phira.js';

export { PHIRA_API };

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
   全部是**独立页面**而不是一个页面里的面板：面板方案下，链接没法直接
   指向"某人的成绩"，而分享链接恰恰是这个工具最主要的传播方式。 */
const NAV = [
  ['/', '首页', 'home'],
  ['/app', '算定数', 'app'],
  ['/charter', '谱师', 'charter'],
  ['/user', '玩家', 'user'],
  ['/data', '数据', 'data'],
];

export function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  el.className = 'nav';
  el.innerHTML = '<a class="brand" href="/">P.<b>H</b>.M.</a>'
    + '<div class="links">' + NAV.map(([href, label, key]) =>
      '<a href="' + href + '"' + (key === active ? ' class="on"' : '') + '>' + label + '</a>'
    ).join('') + '</div>'
    + '<div class="spacer"></div>'
    + '<span class="ver">' + esc(APP_VER) + '</span>';
}

/* ══════════════════════════════════════════════════════════════
 * 格式化
 * ══════════════════════════════════════════════════════════════ */

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
export const TIER_COLOR = {
  EZ: '#4cc38a', HD: '#5aa2e8', IN: '#e8a33d', AT: '#e5534b', SP: '#c98ce8',
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
  const t = lvTag(level);
  if (t === '?') {
    return '<span class="pill" title="Phira 的难度档位是自由文本，这一栏没写成 EZ/HD/IN/AT/SP 的规范形式"'
      + ' style="font-size:10.5px;padding:0 5px">未标注</span>';
  }
  return '<span class="tier" style="background:' + tierColor(t) + '">' + t + '</span>';
}

/** 准度展示。缺失时给出**原因**，不用横杠。 */
export function accCell(v) {
  if (v == null || !isFinite(+v)) {
    return '<span class="dim2" title="Phira 这条记录里没有准确率字段（通常是旧记录）">无记录值</span>';
  }
  return pct(v, 2);
}

/** 标称定数展示。0 / 空 / 离群都算「没标」。 */
export function constCell(d) {
  const n = +d;
  if (!(n > 0)) return '<span class="dim2" title="谱师没有填标称定数（Phira 上这一栏可以为空）">未填</span>';
  if (n > 20) return '<span class="dim2" title="这个值明显超出正常范围，多半是玩梗或填错了">' + f2(n) + '?</span>';
  return f2(n);
}

/* ══════════════════════════════════════════════════════════════
 * 术语表 —— 小白友好
 * ══════════════════════════════════════════════════════════════
 * 反馈里最集中的一条：「官谱标度 / B19 / RKS / p99 这些黑话像天书」。
 * 做法不是把术语删掉（内行需要它们），而是**每个术语第一次出现时能点开看**。
 * 这份表被 /app 与 /user 共用，所以放在这里而不是各页复制一份。 */
export const GLOSSARY = [
  ['社区共识（主结果）',
   '把你这张谱的结构特征，拿去和 <b>Phira 上 9,508 张社区谱</b>里最相近的 20 张比，'
   + '看它们被标成多少定数。这是<b>谱师实际定价的共识</b>，最贴近你在 Phira 里看到的数字。'],
  ['官谱标度',
   '同一套算法，但参照集换成 <b>1,037 张 Phigros 官方谱</b>。'
   + '这是与官方一致的<b>绝对</b>标度。两个标度会差 2~3 级是正常的 —— '
   + '因为社区谱和官谱<b>结构分布本来就不同</b>（社区谱定数中位 15.1，官谱 10.6）。'],
  ['不确定范围',
   '那 20 张参照谱的定数<b>最小值到最大值</b>。'
   + '范围窄 = 参照集里有和你几乎一样的谱，结论硬；范围宽 = 没有紧密对应物，中点只能当粗略参照。'],
  ['PS 负荷',
   '本工具自己的负荷标度（0–20），由密度 / 结构 / 协调 / 持续四组加权合成。'
   + '<b>和上面两个定数不同标度</b>，不要混着比。'],
  ['标称定数',
   'Phira 上谱师自己填的那个难度数字（你在游戏里看到的那个）。'
   + '它是<b>人工填写</b>，不是测量值 —— 实测同曲同物量的相邻难度标注差中位就有 2.80 级。'],
  ['RKS',
   'Phira 的水平分。官方算法是「前 19 首单曲水平 + 1 个满分位，除以 20」。'
   + '⚠️ <b>Phira 服务端的 RKS/B19 计算已经停摆</b>（实测抽样多位活跃玩家，'
   + 'bestPool 最新成绩全停在 2023 ~ 2026-03），所以官方那个数常年不动。'
   + '本站在官方停更后<b>按同一公式自算一个替代值</b>，并标注它是替代值。'],
  ['B19',
   '「Best 19」的简称 —— 官方取你最好的 19 个单曲成绩来算总 RKS。同上，这个链路已经停更。'],
  ['p99 / 加权密度',
   '把谱面按时间切成小段，算出每一秒的「有效物量」，p99 就是<b>只有最难的那 1% 时间能超过</b>的值。'
   + '用来看「最密集的地方有多密」，比平均密度更能反映难度。'],
  ['交叉手',
   '同一只手需要连续跨过另一只手去击打的频率。Phira 里用相邻两键的横向位移来判断。'],
];

export function glossaryHTML(idPrefix) {
  const pid = idPrefix || 'g';
  return '<details class="gloss"><summary>术语看不懂？点开这里（' + GLOSSARY.length + ' 条）</summary>'
    + '<dl>' + GLOSSARY.map(([k, v]) =>
        '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl></details>';
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
        ? '第 <b>' + page + '</b> 页'
        : '第 <b>' + from + '–' + to + '</b> 条 · 共 <b>' + total + '</b> 条 · 第 <b>'
          + page + '</b>/' + pages + ' 页')
    + '</div>'
    + '<div class="pgbtns">'
    + btn('‹', page - 1, page <= 1, '上一页')
    + seq.map(v => v === '…'
        ? '<span class="pgecl">…</span>'
        : '<button class="pg' + (v === page ? ' on' : '') + '" type="button" data-go="' + v + '">' + v + '</button>'
      ).join('')
    + btn('›', page + 1, page >= pages, '下一页')
    + '</div>'
    + (o.sizes && o.sizes.length
        ? '<select class="pgsel" id="pgsize">'
          + o.sizes.map(x => '<option value="' + x + '"' + (x === size ? ' selected' : '') + '>每页 '
            + x + ' 条</option>').join('')
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

/** 批量读本站定数缓存（只读、便宜、60/分/IP）。返回 Map。 */
export async function loadChartCache(ids) {
  const want = [...new Set((ids || []).map(Number).filter(n => n > 0))];
  const missing = want.filter(id => !_cache.has(id));
  if (missing.length) {
    /* 服务端一次最多吃这么多 id，分批避免 URL 过长 */
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      try {
        const r = await fetch('/api/charts?ids=' + chunk.join(','));
        const j = r.ok ? await r.json() : null;
        const rows = (j && (j.charts || j.rows || j)) || {};
        for (const id of chunk) _cache.set(id, rows[id] || null);
      } catch (e) {
        for (const id of chunk) _cache.set(id, null);
      }
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

export const RKS_NOTE = '公式与 Phigros 官方一致（<span class="mono">((acc−55)/45)² × 定数</span>，'
  + '前 19 条 + φ 位 ÷ 20）。<b>它不是官方 RKS 的复现</b>：'
  + '官方 RKS/B19 计算在 Phira 服务端已经停摆（见下方说明），'
  + '而本值只能基于我们拿得到的成绩，因此通常<b>偏低</b>。';
