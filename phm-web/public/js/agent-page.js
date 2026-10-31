/* ============================================================
 * js/agent-page.js —— /agent 页面的交互层
 * ============================================================
 * 只做三件事：把消息画出来、把审批弹出来、把用户的话送进去。
 * 业务逻辑全在 agent.js / agent-runtime.js / agent-commands.js 里，
 * 这一层**不该有**任何关于谱面的判断 —— 否则以后换界面要重写一遍。
 * ============================================================ */

import { renderNav, applyStatic, onLangChange, t, esc } from './ui.js?v=V0.22.5.0';
import { createWriter } from './agent.js?v=V0.22.5.0';

const $ = (s) => document.querySelector(s);
const log = $('#log');
const q = $('#q');
const sendBtn = $('#send');
const statEl = $('#stat');

let writer = null;
let busy = false;

function bubble(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  if (text != null) el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/* 极简 markdown：只处理代码块与行内代码，其余一律 textContent。
   不做完整解析 —— 那需要几百行且必然带 XSS 面。宁可少渲染。 */
function render(el, text) {
  const parts = String(text).split(/```/);
  let html = '';
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      html += `<pre>${esc(nl >= 0 ? p.slice(nl + 1) : p)}</pre>`;
    } else {
      html += esc(p).replace(/`([^`]+)`/g, '<code>$1</code>');
    }
  });
  el.innerHTML = html;
  log.scrollTop = log.scrollHeight;
}

/* ── 审批卡片 ──
   ⚠ 改动之前就把「要改什么」摊开，而不是改完再让人确认。
      所以 approve() 是一个挂起的 Promise，用户点完才继续。 */
function askApproval({ name, kind, plan }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'msg gate';
    el.innerHTML = `<div class="t">${t(kind === 'danger' ? 'ag.danger' : 'ag.approve')}：${esc(name)}</div>
      <div class="p">${esc(JSON.stringify(plan ?? {}, null, 1))}</div>
      <div class="b"><button class="yes">${t('ag.yes')}</button><button class="no">${t('ag.no')}</button></div>`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    const done = (ok) => {
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      el.classList.add(ok ? 'ok' : 'no');
      resolve(ok);
    };
    el.querySelector('.yes').addEventListener('click', () => done(true));
    el.querySelector('.no').addEventListener('click', () => done(false));
  });
}

function onEvent(type, d) {
  if (type === 'assistant-end' && d.text) {
    const el = bubble('bot');
    render(el, d.text);
  }
  if (type === 'tool-start') {
    const el = bubble('bot');
    el.innerHTML = `<span class="tool">→ ${esc(d.name)}</span>`;
  }
  if (type === 'tool-end') {
    const ok = d.result && d.result.ok !== false;
    const last = log.lastElementChild;
    if (last && last.className === 'msg bot' && last.querySelector('.tool')) {
      last.innerHTML += `<span class="tool"> ${ok ? '✓' : '✗'}${
        d.result && d.result.error ? ' ' + esc(String(d.result.error).slice(0, 120)) : ''}</span>`;
    }
  }
  if (type === 'error') {
    const el = bubble('bot err');
    el.textContent = d.message;
  }
  if (type === 'turn-end') {
    const s = d.stats || {};
    statEl.textContent = `${s.rounds ?? 0} 轮 · ${s.tools ?? 0} 次工具 · ${
      ((s.promptTokens ?? 0) + (s.completionTokens ?? 0))} tokens`;
  }
}

async function submitPrompt() {
  const text = q.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  q.value = ''; q.style.height = 'auto';
  bubble('user', text);
  try {
    const r = await writer.run(text);
    if (!r.ok) {
      const el = bubble('bot err');
      el.textContent = r.error || '任务失败';
    }
  } catch (e) {
    const el = bubble('bot err');
    el.textContent = String(e.message || e);
  } finally {
    busy = false; sendBtn.disabled = false;
    q.focus();
  }
}

async function startPage() {
  renderNav('agent');
  applyStatic();
  onLangChange(() => applyStatic());

  /* 先探服务端有没有配 Key —— 没配就别让人白打字 */
  let ready = false, msg = '';
  try {
    const r = await fetch('/api/agent/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (r.status === 503) {
      const j = await r.json().catch(() => ({}));
      msg = j.message || t('ag.notReady');
    } else { ready = true; r.body?.cancel?.(); }
  } catch { msg = '连不上服务端'; }

  statEl.dataset.ok = ready ? '1' : '0';
  statEl.textContent = ready ? `${t('ag.ready')} · deepseek-flash` : t('ag.off');
  if (!ready) {
    const el = bubble('bot err');
    el.textContent = msg + '\n\n配好之后刷新本页即可。';
    sendBtn.disabled = true;
    return;
  }

  writer = createWriter({
    model: 'deepseek-flash',
    approve: askApproval,
    onEvent,
    context: () => ({
      /* 生成脚本里能拿到的只读变量。没有音频分析时给空数组，
         让模型知道"现在没有拍点可依"，而不是让它编。 */
      bpm: null,
      beats: [],
      sections: [],
      note: '尚未上传音频；beats/sections 为空。请先向用户确认 BPM 或要求上传音频。',
    }),
  });

  /* 生成结果同步到页面上的谱面状态，供 chart_lint / difficulty_estimate 读 */
  bubble('bot', t('ag.lead'));
}

sendBtn.addEventListener('click', submitPrompt);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
});
q.addEventListener('input', () => {
  q.style.height = 'auto';
  q.style.height = Math.min(150, q.scrollHeight) + 'px';
});
document.querySelectorAll('.tools button').forEach((b) => {
  b.addEventListener('click', () => { q.value = b.dataset.p; q.focus(); });
});

startPage();
