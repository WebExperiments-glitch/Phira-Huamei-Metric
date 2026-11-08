# 事故复盘 · 2026-11-08 · 看板娘生产环境 403（静默失败）

> 结论：**看板娘随 V0.27.2.0 上线后，在生产环境对所有访客都画不出来。**
> 页面挂载点在、控制台无报错、服务端无日志——所以四十分钟内没人发现。
> 由外部（wumeiguan）实测发现并以 PR/Issue 提交；其账号随后被平台误封，材料线下流转。

## 现象

```
404 页有 #xl404 挂载点（3 处引用都在）
但 canvas 不出现：/api/xili/manifest/resigned → 403
```

## 我们的复现（2026-11-08 独立验证）

```
带 Origin: https://phm.app.workbuddy.host      → 403
带 Referer: https://phm.app.workbuddy.host/...  → 403
恶意 Origin: https://evil.example              → 403（这条是对的）
```

**同源请求也 403** —— 说明放行逻辑整体失效，不是伪造头被拦。

## 根因

`lib/xili.mjs` 的 `sameOrigin()` 拿 `req.headers.host` 当比对基准。
但我们部署在 CloudStudio Gateway 后面（响应头 `server: CloudStudio Gateway`），
反向代理会把 Host 改写成上游内部主机名，**公开主机名只留在 `x-forwarded-host`**。

于是：`new URL(origin).host`（公开域名） ≠ `req.headers.host`（内部名）→ 永远 false → 全体 403。

旁证：`/api/v1/meta?diag=1` 在**未发送** Authorization 时报告 `authorization: 386`
—— 网关确实在注入/改写请求头。

## 修法

```js
const xfh = (req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
const hosts = new Set([xfh, (req.headers.host || '').toLowerCase(), process.env.PHM_PUBLIC_HOST].filter(Boolean));
// Origin / Referer 的 host 只要命中任一即可
```

- 反代后面：靠 `x-forwarded-host`
- 本地直跑：行为不变
- 网关连 xfh 也剥掉：可用 `PHM_PUBLIC_HOST=phm.app.workbuddy.host` 兜底

## 本地验证（四种情形）

| 场景 | 期望 | 实测 |
|---|---|---|
| 反代（Host 内部名 + `X-Forwarded-Host: phm.example.com` + 同源 Origin） | 200 | **200** |
| 本地同源（Origin = `http://127.0.0.1:5252`） | 200 | **200** |
| 恶意 Origin（`evil.example`） | 403 | **403** |
| 不带任何头 | 403 | **403** |

## 为什么两天没发现

```
失败是静默的：canvas 画不出来，但页面不报错
没有服务端日志：403 只返回 JSON，不打原因
验收只测了「不带 Referer → 403」（那是期望行为），
没测「带同源 Referer → 应该 200」——只验了防线的一半
```

**这条最值得记：验收一个门，必须同时验「该放行的放行了」和「该拦的拦住了」。**

## 待办（本次未做）

- [ ] 403 路径加 reason 日志（只记原因，不打值）：`no-origin` / `host-mismatch` / `bad-signature`
      —— 这类静默失败下次能一眼定位
- [ ] 部署后 30 秒线上验证：`curl -H "origin: https://phm.app.workbuddy.host" .../manifest/fullbody` 应 200

## 附带修的另一处（同批提交）

`public/phm-api.html` 的鉴权头由 `Authorization: Bearer` 改为 `x-phm-key`。

原因：网关会写入它自己的 Authorization（diag 显示 386 字节），把用户的 Key 盖掉，
**表现是静默降级成匿名配额（1000/h → 100/h）**，只在用量页看得出来。
服务端 `KEY_HEADERS` 本来就优先 `x-phm-key`，客户端跟上即可。
同时补了「自检 /meta?diag=1」按钮与「标度差（参考）」列。
