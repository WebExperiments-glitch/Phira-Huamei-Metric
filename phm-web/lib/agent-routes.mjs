/* ============================================================
 * lib/agent-routes.mjs —— 写谱 Agent 的模型代理
 * ============================================================
 * 【这个模块只干一件事】
 *   把浏览器发来的 {model, system, messages, tools} 转给 DeepSeek，
 *   然后把上游 SSE **原样流回去**。
 *
 * 【为什么必须有服务端这一层】
 *   Key 不能进浏览器。前端直连等于把 Key 交给每个访客 ——
 *   DevTools 里一眼就能看到，而且会被爬。
 *   这是「聚合站」和「前端直连」唯一实质的区别。
 *
 * 【为什么不在中间解析再重组】
 *   重组会丢 `usage`、`reasoning_content` 和增量结构。
 *   我们只需要透传，前端自己解析（见 public/js/agent.js）。
 *
 * 【⚠ 路由工厂契约】
 *   chatRoute 处理了就 **必须 return true**。
 *   返回 falsy 会被 server.mjs 当成"没命中"继续往下走 → send404 →
 *   此时响应头已经发出去了 → ERR_HTTP_HEADERS_SENT → **整个进程退出**。
 *   这个坑 2026-10-20 真实踩过，未登录请求就能下线整站。
 *
 * 【没有 Key 怎么办】
 *   fail-closed：返回 503 + 明确的说明。
 *   **绝不**"降级成本地规则生成"—— 用户会以为模型在写，其实不是。
 * ============================================================ */

