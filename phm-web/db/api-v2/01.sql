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
