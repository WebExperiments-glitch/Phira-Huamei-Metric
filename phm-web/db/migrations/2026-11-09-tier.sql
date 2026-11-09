-- ============================================================
-- 2026-11-09-tier.sql —— Key 分级（plan）+ 升级申请 + 管理员 RPC
-- ============================================================
-- 【为什么是一个多语句文件，而不是 db/api-v1/ 下的编号文件】
--   db/api-v1/*.sql 是给 WorkBuddy MCP 的 SQL 模式用的：**一次一条语句**。
--   这份迁移要一次成事务（建表 + 5 个函数 + 授权），拆开反而危险 ——
--   中途失败会留下半套 RPC。所以放 db/migrations/，用 pg 直连整段执行。
--
--   执行：node tools/db-migrate.mjs db/migrations/2026-11-09-tier.sql
--
-- 【幂等】全部 if not exists / or replace，可重复执行。
-- 【安全】管理类 RPC 一律要 p_secret（phm_secrets.k='writer'），
--   与新表 enable row level security + revoke，只走 RPC。
--
-- 【背景】hm_api_keys 早就有 plan 列（默认 'free'），但代码一直靠
--   owner 前缀猜档位（internal→admin）。那是临时办法：改档位要重建 key。
-- ============================================================

begin;

-- ── 1. 升级申请 ─────────────────────────────────────────────
create table if not exists public.hm_tier_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  from_plan text not null default 'free',
  to_plan text not null default 'premium',
  reason text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  constraint hm_tier_requests_status_chk check (status in ('pending', 'approved', 'rejected'))
);

alter table public.hm_tier_requests enable row level security;
revoke all on public.hm_tier_requests from public, anon, authenticated;

-- 一个人同时只能有一条 pending。靠**数据库**保证，不能只靠 RPC 里的
-- exists 检查 —— 并发两次提交会同时通过那次检查。
create unique index if not exists hm_tier_requests_one_pending
  on public.hm_tier_requests (owner_id) where status = 'pending';

create index if not exists hm_tier_requests_created_idx
  on public.hm_tier_requests (status, created_at desc);

-- ── 2. 管理员：全量 key + 用量 ──────────────────────────────
--   不复用 hm_api_key_list：那个按 owner 过滤，管理员要的是全部。
create or replace function public.hm_admin_key_list(p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rows jsonb;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into rows
  from (
    select jsonb_build_object(
      'id', k.id, 'owner', k.owner_id, 'name', k.name, 'hint', k.hint,
      'plan', k.plan, 'created_at', k.created_at,
      'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
      'scopes', m.scopes, 'expires_at', m.expires_at,
      'calls_total', coalesce(u.n, 0), 'calls_24h', coalesce(u.n24, 0),
      'last_status', u.last_status
    ) as x
    from hm_api_keys k
    left join hm_api_key_meta m on m.key_id = k.id
    left join lateral (
      select count(*) as n,
             count(*) filter (where created_at > now() - interval '24 hours') as n24,
             (array_agg(status order by created_at desc))[1] as last_status
      from hm_api_usage w where w.key_id = k.id
    ) u on true
  ) t;

  return jsonb_build_object('ok', true, 'keys', rows);
end $$;

-- ── 3. 管理员：改档位 ──────────────────────────────────────
create or replace function public.hm_admin_set_plan(p_secret text, p_id uuid, p_plan text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; n int;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_plan not in ('free', 'premium', 'admin') then
    raise exception 'bad_plan' using errcode = '22023';
  end if;
  update hm_api_keys set plan = p_plan where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'plan', p_plan);
end $$;

-- ── 4. 用户：提交升级申请 ──────────────────────────────────
create or replace function public.hm_tier_request_submit(p_secret text, p_owner text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; cur text; rec public.hm_tier_requests;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if nullif(trim(p_owner), '') is null then
    return jsonb_build_object('ok', false, 'error', 'no_owner');
  end if;

  select coalesce(max(plan), 'free') into cur from hm_api_keys
    where owner_id = p_owner and revoked_at is null;
  if cur is distinct from 'free' then
    return jsonb_build_object('ok', false, 'error', 'already_premium', 'plan', cur);
  end if;

  insert into hm_tier_requests (owner_id, from_plan, to_plan, reason)
    values (p_owner, 'free', 'premium', left(coalesce(p_reason, ''), 500))
    returning * into rec;
  return jsonb_build_object('ok', true, 'id', rec.id);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_pending');
end $$;

-- ── 5. 管理员：列出申请 ────────────────────────────────────
create or replace function public.hm_admin_tier_list(p_secret text, p_status text default 'pending')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rows jsonb;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'owner', r.owner_id, 'from_plan', r.from_plan, 'to_plan', r.to_plan,
      'reason', r.reason, 'status', r.status, 'created_at', r.created_at,
      'decided_at', r.decided_at, 'decided_by', r.decided_by
    ) order by r.created_at desc), '[]'::jsonb) into rows
  from hm_tier_requests r
  where (p_status is null or p_status = '' or r.status = p_status);
  return jsonb_build_object('ok', true, 'requests', rows);
end $$;

-- ── 6. 管理员：批准 / 拒绝 ─────────────────────────────────
--   批准时把该 owner 下**所有有效 key** 一起升级 —— 否则他新建一把又掉回 free。
create or replace function public.hm_admin_tier_decide(
  p_secret text, p_id uuid, p_approve boolean, p_by text default 'admin'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rec public.hm_tier_requests;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;

  select * into rec from hm_tier_requests where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if rec.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_decided', 'status', rec.status);
  end if;

  update hm_tier_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        decided_at = now(), decided_by = left(coalesce(p_by, 'admin'), 120)
    where id = p_id;

  if p_approve then
    update hm_api_keys set plan = rec.to_plan
      where owner_id = rec.owner_id and revoked_at is null;
  end if;

  return jsonb_build_object('ok', true,
    'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

-- ── 7. 授权 ────────────────────────────────────────────────
revoke all on function public.hm_admin_key_list(text) from public;
revoke all on function public.hm_admin_set_plan(text, uuid, text) from public;
revoke all on function public.hm_tier_request_submit(text, text, text) from public;
revoke all on function public.hm_admin_tier_list(text, text) from public;
revoke all on function public.hm_admin_tier_decide(text, uuid, boolean, text) from public;

grant execute on function public.hm_admin_key_list(text) to anon, authenticated;
grant execute on function public.hm_admin_set_plan(text, uuid, text) to anon, authenticated;
grant execute on function public.hm_tier_request_submit(text, text, text) to anon, authenticated;
grant execute on function public.hm_admin_tier_list(text, text) to anon, authenticated;
grant execute on function public.hm_admin_tier_decide(text, uuid, boolean, text) to anon, authenticated;

commit;
