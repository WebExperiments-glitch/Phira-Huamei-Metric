/* ============================================================
 * js/write-page.js —— /write 全屏对话式写谱页
 * ============================================================
 * 与 /rulechart 的区别：那边是「表单驱动」，这边是「对话驱动」。
 * 命令面、审批、体检全部复用 agent.js 那一套 —— 这里只做交互。
 *
 * 【三个交互决定】
 *   ① 空态居中大字 + 大输入框，发第一条消息后切成消息流。不让人先学界面。
 *   ② 附件走输入框左侧「＋」：MP3 触发分析（填进 context），图片进多模态消息。
 *   ③ 思考强度是一个**开关 + 档位**，不是藏在设置里 —— 它对写谱质量影响明显，
 *      但默认关闭（省钱、快），需要时才开。
 * ============================================================ */

import { renderNav, applyStatic, onLangChange, t, esc } from './ui.js?v=V0.22.4.0';
import * as S from './settings.js?v=V0.22.4.0';
import { createWriter } from './agent.js?v=V0.22.4.0';
import { analyzeFile, ensurePlayableAudio } from './audio-analysis.js?v=V0.22.4.0';
import { buildPez } from './rulechart.js?v=V0.22.4.0';
import { renderMarkdown } from './markdown.js?v=V0.22.4.0';

const $ = (s) => document.querySelector(s);
const log = $('#log');
const emptyEl = $('#empty');
const q = $('#q');
const sendBtn = $('#send');
const stopBtn = $('#stop');

const state = {
  writer: null,
  busy: false,
  analysis: null,
  audioBytes: null,
  audioName: '',
  audioNote: '',        /* 音频被转换过时的说明，显示在提示行 */
  images: [],          /* [{ name, dataUrl }] */
  thinking: false,
  effort: 'medium',
  urls: [],
};

/* ── 消息渲染 ── */
function addMsg(who, text, atts) {
  /* 空态一有消息就整体退场 —— 它不该一直挂在上面 */
  emptyEl.hidden = true;
  log.hidden = false;
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.innerHTML = '<div class="body"></div>';
  const body = el.querySelector('.body');
  if (text != null) { if (who === 'user') body.textContent = text; else body.innerHTML = renderMarkdown(text); }
  if (atts && atts.length) {
    const a = document.createElement('div');
    a.className = 'bubble-att';
    a.innerHTML = atts.map((x) => `<span class="f">${esc(x)}</span>`).join('');
    body.appendChild(a);
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return body;
}

/* ── 思考块（懒渲染）── */
function makeThink(bodyEl) {
  const d = document.createElement('details');
  d.className = 'think';
  const t0 = Date.now();
  d.innerHTML = '<summary>正在思考…</summary><div class="tx"></div>';
  const sum = d.querySelector('summary');
  const tx = d.querySelector('.tx');
  let buf = '';
  d.addEventListener('toggle', () => { if (d.open) tx.textContent = buf; });
  bodyEl.appendChild(d);
  return {
    push(delta) {
      buf += delta;
      /* 收起时只存不画 —— 思考文本可以几千字，全渲染会拖慢面板 */
      if (d.open) { tx.textContent = buf; log.scrollTop = log.scrollHeight; }
    },
    /* 结束时把「正在思考」换成「已思考（用时 X 秒）」 */
    done() {
      const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
      sum.textContent = buf ? `已思考（用时 ${sec} 秒）` : `已思考（用时 ${sec} 秒）`;
      if (!buf) d.hidden = true;
    },
  };
}

/* AI 回复下方的小动作：复制 / 重试。
   ⚠ 悬停才出现（CSS 控），不抢正文注意力。 */
function addActions(bodyEl, answer, prompt) {
  const row = document.createElement('div');
  row.className = 'acts';
  const copy = document.createElement('button');
  copy.textContent = '复制';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(answer || ''); copy.textContent = '已复制'; }
    catch { copy.textContent = '复制失败'; }
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  });
  row.appendChild(copy);
  if (prompt) {
    const retry = document.createElement('button');
    retry.textContent = '重试';
    retry.addEventListener('click', () => { q.value = prompt; q.focus(); });
    row.appendChild(retry);
  }
  bodyEl.appendChild(row);
}

