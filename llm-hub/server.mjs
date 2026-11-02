#!/usr/bin/env node
/* ============================================================
 * llm-hub —— 微型模型聚合站
 * ============================================================
 * 【一句话】一个页面、一个 key 池，把多家 LLM 合成一个入口。
 *
 * 【为什么这件事其实很小】
 *   DeepSeek 和 OpenRouter **都是 OpenAI 兼容格式**：
 *     base_url + api_key + { model, messages } → 同一个响应结构
 *   所以"聚合"不需要抽象层，只需要**按模型名把请求转发到对应的 base_url**。
 *   那些号称几百行的"LLM 网关"，核心也就这么点事；体积大的是计费、限流、观测。
 *
 * 【设计上的三个决定】
 *   ① Key 只存在服务端
 *      聚合站和"前端直连"的唯一区别就是这个。浏览器永远拿不到 key，
 *      所以别人扒走前端也白搭。
 *
 *   ② 模型 id 带 provider 前缀
 *      `deepseek/deepseek-v4-pro`  → 走 DeepSeek
 *      `openrouter/anthropic/claude-sonnet-4.6` → 走 OpenRouter
 *      第一段是 provider，其余原样透传。这样前端只要拼一个字符串。
 *
 *   ③ 流式直通，不缓冲
 *      SSE 边收边发。缓冲会毁掉"逐字出现"的体验，而且长回答会卡内存。
 *
 * 【零依赖】
 *   Node 内置 http + 内置 fetch（18+）。不需要 express、不需要 openai SDK。
 *
 * 用法：
 *   1. cp providers.example.json providers.json  → 填 key
 *   2. node server.mjs                （默认 7788）
 *   3. 打开 http://127.0.0.1:7788
 * ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7788);
const CONFIG = path.join(ROOT, 'providers.json');
const PUBLIC = path.join(ROOT, 'public');

/* ── 配置 ──
   ⚠ 缺 key 的 provider 直接跳过，不报错 —— 只配一家也能跑。
      需求是"聚合"，不是"必须全配"。 */
function loadProviders() {
  if (!fs.existsSync(CONFIG)) {
    console.error('[hub] 找不到 providers.json');
    console.error('[hub] 先执行：cp providers.example.json providers.json，然后填 key');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const out = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!p || !p.baseUrl) continue;
    if (!p.apiKey) {
      console.warn(`[hub] 跳过 ${name}：没有 apiKey`);
      continue;
    }
    out[name] = { baseUrl: p.baseUrl.replace(/\/$/, ''), apiKey: p.apiKey,
                  headers: p.headers || {}, models: p.models || [] };
  }
  return out;
}

const PROVIDERS = loadProviders();

function listModels() {
  const list = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    for (const m of p.models) list.push({ id: m.id, label: m.label || m.id, provider: name });
  }
  return list;
}

/* ── 路由：`provider/模型` ──
   第一段匹配已知 provider 就走它，剩下的全部当模型 id。
   这样 openrouter 的 `anthropic/claude-...` 这种带斜杠的 slug 也能原样透传。 */
function route(model) {
  const slash = model.indexOf('/');
  if (slash < 0) return null;
  const prov = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  const p = PROVIDERS[prov];
  if (!p || !rest) return null;
  return { provider: prov, cfg: p, model: rest };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ── 核心：转发 ──
   把前端的 { model, messages, ... } 拆成 { provider, model } + 原参数，
   换成对方的 base_url 和 key，然后把上游的 SSE 原样吐回去。 */
async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: { message: '请求体不是合法 JSON' } });
  }
  const r = route(String(body.model || ''));
  if (!r) {
    return json(res, 400, {
      error: { message: `未知模型 "${body.model}"。格式应为 provider/model，可用：` +
        listModels().map(m => m.id).join(', ') },
    });
  }

  const payload = Object.assign({}, body, { model: r.model });
  const url = r.cfg.baseUrl + '/chat/completions';
  const t0 = Date.now();

  let up;
  try {
    up = await fetch(url, {
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'authorization': 'Bearer ' + r.cfg.apiKey,
      }, r.cfg.headers),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    console.error(`[hub] ${r.provider} 连接失败:`, e.message);
    return json(res, 502, { error: { message: `上游连不上：${e.message}` } });
  }

  /* ⚠ OpenRouter 的坑：错误信息可能藏在 **200 响应体**里，
     不能只看 status。这里先读一小段判断，是错误就当错误返回。 */
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    console.error(`[hub] ${r.provider} ${up.status}:`, text.slice(0, 200));
    return json(res, up.status, { error: { message: text.slice(0, 400) || `上游 ${up.status}` } });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',      /* 让反代也别缓冲 */
  });

  if (!up.body) { res.end(); return; }

  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let chars = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      chars += s.length;
      res.write(s);
    }
  } catch (e) {
    console.error(`[hub] ${r.provider} 流中断:`, e.message);
  } finally {
    try { await reader.cancel(); } catch { /* 已结束 */ }
    res.end();
    console.log(`[hub] ${r.provider}/${r.model}  ${chars} 字符  ${Date.now() - t0}ms`);
  }
}

/* ── 静态 ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const abs = path.join(PUBLIC, rel);
  /* 防目录穿越：规范化后必须仍在 PUBLIC 里 */
  if (!abs.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(abs, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/models' && req.method === 'GET') return json(res, 200, { data: listModels() });
  if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (p === '/healthz') return json(res, 200, { ok: true, providers: Object.keys(PROVIDERS) });

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  const names = Object.keys(PROVIDERS);
  console.log(`[hub] http://127.0.0.1:${PORT}`);
  console.log(`[hub] provider: ${names.length ? names.join(', ') : '（一个都没有，检查 providers.json）'}`);
  console.log(`[hub] 模型 ${listModels().length} 个`);
});
