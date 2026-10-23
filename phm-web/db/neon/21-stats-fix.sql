-- ============================================================
-- 21-stats-fix.sql —— 修 phm_stats：它还在引用已经不存在的 player 列
-- ============================================================
-- 【为什么会有这条】
--   20-scores-fix.sql 把 phm_scores 整张表按真实字段重建了
--   （原来的 player / accuracy / max_combo 全是我猜错的），
--   但**忘了 phm_stats 里还在 select player**。
--
--   → 结果是 /api/stats 直接 500：column "player" does not exist。
--   这条错误的性质要记住：**改表结构时，最容易漏的是"读这张表的函数"**。
--   表和写入口都改了、也验了写入能读回来，唯独漏了统计函数 ——
--   因为它不在「写-读」这条主路径上。
-- ============================================================

/* review-gate: public-read
   这个函数**故意**没有 p_secret —— 它只回四个行数与最新引擎版本，
   给首页和 /status 用的公开累计量。给它加写凭据校验等于逼前端持有一把写钥匙，
   那是把安全模型弄反了。已开 RLS、表本身对 anon 全部 revoke，读不到任何明细。 */
create or replace function public.phm_stats()
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'charts',   (select count(*) from phm_charts),
    /* ⚠ 玩家数按 phira_user_name 去重 —— 数据飞轮提交的就是这个名字。
       原来的 player 列是我凭空造的，从来没有任何代码往里写过。 */
    'scores',   (select count(*) from phm_scores),
    'players',  (select count(distinct phira_user_name) from phm_scores
                  where phira_user_name is not null),
    'engine',   (select engine_build from phm_charts order by verified_at desc limit 1),
    'updated',  (select max(verified_at) from phm_charts)
  );
$$;

revoke all on function public.phm_stats() from public;
grant execute on function public.phm_stats() to anon, authenticated;
