-- ============================================================
-- P.H.M. API v1 —— 密钥与用量表（2026-10-17）
-- ============================================================
-- 在 WorkBuddy / CloudBase 的 MCP(SQL) 里执行一次。
-- 设计口径对齐 DeepSeek 控制台：
--   · key 形如 sk-<32 hex>，明文只在创建时返回一次；
--   · 库里只存 sha256 哈希 + 掩码（sk-495f...0709）；
--   · 每个账号最多 100 个有效 key；支持改名 / 删除（吊销）。
-- 安全原则与现有 hm_* / phm_* 一致：RLS 开启、不给任何角色直连，
-- 只能通过带写入凭据的 SECURITY DEFINER 函数读写。
-- ============================================================

create table if not exists public.hm_api_keys (
  id           uuid primary key default gen_random_uuid(),   -- Tracking ID
  owner_id     text,                                          -- 平台账号 sub；admin 手动发可为 null
  name         text not null default 'default',
  hint         text not null,                                 -- sk-495f****0709（仅展示）
  key_hash     text not null unique,                          -- sha256(完整 key)
  plan         text not null default 'free',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists hm_api_keys_owner_idx on public.hm_api_keys (owner_id);

create table if not exists public.hm_api_usage (
  id          bigint generated always as identity primary key,
  key_id      uuid references public.hm_api_keys(id) on delete set null,
  endpoint    text not null,
  status      int not null,
  chart_id    int,
  duration_ms int,
  created_at  timestamptz not null default now()
);
create index if not exists hm_api_usage_key_time_idx on public.hm_api_usage (key_id, created_at desc);
create index if not exists hm_api_usage_time_idx on public.hm_api_usage (created_at desc);

alter table public.hm_api_keys  enable row level security;
alter table public.hm_api_usage enable row level security;
revoke all on public.hm_api_keys  from public, anon, authenticated;
revoke all on public.hm_api_usage from public, anon, authenticated;

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

-- ── 校验 key（每请求调用；只回最小字段）──
create or replace function public.hm_api_key_lookup(p_secret text, p_hash text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k public.hm_api_keys;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select * into k from hm_api_keys where key_hash = p_hash;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object(
    'ok', true, 'id', k.id, 'owner_id', k.owner_id,
    'plan', k.plan, 'revoked', k.revoked_at is not null
  );
end $$;

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

-- ── 改名 ──
create or replace function public.hm_api_key_rename(
  p_secret text, p_owner text, p_id uuid, p_name text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  update hm_api_keys set name = coalesce(nullif(p_name,''), name)
    where id = p_id and owner_id = p_owner and revoked_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true);
end $$;

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

-- ── 记一条用量 ──
create or replace function public.hm_api_usage_log(
  p_secret text, p_key_id uuid, p_endpoint text, p_status int, p_chart_id int, p_duration_ms int
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  insert into hm_api_usage (key_id, endpoint, status, chart_id, duration_ms)
  values (p_key_id, left(p_endpoint, 80), p_status, p_chart_id, p_duration_ms);
end $$;

-- ── 用量汇总（今日 / 7 日 / 30 日 + 按接口分布）──
create or replace function public.hm_api_usage_summary(p_secret text, p_owner text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', count(*) filter (where u.created_at >= now() - interval '1 day'),
    'week',  count(*) filter (where u.created_at >= now() - interval '7 days'),
    'month', count(*) filter (where u.created_at >= now() - interval '30 days'),
    'keys',  count(distinct u.key_id),
    'by_endpoint', (
      select coalesce(jsonb_object_agg(endpoint, n), '{}'::jsonb) from (
        select endpoint, count(*) n from hm_api_usage u2
        join hm_api_keys k2 on k2.id = u2.key_id
        where k2.owner_id = p_owner and u2.created_at >= now() - interval '30 days'
        group by endpoint
      ) s
    )
  ) into out
  from hm_api_usage u
  join hm_api_keys k on k.id = u.key_id
  where k.owner_id = p_owner;
  return coalesce(out, '{}'::jsonb);
end $$;

-- ── 权限：只给 anon EXECUTE（服务端用 publishable key 调；凭据在函数内校验）──
revoke all on function public.hm_api_key_create(text,text,text,text,text) from public;
revoke all on function public.hm_api_key_lookup(text,text) from public;
revoke all on function public.hm_api_key_list(text,text) from public;
revoke all on function public.hm_api_key_rename(text,text,uuid,text) from public;
revoke all on function public.hm_api_key_revoke(text,text,uuid) from public;
revoke all on function public.hm_api_key_touch(text,text) from public;
revoke all on function public.hm_api_usage_log(text,uuid,text,int,int,int) from public;
revoke all on function public.hm_api_usage_summary(text,text) from public;
grant execute on function public.hm_api_key_create(text,text,text,text,text) to anon, authenticated;
grant execute on function public.hm_api_key_lookup(text,text) to anon, authenticated;
grant execute on function public.hm_api_key_list(text,text) to anon, authenticated;
grant execute on function public.hm_api_key_rename(text,text,uuid,text) to anon, authenticated;
grant execute on function public.hm_api_key_revoke(text,text,uuid) to anon, authenticated;
grant execute on function public.hm_api_key_touch(text,text) to anon, authenticated;
grant execute on function public.hm_api_usage_log(text,uuid,text,int,int,int) to anon, authenticated;
grant execute on function public.hm_api_usage_summary(text,text) to anon, authenticated;