/* ── 工具条目 ──
   ⚠ 一次写谱会调十几次工具（实测最多的那次 21 步），一步一行竖着排下来，
   正文被挤到屏幕外，用户的原话是「会堆在一起」。
   所以：前 4 步直接显示，之后的收进一个可展开的「还有 N 步」。
   失败的那一步**永远露在外面** —— 出事时不该还要点开才看得到。 */
const STEPS_VISIBLE = 4;

function stepsBox(box) {
  /* 传进来的就是工具条目的容器（submit() 里建的 steps div） */
  if (!box._more) box._more = null;
  return box;
}

function toolLine(bodyEl, name, args) {
  const box = stepsBox(bodyEl);
  const el = document.createElement('div');
  el.className = 'tool';
  el.innerHTML = `<span class="ic">·</span><span class="nm">${esc(name)}</span>`
    + `<span class="dt">${esc(JSON.stringify(args || {}).slice(0, 90))}</span>`;
  box.appendChild(el);
  collapseSteps(bodyEl);
  log.scrollTop = log.scrollHeight;
  return el;
}

function collapseSteps(bodyEl) {
  const box = stepsBox(bodyEl);
  const rows = [...box.querySelectorAll('.tool')];
  const over = rows.length - STEPS_VISIBLE;
  if (over <= 0) return;
  /* 保留：最后 2 步 + 任何失败的步骤 */
  const keep = new Set(rows.slice(-2));
  for (const r of rows) if (r.classList.contains('err')) keep.add(r);
  let hidden = 0;
  for (const r of rows) {
    const hide = !keep.has(r) && hidden < over;
    if (hide) hidden++;
    r.hidden = hide;
  }
  if (!bodyEl._more) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-more';
    b.addEventListener('click', () => {
      const on = b.dataset.on === '1';
      b.dataset.on = on ? '0' : '1';
      for (const r of box.querySelectorAll('.tool')) if (r.dataset.hid === '1') r.hidden = !on ? true : false;
      b.textContent = on ? `还有 ${b.dataset.n} 步` : '收起步骤';
    });
    box.appendChild(b);
    bodyEl._more = b;
  }
  const btn = bodyEl._more;
  let n = 0;
  for (const r of rows) { r.dataset.hid = r.hidden ? '1' : '0'; if (r.hidden) n++; }
  btn.dataset.n = String(n);
  if (btn.dataset.on !== '1') btn.textContent = `还有 ${n} 步`;
}


/* ── 审批：改动之前弹 ── */
function approve({ name, kind, plan }) {
  const p = plan && Object.keys(plan).length ? JSON.stringify(plan, null, 1) : '（无摘要）';
  return Promise.resolve(window.confirm(
    (kind === 'danger' ? '⚠ 危险操作：' : '需要确认：') + name + '\n\n' + p));
}

/* ── 附件 ── */
function renderAttach() {
  const box = $('#attach');
  const items = [];
  if (state.audioName) items.push({ k: 'audio', label: '音频 · ' + state.audioName });
  for (const im of state.images) items.push({ k: 'img', label: '图片 · ' + im.name, idx: im });
  box.hidden = items.length === 0;
  box.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'a';
    el.innerHTML = `${esc(it.label)} <b>×</b>`;
    el.querySelector('b').addEventListener('click', () => {
      if (it.k === 'audio') { state.audioName = ''; state.audioBytes = null; state.analysis = null; }
      else state.images = state.images.filter((x) => x !== it.idx);
      $('#hintAudio').textContent = state.analysis
        ? `音频：${state.audioName} · ${state.analysis.bpm?.toFixed?.(1) ?? state.analysis.bpm} BPM · ${state.analysis.beats?.length ?? 0} 拍点`
        : '还没音频 —— 拖一首 MP3 进来。';
      renderAttach();
    });
    box.appendChild(el);
  }
}

