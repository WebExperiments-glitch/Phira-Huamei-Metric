-- ── 校验 key（每请求调用；只回最小字段）──
create or replace function public.hm_api_key_lookup(p_secret text, p_hash text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rec public.hm_api_keys;
begin
  -- ⚠ 同 10.sql：记录变量叫 rec（不叫 k），否则与 phm_secrets.k 撞名 → 42702。
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select * into rec from hm_api_keys where key_hash = p_hash;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object(
    'ok', true, 'id', rec.id, 'owner_id', rec.owner_id,
    'plan', rec.plan, 'revoked', rec.revoked_at is not null
  );
end $$;
