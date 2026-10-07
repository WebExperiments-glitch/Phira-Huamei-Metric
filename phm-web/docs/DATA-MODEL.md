# 数据模型与权限

> **改数据库前先读这份**；改完**同步更新这份文件**。
> 文档与实际结构不一致是这类项目最容易积累的债务。

数据库：WorkBuddy 云服务托管的 PostgreSQL。
**没有迁移文件** —— 结构变更通过 MCP 工具执行 SQL，因此这份文档就是唯一的结构记录。

---

## 表

### `phm_charts` — 共享定数缓存

一行 = 一张谱的结构特征。**这是全站最重要的数据**：它决定所有人看到的定数。

| 列 | 类型 | 说明 |
|---|---|---|
| `chart_id` | `integer` **主键** | Phira 谱面 ID |
| `name` | text | 谱面名 |
| `level` | text | 难度标签（EZ / HD / IN / AT） |
| `difficulty` | numeric | Phira 标称定数 |
| `ref_const` | numeric | ★ 参考定数（k-NN 结果，与官谱同标度） |
| `ps_score` | numeric | ★ PS 负荷标度（0–20，本工具自有标度） |
| `nps` | numeric | 每秒物量 |
| `hold_ratio` | numeric | 长条占比 0–1 |
| `notes` | integer | 实际物量 |
| `stair_avg` | numeric | 纵连段平均速度 |
| `speed_peak` | numeric | 判定线速度峰值 |
| `engine_ver` | text | `server-verified` = 服务端复算 | 
| `computed_at` | timestamptz | 默认 `now()` |
| `verified_at` | timestamptz | **服务端复核时间**（客户端直写的历史行为 `null`） |

**写入规则**：只经 `POST /api/contribute` → `lib/review.mjs` 复核后写入，
落库值一律取自**服务端复算结果**。已有行直接跳过，客户端改不动。

---

### `phm_scores` — 成绩数据

一行 = 某玩家在某谱上的一条成绩。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `bigint` **主键** | 自增 |
| `chart_name` | text **NOT NULL** | 曲名（写入必填） |
| `chart_id` | integer | Phira 谱面 ID（手动打卡时为 null） |
| `chart_diff` / `chart_level` | text | 难度标签 |
| `ref_const` / `official_const` | numeric | 参考定数 / 标称定数 |
| `ps_score` | numeric | 负荷分 |
| `acc` | numeric | 准确率 0–100 |
| `song_rks` | numeric | 单曲 RKS |
| `nps` / `speed_peak` | numeric | 特征 |
| `phira_user_id` | integer | 玩家 Phira UID |
| `phira_user_name` | text | 玩家名 |
| `client_id` | text | 假名化标识（**不是匿名**，同一浏览器可关联） |
| `source` | text | `manual` / `phira` / `phira-recent`，默认 `manual` |
| `engine_ver` | text | 产生该行时的引擎版本 |
| `created_at` | timestamptz | 默认 `now()` |

唯一索引：`(phira_user_id, chart_id)` —— 同一玩家同一谱只留一行（upsert 目标）。

> ⚠ 该表含玩家身份信息，**已撤销匿名 SELECT**（见下）。对外只走聚合 RPC。

---

### `phm_profiles` — 账号档案

一行 = 一个 P.H.M. 账号（可选功能）。

| 列 | 类型 | 说明 |
|---|---|---|
| `owner_id` | text **主键** | 默认 `auth.uid()` —— **不要从客户端传** |
| `display_name` | text | 显示名 |
| `phira_uid` / `phira_name` | integer / text | 绑定的 Phira 账号 |
| `created_at` | timestamptz | 默认 `now()` |
| `last_seen` | timestamptz | 最后活跃（默认 `now()`） |
| `visits` | integer | 访问计数（默认 1，由 `phm_touch()` 原子递增） |

---

## RPC（对外只暴露这些）

| 函数 | 返回 | 用途 |
|---|---|---|
| `phm_stats()` | `json` | 全局聚合：账号数、今日/7日/30日活跃、绑定数、成绩数、缓存数 |
| `phm_plays(name_in text)` | `json` | 某谱的玩家表现：`{n, avg, min, max, med, oc}` |
| `phm_mine(uid_in bigint, ids_in bigint[])` | `integer` | 某玩家在给定谱号里已有几条 |
| `phm_touch()` | `void` | 原子更新本人档案的 `last_seen` 与 `visits` |

**设计原则**：所有 SECURITY DEFINER 函数都
① `SET search_path = public` ② `REVOKE ALL FROM PUBLIC` ③ 只 `GRANT EXECUTE` 给需要的角色。

`phm_stats` / `phm_plays` / `phm_mine` 只`返回聚合数字或计数`，**不返回任何个体字段**。

---

## 权限矩阵（当前实际状态）

| 对象 | anon / authenticated | 说明 |
|---|---|---|
| `phm_charts` | SELECT ✅ INSERT ✅ UPDATE ✅ | 前端要读缓存；写入经网关 |
| `phm_scores` | **SELECT ❌** INSERT ✅ UPDATE ✅ | **已撤销全表读**，改走聚合 RPC |
| `phm_profiles` | 仅本人（`owner_id = auth.uid()`）| 三道 RLS 全开且限本人 |
| 所有表 | **DELETE ❌** | 匿名不可删（防恶意清库） |
| `phm_stats` / `phm_plays` / `phm_mine` | EXECUTE ✅ | 聚合接口 |
| `phm_touch` | EXECUTE ✅（仅 authenticated）| 需要登录 |

### 为什么 `phm_scores` 的 INSERT 收不掉

服务端网关与浏览器**用的是同一把 `publishableKey`**，同为 `anon` 角色 ——
托管环境不提供 service key。所以：

- 如果撤销 `anon` 的 INSERT → **服务端也写不了**，导入功能全断
- 因此只能保留写权限，靠**网关校验 + 服务端复核**降低风险

**这是当前托管能力的硬限制**，不是设计疏漏。
托管方一旦提供 service key，就能把写权限收归服务端：
撤销 `anon` 的 INSERT/UPDATE，网关改用高权限凭据 —— 届时无需改动前端。

---

## 结构变更怎么做

1. 用 MCP 工具执行 SQL（`mode: "migrate"`）
2. 一条语句一次调用（不支持多语句）
3. **回来更新这份文档**
4. RLS / GRANT 两道门都要设（只设一个不生效）

### 两道门（血泪教训）

PostgreSQL 的权限是**表级 GRANT** 和 **RLS 策略**两道独立的门：

```sql
-- 门 1：表级授权
GRANT SELECT, INSERT, UPDATE ON TABLE public.xxx TO authenticated, anon;
-- 门 2：行级策略
CREATE POLICY xxx_update_own ON xxx FOR UPDATE TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
```

**只开一道等于没开**。曾经因为只 `GRANT SELECT, INSERT` 没给 `UPDATE`，
导致 `upsert`（内部是 `ON CONFLICT DO UPDATE`，**即使不冲突也要求 UPDATE 权限**）
全线 401，导入功能静默失效了很久 —— 因为错误被写进了隐藏面板，没人看见。

### 加 RPC 的标准写法

```sql
CREATE OR REPLACE FUNCTION phm_xxx(arg_in TYPE)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER                    -- 需要跨行读时用；否则用 INVOKER
SET search_path = public            -- 必加，防 search_path 注入
AS $$ ... $$;

REVOKE ALL ON FUNCTION phm_xxx(TYPE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION phm_xxx(TYPE) TO anon, authenticated;
```
