-- ============================================================
-- 21.sql —— hm_rate 孤儿行回收（表只增不减会把云服务额度吃光）
-- ============================================================
-- 【症状】
--   2026-10-21 收到「P.H.M. 应用云服务额度不足」。查下来最大的表是 hm_rate：
--   **12,215 行 / 809 个 key**，而时间跨度只有 3.9 天 —— 约 3,100 行/天。
--   全库其他表加起来才几 MB，问题集中在这一张。
--
-- 【根因】
--   `hm_rate_hit()` 里那句 `DELETE ... WHERE k = p_key AND t <= cutoff`
--   只清**同一个 key** 的过期行。于是：一个 key 用过之后再也不会出现时
--   （换 IP、一次性访客、不同路由），它的行就**永远留在表里** —— 没人会再来删它。
--   表只增不减。
--
-- 【修法】
--   在 `hm_rate_hit` 里加一次**概率性全局清扫**：
--   早于 48 小时的行一定不在任何窗口内（最长的窗口是 analyze 的「每日」），
--   48 小时是故意留的余量，不是精确值。
--   ⚠ 为什么用概率而不是每次请求都扫：每次限流请求都带一条全表 DELETE，
--     等于给热路径加一次全表扫描。1/64 的概率下，按实测量级每天扫几十次，
--     足够把行数压住，而代价可以忽略。
--   ⚠ 为什么不用定时任务：托管环境没有可靠的 cron（见 18.sql 同一理由）。
--
-- 【验证】
--   跑完后 `select count(*) from hm_rate` 应回落到几百行量级。
-- ============================================================

create or replace function public.hm_rate_hit(
  p_secret text, p_key text, p_max integer, p_window_ms bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; n bigint; cutoff bigint;
begin
  select v into s from phm_secrets where k='writer';
  if s is null or p_secret is null or p_secret != s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  cutoff := (extract(epoch from clock_timestamp()) * 1000)::bigint - p_window_ms;
  /* 先回收过期行，再数窗口内的 —— 同一个语句里做完，避免竞态。
     ⚠ 这句只管**同一个 key**：用过的 key 不再出现时，它的行没人删（本次要修的）。 */
  delete from hm_rate where k = p_key and t <= cutoff;
  select count(*) into n from hm_rate where k = p_key;
  if n >= p_max then
    select min(t) into cutoff from hm_rate where k = p_key;
    return jsonb_build_object('ok', false,
      'reset_ms', greatest(0, coalesce(cutoff, 0) + p_window_ms - (extract(epoch from clock_timestamp()) * 1000)::bigint));
  end if;
  insert into hm_rate (k, t) values (p_key, (extract(epoch from clock_timestamp()) * 1000)::bigint);

  /* ⭐ 本次新增：概率性全局清扫。
        最长的限流窗口是 analyze 的「每日」，所以 48 小时之外的行
        在任何窗口里都已经无效 —— 留着只是白占存储。
        实测背景：12,215 行 / 809 个 key，其中绝大多数是"再也不出现的 key"
        留下的孤儿，表因此只增不减，最终把应用云服务额度吃光。 */
  if random() < 0.015625 then   -- 1/64
    delete from hm_rate
    where t < (extract(epoch from clock_timestamp()) * 1000)::bigint - 172800000;
  end if;

  return jsonb_build_object('ok', true, 'remaining', p_max - n - 1);
end $$;

-- 权限：先收回，再显式授权（2026-10-20 的教训：只 revoke 不 grant = 部署后 permission denied）
revoke all on function public.hm_rate_hit(text, text, integer, bigint) from public, anon, authenticated;
grant execute on function public.hm_rate_hit(text, text, integer, bigint) to anon, authenticated;

-- 顺手把已经积下的 12,000+ 行孤儿清掉（这一次性操作；之后由上面的概率清扫兜住）
delete from hm_rate
where t < (extract(epoch from clock_timestamp()) * 1000)::bigint - 172800000;
