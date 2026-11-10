/* js/ui/format.js —— 纯格式化：数字、等级、时间、转义
 *
 * 这是最底层的一块，不 import 任何东西（除了无）。所有 UI 模块都依赖它。
 */

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
