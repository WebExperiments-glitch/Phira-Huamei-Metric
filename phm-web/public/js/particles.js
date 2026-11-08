/* ============================================================
 * js/particles.js —— 琥珀粒子群（Live2D 到位前的替代物）
 * ============================================================
 * 【为什么是粒子】
 *   Live2D 看板娘还在做（见 assets/07-Live2D目标.md）。
 *   在那之前，这里用一团会被人手拨开的琥珀色粒子占住"角色位" ——
 *   交互语义一致：鼠标靠近，它会躲。
 *
 * 【物理模型】借的是粒子文字那套（弹簧回归 + 阻尼 + 鼠标斥力）：
 *   每个粒子有一个缓慢游走的「锚点」home
 *   弹簧   acc += (home - pos) * spring          → 拉回原位
 *   阻尼   vel *= friction                        → 衰减
 *   斥力   dist < R 时 force ∝ (1 - dist/R)        → 鼠标把它弹开
 *   参数取自公开实现的常用档：spring .025 / friction .92 / R 60 / force 4
 *
 * 【性能】
 *   粒子数按面积算（ppm），上限 260；DPR 感知；
 *   页面不可见时暂停（visibilitychange）；prefers-reduced-motion 时只画静态一帧。
 *
 * 【无障碍】纯装饰，canvas 加 aria-hidden；不拦截指针事件（鼠标穿透）。
 * ============================================================ */

const DEFAULTS = {
  count: 0,            /* 0 = 按面积算 */
  ppm: 2600,           /* 每百万像素的粒子数 */
  max: 260,
  spring: 0.025,
  friction: 0.92,
  repelRadius: 62,
  repelForce: 4.2,
  wander: 0.16,        /* 锚点游走幅度（像素/帧） */
  drift: 0.0022,       /* 游走速度 */
  hue: 40,             /* 琥珀色相（HSL 的 H）；S/L 从 --brand 令牌算 */
  sat: 88,
  size: [1.1, 2.4],
  link: 46,            /* 两粒子距离小于此值时连线（0 = 不连） */
  linkAlpha: 0.1,
};

export function mountParticles(canvas, opts = {}) {
  if (!canvas || !canvas.getContext) return null;
  const o = Object.assign({}, DEFAULTS, opts || {});
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;

  const reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0, h = 0, dpr = 1;
  let pts = [];
  let raf = 0, running = false, t = 0;

  const mouse = { x: -1e4, y: -1e4, on: false };

  /* 颜色从 CSS 令牌 --brand 取，亮/暗主题自动跟随。
     ⚠ 不能在 JS 里硬编码色值：设计闸门要求颜色只来自令牌，
       而且写死的琥珀在浅色主题下会糊在浅底上。 */
  let brand = { h: o.hue, s: o.sat, l: 62 };
  function readBrand() {
    try {
      const cs = getComputedStyle(document.documentElement);
      const raw = String(cs.getPropertyValue('--brand') || '').trim();
      const hsl = /hsl\(([^)]+)\)/.exec(raw);
      if (hsl) {
        const p = hsl[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (p.length >= 3) { brand = { h: p[0], s: p[1], l: p[2] }; return; }
      }
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
      if (hex) {
        let h = hex[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const r = parseInt(h.slice(0, 2), 16) / 255,
              g = parseInt(h.slice(2, 4), 16) / 255,
              b = parseInt(h.slice(4, 6), 16) / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let hh = 0; const l = (mx + mn) / 2;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        if (d !== 0) {
          if (mx === r) hh = ((g - b) / d) % 6;
          else if (mx === g) hh = (b - r) / d + 2;
          else hh = (r - g) / d + 4;
          hh *= 60; if (hh < 0) hh += 360;
        }
        brand = { h: Math.round(hh), s: Math.round(s * 100), l: Math.round(l * 100) };
      }
    } catch { /* 取不到就退回默认琥珀 */ }
  }

  function seed(n) {
    pts = [];
    for (let i = 0; i < n; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      pts.push({
        x, y, vx: 0, vy: 0,
        hx: x, hy: y,
        ph: Math.random() * Math.PI * 2,
        sp: 0.4 + Math.random() * 1.2,
        r: o.size[0] + Math.random() * (o.size[1] - o.size[0]),
        a: 0.35 + Math.random() * 0.5,
      });
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = o.count || Math.min(o.max, Math.round((w * h) / 1e6 * o.ppm));
    if (Math.abs(want - pts.length) > 2 || !pts.length) seed(want);
  }

  function step() {
    t += 1;
    /* 锚点缓慢游走：两个不同频率的正弦叠加，避免看出规律 */
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.ph += o.drift * p.sp;
      p.hx += Math.cos(p.ph) * o.wander * p.sp;
      p.hy += Math.sin(p.ph * 0.83) * o.wander * p.sp;
      if (p.hx < -20) p.hx = w + 20; else if (p.hx > w + 20) p.hx = -20;
      if (p.hy < -20) p.hy = h + 20; else if (p.hy > h + 20) p.hy = -20;

      let ax = (p.hx - p.x) * o.spring;
      let ay = (p.hy - p.y) * o.spring;

      if (mouse.on) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        const R = o.repelRadius;
        if (d2 < R * R && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = o.repelForce * (1 - d / R) * (d / R + 0.35);
          ax += (dx / d) * f * 0.6;
          ay += (dy / d) * f * 0.6;
        }
      }
      p.vx = (p.vx + ax) * o.friction;
      p.vy = (p.vy + ay) * o.friction;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const light = brand.l;
    /* 先画连线（同一琥珀色，低透明度） */
    if (o.link > 0) {
      ctx.lineWidth = 0.6;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx * dx + dy * dy > o.link * o.link) continue;
          ctx.strokeStyle = 'hsla(' + brand.h + ',' + brand.s + '%,' + light + '%,' + o.linkAlpha + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      ctx.fillStyle = 'hsla(' + brand.h + ',' + brand.s + '%,' + light + '%,' + p.a + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame() {
    step();
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ── 指针：进入即有斥力，离开后仍保留最后位置（自然回落）── */
  function onMove(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.touches && e.touches[0] ? e.touches[0] : e;
    mouse.x = (p.clientX - rect.left);
    mouse.y = (p.clientY - rect.top);
    mouse.on = true;
  }
  function onLeave() { mouse.on = false; mouse.x = -1e4; mouse.y = -1e4; }

  canvas.addEventListener('pointermove', onMove, { passive: true });
  canvas.addEventListener('pointerdown', onMove, { passive: true });
  canvas.addEventListener('pointerleave', onLeave, { passive: true });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);
  else window.addEventListener('resize', resize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  resize();
  readBrand();
  if (reduce) { step(); draw(); } else start();

  return {
    destroy() {
      stop();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    },
  };
}
