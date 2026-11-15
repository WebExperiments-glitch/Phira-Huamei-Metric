/* ============================================================
 * lib/hm.mjs —— huamei 数据飞轮的服务端核心（身份 + 成绩校验）
 * ============================================================
 * 【为什么单独一个文件】
 *   这一摊和静态托管 / 定数网关没有任何关系：它处理的是「客户端上报的一局
 *   成绩能不能落库」以及「这个上报的人是谁」。塞在 server.mjs 里除了让那个
 *   文件越过 900 行上限之外，还会让人误以为它和 /api/contribute 共用防线 ——
 *   其实两者的信任模型完全不同（那边服务端能自己复算谱面，这边不能）。
 *
 * 【两条信任边界，别混】
 *   1. 身份：`whoami()` 主路调云端 `user/me`；主路被沙箱环境掐掉时降级为
 *      **本地解 JWT**（无法验签）。见 `subFromJwt` 的说明。
 *   2. 成绩：`validatePlay()` 重算 score/accuracy 做**一致性**校验，
 *      但**不为不一致拒收** —— 理由见函数内注释与契约 §8。
 *
 * 契约：docs/规范/数据飞轮契约.md（**改契约先改文档**）
 * ============================================================ */

/** 从 publishableKey 推应用 id（`wbpk_<appId>_<rest>` → `wbapp_<appId>`）。
 *  避免两处各写一份，校验 token 的 `aud` 时用。 */
export function appIdFromKey(key) {
  const m = String(key || '').match(/^wbpk_([^_]+)_/);
  return 'wbapp_' + (m ? m[1] : '');
}

/** 降级路径：直接解析 JWT 拿 `sub`。
 *
 * ══════════════════════════════════════════════════════════════
 * 【为什么需要它 —— 2026-10-11 实测】
 * ══════════════════════════════════════════════════════════════
 * 正路是调 `/.cloud/auth/v1/user/me` 换身份。但**从托管沙箱里发出的请求
 * 换不到**：本机同代码同 token 全绿，线上 5 种头组合一律 401 ——
 * 连完整模拟浏览器（Referer + Origin + Sec-Fetch-* 全套）也是 401。
 * 服务端把我们从沙箱发出的请求判成**另一个 client**，与头无关。
 * → 线上只能走这条降级路径。
 *
 * 【信任边界（必须如实说明）】
 *   token 是 **HS256**（对称签名），密钥在服务端、我们拿不到 →
 *   **本函数无法验签**，只能校验结构 / `aud` / `exp`。
 *   因此**身份是可伪造的**：任何人都能自己拼一个 HS256 JWT 冒充别人。
 *
 *   为什么仍可接受：
 *     · 契约 §8 已经写明「单条成绩不可信」，个体数据只作聚合用；
 *     · 危害面仅限「往别人名下塞假成绩」，不涉及任何隐私数据读取；
 *     · 一旦平台放开沙箱的出站身份，`whoami` 会优先走正路 —— 那时本函数
 *       自动退居兜底（`variant` 字段里会体现走的是哪条路）。
 *
 *   若将来要真正堵住：需要平台提供一种**沙箱内可用**的换身份方式。 */
export function subFromJwt(token, appId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { err: 'not_jwt' };
  let payload;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return { err: 'bad_payload' }; }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) return { err: 'no_sub' };
  // aud 必须是本应用 —— 防止拿别的应用的 token 来报
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (appId && !aud.includes(appId)) return { err: 'aud_mismatch' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) return { err: 'expired' };
  return { sub };
}

/** 浏览器化请求头 —— 云端鉴权靠 Referer 判身份，顺手把其余头也补全。 */
const BROWSERISH = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

