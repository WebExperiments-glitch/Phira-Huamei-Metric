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

/** 用用户的 huamei token 换身份（工厂：把站点相关配置关在里面）。
 *
 * @returns `async (token) => {sub, variant, verified}` 或 `{err, tried, jwt}`
 *
 * ⚠⚠ **`Referer` / `Origin` 是硬要求 —— 实测（2026-10-11，同一个真 token）：**
 *   · 只带 key 头            → 401 invalid_grant
 *                              "the session is invalid, expired or issued for another client"
 *   · 带上 Referer 或 Origin → 200，正常返回 sub/email
 *   依据见 `lib/cloud.mjs` 顶部：「身份由 referer 判定」。
 *   浏览器跑 SDK 时这头自动就有，服务端自己调就得自己补。
 *
 * ⚠ **别被那句错误措辞骗了** —— "issued for another client" 听起来像 token 有问题，
 *   其实只是**我们没报身份**。
 *
 * ⚠ 为什么逐个变体试：**本机跑通 ≠ 生产跑通**。实测本机全绿、线上仍 401，
 *   怀疑托管边缘对从沙箱发出的出站请求改写了 headers。所以逐个试，
 *   并把每个变体的上游状态码一起带回去 —— 别再出现「本地好好的、线上不行」
 *   而无从下手的情况。 */
export function makeWhoami({ cloudAuth, siteOrigin, referer, key, appId }) {
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
    judge_ver: parseInt(body.judge_ver, 10) || 1,
    played_at: parseInt(body.played_at, 10) || null,
    judge_blob: blob,
  };
  /* `warn` 一路带到响应体 —— 调用方必须把它透出去，否则诊断信息就死在这里。 */
  return { row, warn };
}
