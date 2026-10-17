-- ── 校验 Key：补 scopes / expires_at（旧 Key 默认全量）──
create or replace function public.hm_api_key_lookup(p_secret text, p_hash text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k public.hm_api_keys; m public.hm_api_key_meta;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select * into k from hm_api_keys where key_hash = p_hash;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into m from hm_api_key_meta where key_id = k.id;
  return jsonb_build_object(
    'ok', true, 'id', k.id, 'owner_id', k.owner_id, 'plan', k.plan,
    'revoked', k.revoked_at is not null,
    'scopes', coalesce(m.scopes, '{charts:read,analyses:write,usage:read}'::text[]),
    'expires_at', m.expires_at
  );
end $$;
