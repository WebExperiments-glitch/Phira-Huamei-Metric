-- ============================================================
-- 2026-11-11-lookups-rls.sql —— 给 hm_lookups 补上 RLS
-- ============================================================
-- 【为什么单独一个迁移】
--   建表那次（2026-11-11-lookups.sql）漏了 RLS，被 pre-push 的 review-gate
--   拦下来才发现。而隐私政策第 4 节明确写着「数据库启用行级安全」——
--   写了却没做到，比不写更糟。
--
-- 【为什么开了 RLS 服务还能用】
--   所有读写都走 SECURITY DEFINER 函数（hm_lookup_touch/list/merge/clear），
--   它们以**定义者**身份执行，不受 RLS 约束。
--   而 anon / authenticated 直接查表 → 被 RLS 挡死，且下面还显式 revoke 了表权限。
--
-- 【所以这张表的效果是】
--   只有服务端凭据能通过 RPC 访问；换成一个裸的 PostgREST 请求（带 publishableKey）
--   读不出任何一行。和其它表（hm_plays / hm_tier_requests）保持一致。
-- ============================================================

begin;

alter table public.hm_lookups enable row level security;

/* 连表级权限都收掉 —— 匿名角色连"表存在"都不该能探测到行数 */
revoke all on public.hm_lookups from anon, authenticated;

commit;
