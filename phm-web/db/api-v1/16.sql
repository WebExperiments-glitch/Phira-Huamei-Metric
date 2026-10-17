-- ── 记一条用量 ──
create or replace function public.hm_api_usage_log(
  p_secret text, p_key_id uuid, p_endpoint text, p_status int, p_chart_id int, p_duration_ms int
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  insert into hm_api_usage (key_id, endpoint, status, chart_id, duration_ms)
  values (p_key_id, left(p_endpoint, 80), p_status, p_chart_id, p_duration_ms);
end $$;
