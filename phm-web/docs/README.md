# P.H.M. Standard — 开发文档

> **给接手的人**：这份文档的目标是让你**只看 3 个文件就能开始改代码**。
> 没时间的话，按顺序读：**本文件 → `ARCHITECTURE.md` → 你想改的那块源码**。

---

## 30 秒了解这是什么

一个 Phira / Phigros 谱面难度参考工具。用户拖入谱面包（`.pez` / `.zip`），
浏览器本地解析并算出「参考定数」，同时把**结构特征**贡献到共享缓存里，
让下一个人搜到同一张谱时不必再下载。

**三条必须记住的原则**（所有设计都围绕它们）：

1. **谱面文件永远不上传。** 解析全在浏览器内完成，上传的只有算出来的特征数字。
2. **落库的定数必须由服务端复算。** 客户端算的值只用来做一致性检查，
   永远不会直接写进数据库。
3. **网关不是安全边界。** 它和浏览器同权限、连 Referer 都能伪造，
   攻击者可以完全绕开它直连 REST。所以写权限必须**在数据库里**收回
   （表级 GRANT 已撤销，写路径只剩带凭据的 `SECURITY DEFINER` 函数）。

第 2、3 条合起来才是防投毒。详见 `SECURITY.md`。

---

## 目录地图（照着找就行）

```
phm-web/
├── server.mjs                 ← 后端入口：HTTP 服务、路由、静态托管
├── write-secret.txt           ← ★ 写入凭据（唯一能写缓存的东西；**已 gitignore，绝不入库**）
├── package.json               ← 只声明 start 脚本，无第三方依赖
│
├── lib/
│   ├── review.mjs             ← ★ 服务端复核：下载谱面 + 复算 + 与提交值比对
│   └── cloud.mjs              ← ★ 云数据库访问层：地址 / publishableKey / 写入凭据 / dbFetch
│                                 （server.mjs 与 tools/ 共用同一份，别在别处再配一遍）
│
├── public/                    ← 静态资源根目录（只有这里的内容会被送出）
│   ├── index.html             ← 页面结构 + 全部前端逻辑（模块化的单文件）
│   ├── privacy.html           ← 隐私政策
│   ├── 404.html               ← 错误页（服务端对未命中路径下发它，状态码仍是 404）
│   ├── robots.txt             ← 禁爬 /api/（/api/analyze 是全站最贵的路径）
│   ├── sitemap.xml
│   ├── og.png                 ← 分享卡片 1200×630（由 tools/make-og.mjs 生成）
│   ├── css/                   ← （预留）
│   └── js/
│       └── engine.js          ← ★★ 引擎：浏览器与 Node 共用的唯一真源
│
├── tools/
│   ├── make-og.mjs            ← 重新生成分享卡片（改文案后跑一次）
│   └── warm-cache.mjs         ← ★ 批量预热共享定数缓存（默认填金标集 Ranked + Special）
│
└── docs/
    ├── README.md              ← 你正在看的
    ├── ARCHITECTURE.md        ← 数据流、分层、设计取舍
    ├── DATA-MODEL.md          ← 表结构、RPC、权限（改数据库先看这个）
    └── SECURITY.md            ← 信任边界、风险清单、已知限制
```

> **版本号只有一处**：`index.html` 里的 `<meta name="app-version">`。
> 页头标签、页脚、`PHM.status()`、以及引擎的缓存版本串都从它取 —— 改一处就够。
> 别在别处再写死版本（曾经 `<title>` / 页头 / 页脚 / README 四处各一份，改一处忘三处）。
> ⚠ `engine_ver`（`"5d-knn-…"`）是**另一根轴**：它是算法版本、会被写进数据行，引擎没改动就不要动。

**按任务找文件：**

| 我想改… | 看这个 |
|---|---|
| 难度算法 / 特征 / k-NN | `public/js/engine.js` |
| 页面交互 / 渲染 | `public/index.html`（找对应函数名） |
| 接口路由 / 校验 / 限流 / 静态托管 | `server.mjs` |
| 数据库地址 / 写入凭据 / 读写封装 | `lib/cloud.mjs` |
| 服务端复核逻辑 | `lib/review.mjs` |
| 数据库表或权限 | `docs/DATA-MODEL.md` → 然后用 MCP 执行 SQL |
| 隐私相关文案 | `public/privacy.html` + `index.html` 里的设置面板 |

---

## 批量预热共享缓存

```bash
cd phm-web
node tools/warm-cache.mjs --dry-run          # 先看计划，不下载
node tools/warm-cache.mjs --limit 600        # 填金标集（Ranked + Special，约 631 张）
node tools/warm-cache.mjs --types 0          # 只填 Ranked
```

**为什么需要它**：页面的价值取决于「搜任何一张谱都能出定数」。空库时来的人
看到「定数缓存 15 张」就走了 —— 所以推广前先把库填起来。

**选哪批**：默认填 **金标集**（`type=0` Ranked 581 张 + `type=1` Special 50 张）。
这批是计入 rks 的谱，正是玩家会在意定数的那些，比按创建时间乱抓一批有用得多。

