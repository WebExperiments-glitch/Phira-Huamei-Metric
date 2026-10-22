/* ============================================================
 * js/motion.js —— 动效运行时（零依赖，2026-10-21）
 * ============================================================
 * 【它做什么】
 *   1. 给页面上的 .mv / .mv-title / .mv-lift / .mv-magnet 打标与观察
 *   2. 注入滚动进度条 #mvbar（CSS scroll-driven，本文件只管建节点）
 *   3. 数字滚动（[data-count]）
 *   4. 给动态渲染的列表（[data-mv-list]）做交错入场
 *
 * 【它刻意不做什么】
 *   · 不引 GSAP / Lenis / AOS。前端零依赖是这仓库的铁律（package.json
 *     里唯一的生产依赖是 pg，且在服务端）。为了 5 个效果引 45KB 的库，
 *     在"查一个数字就走"的工具站上不划算 —— 而且这 5 个效果
 *     总共不到 200 行。
 *   · 不做 splash / 预加载动画。工具站的礼貌是把人尽快送到搜索框前。
 *   · 不做自定义光标 / WebGL / 粒子。与"测量报告"的气质相悖。
 *
 * 【失效安全（最重要的一节）】
 *   整份代码在下面任一条成立时**一行都不做**，直接 return：
 *     · 用户开了「减弱动效」
 *     · 浏览器没有 IntersectionObserver
 *   此时 <html> 上不会有 .mv-on，css/motion.css 里所有 `opacity:0`
 *   的前提不成立 → 页面照常完全可读。
 *   「动效挂掉」和「内容挂掉」必须是两件事。
 *
 * 【零闪烁】
 *   顺序很关键：**先**把已经在视口内的目标标成 .mv-in，**再**给 <html>
 *   加 .mv-on。反过来的话，加类的同一帧元素会被 CSS 藏起来，
 *   下一帧才由观察器放出来 —— 肉眼看到的就是闪一下。
 *
 * ⚠ 本文件**不 import 任何项目模块**：ES 模块按 URL 去重，一旦带了
 *   ?v= 又和其它页面不一致，就会出现两个实例（这个坑真踩过）。
 *   它自带全部逻辑，只通过 window.PHM_MOTION 对外提供钩子。
 * ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var html = doc.documentElement;

  /* ── 前置条件：不满足就什么都不做 ── */
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (reduced || !('IntersectionObserver' in window)) return;

  /* 元素是否已经在视口内（留一点余量，避免"贴边触发"看起来像没动） */
  var inView = function (el, pad) {
    var r = el.getBoundingClientRect();
    var h = window.innerHeight || 0;
    return r.top < h - (pad || 0) && r.bottom > 0;
  };

  /* 统一的观察器：进视口 → 加 .mv-in → 立刻停止观察（一次性）。
     不做"滚回来再播一遍" —— 重复入场会让长页面变得躁。 */
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (!en.isIntersecting) continue;
      en.target.classList.add('mv-in');
      io.unobserve(en.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });

  /* 把延迟夹到 8 档：再往后用户已经滚过去了，那 0.5s 的等待纯属浪费 */
  var stagger = function (el, i) {
    el.style.setProperty('--mv-i', String(Math.min(i, 8)));
  };

  /* ── 1) 收集目标 ─────────────────────────────────────────── */

  /* 成组入场：容器上标 data-mv-group，它的**直接子元素**依次入场。
     用直接子元素而不是"所有后代"，是因为后代里有无数的行内 span，
     逐个入场会变成"字在跳"。 */
  doc.querySelectorAll('[data-mv-group]').forEach(function (g) {
    var kids = Array.prototype.slice.call(g.children);
    kids.forEach(function (el, i) {
      if (el.hasAttribute('data-mv')) return;   /* 已经由 data-mv 指定形态了 */
      el.classList.add('mv');
      stagger(el, i);
    });
  });

  /* 单个目标：data-mv="up|title|lift|magnet" */
  var MAP = { up: 'mv', title: 'mv-title', lift: 'mv-lift', magnet: 'mv-magnet' };
  doc.querySelectorAll('[data-mv]').forEach(function (el) {
    var cls = MAP[String(el.getAttribute('data-mv') || '').trim()];
    if (cls) el.classList.add(cls);
  });

  /* ── 2) 决定首屏那一批怎么出现（零闪烁的关键） ── */
  /* 这里有个必须想清楚的时间线：
       · module 脚本是 defer 的，通常在**首帧绘制之前**执行 ——
         此时给元素加 .mv-on 把初始态藏起来，用户**从未看见过**它，
         所以不会有"闪一下"。
       · 但如果脚本因为网速/缓存晚了（页面已经画出来了），再加 .mv-on
         就会让已经可见的内容突然消失一下 —— 那是最难看的一种 bug。
     判据：performance.now() < 250ms 认为"还没绘制过"。这是一个保守的
     经验值：本地 5KB 模块几乎必然在 100ms 内跑完；真跑慢了，就
     放弃首屏动画，直接让内容可见 —— 动效永远不该比内容重要。 */
  var canIntro = false;
  try { canIntro = !performance.now || performance.now() < 250; } catch (e) {}

  var targets = doc.querySelectorAll('.mv, .mv-title');
  var above = [], below = [];
  targets.forEach(function (el) {
    (inView(el, (window.innerHeight || 0) * 0.06) ? above : below).push(el);
  });

  /* 已经画过了 / 不能做入场 → 首屏直接到位（不加 .mv-on 之前就加 .mv-in） */
  if (!canIntro) above.forEach(function (el) { el.classList.add('mv-in'); });

  /* 开门：所有初始隐藏态从这里开始生效 */
  html.classList.add('mv-on');

  /* 能做入场 → 门开之后再放行首屏那一批，于是它们会**依次抬起来**。
     ⚠ 必须两跳 rAF：第一跳让浏览器把 opacity:0 / translateY(14px) 认下来，
     第二跳才改成 1 / none —— 同一帧内改两次会被合并成"没有动画"。 */
  if (canIntro && above.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        above.forEach(function (el) { el.classList.add('mv-in'); });
      });
    });
  }

  /* 视口下方那批：本来就看不见，直接交给观察器 */
  below.forEach(function (el) { io.observe(el); });

  /* ── 3) 滚动进度条 ───────────────────────────────────────── */
  (function () {
    if (doc.getElementById('mvbar')) return;
    var bar = doc.createElement('div');
    bar.id = 'mvbar';
    bar.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(bar);
  })();

  /* ── 4) 数字滚动 ─────────────────────────────────────────── */
  /* 解析："15.6" → {v:15.6, dec:1}；"9,508" → {v:9508, dec:0, group:true}；
     "—" / "读取中…" → null（不动它，那是文案不是数字）。 */
  var parseNum = function (raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s\u00A0]/g, '');
    var group = /[,，]/.test(s);
    var m = /^(-?\d+(?:\.\d+)?)/.exec(s.replace(/[,，]/g, ''));
    if (!m) return null;
    var frac = (m[1].split('.')[1] || '');
    return { v: parseFloat(m[1]), dec: frac.length, group: group };
  };
  var mvFmt = function (v, dec, group) {
    var s = v.toFixed(dec);
    if (group) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s;
  };

  var DUR = 900;
  var countEl = function (el) {
    var raw = el.textContent;
    var p = parseNum(raw);
    if (!p) return;
    /* 同一个文本只滚一次：packs 卡片重渲染时会再走一遍这个函数，
       不拦住的话每次翻页整屏数字都在跳。 */
    if (el.dataset.mvCount === raw) return;
    el.dataset.mvCount = raw;
    var t0 = 0;
    /* tabular-nums：滚动过程中位数会变（0 → 9,508），没有等宽数字会左右抖 */
    el.classList.add('num');
    var tick = function (now) {
      if (!t0) t0 = now;
      var k = Math.min(1, (now - t0) / DUR);
      /* easeOutExpo：前 1/3 秒走完大半，剩下的用来"停住" */
      var e = k >= 1 ? 1 : 1 - Math.pow(2, -10 * k);
      if (k >= 1) { el.textContent = String(raw).trim(); return; }
      el.textContent = mvFmt(p.v * e, p.dec, p.group);
      requestAnimationFrame(tick);
    };
    el.textContent = mvFmt(0, p.dec, p.group);
    requestAnimationFrame(tick);
  };

  var countIO = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      countEl(entries[i].target);
      countIO.unobserve(entries[i].target);
    }
  }, { threshold: 0.2 });

  /* [data-count] 是**声明式**的：页面只需要标记"这是个要滚的数"。
     ⚠ 不能用"所有 .num" —— 表格里有几百个数字，那会变成满天飞。 */
  doc.querySelectorAll('[data-count]').forEach(function (el) {
    if (inView(el, 0)) countEl(el); else countIO.observe(el);
  });

  /* ── 5) 动态列表：交错入场 ───────────────────────────────── */
  /* 为什么用 MutationObserver 而不是让每个页面自己调：
     列表渲染逻辑散在 packs.html / app.html 里（两份 render），
     让它们各自记得调一次动效 = 迟早漂移。观察 DOM 变化是**唯一**
     与渲染实现解耦的做法。

     ⚠ 钩子必须挂在**卡片容器**上，不是外面那层 `#list`：
       packs 的结构是 `#list > .grid > 30×.card2`，挂在 #list 上时
       它的唯一子元素是 .grid —— 30 张卡会作为一个整体淡入一次，
       看起来像"整块闪了一下"，而不是交错。
     ⚠ `.grid` 是 innerHTML 塞进来的，本文件初始化时它还不存在，
       所以下面还要有一个"发现新列表"的观察器（见 5b）。 */
  var bindList = function (list) {
    if (!list || list.dataset.mvBound) return;
    list.dataset.mvBound = '1';
    var paint = function () {
      var i = 0;      /* 每批新元素从 0 起算，翻页时第二批不会接着 30 往后排 */
      Array.prototype.slice.call(list.children).forEach(function (c) {
        if (c.dataset.mvSeen) return;
        c.dataset.mvSeen = '1';
        stagger(c, i++);
        if (inView(c, 0)) c.classList.add('mv-in'); else io.observe(c);
      });
    };
    paint();
    try {
      new MutationObserver(paint).observe(list, { childList: true });
    } catch (e) { /* 老浏览器：退化成"一次性入场"，不影响功能 */ }
  };

  doc.querySelectorAll('[data-mv-list]').forEach(bindList);

  /* 5b) 后来才生成的列表容器（packs 的 .grid 是 innerHTML 一次性塞进来的）。
     ⚠ 只监听 body 的 childList，不监听 attributes —— 否则表格每改一个
       类名都会回调一次，在 1000 行数据页上是明显开销。 */
  try {
    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.matches && n.matches('[data-mv-list]')) bindList(n);
          if (n.querySelectorAll) n.querySelectorAll('[data-mv-list]').forEach(bindList);
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (e) {}

  /* ── 6) 磁吸按钮 ─────────────────────────────────────────── */
  /* 只在真有指针的设备上做（触屏的 pointermove 是点击后补发的，
     那会让按钮在按下瞬间跳一下）。 */
  var fine = false;
  try { fine = window.matchMedia('(pointer: fine)').matches; } catch (e) {}
  if (fine) {
    var MAX = 6;    /* 像素。超过 10 就开始像"躲着你"，低于 4 又感觉不到 */
    doc.querySelectorAll('.mv-magnet').forEach(function (btn) {
      var raf = 0, dx = 0, dy = 0;
      var apply = function () {
        raf = 0;
        btn.style.transform = 'translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0)';
      };
      btn.addEventListener('pointermove', function (ev) {
        var r = btn.getBoundingClientRect();
        if (!r.width || !r.height) return;
        dx = ((ev.clientX - (r.left + r.width / 2)) / (r.width / 2)) * MAX;
        dy = ((ev.clientY - (r.top + r.height / 2)) / (r.height / 2)) * MAX;
        btn.classList.add('mv-hot');
        /* 合并到一帧：pointermove 在 120Hz 鼠标上会触发 120 次/秒 */
        if (!raf) raf = requestAnimationFrame(apply);
      });
      var reset = function () {
        btn.classList.remove('mv-hot');
        btn.style.transform = '';
        dx = dy = 0;
      };
      btn.addEventListener('pointerleave', reset);
      btn.addEventListener('pointercancel', reset);
      /* 键盘聚焦时也归位 —— 否则用 Tab 过来按钮还歪着，像坏了 */
      btn.addEventListener('focus', reset);
    });
  }

  /* ── 对外钩子 ────────────────────────────────────────────── */
  /* 页面在**异步渲染完之后**可以主动调：
       PHM_MOTION.reveal(el)   把一个新节点接进观察
       PHM_MOTION.count(el)    立刻滚一个数字
     大多数情况用不上（MutationObserver 已经覆盖了列表），
     留给"结果卡这种一次性插入的大块"用。 */
  window.PHM_MOTION = {
    reveal: function (el) {
      if (!el) return;
      if (inView(el, 0)) el.classList.add('mv-in');
      else io.observe(el);
    },
    count: function (el) { if (el) countEl(el); },
    enabled: true,
  };
})();