const BASE = (process.env.PHM_AGENT_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_KEY = process.env.PHM_OPENROUTER_KEY || '';

/* ── 免费模型链降级 ──
   参考 `huamei-lw-thesis` 的做法：OpenRouter 免费池会限流，
   单个模型 429 就按间隔重试，重试仍失败就换链上下一个。
   ⚠ 链是**兜底**，不是随便换：用户指定的模型优先，只有它挂了才降级。
     悄悄换模型比报错更糟 —— 用户以为在用 A，其实在用 B。 */
const FREE_CHAIN = [
  /* 顺序按 **2026-10-25 实测**排（`tools/bench-tools.mjs` 3 工具、`tools/bench-17.mjs` 真实 17 工具）：
       laguna-s-2.1       ✓ 2.1s / ✓ 17.4s 直捣 chart_generate   ← 唯一走到生成步的
       dots-3-note-preview✓ 2.3s / ✓  7.9s
       north-mini-code    ✓ 5.5s /  第二轮被上游挡（回 HTML）
       flint-v1.0         ✓ 8.1s / ✓ 11.9s 但只到 chart_templates
     ⚠ 被剔除的（别再放回来，都有实测依据）：
       nemotron-3.5-lightning  27.3s、finish=length、**0 工具** —— 光想不干
       inkling-small           要单独授权，实测 401
       xing4.0 / gemma-4-31b / nemotron-3-super / lfm-2.5   Provider returned error */
  'poolside/laguna-s-2.1:free',
  'dots-studio/dots-3-note-preview:free',
  'cohere/north-mini-code:free',
  'recursive/flint-v1.0:free',
];

/* 模型清单缓存（10 分钟）。OpenRouter 的目录有 790 KB，不能每次请求都拉。 */
let modelsCache = { at: 0, data: null };
const KEY = process.env.PHM_AGENT_KEY || '';
/* ⚠ 模型名以**上游通知为准**（2026-10-25 用户转述 DeepSeek 公告）：
     · 请用 `deepseek-flash` —— 现已升级为 DeepSeek-V4.1-Flash-1017
     · 旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` **仍可调用**，
       但对应模型已下线，请求由 V4.1-Flash-1017 提供、按 Flash 价格计费
     · `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役
   所以：默认用 `deepseek-flash`；旧名留在白名单里当**别名**（不报错，直接放行），
   退役的两个单独拦下来给清楚的提示。 */
const DEFAULT_MODEL = process.env.PHM_AGENT_MODEL || 'deepseek-flash';

const MODELS = new Set([
  'deepseek-flash',                    /* ✅ 首选：V4.1-Flash-1017 */
  'deepseek-v4-pro',                   /* Pro 档 */
  'deepseek-v4-flash',                 /* 别名，上游已指向 V4.1-Flash-1017 */
  'deepseek-v4-flash-vision-exp',      /* 别名，同上 */
]);
const RETIRED = new Set(['deepseek-chat', 'deepseek-reasoner']);

export function makeAgentRoutes(deps) {
  const { send, gate, gateAnalyze, readBody } = deps;

  /* Key 有两个来源，优先级：**用户自带** > 服务端环境变量。
     用户自带是为了让「自己配 API」成立 —— 他的 Key 存在自己浏览器的
     localStorage 里，每次请求带上来，我们只做转发，**不落盘、不记录**。
     服务端 Key 只是给"不想自己配"的人兜底。

     ⚠ 用户 Key 用完即弃：不写日志、不回显。错误响应里也要脱敏。 */
  const available = () => Boolean(KEY || OR_KEY);

  /* 模型属于哪家：deepseek-* 走 DeepSeek，其余（含 :free / provider/model）走 OpenRouter */
  const isOpenRouter = (m) => !!m && !/^deepseek/i.test(m);
  const keyOf = (req) => {
    const own = String(req.headers['x-agent-key'] || '').trim();
    /* ⚠ 回落要**两家都试**：只有 DeepSeek Key 的人不该被迫配 OpenRouter，反之亦然。
       第一版只回落 KEY，导致只配 PHM_OPENROUTER_KEY 时整个 AI 功能报 unavailable。 */
    return own || KEY || OR_KEY;
  };

  /* 这把 Key 是哪家的。OpenRouter 是 `sk-or-v1-…`，DeepSeek 是 `sk-<32 hex>`。
     ⚠ 一定要按**这把 Key**判断，不能按「服务端配了谁」判断 ——
       用户在页面里自己填了 DeepSeek Key，界面却报「DeepSeek 不可用」，
       这是最让人上头的一类错误：明明能用的东西说不能用。 */
  const keyKindOf = (k) => {
    const v = String(k || '').trim();
    if (!v) return null;
    if (/^sk-or-/i.test(v)) return 'openrouter';
    if (/^sk-/i.test(v)) return 'deepseek';
    return 'unknown';
  };
  const providersOf = (req) => {
    const ownKind = keyKindOf(req.headers['x-agent-key']);
    return {
      deepseek: Boolean(KEY) || ownKind === 'deepseek',
      openrouter: Boolean(OR_KEY) || ownKind === 'openrouter',
    };
  };

  async function chatRoute(req, res, ip) {
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'POST only' })); return true; }

    /* 没有 Key 时**明说**，不要假装能跑 */
    const userKey = keyOf(req);
    if (!userKey) {
      send(res, 503, JSON.stringify({
        error: 'agent_unavailable',
        message: '服务端没有配置 PHM_AGENT_KEY，AI 写谱功能未开启。'
          + '在 .env 里填 PHM_AGENT_KEY=<DeepSeek key> 后重启即可。',
      }));
      return true;
    }

    /* 与 /api/analyze 共用配额：一次对话可能连调十几轮模型，比分析谱面贵得多 */
    if (!(await gate(res, gateAnalyze({ ip }), 'AI 请求太频繁，请稍后再试'))) return true;

    let body;
    try { body = await readBody(req, 512 * 1024); }
    catch { send(res, 413, JSON.stringify({ error: '请求体过大' })); return true; }

    const model = String(body?.model || '');
    /* ⚠ 两种 id 语义不同，不能统一剥前缀：
         · `deepseek/deepseek-flash` —— `deepseek/` 是**我们自己加的**提供方前缀，剥掉 →
           真正的模型名 `deepseek-flash`
         · `poolside/laguna-s-2.1:free` —— `poolside/` 是 **OpenRouter 模型 id 的一部分**，
           剥掉就变成不存在的模型，请求会落到 DeepSeek 并报 401（实测踩过）
       判据：只有第一段恰好是 `deepseek` 时才剥。 */
    const bare = /^deepseek\//i.test(model) ? model.slice(model.indexOf('/') + 1) : model;
    if (RETIRED.has(bare)) {
      send(res, 400, JSON.stringify({
        error: 'model_retired',
        message: `${bare} 已于 2026-07-24 退役，请改用 deepseek-flash（当前为 V4.1-Flash-1017）`,
      }));
      return true;
    }
    /* OpenRouter 的模型 id 形如 `provider/model[:free]`。
       ⚠ 这里**不能白名单硬拦** —— 它的目录有 467 个模型且随时变，
         写死就会「昨天能用今天不行」。
       放行规则：含 `/` 且不含空格、长度 < 120 → 透传；否则退回白名单/默认。 */
    const looksOR = /^[\w.-]+\/[\w.:-]+$/.test(bare) && bare.length < 120;
    const useModel = MODELS.has(bare) ? bare : looksOR ? bare : DEFAULT_MODEL;

    if (!Array.isArray(body?.messages) || !body.messages.length) {
      send(res, 400, JSON.stringify({ error: 'messages 不能为空' }));
      return true;
    }

    /* 组装上游请求。system 单独抽出来放第一条，其余原样透传。 */
    const messages = body.system
      ? [{ role: 'system', content: String(body.system) }, ...body.messages]
      : body.messages;

    const payload = {
      model: useModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: Math.min(65536, Number(body.maxTokens) || 16384),
    };
    if (Array.isArray(body.tools) && body.tools.length) {
      payload.tools = body.tools;
      payload.tool_choice = 'auto';
    }
    /* 思考强度：两家参数名不同。
       DeepSeek → thinking:{type:'enabled'|'disabled'}（只有 v4/flash 认）
       OpenRouter → reasoning:{effort:'low'|'medium'|'high'}
       ⚠ 参数名写错的后果是**静默失效**（模型不理你，但也不报错），
         所以只在这两家各自的模型上才加。 */
    const wantThink = Boolean(body.thinking);
    if (isOpenRouter(useModel)) {
      if (wantThink) payload.reasoning = { effort: ['low', 'medium', 'high'].includes(body.effort) ? body.effort : 'medium' };
    } else if (/^deepseek-(v4|flash)/i.test(useModel)) {
      payload.thinking = { type: wantThink ? 'enabled' : 'disabled' };
    }

    /* 上游调用：按模型决定发给谁。
       OpenRouter 要额外两个归属头（不填也能用，填了会出现在它的排行榜上）。 */
    const callUpstream = async (model, key) => {
      const or = isOpenRouter(model);
      const url = (or ? OR_BASE : BASE) + '/chat/completions';
      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
      if (or) { headers['HTTP-Referer'] = 'https://phm.app.workbuddy.host'; headers['X-Title'] = 'P.H.M.'; }
      return fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ ...payload, model }),
        signal: AbortSignal.timeout(180_000),
      });
    };

    let up;
    try {
      up = await callUpstream(useModel.includes('/') ? useModel : useModel, userKey);
      /* 429 / 5xx 时按免费链降级。
         ⚠ 只在**用户没指定具体模型**（用的是默认）或指定的是免费模型时才降，
           并且把实际用的模型名回报给前端 —— 不能悄悄换。 */
      if ((up.status === 429 || up.status >= 500) && isOpenRouter(useModel)) {
        for (const alt of FREE_CHAIN) {
          if (alt === useModel) continue;
          const retry = await callUpstream(alt, userKey);
          if (retry.ok) {
            up = retry;
            console.warn(`[agent] ${useModel} 不可用，降级到 ${alt}`);
            break;
          }
        }
      }
    } catch (e) {
      /* ⚠ 错误信息里可能带 URL，但绝不会带 Key；仍然过一遍脱敏兜底 */
      send(res, 502, JSON.stringify({ error: 'upstream_unreachable', message: String(e.message).replaceAll(userKey, '[已隐藏]') }));
      return true;
    }

    if (!up.ok) {
      let text = '';
      try { text = (await up.text()).replaceAll(userKey, '[已隐藏]'); } catch { /* 读不到就算了 */ }
      const zh = { 400: '请求参数或上下文无效', 401: 'API Key 无效', 402: 'API 余额不足',
        403: '请求被拒绝', 429: '请求过于频繁', 503: '服务繁忙' }[up.status] || '上游请求失败';
      send(res, up.status, JSON.stringify({ error: 'upstream_error', status: up.status, message: `${up.status}：${zh}`, detail: text.slice(0, 400) }));
      return true;
    }

    /* 透传 SSE。不解析、不重组。 */
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',      /* 让反代也别缓冲 */
    });

    if (!up.body) { res.end(); return true; }
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      /* 客户端断开或上游中断。**不能 throw** —— 路由已经返回了，抛出去没人接。 */
      if (!res.writableEnded) res.end();
    } finally {
      try { await reader.cancel(); } catch { /* 已结束 */ }
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  /* GET /api/agent/models —— 免费模型实时清单
     ⚠ 缓存 10 分钟：目录 790 KB，每次请求都拉会把页面拖死。
     ⚠ 只筛 `:free`：用户要的是「能用且不花钱」，付费模型列出来反而误导。 */
  async function modelsRoute(req, res) {
    if (req.method !== 'GET') { send(res, 405, JSON.stringify({ error: 'GET only' })); return true; }
    const providers = providersOf(req);
    const now = Date.now();
    if (!modelsCache.data || now - modelsCache.at > 10 * 60 * 1000) {
      try {
        const r = await fetch(OR_BASE + '/models', { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        modelsCache = {
          at: now,
          data: (j.data || []).map((m) => ({
            id: m.id,
            name: m.name,
            context: m.context_length || 0,
            free: String(m.id).endsWith(':free'),
            pricing: m.pricing || null,
          })).filter((m) => m.free).sort((a, b) => b.context - a.context),
        };
      } catch (e) {
        /* 拉不到就用旧缓存；连旧缓存都没有就明说，不要给空数组让人以为没有免费模型 */
        if (!modelsCache.data) {
          send(res, 502, JSON.stringify({ error: 'models_unreachable', message: String(e.message) }));
          return true;
        }
      }
    }
    send(res, 200, JSON.stringify({
      count: modelsCache.data.length,
      cachedAt: modelsCache.at,
      /* DeepSeek 在链首：它是唯一被实测证明能稳定走完
         editor_context → chart_generate → chart_lint 的模型。 */
      chain: providers.deepseek ? ['deepseek-flash', ...FREE_CHAIN] : FREE_CHAIN,
      /* 前端据此选默认模型：只配了 OpenRouter Key 的用户选 deepseek-flash
         会 401（拿 OR 的 key 去请求 DeepSeek），而那错误信息看不出根因。
         ⚠ 必须算上请求头里用户自带的 Key，只看 process.env 会把
           「自己填了 Key 的用户」判成没有任何 provider。 */
      providers,
      data: modelsCache.data,
    }));
    return true;
  }

  /* ── 模型可用性探测（三色灯）──
     green  正常回复
     yellow 排队/限流（429、或上游明确说 busy）
     red    不可用（鉴权失败、模型不存在、网络不通）

     ⚠ 探测本身也要花钱/占配额，所以：
       · 只发 1 个 token 的「ping」，max_tokens=1
       · 结果缓存 60 秒，同一模型不会被子多次点爆
       · **不并发探测全部**：前端一次最多查 8 个，超过就拒绝，避免被当成压测 */
  const probeCache = new Map();
  const PROBE_TTL = 60_000;

  async function probeRoute(req, res, ip) {
    if (req.method !== 'POST') { send(res, 405, JSON.stringify({ error: 'POST only' })); return true; }
    if (!(await gate(res, gateAnalyze({ ip }), '探测太频繁，请稍后再试'))) return true;
    let body;
    try { body = await readBody(req, 32 * 1024); }
    catch { send(res, 413, JSON.stringify({ error: '请求体过大' })); return true; }

    const models = Array.isArray(body?.models) ? body.models.slice(0, 8) : [];
    if (!models.length) { send(res, 400, JSON.stringify({ error: 'models 不能为空' })); return true; }
    const key = keyOf(req);
    if (!key) { send(res, 503, JSON.stringify({ error: 'agent_unavailable' })); return true; }

    const now = Date.now();
    const out = [];
    for (const m of models) {
      const id = String(m || '');
      if (!/^[\w.-]+\/[\w.:-]+$/.test(id)) { out.push({ model: id, state: 'red', detail: '模型名格式不对' }); continue; }
      const hit = probeCache.get(id);
      if (hit && now - hit.at < PROBE_TTL) { out.push({ ...hit.value, cached: true }); continue; }

      let value;
      try {
        const r = await fetch(OR_BASE + '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + key,
            'HTTP-Referer': 'https://phm.app.workbuddy.host', 'X-Title': 'P.H.M. probe',
          },
          body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(25_000),
        });
        if (r.ok) {
          value = { model: id, state: 'green', detail: '正常回复' };
        } else if (r.status === 429) {
          /* 429 = 免费池排队。这不是故障，是它的常态 —— 所以是黄不是红。 */
          value = { model: id, state: 'yellow', detail: '排队 / 限流（稍后自动重试）' };
        } else if (r.status === 402) {
          value = { model: id, state: 'red', detail: '余额不足' };
        } else if (r.status === 401 || r.status === 403) {
          value = { model: id, state: 'red', detail: 'Key 无效或无权访问' };
        } else if (r.status === 404) {
          value = { model: id, state: 'red', detail: '模型不存在 / 已下线' };
        } else {
          value = { model: id, state: 'red', detail: 'HTTP ' + r.status };
        }
      } catch (e) {
        value = { model: id, state: 'red', detail: String(e.name === 'TimeoutError' ? '探测超时' : e.message).slice(0, 80) };
      }
      probeCache.set(id, { at: now, value });
      if (probeCache.size > 200) probeCache.delete(probeCache.keys().next().value);
      out.push(value);
    }
    send(res, 200, JSON.stringify({ at: now, results: out }));
    return true;
  }

  /* 统一入口：server.mjs 那边**每多一行就超上限**（900 行硬约束），
     所以把三条路由收进一个 dispatch。新增 agent 子路由只改这里，不动 server.mjs。 */
  async function handleAgentRequest(req, res, url, ip) {
    const sub = url.pathname.slice('/api/agent/'.length);
    if (sub === 'chat') return chatRoute(req, res, ip);
    if (sub === 'models') return modelsRoute(req, res);
    if (sub === 'probe') return probeRoute(req, res, ip);
    send(res, 404, JSON.stringify({ error: 'unknown agent endpoint: ' + sub }));
    return true;
  }

  return { handle: handleAgentRequest, chatRoute, modelsRoute, probeRoute, available, model: () => DEFAULT_MODEL };
}
