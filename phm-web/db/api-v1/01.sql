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
