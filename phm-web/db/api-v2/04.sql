-- ── 设置/更新某个 Key 的 scope 与过期时间 ──
create or replace function public.hm_api_key_meta_set(
  p_secret text, p_owner text, p_id uuid, p_scopes text[], p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare allowed text[] := '{charts:read,analyses:write,usage:read}'::text[];
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_scopes is null or array_length(p_scopes, 1) is null then
    raise exception 'scopes required' using errcode = 'P0001';
  end if;
  if not (p_scopes <@ allowed) then
    raise exception 'invalid scope' using errcode = 'P0001';
  end if;
  if not exists (select 1 from hm_api_keys where id = p_id and owner_id = p_owner and revoked_at is null) then
    return jsonb_build_object('ok', false);
  end if;
  insert into hm_api_key_meta (key_id, scopes, expires_at)
  values (p_id, p_scopes, p_expires_at)
  on conflict (key_id) do update set scopes = excluded.scopes, expires_at = excluded.expires_at;
  return jsonb_build_object('ok', true, 'scopes', p_scopes, 'expires_at', p_expires_at);
end $$;
