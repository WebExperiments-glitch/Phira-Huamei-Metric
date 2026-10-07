# 安全模型

> 这份文件记录**信任边界在哪**、**修过哪些坑**、**还剩下什么没解决**。
> 最后一项尤其重要 —— 不要假装已解决。

---

## 信任边界

```
                不可信                          │        可信
                                               │
  用户浏览器 ─────────────────────────────────┼──► Node 网关
  （能改任何请求）                              │   （校验 + 限流 + 复算）
                                               │        │
                                               │        │ 带写入凭据
                                               │        ▼
                                               │   云数据库
                                               │   ▲
  攻击者 ── 直连 REST，完全跳过网关 ────────────┼───┘
         ⚠ 这一步**必然可达**（密钥在网页源码里）
            所以真正的门必须设在数据库内部
```

**核心规则 1：凡是客户端提交的业务数值，一律不可信。**

客户端可以随便伪造：`ref_const`、`ps_score`、`nps`、`acc`、`chart_id`、
`phira_user_id`…… 所以：

| 数据 | 谁说了算 |
|---|---|
| 谱面结构特征 / 参考定数 | **服务端复算**（客户端值只做一致性检查） |
| 成绩数据 | 网关字段校验（**无法验证真实性**，见下文"未解决"） |
| 账号归属 | 数据库 `auth.uid()`，客户端传的 `owner_id` 被忽略 |

**核心规则 2：网关不是安全边界。**

网关与浏览器**持同一把 `publishableKey`、同为 `anon`**，
连 `Referer` 都能被非浏览器客户端随手设置 ——
所以**数据库无法区分「网关」和「攻击者」**。
把校验放在网关里只挡得住老实人，挡不住绕过网关直连 REST 的人。

→ 真正的门必须落在**数据库内部**：见下一节。

---

## 防投毒：共享定数缓存怎么被保住的

**威胁**：`phm_charts` 是全站定数的来源。如果攻击者能写进去，
就能让所有用户看到错误定数 —— 对一个「以数据正确性为产品」的工具，这是致命的。

这个问题的修复走了**三代**，前两代都不够，记下来是因为第三代才是对的。

### 第一代：信任客户端（已废）

特征由客户端算完提交 → 攻击者伪造一张同名谱面就能覆盖真实值。

### 第二代：服务端复算（必要，但不充分）

`lib/review.mjs`：网关收到贡献后，**自己**向 Phira 要文件地址并下载谱面
（浏览器受 CORS 限制下载不了，**服务端不受** —— 这是这件事只有服务端能做的原因），
用**与浏览器完全相同的那一份引擎**（`public/js/engine.js`）复算，
再把**服务端算出的值**落库。

实测（提交 6 个伪造字段）：

```
请求：{chart_id: 47579, ref_const: 9.99, ps_score: 3.0, nps: 99.9, notes: 1, ...}
响应：{written: 1, mismatched: 1,
       note: "客户端值不一致（已改用服务端值）: ref_const,ps_score,nps,notes,..."}
入库：ref_const = 15.3, ps_score = 9.7016, notes = 1137   ← 全是服务端算的
```

> **注意取舍**：客户端值不一致**不拒绝写入**，而是改用服务端值。
> 因为不一致通常只是说明客户端引擎过期了（用户没刷新）。拒绝写入会白丢一次
> 缓存机会，而写入服务端值既不丢数据也堵死了投毒。

**但这只堵住了「走网关」这条路。** 攻击者可以直接 `POST` 到
`https://phm.app.workbuddy.host/.cloud/database/rest/phm_charts`
—— 一个完全合法的、源码里就能查到的公开端点。实测后果：

| 攻击 | 结果 |
|---|---|
| 不带任何标记直接 INSERT | 401（被 RLS 挡住） |
| INSERT 时**顺手填上 `engine_ver='server-verified'` + `verified_at`** | **201 写入成功** ⚠ |
| `PATCH` 修改已有权威行（Pandemic → 9.9） | **204 修改成功** ⚠ |

