-- ── 读取探测历史（并顺带清理过期行） ──
create or replace function public.hm_status_get(
  p_secret text, p_since bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cutoff bigint;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_since is null then
    raise exception 'since required' using errcode = 'P0001';
  end if;

  /* ⚠ 清理放在**读**路径上，不建定时任务。
     托管环境没有可靠的 cron，而这张表一天最多长9×24=216 行，
     不清也不会失控；顺带清理的成本只是一条索引友好的 delete。
     多留 30 天 = 最多 6480 行，可忽略。 */
  cutoff := p_since - 30 * 24;
  delete from hm_status_hour where hour < cutoff;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'target', target, 'hour', hour, 'up_milli', up_milli,
      'ms', ms, 'ok', ok, 'n', n
    ) order by hour)
    from hm_status_hour
    where hour >= p_since
  ), '[]'::jsonb);
end $$;