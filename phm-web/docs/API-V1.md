# API v1 设计（草案）

> 目标：做成 DeepSeek / OpenAI 那种开发者体验 —— `base_url` + `api_key` + `/v1` 版本化接口
> + 文档页 + 用量/密钥控制台。**免费，不做计费**。

## 1. 对外形态

```text
base_url: https://phm.app.workbuddy.host/api/v1
auth:     Authorization: Bearer sk-<32 hex>
```

| 接口 | 方法 | 说明 |
|---|---|---|
| `/charts/{chart_id}` | GET | 读已分析的定数缓存；未分析返回 `analyzed:false` |
| `/analyses` | POST | 分析并写入缓存。v1 **只接受 chart_id**（不接收谱面文件） |
| `/usage` | GET | 当前 key（或账号）的调用量：今日 / 7 日 / 30 日 |
| `/keys` | GET/POST | 网页账号登录后管理 API Key（列表 / 创建 / 改名 / 删除） |
| `/keys/{id}` | PATCH/DELETE | 改名 / 吊销；**每账号最多 100 个有效 key** |
| `/openapi.json` | GET | OpenAPI 3.1 描述，方便生成 SDK |

### 响应（成功）

```json
{
  "chart_id": 22681,
  "name": "Pandemic",
  "level": "IN.16",
  "difficulty": 16.6,
  "ref_const": 15.6,
  "ref_official": 16.1,
  "ps_score": 13.4,
  "uncertainty": { "lo": 15.0, "hi": 16.2, "q1": 15.4, "q3": 15.8 },
  "engine_ver": "com-trim15-v0.5.0",
  "engine_build": "com-trim15-v0.5.0",
  "cached": true
}
```

数值口径与网页一致：`ref_const` = 社区共识标度，`ref_official` = 官谱标度。

### 错误（对齐 OpenAI 风格）

```json
{ "error": { "type": "invalid_request_error", "code": "chart_not_found", "message": "..." } }
```

## 2. 认证与配额

| 身份 | 额度 |
|---|---|
| 匿名（无 key） | 100 次/小时（按真实对端 IP + 全局桶） |
| API Key（免费） | 1000 次/小时；分析 200 次/天 |

- Key 格式 `sk-<32 位十六进制>`（对齐 DeepSeek 控制台样式），库中只存
  **sha256 哈希**与掩码（`sk-495f****0709`）；明文只在创建响应里出现一次。
- 每个账号最多 **100 个有效 key**；支持改名、删除（吊销，保留用量记录）。
- Key 自助生成：网页登录（现有平台账号）→ `/developer` 控制台 → 创建。
- 控制台列表字段：名称 / Tracking ID（UUID）/ 掩码 Key / 创建日期 / 最近使用 / 改名 / 删除。
- 匿名请求不写用量明细；带 key 的请求逐条写 `hm_api_usage`。

## 3. 数据库

迁移：[../db/api-v1.sql](../db/api-v1.sql)

- `hm_api_keys`：id（Tracking ID）/ owner_id / name / hint / key_hash / plan / created_at / last_used_at / revoked_at
- `hm_api_usage`：id / key_id / endpoint / status / chart_id / duration_ms / created_at
- RPC：`hm_api_key_create`（内含 100 上限）/ `hm_api_key_lookup` / `hm_api_key_list` /
  `hm_api_key_rename` / `hm_api_key_revoke` / `hm_api_key_touch` /
  `hm_api_usage_log` / `hm_api_usage_summary`
- 两张表 RLS 开启、任何角色无直连；只能通过带写入凭据的 SECURITY DEFINER 函数访问。

## 4. 页面

| 路径 | 内容 | 是否需登录 |
|---|---|---|
| `/developers` | 开发者文档：快速开始 / 认证 / 接口 / 错误码 / 限流 / 更新日志 | 否 |
| `/developer` | 控制台：API Key 列表（名称/Tracking ID/掩码/创建/最近使用/改名/删除）+ 用量（今日/7日/30日 + 按接口分布） | 是（平台账号） |

视觉沿用站内 `base.css` + `ui-kit.css`：左侧文档导航、右侧目录、代码块、卡片式用量。

## 5. 分阶段

1. **P1（本次）**：建表 SQL → 接口 + Key 校验 + 限流 + 文档页。
2. **P2**：控制台（登录、创建/吊销 key、用量图表）。
3. **P3**：OpenAPI + 示例 SDK（JS/Python/curl）、CLI 改为调用 API。
4. 以后（另开 ADR）：谱面文件上传分析（会动"文件不上传"的承诺，需单独设计）。

## 6. 明确不做

- 不做计费/充值/发票；所有额度免费。
- v1 不接收谱面文件（守住核心隐私承诺）。
- 不暴露 `hm_api_keys` / `hm_api_usage` 直读接口。
