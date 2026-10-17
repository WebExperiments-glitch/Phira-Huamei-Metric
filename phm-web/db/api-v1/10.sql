-- ── 创建 key（服务端生成明文/哈希/掩码后调用；每账号最多 100 个有效 key）──
create or replace function public.hm_api_key_create(
  p_secret text, p_owner text, p_name text, p_hint text, p_hash text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k public.hm_api_keys; cnt int;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if nullif(p_owner,'') is not null then
    select count(*) into cnt from hm_api_keys
      where owner_id = p_owner and revoked_at is null;
    if cnt >= 100 then
      raise exception 'key_limit' using errcode = 'P0001';
    end if;
  end if;
  insert into hm_api_keys (owner_id, name, hint, key_hash)
  values (nullif(p_owner,''), coalesce(nullif(p_name,''),'default'), p_hint, p_hash)
  returning * into k;
  return jsonb_build_object('ok', true, 'id', k.id, 'hint', k.hint, 'name', k.name);
end $$;
