# llm-hub —— 微型模型聚合站

一个页面、一套 key，把多家 LLM 合成一个入口。**零依赖**，只要有 Node 18+。

```
node server.mjs          # 默认 127.0.0.1:7788
```

## 为什么这件事比看起来小

DeepSeek 和 OpenRouter **都是 OpenAI 兼容格式**：

```
base_url + api_key + { model, messages }  →  同一个响应结构
```

所以"聚合"不需要抽象层，只需要**按模型名把请求转发到对应的 base_url**。

## 三个设计决定

**① key 只存服务端**
浏览器永远拿不到 key。这是聚合站和"前端直连"的唯一实质区别——扒走前端也白搭。

**② 模型 id 带 provider 前缀**

```
deepseek/deepseek-v4-pro                    → api.deepseek.com
openrouter/anthropic/claude-sonnet-4.6      → openrouter.ai/api/v1
```

第一段是 provider，其余原样透传。所以 OpenRouter 那些带斜杠的 slug 也能用。

**③ 流式直通，不缓冲**
SSE 边收边发。缓冲会毁掉逐字出现的体验，长回答还会卡内存。

## 配置

```bash
cp providers.example.json providers.json
# 填 apiKey
```

缺 `apiKey` 的 provider 会被**跳过**，只配一家也能跑。

## 已知坑（都处理了）

| 坑 | 处理 |
|---|---|
| `deepseek-chat` / `deepseek-reasoner` **2026-07-24 已退役** | 模板里只写 `v4-flash` / `v4-pro` |
| OpenRouter 的错误可能藏在 **200 响应体**里 | 先看 content-type，不是 SSE 就当错误返回 |
| Agent 类客户端要求 `/v1/chat/completions` | 本服务是 `/api/chat`，只服务自己的前端 |

## 验证方式（不需要真 key）

起一个假上游，把 `providers.json` 的 `baseUrl` 指过去，验证路由与 SSE 透传：

```json
"mock": { "baseUrl": "http://127.0.0.1:7799", "apiKey": "x",
          "models": [{ "id": "echo-1" }] }
```

实测：`mock/echo-1` → 上游收到 `model: "echo-1"`（前缀已剥），SSE 原样流回。
