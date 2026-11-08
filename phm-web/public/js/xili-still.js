/* ============================================================
 * js/xili-still.js —— 静态位（不走拖拽）的汐里，用于 404 / 空状态
 * ============================================================
 * 和角落看板娘用的是同一套投递：manifest 要同源 → 5 分钟签名 → 逐块取 → canvas 拼。
 * 区别只有两点：尺寸固定、没有交互。
 *
 * 为什么 404 也走这套而不是放一张 <img>：
 *   放 <img src="/img/xxx.webp"> 等于把成品图挂在公开路径上，
 *   右键就能存。而 404 是最容易被"路过"的页面，不该是泄露口。
 *
 * 失败策略：任何一步出错就把容器清空 —— 404 页少一张插画不影响任何功能。
 * ============================================================ */

export async function mountXiliStill(el, key, px) {
  const box = typeof el === 'string' ? document.getElementById(el) : el;
  if (!box) return;
  try {
    const r = await fetch(`/api/xili/manifest/${key}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const m = await r.json();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = dpr / 2;
    const off = document.createElement('canvas');
    off.width = Math.round(m.w * k);
    off.height = Math.round(m.h * k);
    const octx = off.getContext('2d');
    const tw = off.width / m.cols;
    const th = off.height / m.rows;

    const jobs = [];
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        const url = `/api/xili/tile/${key}/${row}-${col}?exp=${m.exp}&sig=${encodeURIComponent(m.sig)}`;
        jobs.push(fetch(url, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
          .then((blob) => createImageBitmap(blob))
          .then((bmp) => { octx.drawImage(bmp, col * tw, row * th, tw + 1, th + 1); }));
      }
    }
    await Promise.all(jobs);

    const [tx, ty, tcw, tch] = m.trim || [0, 0, m.w, m.h];
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(tcw * k);
    canvas.height = Math.round(tch * k);
    canvas.getContext('2d').drawImage(
      off, Math.round(tx * k), Math.round(ty * k), canvas.width, canvas.height,
      0, 0, canvas.width, canvas.height,
    );
    canvas.style.width = px + 'px';
    canvas.style.height = 'auto';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '汐里 · 定数测量员');
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.draggable = false;

    box.replaceChildren(canvas);
  } catch {
    box.replaceChildren();
  }
}
