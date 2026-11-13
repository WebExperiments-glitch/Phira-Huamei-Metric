/* lib/api-votes.mjs —— 人类难度标注（投票）
 *
 * 三个端点：
 *   GET  /votes/next?lo=&hi=   抽一张你没投过的谱
 *   POST /votes                投一票（可改）
 *   GET  /votes/today          今日进度
 *
 * 【为什么要「打不过」这个选项】
 *   用户抽到一张远超自己水平的谱，真实反应是关掉页面。
 *   如果不把这个行为收成数据，结果就是**难谱永远没票、样本严重偏向简单谱**。
 *   「我打不过」和「我觉得 16.0」一样是判断，而且更难伪造。
 *
 * 【为什么不强制注册】
 *   投票要的是量。让用户先注册再投票，等于没人投。
 *   主体用 cid:<浏览器UUID>（与查询历史同一套），绑账号后自然合并。
 */
export function makeVoteRoutes(deps) {
  const { requireScope, gateApi, callApiRpc, logUsage, apiErr, json, readBody } = deps;

  const rpcJson = (r) => { try { return JSON.parse(r && r.body) || {}; } catch { return {}; } };

  /* Phira 列表分页缓存：同一页 10 分钟内复用。
     抽谱是「随机页」的，命中率不高，但只要命中就省一次跨境往返（~1s）。 */
  const MAX_PAGE = 326;      /* /chart?page= 的实际上限（count 9758 / 30） */
  const PAGE_TTL = 10 * 60_000;
  const pageCache = new Map();

  async function fetchPhiraPage(page) {
    const hit = pageCache.get(page);
    if (hit && Date.now() - hit.ts < PAGE_TTL) return hit.rows;
    try {
      const r = await fetch('https://api.phira.cn/chart?page=' + page, {
        headers: { 'user-agent': 'phm-vote/1 (difficulty labelling)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const rows = Array.isArray(j && j.results) ? j.results : [];
      pageCache.set(page, { rows, ts: Date.now() });
      /* 缓存别无限长：超过 400 页就丢弃最旧的 */
      if (pageCache.size > 400) pageCache.delete(pageCache.keys().next().value);
      return rows;
    } catch (e) { return null; }
  }

  const cidOf = (req) => {
    const raw = String((req.headers && req.headers['x-phm-cid']) || '').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return 'cid:' + raw.toLowerCase();
    }
    return '';
  };

  return async function handleVotes(req, res, who, ip, p, qp) {
    const subject = (who && who.kind === 'account' && who.id ? 'acct:' + who.id : '') || cidOf(req);

    if (req.method === 'GET' && p === '/votes/next') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip))) return true;
      if (!subject) { json(res, 200, { ok: true, item: null, reason: 'no_subject' }); return true; }

      const lo = Number(qp.get('lo')) || 8;
      const hi = Number(qp.get('hi')) || 18;

      /* 实时从 Phira 抽，不依赖本地谱面表 —— 线上 phm_charts 只有 16 行，
         导入 1.4 万行要跨境跑几分钟且要一直同步，不如直接用上游。
         做法：随机页 → 拉 30 条 → 难度过滤 → 排除已投 → 随机取一条。
         ⚠ 列表端点只返回 tags 含 regular 的谱（9,758 张 / 326 页），
           plain 与 troll 拿不到。这是上游硬限制，对「标难度」够用。 */
      for (let attempt = 0; attempt < 4; attempt++) {
        const page = 1 + Math.floor(Math.random() * MAX_PAGE);
        const rows = await fetchPhiraPage(page);
        if (!rows || !rows.length) continue;

        const cands = rows.filter((c) => c && c.reviewed !== false
          && typeof c.difficulty === 'number' && c.difficulty >= lo && c.difficulty <= hi);
        if (!cands.length) continue;

        const ids = cands.map((c) => Number(c.id)).filter(Boolean).join(',');
        let voted = new Set();
        try {
          const hasR = await callApiRpc('hm_vote_has', { p_subject: subject, p_ids: ids });
          const arr = rpcJson(hasR);
          voted = new Set((Array.isArray(arr) ? arr : []).map(Number));
        } catch (e) { /* 查不到已投时按「全都没投」处理，宁可重复抽也不卡住 */ }

        const free = cands.filter((c) => !voted.has(Number(c.id)));
        if (!free.length) continue;

        const pick = free[Math.floor(Math.random() * free.length)];
        json(res, 200, {
          ok: true,
          item: {
            chart_id: Number(pick.id),
            name: pick.name || '',
            level: pick.level || '',
            difficulty: pick.difficulty,
            charter: pick.charter || '',
            ref_const: null,
            votes: 0,
            /* 谱面文件（.pez = zip）。前端拼成 /api/v1/file?u=... 同源中转下载，
               不直连上游 —— 直连会被防盗链挡，且跨域拿不到文件名。 */
            file: typeof pick.file === 'string' ? pick.file : '',
          },
        });
        return true;
      }
      json(res, 200, { ok: true, item: null, reason: 'no_candidate' });
      return true;
    }

    if (req.method === 'GET' && p === '/votes/today') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip))) return true;
      if (!subject) { json(res, 200, { ok: true, today: 0 }); return true; }
      const r = await callApiRpc('hm_vote_today', { p_subject: subject });
      json(res, 200, { ok: true, today: rpcJson(r).today || 0 });
      return true;
    }

    if (req.method === 'POST' && p === '/votes') {
      if (!requireScope(res, who, 'charts:read')) return true;
      if (!(await gateApi(res, who, ip, { endpoint: '/votes' }))) return true;
      if (!subject) { json(res, 200, { ok: false, reason: 'no_subject' }); return true; }

      const body = await readBody(req, 2 * 1024);
      const chartId = Number((body && body.chart_id) || 0);
      if (!chartId || chartId < 1) {
        apiErr(res, 400, 'invalid_request_error', 'bad_chart_id', 'chart_id must be a positive integer');
        return true;
      }
      const verdict = String((body && body.verdict) || 'rated');
      const value = body && body.value != null ? Number(body.value) : null;
      if (verdict === 'rated' && (!Number.isFinite(value) || value < 1 || value > 25)) {
        apiErr(res, 400, 'invalid_request_error', 'bad_value', 'value must be between 1 and 25');
        return true;
      }
      const t0 = Date.now();
      const r = await callApiRpc('hm_vote_put', {
        p_subject: subject,
        p_chart_id: chartId,
        p_verdict: verdict,
        p_value: verdict === 'rated' ? value : null,
        p_played: !!(body && body.played),
        p_band: body && body.band != null ? Number(body.band) : null,
      });
      logUsage(who, '/votes', r && r.ok ? 200 : 502, null, t0);
      if (!r || !r.ok) { apiErr(res, 502, 'server_error', 'vote_failed', 'could not record vote'); return true; }
      json(res, 200, rpcJson(r));
      return true;
    }

    return false;
  };
}
