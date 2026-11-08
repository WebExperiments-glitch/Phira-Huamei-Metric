/* ============================================================
 * js/xili-dock.js —— 角落看板娘（首页）
 * ============================================================
 * 【为什么要 36 次请求拼一张图】
 *   我们不提供"一个可下载的文件"。图被切成 6×6 块，靠签名逐块取回，
 *   再由 canvas 拼。别人抓单块只有 1/36，抓 36 块拼出来的是**带水印**的图。
 *   这不是防不住截图，是让"随手存图"这件事变得麻烦且留下出处。
 *
 * 【交互克制】
 *   · 只在首页出现，可关闭，关掉后 localStorage 记住
 *   · 不跟随滚动做动画，不主动弹台词（点她才有）
 *   · 窄屏直接不加载（连图都不请求）
 *   · 任何一步失败 → 整块移除，绝不因为装饰影响主功能
 * ============================================================ */

const KEY = 'phm_xili_off';
const LINES = [
  '不演奏，只测量。',
  '15.7。',
  '差 0.9。',
  '……下一张。',
];

export async function mountXiliDock() {
  const box = document.getElementById('xl-dock');
  if (!box) return;
  try { if (localStorage.getItem(KEY) === '1') return; } catch { /* 隐私模式 */ }
  if (window.matchMedia('(max-width: 900px)').matches) return;

  try {
    const r = await fetch('/api/xili/manifest/fullbody', { credentials: 'same-origin' });
    if (!r.ok) return;
    const m = await r.json();

    /* 母版是正方形，人物只占中间一竖条（meta.trim）。
       先拼到离屏画布，再按 trim 裁一次 —— 否则 132px 的框里她只有六十来像素高。 */
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = dpr / 3;
    const off = document.createElement('canvas');
    off.width = Math.round(m.w * k);
    off.height = Math.round(m.h * k);
    const octx = off.getContext('2d');
    const tileW = off.width / m.cols;
    const tileH = off.height / m.rows;

    const jobs = [];
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        const url = `/api/xili/tile/fullbody/${row}-${col}?exp=${m.exp}&sig=${encodeURIComponent(m.sig)}`;
        jobs.push(
          fetch(url, { credentials: 'same-origin' })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
            .then((blob) => createImageBitmap(blob))
            .then((bmp) => { octx.drawImage(bmp, col * tileW, row * tileH, tileW + 1, tileH + 1); })
        );
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
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '汐里 · 定数测量员');

    /* 右键 / 拖拽：降低"另存为"的顺手程度（不是安全边界） */
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.draggable = false;

    const bubble = document.createElement('div');
    bubble.className = 'xld-bubble';
    let i = 0;
    canvas.addEventListener('click', () => {
      bubble.textContent = LINES[i++ % LINES.length];
      bubble.classList.add('on');
      clearTimeout(bubble._t);
      bubble._t = setTimeout(() => bubble.classList.remove('on'), 3200);
    });

    const close = document.createElement('button');
    close.className = 'xld-close';
    close.type = 'button';
    close.setAttribute('aria-label', '隐藏看板娘');
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      box.remove();
      try { localStorage.setItem(KEY, '1'); } catch { /* 忽略 */ }
    });

    box.append(bubble, canvas, close);
    box.hidden = false;
  } catch {
    box.remove();
  }
}
