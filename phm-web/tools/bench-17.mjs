/* 用**真实的 17 个工具定义**跑多轮，复现「工具表太大就哑火」。
   定义直接从 agent-commands.js 源码里抠（名 + 描述），参数表用宽松 schema ——
   这一步只测「模会不会想到去调」，不测参数正确率。
   用法：node tools/bench-17.mjs [模型...] */
import { readFileSync } from 'node:fs';
import { AGENT_PROMPT } from '../public/js/agent-prompt.js';

const KEY = (readFileSync('.env', 'utf8').match(/^PHM_OPENROUTER_KEY=(.*)$/m) || [])[1]?.trim();
const src = readFileSync('public/js/agent-commands.js', 'utf8');

const re = /defineCommand\('([a-z_]+)',\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`)/g;
const TOOLS = [];
for (let m; (m = re.exec(src));) {
  TOOLS.push({
    type: 'function',
    function: {
      name: m[1],
      description: (m[2] ?? m[3] ?? '').replace(/\\'/g, "'").slice(0, 400),
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  });
}
console.log('工具数:', TOOLS.length, '| 总描述字长:', TOOLS.reduce((n, t) => n + t.function.description.length, 0));

const MODELS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['poolside/laguna-s-2.1:free', 'dots-studio/dots-3-note-preview:free', 'cohere/north-mini-code:free', 'recursive/flint-v1.0:free'];
const ASK = '写一段 120 BPM 的简单谱面，大约 20 秒，以八分音符为主，难度别太高。写完告诉我物量。';

async function call(model, messages) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, max_tokens: 4000, tools: TOOLS, tool_choice: 'auto', messages }),
    });
    const j = await r.json();
    if (!r.ok) return { err: (j.error?.message || ('HTTP ' + r.status)).slice(0, 100) };
    const msg = j.choices?.[0]?.message || {};
    return { msg, finish: j.choices?.[0]?.finish_reason };
  } catch (e) { return { err: e.name === 'AbortError' ? '超时' : String(e.message).slice(0, 80) }; }
  finally { clearTimeout(timer); }
}

for (const model of MODELS) {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: AGENT_PROMPT }, { role: 'user', content: ASK }];
  const seq = [];
  let r = await call(model, messages);
  if (r.err) { console.log(`✗ ${model}  ${r.err}`); continue; }
  seq.push(r.msg.tool_calls?.map((c) => c.function.name).join(',') || '(无工具)');
  /* 第二轮：把结果喂回去，看它会不会接着写 */
  if (r.msg.tool_calls?.length) {
    messages.push(r.msg);
    for (const c of r.msg.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: true, result: { bpm: 120, notes: 0, lines: 1 } }) });
    }
    const r2 = await call(model, messages);
    seq.push(r2.err ? 'ERR:' + r2.err : (r2.msg.tool_calls?.map((c) => c.function.name).join(',') || '(无工具)'));
  }
  console.log(`${r.msg.tool_calls?.length ? '✓' : '·'} ${model}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${seq.join(' → ')}`);
}
