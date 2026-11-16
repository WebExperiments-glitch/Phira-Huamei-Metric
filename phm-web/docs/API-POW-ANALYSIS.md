# 匿名「PoW 换一次分析」接口约定

> 2026-11-16 · 给游戏客户端的对接文档（服务端已实现）
> 目的：让**没有 API Key 的客户端**也能按需触发一次谱面分析，
> 代价是算一道 PoW 题，而不是把 Key 塞进安装包里。

---

## 0. 为什么要有这条路

| 约束 | 事实 |
|---|---|
| 客户端不能带 Key | 反编译就能提取，等于把配额和写权限一起送人 |
| 分析很贵 | 下载谱面 + 算特征 + 跑模型，**20~40 秒** |
| 网关 30 秒就断 | 同步等必 **504**（成绩上传踩过同一个坑，才改的异步队列） |
| 定数是公开数据 | 读路径不需要保密，也不该被 Key 挡住 |

所以拆成两件事：**读**（匿名、便宜、直接返回）+ **算**（匿名可触发，但要付算力且走后台）。

---

## 1. 读：拿一个已缓存的定数

```http
GET /api/v1/charts/{chart_id}?sharecode=NXNUI4YAVG
```

无需任何鉴权头。返回：

```json
{
  "chart_id": 78280, "name": "…", "level": "IN Lv.14",
  "difficulty": 14.3,        // Phira 谱师标称值（官方值）
  "ref_const": 14.097,       // ★ P.H.M. 实测（社区标度）
  "ref_official": null,      // 官谱标度，社区谱通常为 null
  "ps_score": 7.6874, "notes": 591,
  "engine_build": "com-ridge37-v1.1.0",
  "analyzed": true, "cached": true
}
```

未收录时返回 `200` + `{"chart_id":…, "analyzed":false, "cached":false}` ——
**不是错误**，客户端应回落到官方定数显示，不要弹错。

> ⚠ `ref_const` 与 `difficulty` 是**两把尺子**：前者是社区标度实测值，
> 后者是谱师自填。界面上必须区分标注，不能混成一个数字。

匿名读取配额：**100 次/小时/IP**，突发 12 次/10 秒。配合本地缓存足够。

---

## 2. 算：PoW 换一次分析

### 2.1 领一道题

```http
GET /api/v1/pow?sharecode=NXNUI4YAVG
```

```json
{ "seed": "a1b2c3d4e5f6a7b8c9d0e1f2", "bits": 20, "expires_at": "2026-11-16T13:20:00.000Z", "purpose": "analyze" }
```

- `bits` 是**真正的 bit 数**（不是十六进制零的个数）。
- 有效期 **3 分钟**，一题只能用一次。

### 2.2 本地解

```
找到 nonce，使 sha256(seed + ":" + nonce) 的前 bits 个 bit 为 0
nonce 为十六进制字符串，长度 1~16
```

参考实现（Rust）：

```rust
fn solve(seed: &str, bits: u32) -> String {
    for i in 0u64.. {
        let nonce = format!("{:x}", i);
        let digest = sha256(format!("{}:{}", seed, nonce).as_bytes());
        if leading_zero_bits(&digest) >= bits { return nonce; }
    }
    unreachable!()
}
```

**成本**：20 bit 平均 100 万次哈希，手机 Rust 约 **1~3 秒**。
这正是设计意图——单次用户操作可接受，批量刷要付同样代价。

### 2.3 提交

```http
POST /api/v1/analyses?sharecode=NXNUI4YAVG
x-phm-pow: <nonce>

{ "chart_id": 80030 }
```

- 已缓存 → `200` + 完整结果（**不消耗算力，也不消耗配额**）
- 未缓存 → `202`

```json
{ "chart_id": 80030, "queued": true, "dedup": false,
  "poll": "/api/v1/charts/80030",
  "note": "analysis runs in the background; poll the poll URL until analyzed is true",
  "quota_remaining": 4 }
```

`dedup: true` 表示**同一张谱已经在算了**（别人刚点过），你不需要重复排队。

### 2.4 轮询结果

对 `poll` 地址每 2~3 秒查一次，直到 `analyzed: true`。
经验上限 60 秒；超时就告诉用户「稍后再看」，不要死循环。

---

## 3. 错误码

| 状态 | code | 含义 | 客户端该做什么 |
|---|---|---|---|
| `428` | `precondition_required` | 没带 `x-phm-pow` 或答案不对 | 从响应体的 `challenge` 取题重解 |
| `429` | `analysis_quota_exceeded` | 仅在运维显式设了日上限时出现 | 提示稍后再试，或直接用官方定数 |
| `503` | `analysis_busy` | 队列积压满 | 退避 5 秒重试 |
| `400` | `invalid_chart_id` | chart_id 不是正整数 | 参数问题，不要重试 |

---

## 4. 配额与限制（写死的事实，别假设）

| 项 | 值 | 说明 |
|---|---|---|
| 匿名分析 | **不限次**（默认） | 每次仍要过一道 PoW；不按天卡人头 |
| PoW 难度 | 20 bit（可用 `PHM_POW_ANALYZE_BITS` 调，夹取 12~24） | 题目一次一换 |
| 挑战有效期 | 3 分钟 | 过期要重新领 |
| 队列并发 | 1 | 分析是 CPU 重活，串行才不会拖垮站点 |
| 队列上限 | 64 张 | 满了返回 503 |

---

