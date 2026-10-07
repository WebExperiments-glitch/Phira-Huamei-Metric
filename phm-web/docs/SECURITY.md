# 安全模型

> 这份文件记录**信任边界在哪**、**修过哪些坑**、**还剩下什么没解决**。
> 最后一项尤其重要 —— 不要假装已解决。

---

## 信任边界

```
                不可信                          │        可信
                                               │
  用户浏览器 ─────────────────────────────────┼──► Node 网关
  （能改任何请求）                              │   （唯一的写入口）
                                               │        │
                                               │        ▼
                                               │   云数据库
```

**核心规则：凡是客户端提交的业务数值，一律不可信。**

具体来说，客户端可以随便伪造：`ref_const`、`ps_score`、`nps`、`acc`、`chart_id`、
`phira_user_id`…… 所以：

| 数据 | 谁说了算 |
|---|---|
| 谱面结构特征 / 参考定数 | **服务端复算**（客户端值只做一致性检查） |
| 成绩数据 | 网关字段校验（**无法验证真实性**，见下文"未解决"） |
| 账号归属 | 数据库 `auth.uid()`，客户端传的 `owner_id` 被忽略 |

---

## 防投毒：共享定数缓存怎么被保住的

**威胁**：`phm_charts` 是全站定数的来源。如果攻击者能写进去，
就能让所有用户看到错误定数 —— 对一个「以数据正确性为产品」的工具，这是致命的。

**攻击路径**（修复前是可行的）：
```
伪造一个谱面文件 → 把 name 设成真实曲名 → 匹配到真实 chart_id
  → 提交自己编的 ref_const → 覆盖 phm_charts 里那一行的值
```

**现在的防线**（`lib/review.mjs`）：

1. 网关收到贡献 → **先查该 chart_id 是否已有权威值**，有就直接跳过
2. 没有 → 服务端**自己向 Phira 要文件地址并下载谱面**
   （浏览器受 CORS 限制下载不了，**服务端不受** —— 这是这件事只有服务端能做的原因）
3. 用 **与浏览器完全相同的那一份引擎**（`public/js/engine.js`）复算
4. 与客户端提交值逐字段比对
5. **写入的永远是服务端算出来的值**

**结果**：无论客户端提交什么，落库值都来自服务端自己的计算。投毒在架构上不成立。

实测（提交 6 个伪造字段）：

```
请求：{chart_id: 47579, ref_const: 9.99, ps_score: 3.0, nps: 99.9, notes: 1, ...}
响应：{written: 1, mismatched: 1,
       note: "客户端值不一致（已改用服务端值）: ref_const,ps_score,nps,notes,..."}
入库：ref_const = 15.3, ps_score = 9.7016, notes = 1137   ← 全是服务端算的
```

> **注意第 4 步的取舍**：客户端值不一致**不拒绝写入**，而是改用服务端值。
> 因为不一致通常只是说明客户端引擎过期了（用户没刷新）。拒绝写入会白丢一次
> 缓存机会，而写入服务端值既不丢数据也堵死了投毒。

---

