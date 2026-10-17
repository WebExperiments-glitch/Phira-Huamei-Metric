-- ── 用量汇总（今日 / 7 日 / 30 日 + 按接口分布）──
create or replace function public.hm_api_usage_summary(p_secret text, p_owner text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', count(*) filter (where u.created_at >= now() - interval '1 day'),
    'week',  count(*) filter (where u.created_at >= now() - interval '7 days'),
    'month', count(*) filter (where u.created_at >= now() - interval '30 days'),
    'keys',  count(distinct u.key_id),
    'by_endpoint', (
      select coalesce(jsonb_object_agg(endpoint, n), '{}'::jsonb) from (
        select endpoint, count(*) n from hm_api_usage u2
        join hm_api_keys k2 on k2.id = u2.key_id
        where k2.owner_id = p_owner and u2.created_at >= now() - interval '30 days'
        group by endpoint
      ) s
    )
  ) into out
  from hm_api_usage u
  join hm_api_keys k on k.id = u.key_id
  where k.owner_id = p_owner;
  return coalesce(out, '{}'::jsonb);
end $$;