async function pickFiles(files) {
  for (const f of files) {
    if (/^audio\//.test(f.type) || /\.(mp3|ogg|wav|flac|m4a|aac)$/i.test(f.name)) {
      state.audioName = f.name;
      const raw = new Uint8Array(await f.arrayBuffer());
      state.audioBytes = raw;
      /* ⚠ 扩展名不可信：手机录音/微信转存常见「AAC 装成 .mp3」，
         Phira 的 symphonia 解不了，导入时报 unsupported codec。
         这里先按 magic bytes 认容器：mp3/ogg/wav 原样透传（无损），
         其余解码成 PCM WAV（也不再有新的质量损失，只是体积变大）。 */
      state.audioNote = '';
      try {
        const fixed = await ensurePlayableAudio(raw, f.name);
        state.audioBytes = fixed.bytes;
        state.audioName = fixed.name;
        if (fixed.from) {
          state.audioNote = `原文件其实是 ${fixed.from.toUpperCase()}，已转成 WAV（无损）`;
        }
      } catch (e) {
        state.audioNote = '音频格式无法转换：' + String(e.message || e);
      }
      $('#hintAudio').textContent = '分析音频中…';
      try {
        state.analysis = await analyzeFile(f);
        const a = state.analysis;
        const bpm = typeof a.bpm === 'object' ? a.bpm.value : a.bpm;
        /* 网格自评：告诉用户**这一首**能不能信，而不是给一个全局准确率。
           ⚠ 措辞是「节拍对齐」不是「准确率」—— 它衡量网格与音频是否对得上，
             不衡量 BPM 数字对不对（八度写错时两种网格时间点相同）。 */
        const g = a.grid || {};
        const vt = { good: ['节拍对齐良好', 'var(--ok)'],
                     fair: ['节拍对齐一般，建议听一遍确认', 'var(--warn)'],
                     weak: ['节拍对齐较差，BPM 建议手动确认', 'var(--err)'] }[g.verdict]
                  || ['节拍对齐未知', 'var(--fg4)'];
        const pct = g.ok ? Math.round(g.score * 100) : null;
        /* ⚠ 文件名与转码说明都是**外部输入**（用户拖进来的文件、异常消息），
           拼进 innerHTML 前必须转义 —— CodeQL 在 PR #46 上抓到的就是这两处。
           其余部分是数字和我们自己写死的文案，不需要转义。 */
        $('#hintAudio').innerHTML = `音频：${esc(state.audioName)} · <b>${bpm}</b> BPM`
          + (pct == null ? '' : ` · <span style="color:${vt[1]}">${vt[0]}（${pct}%）</span>`)
          + ` · ${(a.beats || []).length} 拍点`
          + (g.devMs == null ? '' : ` · 偏差 ${g.devMs}ms`)
          /* 音频被转换过就**明说**：用户需要知道包里装的不是他那个文件 */
          + (state.audioNote ? ` · <span style="color:var(--warn)">${esc(state.audioNote)}</span>` : '');
      } catch (e) {
        $('#hintAudio').textContent = '音频分析失败：' + String(e.message || e);
        state.analysis = null;
      }
    } else if (/^image\//.test(f.type)) {
      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      state.images.push({ name: f.name, dataUrl });
    }
  }
  renderAttach();
}

