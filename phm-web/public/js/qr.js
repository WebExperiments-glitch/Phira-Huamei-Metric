/* ============================================================
 * js/qr.js —— 在 canvas 上画二维码（分享卡用）
 * ============================================================
 * 【为什么卡片上要有二维码】
 *   卡片会流向抖音 / 小红书 / B 站动态 —— **那些地方链接点不了**。
 *   原来卡上只有一行 `phm.app.workbuddy.host`，让观众手打这串域名，
 *   转化率基本是零。二维码是唯一能"一眼带走"的路径。
 *
 * 【为什么用 vendor 里的库而不是自己写】
 *   QR 的纠错块表、掩码评分、格式信息 BCH 都是硬规范。手写最容易出的错是
 *   「能生成、看起来也对、但扫不出来」—— 而这种错肉眼发现不了。
 *   uqr 是 MIT、27KB、零依赖，只在**导出卡片**时动态 import。
 *
 * 【两个容易画错的点】
 *   ① **静区（quiet zone）**：QR 规范要求四周留 4 个模块的白边，
 *      不留的话很多扫码器直接认不出来。库给的矩阵**不含**静区。
 *   ② **模块尺寸取整**：cell 取整会让整块变小、边缘对不齐；
 *      直接乘会留缝。这里用「按像素取整的边界」逐格计算，
 *      保证相邻格子严丝合缝（见 drawQr 里的 px/nextPx）。
 * ============================================================ */

let _mod = null;

/** 懒加载编码器。版本串跟页面 meta 走 —— 硬编码版本号会在发版后失配。 */
async function loadEncoder() {
  if (_mod) return _mod;
  const v = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  _mod = await import('/vendor/uqr.mjs' + (v ? '?v=' + encodeURIComponent(v) : ''));
  return _mod;
}

/**
 * 画二维码。
 *
 * @param {CanvasRenderingContext2D} c
 * @param {string} text 要编码的内容（URL）
 * @param {number} x 左上角
 * @param {number} y 左上角
 * @param {number} size 绘制边长（含静区）
 * @param {{dark?:string, light?:string, ecc?:string}} [opt]
 * @returns {Promise<{size:number, modules:number}>}
 */
async function drawQr(c, text, x, y, size, opt) {
  const o = opt || {};
  /* ⚠ 颜色必须由调用方传（lint-slop 不允许在 public/js 里写死色值 ——
     色板是 CSS 令牌的事，写死之后换肤就漏掉这一块）。
     调用方是 sharecard.js，它已经有成对的卡片色常量。 */
  const dark = o.dark, light = o.light;
  if (!dark || !light) throw new Error('drawQr 需要 dark / light 两个颜色');
  const { encode } = await loadEncoder();
  /* ⚠ border: 0 —— 让库不要在矩阵里加自己的静区，静区由我们统一控制。
     否则「库的 1 格 + 我们的 4 格」= 5 格，白白吃掉有限的像素预算。 */
  const { size: n, data } = encode(String(text || ''), { ecc: o.ecc || 'M', border: 0 });

  const quiet = Number.isFinite(o.quiet) ? o.quiet : 2;
  const total = n + quiet * 2;
  /* ⚠⚠ **必须是整数倍**。
     之前用 `size/total` 得到 3.38 这种小数，再逐格 round → 格子宽度在 3 和 4 之间
     交替，看起来正常，但**解码器按均匀网格采样，直接认不出来**。
     实测：132px 的码在 jsQR 下完全解不出；改成整数 scale 后立刻通过。 */
  const scale = Math.max(1, Math.floor(size / total));
  const used = scale * total;
  const ox = x + Math.floor((size - used) / 2);
  const oy = y + Math.floor((size - used) / 2);

  /* 白底铺满整块（含静区）。不做透明 —— 深色卡片上透明底会变成黑底黑码。 */
  c.fillStyle = light;
  c.fillRect(x, y, size, size);

  c.fillStyle = dark;
  for (let r = 0; r < n; r++) {
    const py = oy + (quiet + r) * scale;
    for (let q = 0; q < n; q++) {
      if (!data[r][q]) continue;
      c.fillRect(ox + (quiet + q) * scale, py, scale, scale);
    }
  }
  return { size, modules: n, scale };
}

/** 卡片右下角的固定画法：白底圆角块 + 码 + 可选的一行小字。 */
export async function drawQrBadge(c, text, x, y, size, opt) {
  const o = opt || {};
  c.fillStyle = o.light;
  /* 圆角底板比码本身大一圈，贴在深色卡片上不刺眼 */
  c.beginPath();
  const pad = Math.round(size * 0.09);
  const r = Math.round(size * 0.10);
  const bx = x - pad, by = y - pad, bw = size + pad * 2, bh = size + pad * 2;
  c.moveTo(bx + r, by);
  c.arcTo(bx + bw, by, bx + bw, by + bh, r);
  c.arcTo(bx + bw, by + bh, bx, by + bh, r);
  c.arcTo(bx, by + bh, bx, by, r);
  c.arcTo(bx, by, bx + bw, by, r);
  c.closePath();
  c.fill();
  return drawQr(c, text, x, y, size, o);
}
