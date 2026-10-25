/* 免费模型「会不会真的调工具」实测 —— 不是看文档写的 supported_parameters，
   而是发同一份真实系统提示词 + 真实工具表，看它到底吐不吐 tool_calls。
   用法：node tools/bench-tools.mjs */
import { readFileSync } from 'node:fs';
import { AGENT_PROMPT } from '../public/js/agent-prompt.js';

const KEY = (readFileSync('.env', 'utf8').match(/^PHM_OPENROUTER_KEY=(.*)$/m) || [])[1]?.trim();
if (!KEY) throw new Error('没有 PHM_OPENROUTER_KEY');

const TOOLS = [
  { type: 'function', function: { name: 'chart_generate', description: '执行一段生成脚本，产出整张谱面。脚本里可用 tap(b,x) / hold(b1,b2,x) / drag(b,x) / flick(b,x)，以及 beats、sections、bpm 等只读变量。', parameters: { type: 'object', properties: { script: { type: 'string' }, name: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'chart_lint', description: '检查当前谱面能否玩，返回问题清单。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'editor_context', description: '读取当前编辑器状态、音频分析结果。', parameters: { type: 'object', properties: {} } } },
];

const ASK = '写一段 120 BPM 的简单谱面，大约 20 秒，以八分音符为主，难度别太高。写完告诉我物量。';

const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3.5-lightning:free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
  'liquid/lfm-2.5-2.6b:free',
  'dots-studio/dots-3-note-preview:free',
  'recursive/flint-v1.0:free',
];

async function one(model) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, max_tokens: 3000, tools: TOOLS,
        messages: [{ role: 'system', content: AGENT_PROMPT }, { role: 'user', content: ASK }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return { model, err: (j.error?.message || ('HTTP ' + r.status)).slice(0, 110), ms: Date.now() - t0 };
    const m = j.choices?.[0]?.message || {};
    const calls = m.tool_calls || [];
    return {
      model, ms: Date.now() - t0,
      finish: j.choices?.[0]?.finish_reason,
      n: calls.length,
      names: calls.map((c) => c.function?.name).join(','),
      argOK: calls.length ? calls.every((c) => { try { JSON.parse(c.function.arguments); return true; } catch { return false; } }) : null,
      text: (m.content || '').replace(/\s+/g, ' ').slice(0, 90),
    };
  } catch (e) {
    return { model, err: e.name === 'AbortError' ? '超时 90s' : String(e.message).slice(0, 90), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

const rows = [];
for (const m of CANDIDATES) {
  const r = await one(m);
  rows.push(r);
  console.log(r.err
    ? `✗ ${m}  ${r.err}  (${r.ms}ms)`
    : `${r.n ? '✓' : '·'} ${m}  tools=${r.n} [${r.names}] finish=${r.finish} jsonOK=${r.argOK} ${r.ms}ms\n    "${r.text}"`);
}
console.log('\n--- 能调工具的 ---');
for (const r of rows.filter((x) => x.n > 0)) console.log(` ${r.model}  ${r.n} 个`);