/* ── 发送 ── */
async function submit() {
  const text = q.value.trim();
  if (!text && !state.images.length) return;

  /* 忙时插话（不是排队）—— 两个语义不同：插话打断当前轮重新规划 */
  if (state.busy && state.writer) {
    const id = state.writer.steer(text);
    if (id) {
      const body = addMsg('user', text);
      body.dataset.sid = id;
      body.style.opacity = '.7';
      q.value = ''; q.style.height = 'auto';
      return;
    }
  }
  if (state.busy) return;

  if ($('#dot').dataset.ok !== '1') {
    addMsg('bot', 'AI 功能未开启：先在「模型设置」里填 API Key，或在服务端配 `PHM_OPENROUTER_KEY`。');
    return;
  }

  const atts = [];
  if (state.audioName) atts.push('音频 · ' + state.audioName);
  for (const im of state.images) atts.push('图片 · ' + im.name);
  addMsg('user', text, atts);

  state.busy = true;
  sendBtn.disabled = true;
  stopBtn.dataset.on = '1';
  q.value = ''; q.style.height = 'auto';

  const bodyEl = addMsg('bot', '');
  const think = makeThink(bodyEl);
  const content = document.createElement('div');
  /* ⚠ 工具痕迹和正文必须**分两个容器**。
     旧版共用一个 content，每来一个文字增量就 content.innerHTML = renderMarkdown(answer)，
     把前面画的工具条目整片冲掉 —— 用户看到「报告」，却看不到它是怎么一步步生成的，
     出问题时连「哪一步失败」都查不了。 */
  const steps = document.createElement('div');
  const textEl = document.createElement('div');
  content.append(steps, textEl);
  bodyEl.appendChild(content);
  let answer = '';
  let exported = false;   /* 这轮是否已经给过下载链接 */

  /* 图片作为多模态内容：和文字一起塞进第一条 user 消息 */
  const images = state.images.slice();
  state.images = []; renderAttach();

  state.writer = createWriter({
    model: $('#model').value,
    apiKey: S.get(S.KEYS.agentKey, '') || '',
    thinking: state.thinking,
    effort: state.effort,
    approve,
    /* 主路径 + **动画/编排**。
       ⚠ 上一版只发 8 条"主路径"，把 trajectory_generate / event_shake / line_manage
         全藏了 —— 结果模型只能往一条静止的判定线上撒音符，产出就是规则写谱。
         用户的原话：「这 TM 还是规则写谱」。工具面要窄，但**不能窄到把创作手段拿掉**。 */
    only: ['editor_context', 'audio_query', 'chart_query', 'chart_generate', 'chart_patch',
           'trajectory_generate', 'event_shake', 'line_manage',
           'chart_lint', 'difficulty_estimate', 'chart_export', 'ask_user'],
    context: () => {
      const a = state.analysis;
      const bpm = a ? (typeof a.bpm === 'object' ? a.bpm.value : a.bpm) : null;
      const ctx = {
        bpm, bpmAlt: a?.bpmAlt ?? null,
        beats: (a?.beats || []).map((b) => (typeof b === 'object' ? b.time : b)),
        sections: a?.sections || [],
        duration: a?.duration ?? null,
        onsets: (a?.onsets || []).length,
        audioName: state.audioName,
        grid: a?.grid ?? null,
        /* 与「出谱后自动给下载」共用同一份实现 */
        buildPez: async (chart, o) => {
          const built = offerPez(bodyEl, chart, { audio: o?.audio, audioName: o?.audioName });
          if (!built) throw Error('打包失败，原因见消息里的红字');
          exported = true;
          return { pez: built.pez, download: true };
        },
      };
      /* ⚠⚠ 音频字节**绝不能是可枚举属性**。
         这个对象会被 agent-runtime 整个 JSON.stringify 进系统提示，
         一个 5 MB 的 MP3 会变成几十 MB 的 `{"0":255,"1":216,…}` ——
         请求当场被掐断，浏览器只报 `Failed to fetch`。
         （2026-10-25 实测：传音频就崩，不传就正常。）
         命令侧还要读它（chart_export 要音频），所以用不可枚举属性挂上去：
         `st.audio` 取得到，JSON.stringify 看不见。 */
      Object.defineProperty(ctx, 'audio', {
        value: state.audioBytes, enumerable: false, configurable: true,
      });
      return ctx;
    },
    onEvent: (type, d) => {
      if (type === 'reasoning') think.push(d.delta);
      if (type === 'text') { answer += d.delta; textEl.innerHTML = renderMarkdown(answer); log.scrollTop = log.scrollHeight; }
      if (type === 'tool-start') d._el = toolLine(steps, d.name, d.arguments);
      /* ask_user 的结果要在界面上**画成可点的选项**。
         ⚠ 之前只把结果塞回模型，用户根本看不到问题 ——
           模型下一轮说"回上面三个问题"，而上面什么都没有。 */
      if (type === 'tool-end' && d.result && d.result.result && d.result.result.needUser) {
        const q0 = d.result.result;
        const card = document.createElement('div');
        card.style.cssText = 'margin:10px 0;padding:12px 14px;border:1px solid var(--line2);'
          + 'border-radius:12px;background:var(--card)';
        const title = document.createElement('div');
        title.style.cssText = 'font-size:14px;color:var(--fg);margin-bottom:9px';
        title.textContent = q0.question || '需要确认';
        card.appendChild(title);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:7px;flex-wrap:wrap';
        for (const opt of q0.options || []) {
          const b = document.createElement('button');
          b.className = 'tool-pill';
          b.textContent = opt;
          b.addEventListener('click', () => { q.value = opt; q.focus(); });
          row.appendChild(b);
        }
        card.appendChild(row);
        steps.appendChild(card);
      }
      if (type === 'tool-end') {
        const ok = d.result && d.result.ok !== false;
        const el = d._el || toolLine(steps, d.name, {});
        el.className = 'tool ' + (ok ? 'ok' : 'err');
        el.querySelector('.ic').textContent = ok ? '✓' : '✗';
        /* 失败了要把它**顶出来**：折叠规则会保住 .err，但得重算一遍 */
        if (!ok) collapseSteps(steps);
        if (d.result && d.result.error) {
          el.querySelector('.dt').textContent = String(d.result.error).slice(0, 90);
        }
      }
      if (type === 'steering') {
        const target = document.querySelector(`#log .msg.user .body[data-sid="${d.id}"]`);
        if (target) target.style.opacity = '1';
      }
    },
  });

  /* ⚠ 注意别写回 content.innerHTML —— 那会把 steps 里的工具痕迹一起抹掉 */
  const note = (txt, color) => {
    const d = document.createElement('div');
    d.style.cssText = 'font-size:12.5px;color:' + color;
    d.textContent = txt;
    textEl.appendChild(d);
  };

  try {
    const r = await state.writer.run(text || '（见附件）');
    think.done();
    addActions(bodyEl, answer, text);
    /* 出谱了就把下载入口**直接摆出来**。
       ⚠ 不能指望模型调 chart_export —— 实测里它生成了 100 个音符、
         跑了体检、写了报告，然后**忘了给文件**。用户要的是能打的包，
         不是一段描述。这里兜底，与模型是否想起无关。 */
    const c = state.writer.chart;
    const total = (c?.judgeLineList || []).reduce((n, l) => n + (l.notes?.length || 0), 0);
    /* ⚠ 只在这轮**还没导出过**时兜底。模型自己调了 chart_export 时
       已经给过一个链接，再补一个就是两个一模一样的「下载 xxx.pez」，
       用户会以为下的是两个不同的包。 */
    if (total && !exported) offerPez(bodyEl, c);
    if (!r.ok) note(r.error || '失败', 'var(--err)');
    if (r.queued) note('已排队', 'var(--fg3)');
  } catch (e) {
    /* ⚠ `Failed to fetch` 是浏览器最没用的一句报错：它同时表示「服务没起来」
       和「服务中途挂了」。用户看到的只是三个英文单词，完全不知道该干嘛。
       （2026-10-25 真实踩到：本地 server 进程被回收，页面还挂着「已就绪」。） */
    const raw = String(e?.message || e);
    const offline = /failed to fetch|networkerror|load failed/i.test(raw);
    note(offline
      ? '连不上本地服务 —— 服务端进程可能已经退出。在 phm-web 目录下重新跑 `npm start`，然后刷新本页。'
      : raw, 'var(--err)');
    if (offline) { $('#dot').dataset.ok = '0'; $('#stat').textContent = '未开启'; }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    stopBtn.dataset.on = '0';
    state.writer = null;
  }
}

