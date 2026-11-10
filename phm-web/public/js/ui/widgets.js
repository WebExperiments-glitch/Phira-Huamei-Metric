/* js/ui/widgets.js —— 渲染组件：徽章、分页、术语、标签组
 *
 * 都是「给数据 → 出 HTML 片段」，不含 IO。
 */

import { esc, lvTag, pct, f2 } from './format.js?v=V0.29.0.5';
import { t } from '../i18n.js?v=V0.29.0.5';
export const TIER_COLOR = {
  EZ: 'var(--ok)', HD: 'var(--info)', IN: 'var(--brand)', AT: 'var(--err)', SP: 'var(--purple)',
};
export function tierColor(t) { return TIER_COLOR[t] || 'var(--fg2)'; }

/** unix 秒 或 ISO 串 → 本地日期。
 *  ⚠ 实测 Phira 的 `time` 是 **ISO 字符串**（"2026-08-13T17:59:40.402402Z"），
 *    不是 unix 秒。直接 `new Date(t * 1000)` 会得到 Invalid Date。 */


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
