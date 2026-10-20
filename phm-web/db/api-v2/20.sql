-- ============================================================
-- P.H.M. 自建账号：档案 / 活跃统计
-- ============================================================
-- 背景：登录体系从**平台云 SDK** 收敛到**自建账号**（lib/hm-accounts.mjs）。
--   原因不是"自建更好玩"，是平台 token 是 HS256、密钥在平台手里 ——
--   我们只能解析不能验签，等于任何人都能伪造 sub 冒充别人。
--   自建 token 的密钥只在服务端，verifyOwnToken() 能真验。
--
-- 但收敛有个代价：原来 `phm_profiles` / `phm_touch` 绑的是**云端 auth.uid()**。
--   切到自建后前端不再有云端会话，那两张表就没法直连了。
--
-- 解决：新建 `hm_profiles`，以**自建 sub** 为键，读写一律走
--   SECURITY DEFINER RPC（与 hm_accounts / hm_status_hour 同一套规矩）。
--
-- ⚠ 为什么另起一张表而不是复用 phm_profiles：
--   `owner_id` 那一列里将来会同时存在「云端 uid」和「自建 sub」两种来源，
--   而它们**长得一样**（都是 19 位数字）—— 混在一张表里没法区分谁是谁，
--   清理旧数据时也分不清哪些能删。宁可多一张表。
--   `phm_profiles` 保留不动，等确认没有旧数据引用后再手动删。
--
-- ⚠ 为什么只留 RPC、不给任何角色直连：
--   与 hm_accounts 同一条信任边界。publishableKey 本来就公开在网页里，
--   一旦表对 anon 可读，就等于把所有人的邮箱、绑定的 Phira uid 公开。
-- ============================================================

