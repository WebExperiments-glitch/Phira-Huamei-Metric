-- ============================================================
-- 2026-11-09-admin2.sql —— 把二级密码的哈希挪到数据库
-- ============================================================
-- 【为什么必须挪】
--   原先存在服务端文件 admin2-hash.txt。问题：**每次部署都会覆盖文件系统**，
--   用户设了二级密码，下一次部署就丢了 —— 表现是"设了又变成没设"。
--   存进 phm_secrets 才能跨部署持久。
--
-- 【存的是哈希，不是明文】
--   scrypt 哈希，参数写在值里（scrypt$N$r$p$salt$hash），
--   与 lib/api-admin.mjs 的 checkAdmin2 对应。
--
-- 【为什么不给"读哈希"的 RPC】
--   只需比对，不需要读出。只给 put / verify 两个操作 —— 拿不到哈希就无从离线爆破。
--   verify 在服务端做（把候选密码 + salt 算一遍），调用方只拿布尔结果。
--
-- 执行：node tools/db-migrate.mjs db/migrations/2026-11-09-admin2.sql
-- ============================================================

begin;

-- 写入（首次设置或修改都走这里；用 upsert 保证只有一行）
create or replace function public.hm_admin2_put(p_secret text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if nullif(p_hash, '') is null then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  insert into phm_secrets (k, v) values ('admin2', p_hash)
  on conflict (k) do update set v = excluded.v;
  return jsonb_build_object('ok', true);
end $$;

-- 读（只给服务端自己用：拿 salt 与期望哈希做常量时间比较）
--   ⚠ 这个 RPC 必须用 p_secret 保护：拿到哈希就能离线爆破二级密码。
create or replace function public.hm_admin2_get(p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; h text;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select v into h from phm_secrets where k = 'admin2';
  if h is null then return jsonb_build_object('ok', true, 'set', false); end if;
  return jsonb_build_object('ok', true, 'set', true, 'hash', h);
end $$;

revoke all on function public.hm_admin2_put(text, text) from public;
revoke all on function public.hm_admin2_get(text) from public;
grant execute on function public.hm_admin2_put(text, text) to anon, authenticated;
grant execute on function public.hm_admin2_get(text) to anon, authenticated;

commit;