## 修过的真实漏洞（都是自己踩的，记下来防复发）

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | `server.mjs` / `package.json` / `server-store.json` 可被公开下载（含数据库地址、密钥、**真实访客 IP**） | 把「目录穿越防护」当成了「白名单」—— 只检查路径不以 ROOT 开头 | 静态根改为 `public/` + 扩展名白名单 |
| 2 | 调试接口对公网开放（`/api/kv` 泄露访客 IP，`/api/net` 是 SSRF 跳板） | 图方便留了探针接口 | 删除；`/api/health` 只回 `{ok:true}` |
| 3 | `phm_scores` 对匿名**全表可读**（含 Phira UID / 用户名 / client_id） | 隐私文案只写了「导入前会确认」，没意识到「确认之后全世界都能 GET」 | `REVOKE SELECT` + 新建聚合 RPC `phm_plays` / `phm_mine` |
| 4 | 关闭自动上传后**仍然上传** | `contributeChart()` 被无条件调用，没检查开关 —— 与隐私政策直接矛盾 | 外层 `if(OPTN())` + 函数内二次 `if(!OPTN()) return null` |
| 5 | `/api/*` 失败回退直连数据库 | 想避免单点故障，实际制造了**绕过网关的写库路径** + 越忙越打的重试风暴 | 彻底删除 fallback |
| 6 | 第三方 SDK 用 `@dev` 浮动标签且无 SRI | 直接抄了官方示例 | 钉 `0.1.3` + 真实 `integrity` 哈希 |
| 7 | 可导入**任意人**的 Phira 成绩 | 查询任意 UID 后自动导入，数据来源真实性为零 | 新增 `confirmOwn()`，只对本人声明过的账号自动上传 |
| 8 | 限流文件读改写无锁 / `visits` 非原子 | `readFileSync→writeFileSync`、读-改-写 | 串行队列 + `phm_touch()` RPC 原子递增 |
| 9 | `upsert` 全线 401（导入静默失效） | 只 `GRANT SELECT, INSERT` 没给 `UPDATE`；且 `upsert` 内部 `ON CONFLICT DO UPDATE` **即使不冲突也要求 UPDATE 权限** | 补齐 GRANT + RLS 两道门 |
| 10 | 线上所有谱面解析失败 | 编辑时吃掉箭头函数的 `>`，`en=({...})` 成了**合法语法**，语法检查发现不了 | 修字符；**并把「真实执行」写进开发流程** |

---

## 尚未解决（诚实清单）

### 1. `phm_scores` 的写入权限收不回来 ⚠️

服务端网关与浏览器**同用一把 `publishableKey`**、同为 `anon` 角色。
撤销 `anon` 的 INSERT 会让服务端也写不了，导入功能全断。

**影响**：攻击者可以绕过网关照直连数据面，往 `phm_scores` 灌**伪造的成绩**。

**缓解**：网关侧校验 + 限流；聚合统计用中位/均值，单点灌水影响有限。

**根治**：需要托管方提供 service key。
一旦有了，撤销 `anon` 的 INSERT/UPDATE、网关改用高权限凭据，**前端无需改动**。

### 2. 成绩数据的"归属真实性"无法验证

我们无法证明「提交这条成绩的人就是该成绩的所有者」。
`confirmOwn()` 只是让用户**自我声明一次**，不是密码学证明。

Phira 没有向第三方提供 OAuth 或签名接口，所以**在当前生态下无解**。
这一点的定位应该是「自我声明的高置信度数据」，而不是「已验证数据」。

### 3. Rate limiting 可被 `X-Forwarded-For` 伪造绕过

限流按 IP 计数，而 XFF 头可以伪造。
已加**全局桶**（240/分钟）兜底，但仍可被分布式绕过。

### 4. 无 CSP 报告 / 无 CI

CSP 已下发，但没有 `report-uri` 收集违规；也没有 CI 把引擎真实执行脚本接进流程。

### 5. 服务端文件存储不跨部署

`server-store.json`（限流计数）在重新部署后丢失 —— 已确认。
所以它**只存可重建的数据**，不要往里放任何有状态的东西。

---

## 安全响应头（当前实际下发）

```
strict-transport-security: max-age=31536000; includeSubDomains
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
cross-origin-opener-policy: same-origin
permissions-policy: geolocation=(), microphone=(), camera=(), interest-cohort=()
content-security-policy: default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  connect-src 'self' https://api.phira.cn https://phm.app.workbuddy.host https://cdn.jsdelivr.net;
  base-uri 'self'; object-src 'none'
```

`frame-ancestors` 故意不写在 CSP 里 —— 与 `X-Frame-Options: DENY` 重复，
且 Chrome 会对 `'none'` 与其他源混写报错。

---

## 提交安全修复的检查清单

- [ ] 是否有**密钥/内部地址**可能随静态文件泄露？（白名单之外一律 404）
- [ ] 客户端提交的值，服务端**是否独立验证过**？
- [ ] 失败路径是否留下了**替代通道**（fallback / 降级写入）？
- [ ] 文档承诺与实际行为**是否一致**？（这个项目最容易犯的错）
- [ ] 改动涉及解析/托管/权限时，是否**真实执行**过端到端场景？
- [ ] 隐私相关文案是否与代码行为逐条对得上？
