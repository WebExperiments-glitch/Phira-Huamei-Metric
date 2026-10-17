-- ── 列表（控制台；按创建时间倒序）──
create or replace function public.hm_api_key_list(p_secret text, p_owner text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'hint', hint, 'plan', plan,
      'created_at', created_at, 'last_used_at', last_used_at,
      'revoked_at', revoked_at
    ) order by created_at desc)
    from hm_api_keys where owner_id = p_owner
  ), '[]'::jsonb);
end $$;
