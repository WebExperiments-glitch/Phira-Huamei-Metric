/* 走我们自己的 /api/agent/chat（流式），用与 agent.js 完全相同的解析逻辑，
   看 tool_calls 到底有没有被累加出来。直连 OpenRouter 时它是有的。 */
import { readFileSync } from 'node:fs';
import { AGENT_PROMPT } from '../public/js/agent-prompt.js';

const src = readFileSync('public/js/agent-commands.js', 'utf8');
const re = /defineCommand\('([a-z_]+)',\s*(?:'((?:[^'\\]|\\.)*)'|`([^`]*)`)/g;
const tools = [];
for (let m; (m = re.exec(src));) {
  tools.push({ type: 'function', function: { name: m[1], description: (m[2] ?? m[3] ?? ''), parameters: { type: 'object', properties: {}, additionalProperties: true } } });
}

const base = process.argv[2] || 'http://127.0.0.1:5199';
const model = process.argv[3] || 'poolside/laguna-s-2.1:free';

const r = await fetch(base + '/api/agent/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model, system: AGENT_PROMPT, tools, thinking: false, effort: 'medium',
    messages: [{ role: 'user', content: '写一段 120 BPM 的简单谱面，大约 20 秒，以八分音符为主。写完告诉我物量。' }],
  }),
});
console.log('HTTP', r.status, r.headers.get('content-type'));

const reader = r.body.getReader();
const dec = new TextDecoder();
let buf = '', frames = 0, content = '', finish = '', done = false;
const calls = new Map();
const kinds = {};
for (;;) {
  const { done: end, value } = await reader.read();
  if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { done = true; continue; }
      let j; try { j = JSON.parse(payload); } catch { continue; }
      frames++;
      if (j.error) { console.log('ERROR FRAME', JSON.stringify(j.error).slice(0, 200)); continue; }
      const ch = j.choices && j.choices[0];
      if (!ch) { kinds['no-choice'] = (kinds['no-choice'] || 0) + 1; continue; }
      finish = ch.finish_reason || finish;
      const d = ch.delta || {};
      for (const k of Object.keys(d)) kinds[k] = (kinds[k] || 0) + 1;
      if (d.content) content += d.content;
      for (const part of d.tool_calls || []) {
        const idx = part.index ?? 0;
        let e = calls.get(idx);
        if (!e) { e = { id: '', function: { name: '', arguments: '' } }; calls.set(idx, e); }
        if (part.id) e.id = part.id;
        if (part.function?.name) e.function.name += part.function.name;
        if (part.function?.arguments) e.function.arguments += part.function.arguments;
      }
    }
  }
}
console.log('frames', frames, '| done', done, '| finish', finish);
console.log('delta 键统计', JSON.stringify(kinds));
console.log('content 长度', content.length, '|', JSON.stringify(content.slice(0, 160)));
console.log('tool_calls', calls.size, [...calls.values()].map((c) => c.function.name + '(' + c.function.arguments.length + 'B, id=' + (c.id ? 'y' : 'n') + ')').join(' '));
