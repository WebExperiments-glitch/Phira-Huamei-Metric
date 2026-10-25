/* ============================================================
 * js/agent.js —— 写谱 Agent 的装配点
 * ============================================================
 * 【为什么单独一个文件】
 *   提示词 / 命令注册表 / 主循环三件是**可测的零件**，各自纯逻辑；
 *   这里负责把它们和一个真实的模型服务接起来。
 *   页面只 import 这一个文件，不关心内部拼装。
 *
 * 【为什么模型调用走自己的 /api 代理，而不是浏览器直连 DeepSeek】
 *   Key 必须留在服务端。浏览器直连等于把 Key 交给每个访客
 *   （DevTools 里一眼就能看到）。这与 llm-hub 的设计同一条原则。
 *
 * 【为什么 complete() 自己解析 SSE】
 *   服务端是**透传**上游 SSE，不在中间解析再重组 ——
 *   解析一遍再序列化会丢掉 `usage`、`reasoning_content` 和增量结构。
 * ============================================================ */

import { AGENT_PROMPT } from './agent-prompt.js?v=V0.22.4.0';
import { createCommands, emptyChart } from './agent-commands.js?v=V0.22.4.0';
import { ChartAgent } from './agent-runtime.js?v=V0.22.4.0';

/**
 * 创建一套「写谱工作台」：一份谱面状态 + 一套命令 + 一个 agent。
 *
 * @param {object} o
 *   o.model      模型 id，如 'deepseek/deepseek-v4-pro'
 *   o.approve    审批回调 ({name, kind, plan}) => Promise<boolean>
 *   o.context    返回宿主状态（bpm/beats/sections/energy…），生成命令要用
 *   o.onEvent    事件回调，页面拿它渲染进度
 */
export function createWriter({ model = 'deepseek-flash', apiKey = '', thinking = false, effort = 'medium', approve, context = () => ({}), onEvent, only = null } = {}) {
  let chart = emptyChart({});
  const state = { model, busy: false };

  const commands = createCommands({
    approve: approve ?? (async () => true),
    getChart: () => chart,
    setChart: (c) => { chart = c; },
    getState: context,
  });

  /* 工具面收窄 —— /write 只发主路径。
     ⚠ 依据是实测（tools/bench-17.mjs + 页面复跑，2026-10-25）：
       17 个工具全发时，弱模型会挑 chart_read / chart_templates 而**跳过 chart_generate**，
       任务原地打转；只发 3 个时它 2.1 秒就把 editor_context 调了。
       命令本身不删，只是不告诉模型 —— 提示词里点名要用的照旧能调。 */
  if (Array.isArray(only) && only.length) {
    const keep = new Set(only);
    commands.tools = () => [...keep]
      .filter((n) => commands.entries.has(n))
      .map((n) => {
        const c = commands.entries.get(n);
        return { type: 'function', function: { name: c.name, description: c.description, parameters: c.parameters } };
      });
  }

  /** 调服务端代理，解析 SSE 增量，拼成 {content, tool_calls} */
  async function complete({ system, messages, tools, signal, onText, onReasoning }) {
    const r = await fetch('/api/agent/chat', {
      method: 'POST',
      /* 用户自带的 Key 走这个头，服务端只做转发、不落盘。
         没有就留空，服务端回落它自己的环境变量。 */
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-agent-key': apiKey } : {}) },
      body: JSON.stringify({ model, system, messages, tools, thinking, effort }),
      signal,
    });
    /* ⚠ 错误可能藏在 200 响应体里（OpenRouter 的坑）。
       所以先看 content-type 是不是 SSE，不是就按错误处理。 */
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('event-stream')) {
      const j = await r.json().catch(() => ({}));
      throw Error((j.error && j.error.message) || `模型服务 HTTP ${r.status}`);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', finish = '', done = false, usage = null;
    const calls = new Map();

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
          let j;
          try { j = JSON.parse(payload); } catch { continue; }
          if (j.error) throw Error(j.error.message || '模型返回错误');
          if (j.usage) usage = j.usage;
          const ch = j.choices && j.choices[0];
          if (!ch) continue;
          finish = ch.finish_reason || finish;
          const d = ch.delta || {};
          if (d.content) { content += d.content; onText?.(d.content); }
          if (d.reasoning_content) { reasoning += d.reasoning_content; onReasoning?.(d.reasoning_content); }
          for (const part of d.tool_calls || []) {
            const idx = part.index ?? 0;
            let e = calls.get(idx);
            if (!e) { e = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(idx, e); }
            if (part.id) e.id = part.id;
            if (part.function?.name) e.function.name += part.function.name;
            if (part.function?.arguments) e.function.arguments += part.function.arguments;
          }
        }
      }
    }

    /* 两个硬检查 —— 少了任何一个，截断的响应都会被当成成功，
       于是写出一张**不完整的谱面而且没人知道**。 */
    if (!done || !finish) throw Error('模型响应中断；本轮未执行新命令，可重试');
    if (finish === 'length') throw Error('模型输出达到长度上限；请缩小任务或提高上限后重试');

    const toolCalls = [...calls.values()];
    if (toolCalls.some(c => !c.id || !c.function.name)) throw Error('模型工具调用不完整');
    return {
      role: 'assistant',
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      usage,
    };
  }

  const agent = new ChartAgent({
    commands,
    complete,
    prompt: () => AGENT_PROMPT,
    context,
    config: () => ({ model, apiKey: '' }),
  });

  if (onEvent) {
    for (const t of ['round', 'text', 'reasoning', 'tool-start', 'tool-end', 'assistant-end', 'error', 'turn-end']) {
      agent.addEventListener(t, (e) => onEvent(t, e.detail));
    }
  }

  return {
    agent,
    commands,
    get chart() { return chart; },
    set chart(c) { chart = c; },
    run: (text) => agent.run(text),
    steer: (text) => agent.steer(text),
    stop: () => agent.stop(),
  };
}