根因：RLS 策略 `WITH CHECK (engine_ver='server-verified' AND verified_at IS NOT NULL)`
**检查的是攻击者自己填的字段** —— 那不是验证，是填空题。
UPDATE 更糟：`USING (engine_ver='server-verified')` 对所有已有权威行都成立，
于是**任何权威值都能被匿名改写**。

### 第三代：数据库里的凭据门（当前的答案）

关键问题是「网关和攻击者不可区分」。破局点不是想办法区分它们，
而是**换一把钥匙** —— `SECURITY DEFINER` 函数以**属主**身份运行，
天然绕过 RLS，于是可以把「你有没有资格写」变成**函数体内的凭据比对**：

```sql
CREATE FUNCTION phm_put_chart(p_secret text, p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s text;
BEGIN
  SELECT v INTO s FROM phm_secrets WHERE k = 'writer';
  IF s IS NULL OR p_secret IS NULL OR p_secret <> s THEN
    RAISE EXCEPTION 'unauthorized writer' USING ERRCODE = '42501';
  END IF;
  INSERT INTO phm_charts (...) VALUES (...)
  ON CONFLICT (chart_id) DO UPDATE SET ...;
  RETURN jsonb_build_object('ok', true);
END $$;
```

配合 `REVOKE INSERT, UPDATE, DELETE ON phm_charts FROM anon, authenticated`，
**表本身对匿名角色变成只读**。`phm_scores` 同样处理（`phm_put_scores`）。

两个写函数内部**自己填 `engine_ver` / `verified_at` / `computed_at`** ——
调用方传什么都不算数，「伪造权威标记」这条路直接不存在。

**修复后实测（同一批攻击，逐个复跑）：**

| 攻击 | 修复前 | 修复后 |
|---|---|---|
| 朴素投毒 INSERT | 401 | 401 |
| INSERT 并伪造 `server-verified` | **201** | **401** |
| PATCH 改已有权威值 | **204** | **401** |
| DELETE 删行 | — | 401 |
| RPC 不带凭据 | — | 404 / 401 |
| RPC 带错误凭据 | — | **401 `unauthorized writer`** |
| 网关正常写入（带凭据） | 200 | 200 ✅ |

**结果**：投毒需要**先拿到写入凭据**。凭据只存在于服务端进程与数据库里，
不在任何前端产物中（`server.mjs` 已被静态白名单挡住，实测线上 `/server.mjs` → 404）。

### 🔑 写入凭据放哪、怎么轮换

**凭据不入库。** `loadWriteSecret()` 的读取顺序：

1. 环境变量 `PHM_WRITE_SECRET`
2. 同目录 `write-secret.txt`（**已 gitignore**）
3. 都没有 → 空串 → 写入全部失败，但**服务照常可用**
   （`/api/analyze` 仍返回算好的定数，只是标注 `cacheWrite.ok=false`）

第 3 条是刻意的 **fail-closed**：宁可不缓存，也绝不留一条不带凭据的写后门。

轮换 = 两步，**必须同时做**：

```sql
UPDATE phm_secrets SET v = '<新值>' WHERE k = 'writer';
```
```bash
echo '<新值>' > phm-web/write-secret.txt   # 然后重新部署
```

只换一边会立刻 42501 —— 同样是 fail-closed，不会静默降级成「没保护也照写」。