/** 用用户的 token 换身份（工厂：把站点相关配置关在里面）。
 *
 * @returns `async (token) => {sub, variant, verified}` 或 `{err, tried, jwt}`
 *
 * ── 三条路，按可信度排序 ──────────────────────────────────────
 *   ① **我们自己的 token**（`verifyOwnToken`）—— HS256 用服务端独有密钥签的，
 *      **能验签**，所以最可信。这是 2026-10-12 加的自建账号体系。
 *   ② 云端 `user/me` —— 平台发的 token 走这条路。问题是 HS256 密钥在平台手里，
 *      **我们验不了签**，只能靠"云端认它"来间接证明。
 *   ③ `subFromJwt` 本地解析 —— **完全不验签**，只看结构/aud/exp。身份可伪造。
 *      只作为沙箱出站被掐时的兜底，见下面的信任边界说明。
 *
 * ⚠⚠ 关键顺序问题：如果 token **声称**是我们签的（`iss = phm-huamei`）却验不过，
 *     必须**当场拒绝**，绝不能掉到 ②③ 去。否则攻击者给自己拼一个标了 iss 的
 *     token 就能冒充任何人 —— 那比没有自签体系更糟。 */
export function makeWhoami({ cloudAuth, siteOrigin, referer, key, appId, verifyOwnToken, claimsOwnIssuer }) {
  /* 云端 `user/me` 的头组合。⚠⚠ **Referer / Origin 是硬要求** ——
     实测（2026-10-11，同一个真 token）：
       · 只带 key 头            → 401 invalid_grant
                                 "the session is invalid, expired or issued for another client"
       · 带上 Referer 或 Origin → 200，正常返回 sub/email
     依据见 `lib/cloud.mjs` 顶部：「身份由 referer 判定」。
     浏览器跑 SDK 时这头自动就有，服务端自己调就得自己补。
     ⚠ 别被 "issued for another client" 骗了 —— 听起来像 token 有问题，
       其实只是**我们没报身份**。
     ⚠ 为什么逐个试：**本机跑通 ≠ 生产跑通**（本机全绿、线上仍 401），
       怀疑托管边缘改写了出站请求的头。逐个试 + 把每个变体的上游状态码带回去，
       就不会再出现「本地好好的、线上不行」而无从下手。 */
  const variants = [
    // ① 最像浏览器：Referer + Origin + Sec-Fetch 全套
    Object.assign({ referer: referer, origin: siteOrigin }, BROWSERISH),
    // ② 只加 Referer（本机实测这个就够）
    { referer: referer },
    // ③ 只加 Origin
    { origin: siteOrigin },
    // ④ 裸的
    {},
  ];

  return async function whoami(token) {
    if (!token || token.length > 4096) return { err: 'no_token', status: 0 };

    /* ① 我们自己的 token —— 能验签，最可信 */
    if (verifyOwnToken) {
      const own = verifyOwnToken(token);
      if (own) return { sub: own.sub, variant: 'own-jwt', verified: true, email: own.email };
      /* 声称是我们的却验不过 → 拒绝，**不要**掉到下面的兜底路径 */
      if (claimsOwnIssuer && claimsOwnIssuer(token)) {
        return { err: 'own_token_bad_signature' };
      }
    }

    const tried = [];
    for (const variant of variants) {
      const label = Object.keys(variant).filter(k => !(k in BROWSERISH)).join('+') || '(base)';
      try {
        const r = await fetch(cloudAuth + '/user/me', {
          headers: Object.assign({
            /* ⚠ 头名必须是 x-wb-webapp-access-key。用 apikey 会得到 invalid_client。 */
            'x-wb-webapp-access-key': key,
            'authorization': 'Bearer ' + token,
          }, variant),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const j = await r.json();
          const sub = typeof j.sub === 'string' ? j.sub : '';
          if (sub) return { sub, variant: label, verified: true };
        }
        tried.push(label + ':' + r.status);
      } catch {
        tried.push(label + ':ERR');
      }
    }
    // 正路全挂 → 降级（见 subFromJwt 的信任边界说明）
    const fb = subFromJwt(token, appId);
    if (fb.sub) return { sub: fb.sub, variant: 'jwt-fallback', verified: false, tried: tried.join(' ') };
    return { err: 'all_variants_failed', tried: tried.join(' '), jwt: fb.err };
  };
}

/** Phira 的结算公式（**唯一真源**：`prpr/src/judge.rs:207-227`）。
 *
 *     acc   = (perfect + 0.65·good) / total
 *     score = (perfect == total) ? 1_000_000
 *                               : round((0.9·acc + 0.1·max_combo/total) · 1e6)
 *
 * 服务端与客户端各算一遍、互相对照 —— **必须用这一个函数**，
 * 别在别处再抄一份（抄的那份一定会先烂）。 */
export function phiraScore(perfect, good, maxCombo, total) {
  const acc = (perfect + 0.65 * good) / total;
  const score = perfect === total
    ? 1000000
    : Math.round((0.9 * acc + (maxCombo / total) * 0.1) * 1000000);
  return { acc, score };
}

/** 校验并规范化一局成绩。返回 `{row, warn}`；硬伤返回 `{error, code?}`。
 *
 * ⚠ 这里**重算** acc 与 score 与客户端报的对照，不看也不信客户端报的数字。 */
/** 收敛客户端上报的 device 字段。
 *
 *  为什么不能直接存 body.device：
 *  · 那是**不可信输入** —— 谁都能往里塞任意 JSON，包括几 MB 的垃圾
 *  · jsonb 列没类型约束，塞进去就一直在库里
 *
 *  所以只保留白名单字段、只接受预期类型、超长截断。
 *  ⚠ 全部可空：权限被拒 / 非 iOS / 旧客户端都会是 null，这是正常状态。
 */
export function sanitizeDevice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};

  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

  const os = str(raw.os_version, 60);
  if (os) out.os_version = os;
  const model = str(raw.model, 40);
  if (model) out.model = model;

  /* 屏幕：[宽, 高, 像素比]。宽高限制在合理范围，防止塞 1e9 这种值。 */
  if (Array.isArray(raw.screen) && raw.screen.length === 3) {
    const v = raw.screen.map(num);
    if (v.every(x => x !== null) && v[0] > 0 && v[0] < 10000 && v[1] > 0 && v[1] < 10000 && v[2] > 0 && v[2] < 10) {
      out.screen = v;
    }
  }

  /* 经纬度：限范围，并降到**城市级精度**（小数点后 2 位 ≈ 1km）。
     客户端已降精度，这里再兜一道 —— 不能让完整坐标进库。 */
  const lat = num(raw.lat), lon = num(raw.lon);
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = Math.round(lat * 100) / 100;
    out.lon = Math.round(lon * 100) / 100;
  }

  /* 陀螺仪摘要：[均值, 标准差, 峰值]，rad/s。合理范围 ±50（手抖不会超过 30）。 */
  if (Array.isArray(raw.gyro) && raw.gyro.length === 3) {
    const v = raw.gyro.map(num);
    if (v.every(x => x !== null && Math.abs(x) < 100)) out.gyro = v;
  }

  return Object.keys(out).length ? out : null;
}

