-- ── 列表：补 scopes / expires_at ──
create or replace function public.hm_api_key_list(p_secret text, p_owner text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', k.id, 'name', k.name, 'hint', k.hint, 'plan', k.plan,
      'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
      'scopes', coalesce(m.scopes, '{charts:read,analyses:write,usage:read}'::text[]),
      'expires_at', m.expires_at
    ) order by k.created_at desc)
    from hm_api_keys k left join hm_api_key_meta m on m.key_id = k.id
    where k.owner_id = p_owner
  ), '[]'::jsonb);
end $$;
