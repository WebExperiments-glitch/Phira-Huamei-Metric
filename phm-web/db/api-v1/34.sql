-- Key 升级申请：一人同时只能有一条 pending（部分唯一索引在 36.sql）
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
  constraint hm_tier_requests_status_chk check (status in ('pending','approved','rejected'))
);
