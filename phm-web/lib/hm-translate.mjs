/**
 * lib/hm-translate.mjs —— 搜索查询的翻译代理
 *
 * ## 这是干什么的
 *
 * 客户端的搜索支持「中文 → 日文/英文」多语言扩展：把「无呼吸义务」
 * 同时用原文、日文、英文各搜一遍，再合并去重。这样中文用户能搜到
 * 只有日文标题的谱面（Phira 官方搜索只做字符串匹配）。
 *
 * 翻译**必须走服务端**，不能让客户端直连：
 *   · 实测 `translate.googleapis.com` 在国内移动网络直连失败（HTTP 000）
 *   · 第三方 API 的密钥塞进客户端既不安全也没法换 provider
 *   · 服务端能做缓存 —— 热门查询只需真正翻译一次
 *
 * ## 失败策略
 *
 * 任何失败都返回 `{ja: null, en: null}` 而不是报错。
 * 客户端把翻译当作**增强**：拿不到就只用原文搜，用户无感。
 * 翻译服务挂了绝不能让搜索变差。
 */

/** 查询缓存。key = 原文，value = {ja, en}。 */
const CACHE = new Map();
/** 上限。超出整体清空 —— 简单可靠，不值得为它写 LRU。 */
const CACHE_LIMIT = 512;
/** 单次查询的长度上限，防止被当成免费翻译接口刷。 */
const MAX_QUERY_LEN = 80;

/**
 * 调翻译服务。
 *
 * 用 `translate_a/single` 这个公开端点：无 key、返回快、够用。
 * 它不是正式 API（可能随时失效），所以**必须有超时和降级**。
 */
async function translateOne(text, target) {
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx' +
      `&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, {
      // 2.5 秒：翻译是次要信息，不能让搜索等它
      signal: AbortSignal.timeout(2500),
      headers: { 'user-agent': 'phm-web/1.0 (+translate)' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    // 返回形如 [[["译文","原文",...], ...], ...]，把各段拼起来
    if (!Array.isArray(j) || !Array.isArray(j[0])) return null;
    const out = j[0]
      .map((seg) => (Array.isArray(seg) ? seg[0] : ''))
      .filter(Boolean)
      .join('');
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 直接尝试处理翻译请求；不是这个路径就返回 false（调用方继续往下派发）。
 *
 * 做成「一行接入」是刻意的：server.mjs 有 900 行硬上限，多一行都塞不进去。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {string} p 路径
 * @param {Function} send
 * @returns {Promise<boolean>}
 */
export async function tryTranslateRoute(req, res, url, p, send) {
    if (p !== '/api/hm/translate') return false;
    {
    if (req.method !== 'GET') {
      return send(res, 405, JSON.stringify({ error: 'GET only' }));
    }

    const q = (url.searchParams.get('q') || '').trim();
    if (!q) {
      return send(res, 400, JSON.stringify({ error: 'missing q' }));
    }
    if (q.length > MAX_QUERY_LEN) {
      return send(res, 400, JSON.stringify({ error: 'q too long' }));
    }

    const hit = CACHE.get(q);
    if (hit) {
      return send(res, 200, JSON.stringify(hit), {
        'content-type': 'application/json; charset=utf-8',
        'x-cache': 'hit',
      });
    }

    // 日英并行，任何一个失败都不影响另一个
    const [ja, en] = await Promise.all([translateOne(q, 'ja'), translateOne(q, 'en')]);
    const out = { ja, en };

    /* 只在真的有结果时缓存：翻译服务临时挂掉时不要把 null 缓存住，
       否则那首歌永远搜不到日文版。 */
    if (ja || en) {
      if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
      CACHE.set(q, out);
    }

    send(res, 200, JSON.stringify(out), {
      'content-type': 'application/json; charset=utf-8',
    });
    return true;
    }
}