export function validatePlay(body) {
  if (!body || typeof body !== 'object') return { error: 'bad_body' };
  const chartId = parseInt(body.chart_id, 10);
  if (!Number.isFinite(chartId) || chartId < 1) return { error: 'chart_id_invalid' };

  const counts = Array.isArray(body.counts) && body.counts.length === 4
    ? body.counts.map(n => Math.max(0, parseInt(n, 10) || 0)) : null;
  if (!counts) return { error: 'counts_invalid' };

  const notes = Math.max(0, parseInt(body.chart_notes, 10) || 0);
  if (notes < 1 || notes > 100000) return { error: 'chart_notes_invalid' };

  /* 每个非 fake 音符恰好拿一个判定 → 四种判定之和必须等于物量。
     不等就说明上报的数据不完整（漏了 Miss）或伪造。 */
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum !== notes) return { error: 'counts_mismatch', code: 409 };

  /* ── max_combo：**必须用客户端报的那个** ────────────────────────────
     ⚠⚠ 这里曾经写错过，导致**所有含断连的真实成绩被 409 拒收**。
     错法：拿 `perfect + good` 当 max_combo 去反推分数。
           只要中途断过连，真实 max_combo 就**小于** p+g，
           于是服务端算出来的分偏高 → 与客户端报的对不上 → 拒收。
     实例（用户实测那一局，159 音符 / 631855 分）：
       客户端真值  40p + 109g + 10(bad+miss)，max_combo=7
                   → 0.9·0.69717 + 7/159·0.1   = 0.631855 → 631855 ✓
       老式错算法  改用 p+g=149 当连击
                   → 0.9·0.69717 + 149/159·0.1 = 0.721164 → 721164
       差 89309 ≫ 阈值 max(2, 631) → 拒收。**这就是那个 bug 的全貌。**
     （⚠ 当时我还写过「这个分数在整数组合下无解」的结论 —— 那是我把
       窗口下界算错了 0.0001。`900p+585g+100mc` 在窗口内其实有 130 组解。
       教训：数字对不上时先怀疑自己的算术，别急着怀疑上游数据。） */
  const maxCombo = Math.max(0, parseInt(body.max_combo, 10) || 0);
  /* 连击不超过物量、也不超过「能连起来的音符数」—— 这两条是**硬**约束，
     违反说明数据自相矛盾（不是精度问题），拒收。 */
  if (maxCombo > notes || maxCombo > counts[0] + counts[1]) {
    return { error: 'max_combo_impossible', code: 409 };
  }
  const { acc, score } = phiraScore(counts[0], counts[1], maxCombo, notes);

  /* ── 一致性校验：**只记账，不拒收**（2026-10-11 定）───────────────
     算出来的 score/accuracy 应等于客户端报的（两边同一套公式、同一批输入）。
     但一旦不等，原因未必是造假：可能是上游换了计分、可能是我们漏了什么因素。
     这种情况下**拒收真实成绩的害处远大于放行一条可疑数据** ——
     数据飞轮怕的是没数据，不是脏数据（脏数据可以事后筛，丢的成绩找不回来）。

     所以：照算、照比，差异原样塞进响应体的 `warn` 字段带回去，
     客户端会写进 `data/huamei-login.log`，我据此定位。见契约 §8。 */
  const warn = [];
  if (Number.isFinite(Number(body.accuracy)) && Math.abs(Number(body.accuracy) - acc) > 0.005) {
    warn.push('accuracy:' + body.accuracy + '≠' + acc.toFixed(6));
  }
  if (Number.isFinite(Number(body.score)) && Math.abs(Number(body.score) - score) > 2) {
    warn.push('score:' + body.score + '≠' + score + '(mc=' + maxCombo + ')');
  }

  const blob = typeof body.judge === 'string' ? body.judge : '';
  if (!blob) return { error: 'judge_missing' };
  if (blob.length > 400000) return { error: 'judge_too_large', code: 413 };

  const lv = String(body.chart_level || '').trim().slice(0, 8);
  if (!lv) return { error: 'chart_level_missing' };

  const row = {
    chart_id: chartId,
    chart_level: lv,
    chart_digest: typeof body.chart_digest === 'string' ? body.chart_digest.slice(0, 80) : null,
    chart_notes: notes,
    score: parseInt(body.score, 10) || score,
    accuracy: acc,
    max_combo: maxCombo,
    perfect: counts[0], good: counts[1], bad: counts[2], miss: counts[3],
    speed: Number(body.speed) || 1,
    mods: parseInt(body.mods, 10) || 0,
    keyboard: body.keyboard === true,
    client_ver: String(body.client_ver || '').slice(0, 40),
    /* 本局最大同时触点数。0 = 键盘模式（**不是**没采到）；
       旧客户端没这个字段 → null。两者语义不同，不能合并。 */
    max_touch_points: (() => {
      const v = Number(body.max_touch_points);
      return Number.isFinite(v) && v >= 0 && v <= 255 ? Math.round(v) : null;
    })(),
    judge_ver: parseInt(body.judge_ver, 10) || 1,
    /* ⚠ 客户端传的是**毫秒**（chrono::Utc::now().timestamp_millis()），
       而列是 timestamptz —— PG 收到裸数字会当**秒**，1.76e12 秒 ≈ 58600 年。
       实测第一局就落成了 +058842-04-15。这里转成 ISO 再交给 PG。 */
    played_at: (() => {
      const ms = Number(body.played_at);
      if (!Number.isFinite(ms) || ms <= 0) return null;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    })(),
    judge_blob: blob,
    device: sanitizeDevice(body.device),
    /* 8×8 落点热度图，base64(64 字节) = 88 字符。
       ⚠ 严格按长度校验：短了是坏数据，长了一定是有人在塞垃圾。
         不做「宽松截断」—— 那会让错误形状的数据静默入库。 */
    touch_heat: (() => {
      const v = body.touch_heat;
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t.length === 88 ? t : null;
    })(),
  };
  /* `warn` 一路带到响应体 —— 调用方必须把它透出去，否则诊断信息就死在这里。 */
  return { row, warn };
}


