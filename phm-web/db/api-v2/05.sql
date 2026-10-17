-- ── 校验 Key：补 scopes / expires_at（旧 Key 默认全量）──
create or replace function public.hm_api_key_lookup(p_secret text, p_hash text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rec public.hm_api_keys; m public.hm_api_key_meta;
begin
  -- ⚠ 记录变量**不能叫 k**：plpgsql 里它会和 phm_secrets.k 列名撞出
  -- 42702 column reference "k" is ambiguous（延迟解析 → 建函数不报错，
  -- 第一次调用才炸）。凭据也必须用 SELECT INTO 取，不能内联子查询。
  -- 同 db/api-v1/11.sql。
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select * into rec from hm_api_keys where key_hash = p_hash;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into m from hm_api_key_meta where key_id = rec.id;
  return jsonb_build_object(
    'ok', true, 'id', rec.id, 'owner_id', rec.owner_id, 'plan', rec.plan,
    'revoked', rec.revoked_at is not null,
    'scopes', coalesce(m.scopes, '{charts:read,analyses:write,usage:read}'::text[]),
    'expires_at', m.expires_at
  );
end $$;