## 5. 客户端落地的四条要求

1. **不要内嵌 API Key。** 这条路就是为了避免它。
   **也不需要担心每日次数**：默认不限次，只要每次按流程解一道题。
2. **本地缓存定数**，以 `chart_id + engine_build` 为键 —— 引擎升级后旧值可能变，
   换键即自动失效。
3. **未收录时显示官方定数 + 一行标注**（如「P.H.M. 尚未收录」），不要留空。
4. **不要把 PoW 当安全机制**：它只抬高成本，不是身份认证。
   真正的护栏是**一次性核销 + 队列拥塞保护 + 已缓存不重算**（默认不设每日次数上限）。

---

## 6. 服务端实现位置（维护用）

| 文件 | 职责 |
|---|---|
| `lib/api-guard.mjs` | 挑战签发 `issueAnalysisChallenge`、按 bit 校验 `powValidBits` |
| `lib/analysis-queue.mjs` | 去重队列、串行 worker、可选日上限（默认不限次） |
| `lib/api-analysis-routes.mjs` | `POST /analyses` 与 `GET /pow` 两个端点 |
| `tools/test-analysis-pow.mjs` | 7 组断言守住一次性 / 去重 / 背压 / 配额 |

⚠ **一个踩过的坑**：旧的 `powValid` 用 `startsWith('0'.repeat(n))`，
`n` 是**十六进制字符数**不是 bit。拿 `bits: 20` 套它等于要求 80 个零 bit，
永远解不出来。分析档必须用 `powValidBits`，两者不要合并。

---

## 7. 游戏端最小改动清单（照着改即可）

共 4 处改动，都在客户端。服务端已全部就绪。

### 改动 1：新增一个函数「领题 + 解」

```rust
// 位置建议：phira/src/huamei.rs（已有的上报逻辑旁边）
const PHM_BASE: &str = "https://phm.app.workbuddy.host";
const PHM_SHARECODE: &str = "NXNUI4YAVG";   // 与场景/协议页用同一个

#[derive(serde::Deserialize)]
struct PowChallenge { seed: String, bits: u32 }

/// 解：找 nonce 使 sha256("{seed}:{nonce}") 前 bits 个 bit 为 0
fn solve_pow(seed: &str, bits: u32) -> String {
    let mut i: u64 = 0;
    loop {
        let nonce = format!("{i:x}");
        let d = sha256(format!("{seed}:{nonce}").as_bytes());
        let mut need = bits;
        for byte in d {
            let lead = byte.leading_zeros();
            if lead >= need { return nonce; }
            if lead < 8 { break; }
            need -= 8;
        }
        i += 1;
    }
}
```

⚠ **必须放到后台线程**（`std::thread::spawn` 或现有 Task 池）：
20 bit 在手机约 1~3 秒，放主线程会卡住渲染。

### 改动 2：谱面详情页发起查询

顺序很重要 —— **先免费读，再决定要不要花算力**：

```
① GET  {BASE}/api/v1/charts/{id}?sharecode={SC}      // 不需要任何头
   ├─ analyzed == true  → 直接显示 ref_const，结束（不消耗 PoW）
   └─ analyzed == false → 继续 ②

② GET  {BASE}/api/v1/pow?sharecode={SC}              → {seed, bits}
③ 后台线程 solve_pow(seed, bits)                      → nonce
④ POST {BASE}/api/v1/analyses?sharecode={SC}
     x-phm-pow: {nonce}
     {"chart_id": id}
   ├─ 200 → 已算好（别的玩家刚算过），直接用返回值
   ├─ 202 → 已入队，继续 ⑤
   ├─ 428 → 题目过期/答案错，回到 ②（重新领题重解）
   └─ 503 → 服务器忙，退避 5 秒再试 ④

⑤ 每 2~3 秒轮询 ①，最多 60 秒；超时提示「稍后再看」
```

### 改动 3：界面上不要混淆两个数

| 字段 | 是什么 | 建议展示 |
|---|---|---|
| `ref_const` | P.H.M. 实测（社区标度） | 主数字，标注「P.H.M. 实测」 |
| `difficulty` | 谱师自填的标称定数 | 副行，标注「谱师标称」 |

`analyzed == false` 且不等分析时：**显示 `difficulty` + 一行「P.H.M. 尚未收录」**，
不要留空——留空会被当成 Bug 上报。

### 改动 4：本地缓存

- 键：`chart_id + engine_build`（引擎升级后旧值可能变，换键即自动失效）
- 命中缓存就不要再请求网络
- 缓存 `analyzed:false` 的**短一点**（比如 10 分钟），否则玩家永远看不到新结果

### 三条不要做

1. **不要把 API Key 放进去。** 这条路存在的意义就是避免它。
2. **不要并发解多道题。** 一次只查一张谱，题目是一次性的。
3. **不要重试同一个 nonce。** 一次核销即失效，重试必 428。

---

## 8. 已知的边界（如实告知游戏端）

| 现象 | 原因 | 应对 |
|---|---|---|
| 大谱面分析失败（返回 503/始终 analyzed:false） | 谱面 JSON 解压后超过 16MB | 回落显示官方定数 |
| 分析期间站点变慢 | 计算占住 Node 事件循环（尚未挪到 worker 线程） | 客户端不要并发刷 |
| `analyzed:false` 一直不变 | 该谱在上游不可下载，或格式解析不了 | 60 秒后放弃，别死等 |
