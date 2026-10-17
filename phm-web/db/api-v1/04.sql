create index if not exists hm_api_usage_key_time_idx on public.hm_api_usage (key_id, created_at desc);
