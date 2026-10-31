/* ============================================================
 * js/render-page.js —— /render 页面逻辑
 * ============================================================
 * 只做三件事：读文件 → 提取几何 → 按时间画。
 *
 * 【为什么先不做音频】
 *   音频要跟 .pez 里的 music.ogg 对齐，而 .pez 是 ZIP（要解压）、
 *   谱面的「第 0 秒」和音频的「第 0 秒」之间还有 offset。
 *   先把画面做对，音频单独一步接 —— 否则两个变量一起调，出问题分不清是谁的。
 *   （现在支持手动拖一个音频文件进来，用它的 currentTime 驱动，先够用。）
 * ============================================================ */

import { extractGeometry, drawFrame } from '/js/chart-geom.js?v=V0.22.5.0';
import { lintChart } from '/js/chart-lint.js?v=V0.22.5.0';
import { renderNav, t, applyStatic, onLangChange } from '/js/ui.js?v=V0.22.5.0';

const $ = (s) => document.querySelector(s);

const state = {
  geom: null,
  playing: false,
  t: 0,               /* 当前播放时刻（秒） */
  t0: 0,              /* 起播时的时间戳 */
  raf: 0,
  audio: null,
};

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 960;
  const h = Math.round(w * 9 / 16);
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function renderFrame() {
  if (!state.geom) return;
  const c = $('#canvas');
  const { ctx, w, h } = fit(c);
  drawFrame(ctx, state.geom, state.t, w, h);
  $('#tt').textContent = state.t.toFixed(2) + ' / ' + state.geom.duration.toFixed(2) + ' s';
  const seek = $('#seek');
  if (seek && document.activeElement !== seek) {
    seek.value = String(Math.round((state.t / Math.max(0.001, state.geom.duration)) * 1000));
  }
}

function loop() {
  if (!state.playing) return;
  if (state.audio && !state.audio.paused) {
    state.t = state.audio.currentTime;
  } else {
    state.t = (performance.now() - state.t0) / 1000;
  }
  if (state.geom && state.t > state.geom.duration + 0.6) {
    /* 循环：方便反复看同一段 */
    state.t = 0;
    state.t0 = performance.now();
    if (state.audio) state.audio.currentTime = 0;
  }
  renderFrame();
  state.raf = requestAnimationFrame(loop);
}

function play() {
  if (!state.geom) return;
  state.playing = true;
  state.t0 = performance.now() - state.t * 1000;
  if (state.audio) { state.audio.currentTime = state.t; state.audio.play().catch(() => {}); }
  $('#play').textContent = t('rnd.pause');
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(loop);
}

function pause() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  if (state.audio) state.audio.pause();
  $('#play').textContent = t('rnd.play');
}

async function loadChartFile(file) {
  const msg = $('#msg');
  try {
    msg.textContent = t('rnd.reading');
    const txt = await file.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      /* ⚠ .pec 是文本格式，不是 JSON。这里明说，不要让它看起来像"文件坏了"。 */
      throw new Error(t('rnd.needJson'));
    }
    state.geom = extractGeometry(j);
    if (!state.geom.notes.length) throw new Error(t('rnd.noNotes'));
    state.t = 0;
    msg.textContent = '';
    $('#info').hidden = false;
    $('#nNotes').textContent = state.geom.notes.length;
    $('#nLines').textContent = state.geom.lines.length;
    $('#nSchema').textContent = state.geom.schema;
    $('#nDur').textContent = state.geom.duration.toFixed(1) + ' s';
    $('#seek').disabled = false;
    $('#play').disabled = false;
    runLint(state.geom);
    renderFrame();
  } catch (e) {
    msg.textContent = String(e.message || e);
    state.geom = null;
    $('#play').disabled = true;
  }
}

/* ── 体检 ──
   五层校验（语法/密度/配置/手序/深度）。深度层要参考 NPS，暂时不传 ——
   **宁可少报，也不要拿错基准去判**。 */
function runLint(geom) {
  const r = lintChart(geom, {});
  $('#lint').hidden = false;
  const g = $('#lintGrade');
  g.textContent = r.grade;
  g.dataset.g = r.grade;
  const n = r.errors.length + r.warnings.length;
  $('#lintNote').textContent = n ? `${r.errors.length} 个错误 · ${r.warnings.length} 个提醒`
    : '没查出问题';

  const st = r.stats;
  $('#lintStats').innerHTML = [
    ['音符', st.notes], ['时长', st.duration + 's'], ['NPS', st.nps],
    ['峰值', st.peakNps], ['后半/前半', st.backHalf], ['和弦', st.chordCount],
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');

  $('#lintIssues').innerHTML = [
    ...r.errors.map(e => `<li class="err">[${e.layer}] ${e.msg}</li>`),
    ...r.warnings.map(w => `<li class="warn">[${w.layer}] ${w.msg}</li>`),
  ].join('') || '<li>—</li>';
}

/* ── 事件 ── */
function wire() {
  const zone = $('#zone');
  const input = $('#file');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { if (input.files[0]) loadChartFile(input.files[0]); });

  for (const ev of ['dragover', 'dragenter']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadChartFile(f);
  });

  $('#play').addEventListener('click', () => (state.playing ? pause() : play()));
  $('#seek').addEventListener('input', (e) => {
    if (!state.geom) return;
    state.t = (Number(e.target.value) / 1000) * state.geom.duration;
    state.t0 = performance.now() - state.t * 1000;
    if (state.audio) state.audio.currentTime = state.t;
    renderFrame();
  });

  /* 可选音频：用它的 currentTime 驱动时间轴 */
  $('#audio').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (state.audio) URL.revokeObjectURL(state.audio.src);
    state.audio = new Audio(URL.createObjectURL(f));
    state.audio.loop = false;
    $('#audioName').textContent = f.name;
  });

  /* ⚠ 这里原本是 paint —— 那是更早版本的函数名，现在叫 renderFrame。
     恢复文件时把旧名带回来了，冒烟立刻报 ReferenceError。 */
  window.addEventListener('resize', renderFrame);
  onLangChange(() => { applyStatic(); renderFrame(); if (!state.playing) $('#play').textContent = t('rnd.play'); });
}

renderNav('render');
applyStatic();
wire();
