-- ============================================================
-- 00-roles.sql —— 把「平台角色」补齐（在纯 Postgres 上重建 CloudBase 的假设）
-- ============================================================
-- 【为什么需要这一份】
--   迁移脚本里到处是 `grant execute … to anon, authenticated`。这两个角色
--   来自 Supabase/CloudBase 那套（PostgREST 用它们当调用身份），
--   **纯 Postgres 上不存在**，于是从零建库时第一句 grant 就会报
--   `role "anon" does not exist`。
--
-- 【为什么不把它们删掉，改成 grant to public】
--   因为那等于把权限放大到"任何人"——`public` 是**所有**角色。
--   保留两个具名角色、不给 LOGIN，语义是"这两类调用方可以执行这个函数"，
--   与以后接 Data API / 自己写网关都对得上。
--
-- 【为什么给 NOLOGIN】
--   它们是**权限容器**，不是登录账号。给 LOGIN 等于凭空多两个能连库的账号。
--   运行期只有 `neondb_owner` 一个真身份（连接串里的那个）。
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end $$;

-- 让运行时身份能把 anon/authenticated 的身份借出去（SECURITY DEFINER 函数要以属主身份跑，
-- 属主是 neondb_owner，不需要额外授权；这里只是把 schema 的 USAGE 给足，避免以后踩坑）
grant usage on schema public to anon, authenticated;

comment on role anon is '匿名调用方（对应 PostgREST 的 anon）。NOLOGIN：只是权限容器';
comment on role authenticated is '已登录调用方（对应 PostgREST 的 authenticated）。NOLOGIN：只是权限容器';
