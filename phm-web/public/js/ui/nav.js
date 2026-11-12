/* js/ui/nav.js —— 站内导航
 *
 * 18 个页面只需要这个，却被整个 ui.js（533 行）拖着一起下载。
 */

import { esc } from './format.js?v=V0.30.4.0';
import { onLangChange, t } from '../i18n.js?v=V0.30.4.0';
export const APP_VER = (document.querySelector('meta[name="app-version"]') || {}).content || '—';

const NAV = [
  /* 2026-11-07 重排：原来 13 项平铺，用户反馈「有些杂乱」。
     主路径只留「谱面 + 创作」两段，其余收进 /more（按用途分组）。
     ⚠ 每一条都必须实测返回 200 —— smoke 会逐条 fetch 验证。 */
  ['/', 'nav.home', 'home'],
  /* 谱面：查 / 看 / 谁做的 / 谁打的 */
  ['/app', 'nav.app', 'app'],                  /* 拖谱面 → 算定数 */
  ['/packs', 'nav.packs', 'packs'],
  ['/charter', 'nav.charter', 'charter'],
  ['/user', 'nav.user', 'user'],
  /* 创作 */
  ['/write', 'nav.write', 'write'],
  ['/rulechart', 'nav.rulechart', 'rulechart'],
  ['/render', 'nav.render', 'render'],
  /* 其余全部入口 */
  ['/more', 'nav.more', 'more'],
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
  /* 页脚一并渲染 —— 见文件末尾 renderFoot 的注释 */
  try { renderFoot(); } catch (e) { /* 页脚失败不该连累导航 */ }
  if (active) _navActive = active;
  const el = document.getElementById('nav');
  if (!el) return;
  el.className = 'nav';
  el.innerHTML = '<a class="brand" href="/">P.<b>H</b>.M.</a>'
    + '<div class="links">' + NAV.map(([href, key, act]) =>
      '<a href="' + href + '"' + (act === _navActive ? ' class="on"' : '') + '>' + t(key) + '</a>'
    ).join('') + '</div>'
    + '<div class="spacer"></div>'
    /* 全局搜索：站内没有搜索框，用户想找一首歌得先想清楚去 /data 还是 /packs。
       统一跳到 /packs?q= —— 它的过滤覆盖曲名 / 谱师 / 作曲 / 曲绘 / 标签 / 简介，
       是所有入口里召回最全的一个。 */
    + '<button class="navq" id="navq" type="button" aria-label="' + esc(t('nav.search'))
    + '" title="' + esc(t('nav.search')) + '">'
    + '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"'
    + ' stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
    + '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14"/></svg></button>'
    + '<input class="navqi" id="navqi" type="search" autocomplete="off" hidden'
    + ' placeholder="' + esc(t('nav.search.ph')) + '" aria-label="' + esc(t('nav.search')) + '">'
    /* GitHub 放顶栏右侧（2026-10-17 评审：站内的仓库入口原来只挂在某些页面的
       底部/中段，同一份链接散在好几处）。放在版本号前面 —— 版本号是**状态**，
       永远在最右，别被链接挤走。 */
    /* 登录入口放 GitHub 之前：它是**站内的主功能入口**，
       GitHub 是外链，重要度低一档。 */
    + '<a class="navlogin" href="/login">' + esc(t('c.login')) + '</a>'
    + '<a class="ghlink" href="https://github.com/WebExperiments-glitch/Phira-Huamei-Metric"'
    + ' target="_blank" rel="noopener" aria-label="GitHub" title="GitHub · Phira-Huamei-Metric">'
    + '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">'
    + '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>'
    + '</svg></a>'
    /* 版本号带 beta 标记 —— 见 docs/ARCHITECTURE.md「版本策略」：
       beta 期间版本连续增长；等确认没有已知问题后**归零**成 V0.1 并去掉标记。 */
    + '<span class="ver">' + esc(APP_VER) + ' beta</span>';
  wireNavSticky();
  wireNavSearch();
}

/* 搜索框：点图标展开，回车跳 /packs?q=，Esc 收回。
   ⚠ 每次 renderNav 都会重画 innerHTML，所以这里每次都重新取节点绑定；
      节点是新的，不会重复绑定。 */
function wireNavSearch() {
  const btn = document.getElementById('navq');
  const inp = document.getElementById('navqi');
  if (!btn || !inp) return;
  const open = on => {
    inp.hidden = !on;
    btn.classList.toggle('on', on);
    if (on) inp.focus();
  };
  btn.addEventListener('click', () => open(inp.hidden));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; open(false); return; }
    if (e.key !== 'Enter') return;
    const q = String(inp.value || '').trim();
    if (!q) return;
    /* ⚠ 纯数字不做特殊分流：看起来像 UID 的也可能是谱面 ID，
       猜错比不猜更糟。统一交给 /packs 的文本过滤（它也匹配 id 之外的字段）。 */
    location.href = '/packs?q=' + encodeURIComponent(q.slice(0, 60));
  });
  inp.addEventListener('blur', () => { if (!inp.value) open(false); });
}

onLangChange(function () { renderNav(); });

/* ══════════════════════════════════════════════════════════════
 * 格式化
 * ══════════════════════════════════════════════════════════════ */

/* ── 页脚 ──────────────────────────────────────────────────────
 * 26 个页面的 #foot 都是空标签 → 全站没有隐私政策入口（合规要求"显著位置"）。
 * 挂在 renderNav 里：它已被 18 个页面调用，等于零改 HTML 就补上入口。
 * 找不到 #foot 就自己建一个 —— index/app 两页连那个标签都没有。 */
export function renderFoot() {
  /* ⚠ 不是所有页面都有 <footer id="foot">：index.html 与 app.html 就没有。
     所以找不到就**自己建一个**插到 body 末尾 —— 否则首页永远看不到隐私入口，
     而那恰恰是访客最可能落地的地方。 */
  let el = document.getElementById('foot');
  if (!el) {
    el = document.createElement('footer');
    el.id = 'foot';
    el.style.cssText = 'max-width:var(--wrap,1100px);margin:0 auto;padding:0 16px';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div class="foot-links">'
    + '<a href="/privacy">' + esc(t('foot.privacy')) + '</a>'
    + '<span class="foot-sep">·</span>'
    + '<a href="/privacy#collect">' + esc(t('foot.collect')) + '</a>'
    + '<span class="foot-sep">·</span>'
    + '<a href="/terms">' + esc(t('foot.terms')) + '</a>'
    + '<span class="foot-sep">·</span>'
    + '<a href="/status">' + esc(t('foot.status')) + '</a>'
    + '</div>'
    + '<div class="foot-meta">' + esc(t('foot.meta')) + ' · ' + esc(APP_VER) + '</div>';
}