create table if not exists public.hm_profiles (
  sub         text primary key,
  email       text,                      -- 冗余一份，便于排查（不参与鉴权）
  phira_uid   bigint,                    -- 绑定的 Phira 账号
  phira_name  text,
  visits      integer not null default 0,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

comment on table public.hm_profiles is
  '自建账号的档案：绑定 Phira 账号 + 活跃统计。键是 lib/hm-accounts.mjs 生成的 sub。';

-- 与 hm_accounts 同一处置：任何直连角色都没有权限
revoke all on public.hm_profiles from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────
-- 读：拿自己的档案
-- ────────────────────────────────────────────────────────────
create or replace function public.hm_profile_get(
  p_secret text, p_sub text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.hm_profiles;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  /* ⚠ sub 是调用方传的，必须**存在才查**；不存在的 sub 回 `{}` 而不是报错 ——
     "还没有档案"是正常状态（新注册的用户），不该当成异常。 */
  if p_sub is null or p_sub = '' then
    return '{}'::jsonb;
  end if;
  /* ⚠ **账号是否还存在**必须单独查一次。
     自签 JWT 是**无状态**的：注销之后旧 token 在过期前依然能验签通过。
     不查这一步，注销过的 token 还能把会话"恢复"回来（前端显示已登录，
     后端却查不到账号）—— 那种状态比直接 401 难查得多。
     → 这里回 `account_exists:false`，路由据此回 401，前端清 token 并要求重新登录。 */
  if not exists (select 1 from public.hm_accounts where sub = p_sub) then
    return jsonb_build_object('account_exists', false);
  end if;
  select * into r from public.hm_profiles where sub = p_sub;
  if not found then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'sub', r.sub,
    'email', r.email,
    'phira_uid', r.phira_uid,
    'phira_name', r.phira_name,
    'visits', r.visits,
    'first_seen', r.first_seen,
    'last_seen', r.last_seen
  );
end $$;

-- ────────────────────────────────────────────────────────────
-- 写：更新自己的档案（绑定 / 解绑 Phira）
-- ────────────────────────────────────────────────────────────
-- ⚠ 只允许改「跟 Phira 绑定有关」的字段。email 与 visits **不接受**调用方传值：
--   email 该由注册流程写；visits 只能通过 hm_touch 自增。
--   让调用方能改这两个字段 = 可以伪造"我是别人"或刷活跃数。
create or replace function public.hm_profile_put(
  p_secret text, p_sub text, p_email text,
  p_phira_uid bigint, p_phira_name text, p_clear boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.hm_profiles;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_sub is null or p_sub = '' then
    raise exception 'sub required' using errcode = 'P0001';
  end if;
  /* ⚠ 同 hm_profile_get：**账号必须真的存在**。
     否则注销后残留的旧 token 能反过来把档案"写活"，
     库里就会出现一个没有账号的幽灵档案。 */
  if not exists (select 1 from public.hm_accounts where sub = p_sub) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  insert into public.hm_profiles (sub, email, phira_uid, phira_name, last_seen)
  values (
    p_sub,
    nullif(p_email, ''),
    case when p_clear then null else p_phira_uid end,
    case when p_clear then null else nullif(p_phira_name, '') end,
    now()
  )
  on conflict (sub) do update set
    -- email 只在原有为空时补，不覆盖（防止一次误调用改掉登录邮箱）
    email      = coalesce(public.hm_profiles.email, excluded.email),
    phira_uid  = case when p_clear then null else excluded.phira_uid end,
    phira_name = case when p_clear then null else excluded.phira_name end,
    last_seen  = now()
  returning * into r;

  return jsonb_build_object(
    'ok', true,
    'phira_uid', r.phira_uid,
    'phira_name', r.phira_name
  );
end $$;

-- ────────────────────────────────────────────────────────────
-- 活跃：visits + 1
-- ────────────────────────────────────────────────────────────
-- ⚠ 必须是**原子自增**（INSERT ... ON CONFLICT DO UPDATE visits = visits + 1）。
--   早先前端是「读 → +1 → 写」，两个标签页同时开着会互相覆盖，visits 少计。
create or replace function public.hm_touch(
  p_secret text, p_sub text, p_email text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_visits integer;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_sub is null or p_sub = '' then
    return jsonb_build_object('ok', false, 'reason', 'no sub');
  end if;
  /* 注销后的旧 token 也可能打到这里。活跃数没有副作用，
     但也不该给不存在的账号造一行 —— 静默回 ok:false，不报错（统计不该阻断业务）。 */
  if not exists (select 1 from public.hm_accounts where sub = p_sub) then
    return jsonb_build_object('ok', false, 'reason', 'no account');
  end if;

  insert into public.hm_profiles (sub, email, visits, last_seen)
  values (p_sub, nullif(p_email, ''), 1, now())
  on conflict (sub) do update set
    visits    = public.hm_profiles.visits + 1,
    last_seen = now()
  returning visits into n_visits;

  return jsonb_build_object('ok', true, 'visits', n_visits);
end $$;

-- ────────────────────────────────────────────────────────────
-- 注销：真正删除账号
-- ────────────────────────────────────────────────────────────
-- ⚠ 这是自建账号**换来的一项实质能力**，不是顺带补的：
--   用平台云 SDK 时，登录邮箱在平台的认证系统里，客户端没有删除权限 ——
--   「注销账号」只能删掉本站资料，邮箱必须由用户另外发邮件申请。
--   自建之后 hm_accounts 就在我们自己的库里，删除是**一条语句**的事。
--
-- 删三处：
--   · hm_accounts     —— 账号本身（邮箱 + scrypt 哈希）
--   · hm_profiles     —— 档案（Phira 绑定 + 活跃数）
--   · hm_email_codes  —— 该邮箱未用完的验证码（否则注销后手上的码还能注册回来）
--
-- ⚠ **不删** `hm_plays`：贡献的成绩本来就是匿名的（表里没有 owner_id），
--   不挂在账号上，删账号也不该带走它 —— 与其他玩家的定数缓存是同一份数据。
-- ⚠ 失败必须整单回滚：plpgsql 函数本身在一个事务里，任何一步报错都整体回退，
--   不会出现「账号没了但档案还在」的半截状态。
create or replace function public.hm_account_delete(
  p_secret text, p_sub text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text; n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_sub is null or p_sub = '' then
    raise exception 'sub required' using errcode = 'P0001';
  end if;

  /* 先取邮箱 —— 删完 hm_accounts 就查不到了，而验证码表按邮箱建键 */
  select email into v_email from public.hm_accounts where sub = p_sub;

  delete from public.hm_profiles where sub = p_sub;
  delete from public.hm_accounts where sub = p_sub;
  get diagnostics n = row_count;

  if v_email is not null then
    /* 只用未消费的码就够；已消费的留着当审计痕迹 */
    delete from public.hm_email_codes where email = v_email and used = false;
  end if;

  /* 账号不存在也回 ok —— 幂等。让客户端能安全重试，不会因为"已经没了"而卡住。 */
  return jsonb_build_object('ok', true, 'deleted', n > 0);
end $$;

-- ────────────────────────────────────────────────────────────
-- 权限：先收回，再**显式授权给 anon**
-- ────────────────────────────────────────────────────────────
-- ⚠⚠ 这一段最初写错了两次，都是**部署时才炸**的：
--   ① 只写了 revoke，忘了 grant → 调用方拿到 `permission denied for function`
--      （42501）。当时注释还写着「RPC 仍然能调，因为走的是 service 侧凭据」——
--      **我们没有 service_role 凭据**：站内所有 RPC 都是用网页里那把
--      publishable key 以 `anon` 身份调的。看一眼 hm_account_lookup 的 acl 就明白：
--      它显式 grant 给了 anon / authenticated。
--   ② `hm_touch` 里 `declare v integer` 与 `phm_secrets.v` **撞名**，
--      函数体内的 `select v from phm_secrets` 于是报 42702 column reference is ambiguous。
--      变量改名 n_visits。
--
-- 安全性不靠权限位，靠函数体里的 `p_secret` 比对（SECURITY DEFINER 以属主身份运行）：
-- 谁都能调，但没有写入凭据就只会拿到 42501。
revoke all on function public.hm_profile_get(text, text) from public, anon, authenticated;
revoke all on function public.hm_profile_put(text, text, text, bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.hm_touch(text, text, text) from public, anon, authenticated;
revoke all on function public.hm_account_delete(text, text) from public, anon, authenticated;

grant execute on function public.hm_profile_get(text, text) to anon, authenticated;
grant execute on function public.hm_profile_put(text, text, text, bigint, text, boolean) to anon, authenticated;
grant execute on function public.hm_touch(text, text, text) to anon, authenticated;
grant execute on function public.hm_account_delete(text, text) to anon, authenticated;