**凭什么可信**：脚本直接复用服务端的复核链路 `lib/review.mjs → recompute()`，
没有任何客户端数值参与。落库仍走受凭据保护的 `phm_put_chart()`。

**断点续跑**：每次开始先拉一遍已有的 `chart_id`，已缓存的直接跳过。中断了重跑即可。

⚠ 约 7 GB 流量、20~40 分钟。刻意做成**串行** —— 并发下载对 Phira 不礼貌，
而且 `analyzeChart` 是同步计算，并发也压不出吞吐。

---

## 跑起来（本地）

```bash
cd phm-web
node server.mjs          # 默认 3000 端口
# 或指定端口
PORT=8080 node server.mjs
```

打开 <http://localhost:3000> 即可。

**注意**：云服务相关功能（账号、缓存读写）**只在注册的发布域名上工作**，
localhost 上会被服务端的 Origin 校验拒绝 —— 这是设计如此，不是 bug。
本地开发主要验证：解析、计算、UI 渲染。

**部署**：用 `sites` 能力发布 `phm-web/` 目录即可（这是一个 Node HTTP 服务）。

---

## 改代码前必须知道的三件事

### 1. 引擎必须保持"纯计算"

`public/js/engine.js` **同时被浏览器和 Node 服务端加载**。

> **它不能碰 DOM、localStorage、网络请求、文件系统。**

只能：`ArrayBuffer` 进 → 特征对象出。

**为什么**：服务端要靠它复算来验证客户端提交的定数（防投毒）。
一旦引擎里引入了浏览器专有 API，服务端就跑不起来，防投毒失效。

**加功能前先自问：这段代码在 Node 里能跑吗？**

### 2. 改完引擎一定要真实执行一次

历史上出过这样的事故：编辑时把 `=>` 的 `>` 吃掉了，变成 `en=({...})` ——
这是**合法语法**（把对象赋值给变量），`node --check` 和新 Function 都检查不出来，
但运行时会抛 `ReferenceError`，导致线上**所有谱面解析失败**。

**所以**：任何解析相关改动，必须真实跑一张谱面：

```bash
cd phm-web
node --input-type=module -e "
  import { analyzeChart } from './public/js/engine.js';
  import fs from 'node:fs';
  const f = fs.readdirSync('../谱面数据包').filter(x=>x.endsWith('.zip'))[0];
  const b = fs.readFileSync('../谱面数据包/'+f);
  const r = (await analyzeChart(b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength), f)).find(x=>!x.error);
  console.log(r ? '通过: ref='+r.knn.ref : '失败');
"
```

**语法检查 ≠ 功能验证。**

### 3. 前端是 `type="module"`，不是全局脚本

`index.html` 里的主逻辑是 ES module。它通过顶部这几行把引擎摊到全局：

```js
import * as __ENGINE from "/js/engine.js";
Object.assign(globalThis, __ENGINE);
```

所以下面的代码可以**继续直接写** `zipParse(...)` / `analyzeChart(...)`。
**但注意**：module 里定义的函数**不再是 window 属性**，
如果哪天要加内联事件（`onclick="..."`），那是坏的 —— 请继续用事件委托。

---

## 关键流程速查

### 拖入谱面（主路径）

```
用户拖入 .pez
  → handleFiles()            [index.html]
  → analyzeChart()           [engine.js]  本地解析，文件不出浏览器
  → 渲染卡片（参考定数 / PS / 特征）
  → 若开关开启：contributeChart() 逐张串行
       → 按谱名精确匹配 Phira chart_id
       → POST /api/contribute {chart_id, 特征}
            → server 复核（下载谱面 + 复算 + 比对）
            → 写入**服务端算出的值**
```

### 查询 Phira 账号

```
输入用户名/UID
  → pfFindUser() → pfSearch()        [index.html]
  → 取 B19 / 最近成绩 + 谱面信息（并发池 5）
  → 若是本人确认过的账号 → 自动导入成绩
```

### 修改数据库

数据库没有迁移文件，结构变更通过 MCP 工具执行 SQL 完成。
**改之前先读 `docs/DATA-MODEL.md`**，改完之后**同步更新那份文档** ——
文档和实际结构不一致是这个项目最容易犯的错。

---

## 常见坑（都踩过）

| 现象 | 原因 |
|---|---|
| 部署报 `service did not become reachable` | 沙箱偶发故障，**先本地 `node server.mjs` 复现**，本地正常就直接重试 |
| Windows 上 `pkill -f` 杀不掉 node | Git Bash 的 pkill 对 Windows 进程无效，用 PowerShell 按 CommandLine 匹配 |
| 本地打开页面但云功能报错 | 正常现象，见上文"跑起来" |
| 改了 `engine.js` 线上没生效 | 浏览器缓存了模块，硬刷新；或检查 `PHM_VER` 是否更新 |
| 服务端复核失败写不进库 | 看响应里的 `note` 字段，通常是图谱名匹配不上或下载超时 |

---

## 想深入了解

- **为什么这么设计** → `ARCHITECTURE.md`
- **谁能读写什么** → `DATA-MODEL.md`
- **信任边界在哪、还有什么没解决** → `SECURITY.md`