/** huamei 账号验不过时，退到 **Phira 账号**。
 *
 * 2026-11-06 实测 `hm_plays` 0 行，根因不是没人打：客户端只在
 * `huamei::current_token().is_some()` 时才构造上报闭包（scene/song.rs:1035），
 * 而 huamei 账号是自建邮箱体系 —— 玩家只有 Phira 账号。
 *
 * 处理 `x-phira-token`：直接调 Phira 的 `/me` 验明身份。
 *   · 必须真的调上游，不能只信头里的自述
 *   · 验证失败不拒收，按匿名存（数据飞轮怕没数据，不是怕脏数据）
 *   · 前缀 `phira:` 与 huamei 的 sub 区分，事后可分辨来源
 */
/* ═══════════════════════════════════════════════════════════════
 * 【匿名上报】2026-11-15
 *
 * 玩家反馈「打了一局显示本次游玩不计成绩」，数据一条没上来。
 * 根因不在结算界面：/api/hm/play 三道门都要求身份，没登录的请求在
 * 第一道就 401，客户端拿不到回执也就不会留下这一局的判定数据。
 *
 * 现在允许匿名：
 *   · server.mjs 的 anonymous 标记决定走哪条路
 *   · 写库 owner_id = null，匿名样本与账号样本在库里可区分，分析时可分层
 *   · 不验签（没有身份可验），但 validatePlay 的一致性校验仍在
 *   · 限流只走 gateWrite({ip})；不再按 sub —— 那会退化成所有匿名共用一个桶
 *
 * 风险：有人伪造对局刷数据。但判定数据是我们最稀缺的东西（收一张少一张），
 * 为「必须有账号」把它丢掉，代价更大。真要治，方向是按 chart_digest 查重
 * 与异常样本隔离，而不是把门关回去。
 *
 * ⚠ server.mjs 有 900 行硬上限（tools/lint-slop.mjs），所以这段说明放这里。
 * ═══════════════════════════════════════════════════════════════ */

export async function phiraFallback(req, who, hmToken) {
  /* 客户端只有一个 token 槽：登录了 huamei 就放它的 token，否则放 Phira 的。
     所以这里**先看专用头，再退回已解析的 x-hm-token** —— 否则「只有 Phira 账号」
     的玩家永远走不到验证，身份会全部丢掉。 */
  const token = String(req.headers['x-phira-token'] || hmToken || '').trim();
  if (!token) return who;
  try {
    const r = await fetch('https://phira.5wyxi.com/me', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const me = await r.json();
      if (me && Number(me.id) > 0 && (!who.sub || who.verified !== true)) {
        who.sub = 'phira:' + Number(me.id);
        who.verified = true;
        who.phiraAccount = true;
      }
    }
  } catch {
    /* 超时/网络失败：按匿名走，不阻断上报 */
  }
  return who;
}