/* ── 绑定 ── */
$('#addBtn').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { pickFiles(e.target.files); e.target.value = ''; });
sendBtn.addEventListener('click', submit);
stopBtn.addEventListener('click', () => { state.writer?.stop(); });

$('#thinkBtn').addEventListener('click', () => {
  state.thinking = !state.thinking;
  $('#thinkBtn').dataset.on = state.thinking ? '1' : '0';
  $('#thinkBtn').textContent = state.thinking ? '思考 开' : '思考';
  /* 关思考时直接藏起来 —— 灰控件会被当成"禁用"而不是"不适用" */
  $('#effort').hidden = !state.thinking;
});
$('#effort').addEventListener('change', (e) => { state.effort = e.target.value; });

$('#cfgBtn').addEventListener('click', () => { const c = $('#cfg'); c.hidden = !c.hidden; });
$('#cfgClose').addEventListener('click', () => { $('#cfg').hidden = true; });
$('#key').value = S.get(S.KEYS.agentKey, '') || '';
$('#keySave').addEventListener('click', () => {
  const ok = S.set(S.KEYS.agentKey, $('#key').value.trim() || null);
  $('#stat').textContent = ok ? '已保存' : '保存失败';
  if (ok) $('#cfg').hidden = true;
});

/* 拖拽：整个页面都能接文件 */
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) pickFiles(e.dataTransfer.files);
});

