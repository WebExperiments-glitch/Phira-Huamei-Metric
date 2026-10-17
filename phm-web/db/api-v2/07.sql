-- ── 按 Key 汇总用量 ──
create or replace function public.hm_api_usage_key_summary(p_secret text, p_key_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', count(*) filter (where created_at >= now() - interval '1 day'),
    'week',  count(*) filter (where created_at >= now() - interval '7 days'),
    'month', count(*) filter (where created_at >= now() - interval '30 days'),
    'by_endpoint', coalesce((
      select jsonb_object_agg(endpoint, n) from (
        select endpoint, count(*) n from hm_api_usage
        where key_id = p_key_id and created_at >= now() - interval '30 days'
        group by endpoint
      ) s
    ), '{}'::jsonb)
  ) into out from hm_api_usage where key_id = p_key_id;
  return coalesce(out, '{}'::jsonb);
end $$;
