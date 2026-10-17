-- ============================================================
-- P.H.M. API v2 —— Key 元数据（scopes / 过期）、按 Key 用量
-- ============================================================
-- 在 v1 之后执行。表是**新增的**，不改 hm_api_keys 已有列；
-- 旧 Key 没有 meta 行 → 读取时默认「全部 scope、永不过期」，向后兼容。
-- 仍遵守：RLS 开启、无直连、只有 SECURITY DEFINER RPC。
-- ============================================================

create table if not exists public.hm_api_key_meta (
  key_id      uuid primary key references public.hm_api_keys(id) on delete cascade,
  scopes      text[] not null default '{charts:read,analyses:write,usage:read}',
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.hm_api_key_meta enable row level security;
revoke all on public.hm_api_key_meta from public, anon, authenticated;

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

-- ── 按 Key 汇总用量 ──
create or replace function public.hm_api_usage_key_summary(p_secret text, p_key_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', count(*) filter (where created_at >= now() - interval '1 day'),
    'week',  count(*) filter (where created_at >= now() - interval '7 days'),
    'month', count(*) filter (where created_at >= now() - interval '30 days'),
    'by_endpoint', coalesce((
      select jsonb_object_agg(endpoint, n) from (
        select endpoint, count(*) n from hm_api_usage
        where key_id = p_key_id and created_at >= now() - interval '30 days'
        group by endpoint
      ) s
    ), '{}'::jsonb)
  ) into out from hm_api_usage where key_id = p_key_id;
  return coalesce(out, '{}'::jsonb);
end $$;

revoke all on function public.hm_api_key_meta_set(text,text,uuid,text[],timestamptz) from public;
revoke all on function public.hm_api_key_lookup(text,text) from public;
revoke all on function public.hm_api_key_list(text,text) from public;
revoke all on function public.hm_api_usage_key_summary(text,uuid) from public;
grant execute on function public.hm_api_key_meta_set(text,text,uuid,text[],timestamptz) to anon, authenticated;
grant execute on function public.hm_api_key_lookup(text,text) to anon, authenticated;
grant execute on function public.hm_api_key_list(text,text) to anon, authenticated;
grant execute on function public.hm_api_usage_key_summary(text,uuid) to anon, authenticated;
