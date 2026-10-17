/* ============================================================
 * lib/contribute-routes.mjs —— /api/contribute 的准入：换票 + 验票
 * ============================================================
 * 拆出来的原因和 hm-code-routes.mjs 一样：server.mjs 有 900 行上限
 * （lint-slop 守着）。这里只放「换贡献凭证」和「读/验请求头里的凭证」，
 * 真正的写入逻辑仍在 server.mjs —— 它要用到限流闸、在途并发、数据库，
 * 那些依赖本来就属于装配层。
 *
 * 依赖全部由调用方注入，模块不 import server.mjs（避免循环依赖）。
 * ============================================================ */

/** @param deps {send, gate, gateAnalyze, readBody, chartInfo,
 *   issueTicket, verifyTicket, ticketAvailable, ticketCovers,
 *   ticketTtlMs, ticketMaxCharts}
 * @returns {ticketRoute, readTicket, covers} */
export function makeContributeRoutes(deps) {
  const {
    send, gate, gateAnalyze, readBody, chartInfo,
    issueTicket, verifyTicket, ticketAvailable, ticketCovers,
    ticketTtlMs, ticketMaxCharts,
    /* 写路径依赖（服务端复算）—— 由 server.mjs 注入，模块不直接 import 数据库层 */
    dbFetch, dbPutChart, reviewContribution, grosslyMismatched,
    tryEnter, rlLeave, contributeInflight,
  } = deps;

  /* ── POST /api/contribute/ticket ──
     用真实存在的 chart_id 换一张 5 分钟有效的 HMAC 凭证。
     只查 Phira 元数据（小 JSON），**不下载谱面**。 */
  async function ticketRoute(req, res, ip) {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (!ticketAvailable()) {
      /* 没有写凭据 ≠ 放行：fail-closed。贡献链路整体关闭。 */
      return send(res, 503, JSON.stringify({ error: 'ticket_unavailable' }));
    }
    /* 与 /api/analyze 共用配额：领票本身便宜，但它打开的是下载闸门。 */
    if (!(await gate(res, gateAnalyze({ ip }),
      '申请贡献凭证太频繁，请稍后再试'))) return;

    const body = await readBody(req, 16 * 1024);
    const raw = Array.isArray(body && body.chart_ids) ? body.chart_ids
      : (body && body.chart_id != null ? [body.chart_id] : null);
    if (!raw) return send(res, 400, JSON.stringify({ error: 'invalid request body' }));
    const wanted = [...new Set(raw.map(Number)
      .filter(n => Number.isInteger(n) && n > 0))].slice(0, ticketMaxCharts);
    if (!wanted.length) return send(res, 400, JSON.stringify({ error: 'chart_id 无效' }));

    const valid = [], rejected = [];
    for (const cid of wanted) {
      try {
        const info = await chartInfo(cid);
        if (info && info.file) valid.push(cid);
        else rejected.push(cid);
      } catch { rejected.push(cid); }
    }
    if (!valid.length) {
      return send(res, 400, JSON.stringify({ error: 'chart_id 不可用', rejected }));
    }
    const t = issueTicket(valid, { ip });
    return send(res, 200, JSON.stringify({
      ticket: t.ticket, exp: t.exp, ttl: ticketTtlMs,
      chart_ids: valid, rejected: rejected.length ? rejected : undefined,
    }));
  }

  /* ── 读并验请求头里的凭证 ──
     ⚠ 调用方必须**先调它、再读 body**：未认证请求连 body 解析都到不了，
       错误信息也不会回显请求结构（白帽靠 rows:[] 的报错推断出批量格式）。 */
  function readTicket(req, ip) {
    const raw = String(req.headers['x-phm-ticket'] || '').trim();
    if (!raw) {
      return {
        ok: false, status: 401,
        body: { error: 'contribution_ticket_required', hint: '刷新页面后重试（旧页面没有贡献凭证流程）' },
      };
    }
    const tv = verifyTicket(raw, { ip });
    if (!tv.ok) return { ok: false, status: 401, body: { error: tv.error } };
    return { ok: true, cids: tv.cids };
  }


  /* ── 服务端复核后落库 ──
     客户端报上来的特征值一律不直接采信：先查该 chart_id 是否已有权威值，
     没有就用服务端自己的引擎复算一遍（下载谱面 → 与提交值比对），
     一致才写，且**写入的是服务端算出来的值**。 */
  async function write(res, rows, clean, ticketCids) {
    /* 凭证必须覆盖本次要处理的每一个 chart_id —— 不能拿 A 谱的票写 B 谱。 */
    const wanted = clean.map(r => Number(r.chart_id));
    if (!ticketCovers(ticketCids, wanted)) {
      return send(res, 401, JSON.stringify({ error: 'ticket_chart_mismatch' }));
    }
    /* ⚠⚠ 在途并发上限。审计实测（2026-10-13）：/api/analyze 有
       analyzeInflight <= 3 的保护，而 /api/contribute **没有**。
       每一行通过校验的 chart_id 都会让服务端向 Phira 下载 ≤60MB 谱面
       并**同步**跑引擎 —— 同步跑会卡住整个 Node 事件循环。
       所以：拿不到名额就直接 503，**不要**占着事件循环排队。 */
    if (!tryEnter('contribute', contributeInflight)) {
      return send(res, 503, JSON.stringify({
        error: '服务端正在复算其他贡献，请稍后再试',
      }));
    }
    let verified = 0, skipped = 0, failed = 0, mismatched = 0;
    const notes = [];
    try {
      for (const row of clean) {
        try {
          const existing = await dbFetch(
            '/phm_charts?chart_id=eq.' + encodeURIComponent(row.chart_id) + '&select=chart_id');
          if (existing.ok && existing.body && existing.body !== '[]') { skipped++; continue; }

          const { trusted, diffs } = await reviewContribution(row);
          /* 差异**过大** → 两种可能：① 根本不是同一张谱；② 客户端没有排除自己。
             先按「不排除自己」的口径再算一次，对得上就接受（落库仍用排除口径）。 */
          const huge = grosslyMismatched(diffs);
          if (huge.length) {
            let rescued = null;
            try {
              const alt = await reviewContribution(row, { noExclude: true });
              if (!grosslyMismatched(alt.diffs).length) rescued = alt;
            } catch (e) { /* 兜底口径失败不影响主判定 */ }
            if (!rescued) {
              failed++;
              notes.push('提交特征与该谱号严重不符（疑似同名不同难度）→ 拒绝写入: '
                + huge.map(d => d.field).join(','));
              continue;
            }
            mismatched++;
            notes.push('客户端未排除自身参照（已按服务端排除口径落库）');
          }
          const wr = await dbPutChart(trusted);
          if (wr.ok > 0) {
            verified++;
            if (diffs.length) {
              mismatched++;
              notes.push('客户端值不一致（已改用服务端值）: ' + diffs.map(d => d.field).join(','));
            }
          } else { failed++; notes.push('写入失败: ' + String(wr.fail[0] || '').slice(0, 80)); }
        } catch (e) {
          failed++;
          notes.push(String(e.message || e).slice(0, 100));
        }
      }
    } finally {
      /* ⚠ 必须 finally —— 漏了 leave，一次抛错就把名额永久吃掉。 */
      rlLeave('contribute');
    }
    return send(res, 200, JSON.stringify({
      received: rows.length, accepted: clean.length, rejected: rows.length - clean.length,
      written: verified, skipped, failed,
      mismatched: mismatched || undefined,
      note: notes.length ? notes.slice(0, 3) : undefined,
      verified: true, source: 'server-verified',
      policy: '定数由服务端独立复算；落库值永远是服务端计算结果，客户端提交值仅用于一致性检查',
    }));
  }

  return { ticketRoute, readTicket, covers: ticketCovers, write };
}