q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
q.addEventListener('input', () => {
  q.style.height = 'auto';
  q.style.height = Math.min(180, q.scrollHeight) + 'px';
});

/* ── 出谱后给下载入口 ──
   放在消息体里而不是工具栏：工具栏那个是「当前谱面」，出问题的往往是
   上一张留下的状态；每条回复自己的包，才不会下错。
   ⚠ 打包逻辑**只有这一份** —— 命令里的 chart_export 也走它，
     否则两处各写一遍，早晚一个改了另一个没改。 */
function offerPez(bodyEl, chart, o = {}) {
  const audio = o.audio !== undefined ? o.audio : state.audioBytes;
  const audioName = o.audioName || state.audioName || 'audio.wav';
  try {
    const built = buildPez(chart, { audio, audioName });
    const bytes = built?.pez?.length ?? built?.pez?.size ?? 0;
    const url = URL.createObjectURL(new Blob([built.pez], { type: 'application/zip' }));
    state.urls.push(url);
    const id = built.chartJson?.META?.id || 'chart';
    /* ⚠ 给**两个扩展名**，内容一模一样（.pez 本来就是 zip）。
       用户实测：Phira 的本地导入只认 .zip，`.pez` 会直接拒。
       这不是"多给一个方便"—— 给错的扩展名等于没给文件。 */
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center';
    const mk = (name, label) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.className = 'btn2';
      a.textContent = label + (bytes ? '（' + Math.round(bytes / 1024) + ' KB）' : '');
      a.style.cssText = 'border:1px solid var(--brand);border-radius:8px;padding:6px 14px;'
        + 'color:var(--brand);text-decoration:none;font-size:13px';
      return a;
    };
    row.appendChild(mk(id + '.zip', '下载 ' + id + '.zip'));
    row.appendChild(mk(id + '.pez', '.pez'));
    bodyEl.appendChild(row);
    return { pez: built.pez, chartJson: built.chartJson, download: true };
  } catch (e) {
    const d = document.createElement('div');
    d.style.cssText = 'margin-top:8px;font-size:12.5px;color:var(--err)';
    d.textContent = '打包失败：' + String(e.message || e);
    bodyEl.appendChild(d);
    return null;
  }
}

