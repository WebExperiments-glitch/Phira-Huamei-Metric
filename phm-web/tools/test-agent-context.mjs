#!/usr/bin/env node
/* ============================================================
 * tools/test-agent-context.mjs —— 宿主状态序列化回归测试
 * ============================================================
 * 守的是 2026-10-25 那次真事故：`/write` 一上传 MP3 就崩，
 * 浏览器只报 `Failed to fetch`。
 * 根因：`context()` 里挂了 `audio: state.audioBytes`（整首 MP3 的 Uint8Array），
 * agent-runtime 把它 JSON.stringify 进系统提示 → 几十 MB 的
 * `{"0":255,"1":216,…}` → 请求被掐断。
 *
 * 这里不去测 UI，直接测**发给模型的那段 system 文本**：
 *   · 二进制必须是占位符，不是数字数组
 *   · 整段长度必须跟二进制大小无关（放 8 MB 进去也一样短）
 *   · 循环引用不能把序列化搞崩
 * ============================================================ */
import { ChartAgent } from '../public/js/agent-runtime.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

/* 最小 commands 桩：ChartAgent 只用到 tools() / execute() */
const commands = {
  tools: () => [],
  execute: async () => ({ ok: true, result: {} }),
  entries: new Map(),
};

async function systemPromptWith(context, { rounds = 1 } = {}) {
  const seen = [];
  const agent = new ChartAgent({
    commands,
    context,
    prompt: () => 'SYSTEM-PROMPT',
    config: () => ({ model: 'stub' }),
    complete: async ({ system }) => {
      seen.push(system);
      return rounds-- > 0
        ? { role: 'assistant', content: 'ok' }
        : { role: 'assistant', content: 'done' };
    },
  });
  await agent.run('hi');
  return seen[0] || '';
}

/* 1. 二进制必须被剥掉 */
{
  const bytes = new Uint8Array(8 * 1024 * 1024);   /* 8 MB，模拟一首 MP3 */
  bytes[0] = 0xFF; bytes[1] = 0xD8;
  const sys = await systemPromptWith(() => ({ bpm: 145, audioName: '狐属性.mp3', audio: bytes }));
  ok('系统提示里没有裸数字数组', !/"0":\s*255/.test(sys));
  ok('系统提示里有占位符', /\[binary 8388608 bytes/.test(sys), sys.slice(-160));
  /* 这条是关键：提示长度不能随音频大小变化 */
  ok('整段长度 < 2 KB（8 MB 音频也不许膨胀）', sys.length < 2048, sys.length + ' 字符');
}

/* 2. 小对象照旧可读 */
{
  const sys = await systemPromptWith(() => ({ bpm: 145, beats: [0, 0.5, 1], audioName: 'a.mp3' }));
  ok('普通字段原样保留', /"bpm":145/.test(sys) && /"audioName":"a\.mp3"/.test(sys));
}

/* 3. 函数不能被序列化成源码 */
{
  const sys = await systemPromptWith(() => ({ buildPez: () => 1, n: 1 }));
  ok('函数变成占位符', /\[function\]/.test(sys) && !/buildPez.*=>/.test(sys));
}

/* 4. 循环引用不许把整个请求搞崩 */
{
  const a = { name: 'a' };
  a.self = a;
  const sys = await systemPromptWith(() => ({ a }));
  ok('循环引用不抛错且有标记', /\[circular\]/.test(sys), sys.slice(-120));
}

/* 5. 真要坏也得兜住：getter 抛错 */
{
  const sys = await systemPromptWith(() => ({
    get boom() { throw new Error('炸'); },
  }));
  ok('序列化失败时退化成 {}，不炸整轮', typeof sys === 'string' && sys.includes('SYSTEM-PROMPT'));
}

console.log('\n────────');
console.log('宿主状态序列化 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
