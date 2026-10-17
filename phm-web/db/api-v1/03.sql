create table if not exists public.hm_api_usage (
  id          bigint generated always as identity primary key,
  key_id      uuid references public.hm_api_keys(id) on delete set null,
  endpoint    text not null,
  status      int not null,
  chart_id    int,
  duration_ms int,
  created_at  timestamptz not null default now()
);
