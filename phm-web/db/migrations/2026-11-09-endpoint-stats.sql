-- 管理员：按端点聚合调用情况（只覆盖带 Key 的调用 —— 匿名不写 usage 表）
--   ⚠ 为什么不记匿名：无状态部署下每次请求一次写，等于给被打时的数据库加码。
--     匿名的健康度由状态页监控负责（7 条探针），两边分工。
begin;

create or replace function public.hm_admin_endpoint_stats(p_secret text, p_hours int default 24)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rows jsonb; since timestamptz;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  since := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));

  select coalesce(jsonb_agg(x order by (x->>'calls')::int desc), '[]'::jsonb) into rows
  from (
    select jsonb_build_object(
      'endpoint', coalesce(nullif(endpoint, ''), '(unknown)'),
      'calls', count(*),
      'errors', count(*) filter (where status >= 400),
      'p50_ms', coalesce(percentile_disc(0.5) within group (order by duration_ms), 0),
      'max_ms', coalesce(max(duration_ms), 0),
      'last_at', max(created_at)
    ) as x
    from hm_api_usage
    where created_at > since
    group by coalesce(nullif(endpoint, ''), '(unknown)')
  ) t;

  return jsonb_build_object('ok', true, 'hours', p_hours, 'endpoints', rows);
end $$;

revoke all on function public.hm_admin_endpoint_stats(text, int) from public;
grant execute on function public.hm_admin_endpoint_stats(text, int) to anon, authenticated;

commit;