> ⚠ **为什么凭据绝不能进源码**：这个仓库是**公开的**。
> 只要凭据出现在任何一个被提交的文件里，全世界都能写这张缓存，
> 这一整节的防线会当场归零。所以它只活在本地文件与数据库里。

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
| 11 | `/api/analyze` 无任何限流（35 并发全部 200，可枚举 chart_id 打死进程） | 新接口只顾功能忘了成本 —— 它是全站最贵的路径（下载 ≤60MB + 同步跑引擎阻塞事件循环） | 三重约束：每 IP 10/分 + 全局 60/分 + **在途并发 ≤3**（超出 503）。修复后同批请求：200×4 / 503×6 / 429×25 |
| 12 | 投毒仍可绕过网关直连 REST（伪造 `server-verified` 即 201，改权威值即 204） | RLS 的 `WITH CHECK` 检查的是**攻击者自己填的字段** —— 那是填空题不是验证；且 `USING (engine_ver='server-verified')` 对所有权威行成立 | 撤销 anon/authenticated 的 INSERT/UPDATE/DELETE，写路径收归 `SECURITY DEFINER` + 写入凭据（见上一节） |
| 13 | 审计留下的测试行（`chart_id=99999997`「安全测试3」）与被篡改的权威值（Pandemic 16.6 → 9.9） | 我做对抗性测试时**真的写进了生产库**，且当时以为删得掉 | 已清理并重算恢复；教训：**对抗性测试不要在生产库上做**，或至少先想好怎么回滚 |

---

## 尚未解决（诚实清单）

### 1. 凭据的可用性依赖「部署时把本地文件带上」

凭据不随源码走，放在 `write-secret.txt`（gitignored）。
如果某次部署没带上它，写入会全部失败 —— 表现为 `/api/analyze` 返回
`cacheWrite.ok=false`。**这是可观测的，不会静默降级**，
但部署流程里因此多了一个隐式前提（部署器要连非 git 跟踪的文件一起上传）。

**更稳的做法**：走环境变量 `PHM_WRITE_SECRET`（代码已支持，优先于文件）。
缺的只是托管侧给我一个配环境变量的入口。

### 2. 被篡改的缓存没有自动发现机制

凭据门挡住的是**外部人**。如果凭据真的泄露、或有人从仓库读到它，
写进去的假定数**不会被自动发现** —— 我们没有任何对账任务。

**缓解方向（尚未做）**：定期抽样重算（`recompute()` 已经现成），
比对 `ref_const` 与 `verified_at`，把对不上的行标出来。
`phm_charts` 现在只有十几行，全量重算一次也就几十秒，成本完全可接受。

### 3. 成绩数据的"归属真实性"无法验证

我们无法证明「提交这条成绩的人就是该成绩的所有者」。
`confirmOwn()` 只是让用户**自我声明一次**，不是密码学证明。

Phira 没有向第三方提供 OAuth 或签名接口，所以**在当前生态下无解**。
这一点的定位应该是「自我声明的高置信度数据」，而不是「已验证数据」。

### 4. Rate limiting 可被 `X-Forwarded-For` 伪造绕过

限流按 IP 计数，而 XFF 头可以伪造。
已加**全局桶**（写入 240/分、分析 60/分）兜底，但仍可被分布式绕过。

### 5. 无 CSP 报告 / 无 CI

CSP 已下发，但没有 `report-uri` 收集违规；也没有 CI 把引擎真实执行脚本接进流程
（第 10 条漏洞就是这么漏出去的）。

### 6. 服务端文件存储不跨部署

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

- [ ] 是否有**密钥/内部地址**可能随静态文件泄露？
      （白名单之外一律 404；**`server.mjs` 现在装着写入凭据，这一条是硬要求**）
- [ ] 客户端提交的值，服务端**是否独立验证过**？
- [ ] 权限改动**是否实测过绕过**？—— 只测「正常路径能写」等于没测。
      必须真的用 curl 打一遍「不带凭据 / 伪造字段 / 改已有行 / 删行」。
- [ ] 表的 `INSERT/UPDATE/DELETE` GRANT **是否已从 anon/authenticated 撤销**？
      写权限**是否只留在 `SECURITY DEFINER` 函数里**？
- [ ] 失败路径是否留下了**替代通道**（fallback / 降级写入）？
- [ ] 对抗性测试**是不是打在生产库上**？先想好回滚，否则别做。
- [ ] 文档承诺与实际行为**是否一致**？（这个项目最容易犯的错 ——
      曾经这里写着"投毒在架构上不成立"，而实测 201/204 都能写）
- [ ] 改动涉及解析/托管/权限时，是否**真实执行**过端到端场景？
- [ ] 隐私相关文案是否与代码行为逐条对得上？
