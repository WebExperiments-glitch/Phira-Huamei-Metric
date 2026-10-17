-- ── touch last_used_at（失败不影响请求）──
create or replace function public.hm_api_key_touch(p_secret text, p_hash text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  update hm_api_keys set last_used_at = now() where key_hash = p_hash;
end $$;