/* ── 启动：先定模型，再探服务端 ──
   ⚠ 顺序不能反。旧版先拿 'deepseek-flash' 硬探活，只配 OpenRouter Key 时
   必然 401 → 状态灯「未开启」，而真正能用的免费模型一个都没试过。 */
async function startWrite() {
  renderNav('write');
  applyStatic();
  onLangChange(() => applyStatic());

  /* 用户自己在设置里填的 Key 要带上去 —— 否则服务端只按自己的环境变量
     判「有没有 provider」，人明明填了 DeepSeek Key，界面还说 DeepSeek 不可用。 */
  const own = S.get(S.KEYS.agentKey, '') || '';
  const keyHeader = own ? { 'x-agent-key': own } : {};

  /* ① 免费模型（OpenRouter）追加到选择器，顺便定默认值 */
  try {
    const r = await fetch('/api/agent/models', { headers: keyHeader });
    if (r.ok) {
      const j = await r.json();
      const list = j.data || [];
      if (list.length) {
        const g = document.createElement('optgroup');
        g.label = '免费（' + list.length + '）';
        for (const m of list) {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.id.replace(':free', '') + ' · ' + Math.round(m.context / 1000) + 'k';
          g.appendChild(o);
        }
        $('#model').appendChild(g);
      }
      /* ⚠ 必须放在 appendChild 之后：给 <select> 赋一个还不存在的 value
         会被**静默忽略**，选择器停在下拉框第一个选项（deepseek-flash）。
         只配了 OpenRouter Key 时那正好是错的 —— 会拿 OR key 请求 DeepSeek，
         报一个跟真因无关的「API Key 无效」。
         选链上第一个可用项而不是 list[0]：第一个不一定能用
         （inkling-small 要单独授权，实测 401）。 */
      const prov = j.providers || {};
      if (prov.openrouter && !prov.deepseek && list.length) {
        const ids = list.map((m) => m.id);
        const pick = (j.chain || []).find((c) => ids.includes(c));
        $('#model').value = pick || ids[0];
      }
    }
  } catch { /* 拉不到就只留 DeepSeek */ }

  /* ② 用**当前选中的**模型探活 —— 探的不是「服务端有没有 Key」，
     而是「这个组合能不能用」，这样状态灯才跟发消息时的结果一致。 */
  let ready = false, msg = '';
  const probe = $('#model').value;
  try {
    const r = await fetch('/api/agent/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', ...keyHeader },
      body: JSON.stringify({ model: probe, messages: [{ role: 'user', content: 'ping' }] }),
    });
    /* ⚠ 不能只判 503。第一版就是这样，于是「Key 与模型不匹配 → 每个请求 401」
       的时候状态灯还是绿的，用户看到「已就绪」却怎么都发不出去。
       401/403 一律算未就绪，并把服务端的原因原样显示。 */
    if (r.status === 503 || r.status === 401 || r.status === 403) {
      const j = await r.json().catch(() => ({}));
      msg = j.message || j.error || ('HTTP ' + r.status);
      if (r.status === 401 || r.status === 403) {
        msg = '鉴权失败：' + msg + '\n\n多半是「Key 与模型不匹配」。'
          + '当前试的是 `' + probe + '` —— 可以在上方换一个模型再试。';
      }
    } else if (!r.ok) {
      msg = '模型服务返回 HTTP ' + r.status;
    } else { ready = true; r.body?.cancel?.(); }
  } catch { msg = '连不上服务端'; }
  $('#dot').dataset.ok = ready ? '1' : '0';
  $('#stat').textContent = ready ? '已就绪' : '未开启';
  /* ⚠ 未就绪时**不要**往消息流里塞一条错误。
     空态是用户对这个页面的第一印象，一句 HTTP 429 把它挤掉，
     人还没说话就先看到失败。原因放到底部提示行，随输入框一起在那儿。 */
  if (!ready) {
    const h = $('#hintState');
    if (h) {
      h.hidden = false;
      h.textContent = msg.split('\n')[0] || '未开启';
      h.style.color = 'var(--err)';
    }
  }
}

startWrite();
