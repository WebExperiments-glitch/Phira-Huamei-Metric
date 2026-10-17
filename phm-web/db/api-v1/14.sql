-- ── 删除（吊销；不物理删，保留用量记录）──
create or replace function public.hm_api_key_revoke(
  p_secret text, p_owner text, p_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  update hm_api_keys set revoked_at = now()
    where id = p_id and owner_id = p_owner and revoked_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true);
end $$;
