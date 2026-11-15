-- ============================================================
-- hm_api_key_meta_set 的 scope 白名单与代码对齐
--
-- 【为什么要有这个迁移】
--   2026-11-15 用户创建 API Key 时报 key_meta_failed: invalid scope。
--   查下去发现两边白名单不一致：
--
--     代码 lib/api-routes.mjs:32
--       ALL_SCOPES = ['charts:read','analyses:write','usage:read',
--                     'behavior:read','reference:read','engines:read','system:read']  ← 7 个
--
--     数据库 hm_api_key_meta_set 里
--       declare allowed text[] := '{charts:read,analyses:write,usage:read}'  ← 只有 3 个
--
--   前端不传 scopes 时，normalizeScopesInput(null) 会取 ALL_SCOPES 全部，
--   于是 p_scopes <@ allowed 为 false → raise 'invalid scope' → 502 key_meta_failed。
--   界面只显示 3 个勾选项，看起来风平浪静，实际请求带了 7 个。
--
-- 【为什么这个函数之前不在仓库里】
--   它一直是**直接在 Neon 上建的**，没有进 migrations。所以：
--     · 改代码的人不知道库侧的白名单长什么样
--     · 审计时无法确认它到底校验了什么
--   这次把完整定义写进仓库，以后再漂移能 diff 出来。
--
-- 【注意】
--   本文件是从 pg_get_functiondef() 导出的原文，只改了 allowed 那一行。
--   函数里的 secret 校验（p_secret <> writer）保持原样，不要动。
-- ============================================================

CREATE OR REPLACE FUNCTION public.hm_api_key_meta_set(
  p_secret text,
  p_owner text,
  p_id uuid,
  p_scopes text[],
  p_expires_at timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare allowed text[] := '{charts:read,analyses:write,usage:read,behavior:read,reference:read,engines:read,system:read}'::text[];
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
end $function$;
