-- ============================================================
-- 10-core.sql —— 核心表与 RPC 的**重建**
-- ============================================================
-- 【为什么是"重建"而不是"迁移"】
--   2026-10-21 换掉腾讯 CloudBase 时查过：`phm_charts` / `phm_scores` /
--   `phm_secrets` / `hm_accounts` / `hm_email_codes` / `hm_rate` 这六张表
--   **从来没有出现在仓库的任何迁移文件里**（用 git log -S 搜过建表语句，全历史为空）。
--   它们当年是直接在控制台建的，于是库一被隔离，
--   结构就跟着一起没了 —— 这不是"忘了导出"，是"从来没记过"。
--
--   所以这份文件的每一列，依据都是**代码里真实的读写**，不是猜的：
--     · phm_charts 的 16 个字段 ← lib/review.mjs 的 recompute() 返回对象
--     · 读出来的列名              ← lib/cloud.mjs / lib/*.mjs 里的 select=
--     · RPC 的参数名与顺序        ← lib/hm-accounts.mjs / lib/cloud.mjs 的调用点
--
-- ⚠ 这是一次**有据可查的重建**，不是还原。如果哪天能读到旧库（升级 CloudBase
--   或找到备份），拿 `information_schema.columns` 对一遍，把差异补进这里。
-- ⚠ 写入凭据**不在这个文件里**：仓库是公开的。见 tools/neon-secret.mjs。
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1) 写入凭据（SECURITY DEFINER 函数用它判断"是不是服务端在调"）
-- ────────────────────────────────────────────────────────────
create table if not exists public.phm_secrets (
  k text primary key,
  v text not null
);
alter table public.phm_secrets enable row level security;
revoke all on public.phm_secrets from public, anon, authenticated;
comment on table public.phm_secrets is '服务端写入凭据。k=''writer'' 一行；值由 tools/neon-secret.mjs 写入，不入仓';

-- ────────────────────────────────────────────────────────────
-- 2) 谱面分析缓存
--    字段来源：lib/review.mjs recompute() 的返回对象（逐字段核对过）
-- ────────────────────────────────────────────────────────────
create table if not exists public.phm_charts (
  chart_id      bigint primary key,
  name          text,
  level         text,
  difficulty    numeric,
  ref_const     numeric,      -- 社区共识标度（主结果）
  ref_official  numeric,      -- 官谱标度（对照用）
  ps_score      numeric,
  nps           numeric,
  hold_ratio    numeric,
  notes         integer,
  stair_avg     numeric,
  speed_peak    numeric,
  engine_ver    text,         -- 信任标记：服务端复算过
  engine_build  text,         -- 算法版本：对账任务靠它筛"旧引擎算的过期行"
  verified_at   timestamptz not null default now()
);
/* 对账要按 engine_build 扫全表（reconcile-cache --recompute-stale），必须有索引 */
create index if not exists phm_charts_engine_build_idx on public.phm_charts (engine_build);
create index if not exists phm_charts_verified_idx on public.phm_charts (verified_at desc);
alter table public.phm_charts enable row level security;
revoke all on public.phm_charts from public, anon, authenticated;
comment on table public.phm_charts is '谱面分析缓存。只能经 phm_put_chart() 写（带写入凭据），读是公开的';

-- ────────────────────────────────────────────────────────────
-- 3) 成绩上报（贡献通道）
--    字段来源：lib/hm.mjs 的 validatePlay / 代码里出现的 score/acc/perfect…
-- ────────────────────────────────────────────────────────────
create table if not exists public.phm_scores (
  id          bigserial primary key,
  chart_id    bigint not null,
  player      text,
  score       integer,
  accuracy    numeric,
  max_combo   integer,
  perfect     integer,
  good        integer,
  bad         integer,
  miss        integer,
  speed       numeric,
  created_at  timestamptz not null default now()
);
create index if not exists phm_scores_chart_idx on public.phm_scores (chart_id);
create index if not exists phm_scores_time_idx on public.phm_scores (created_at desc);
alter table public.phm_scores enable row level security;
revoke all on public.phm_scores from public, anon, authenticated;
comment on table public.phm_scores is '玩家成绩上报。只能经 phm_put_scores() 写';

-- ────────────────────────────────────────────────────────────
-- 4) 自建账号
--    sub 是 19 位数字字符串（lib/hm-accounts.mjs 的 newSub()），
--    故意长得和平台 uid 一样，混在 owner_id 里不突兀。
-- ────────────────────────────────────────────────────────────
create table if not exists public.hm_accounts (
  sub         text primary key,
  email       text not null unique,
  pass_hash   text not null,
  salt        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.hm_accounts enable row level security;
revoke all on public.hm_accounts from public, anon, authenticated;
comment on table public.hm_accounts is '自建账号。邮箱唯一索引兜住并发注册（23505 → email_taken）';

-- ────────────────────────────────────────────────────────────
-- 5) 邮箱验证码（注册 / 重置密码；登录不需要）
--    一个邮箱一个用途只留最新一条 → 主键 (email, purpose)
-- ────────────────────────────────────────────────────────────
create table if not exists public.hm_email_codes (
  email       text not null,
  purpose     text not null,
  vid         text not null,     -- 验证码的标识（明文码不进库）
  exp         bigint not null,   -- unix 毫秒
  used        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (email, purpose)
);
alter table public.hm_email_codes enable row level security;
revoke all on public.hm_email_codes from public, anon, authenticated;
comment on table public.hm_email_codes is '邮箱验证码。主键 (email,purpose)：同一邮箱同一用途只留最新一条';

-- ────────────────────────────────────────────────────────────
-- 6) 限流计数（hm_rate_hit 用；21.sql 负责回收孤儿行）
-- ────────────────────────────────────────────────────────────
create table if not exists public.hm_rate (
  k text not null,
  t bigint not null
);
create index if not exists hm_rate_k_t_idx on public.hm_rate (k, t);
alter table public.hm_rate enable row level security;
revoke all on public.hm_rate from public, anon, authenticated;
comment on table public.hm_rate is '限流计数（k=键，t=毫秒时间戳）。孤儿行由 hm_rate_hit 的 1/64 概率清扫回收';


-- ════════════════════════════════════════════════════════════
-- RPC
-- ════════════════════════════════════════════════════════════
-- 共同的骨架：security definer（以属主身份跑）+ set search_path + 函数体内比对 p_secret。
-- 安全性靠**函数体里的凭据比对**，不靠权限位 —— 因为站内所有调用都是 anon 身份。

-- ── 写一张分析缓存（upsert；唯一写入口）──
create or replace function public.phm_put_chart(p_secret text, p_row jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'row must be an object' using errcode = 'P0001';
  end if;
  if (p_row->>'chart_id') is null then
    raise exception 'chart_id required' using errcode = 'P0001';
  end if;

  insert into phm_charts (
    chart_id, name, level, difficulty, ref_const, ref_official, ps_score,
    nps, hold_ratio, notes, stair_avg, speed_peak, engine_ver, engine_build, verified_at
  ) values (
    (p_row->>'chart_id')::bigint,
    p_row->>'name',
    p_row->>'level',
    (p_row->>'difficulty')::numeric,
    (p_row->>'ref_const')::numeric,
    (p_row->>'ref_official')::numeric,
    (p_row->>'ps_score')::numeric,
    (p_row->>'nps')::numeric,
    (p_row->>'hold_ratio')::numeric,
    (p_row->>'notes')::integer,
    (p_row->>'stair_avg')::numeric,
    (p_row->>'speed_peak')::numeric,
    coalesce(p_row->>'engine_ver', 'server-verified'),
    p_row->>'engine_build',
    coalesce(nullif(p_row->>'verified_at','')::timestamptz, now())
  )
  on conflict (chart_id) do update set
    name         = excluded.name,
    level        = excluded.level,
    difficulty   = excluded.difficulty,
    ref_const    = excluded.ref_const,
    ref_official = excluded.ref_official,
    ps_score     = excluded.ps_score,
    nps          = excluded.nps,
    hold_ratio   = excluded.hold_ratio,
    notes        = excluded.notes,
    stair_avg    = excluded.stair_avg,
    speed_peak   = excluded.speed_peak,
    engine_ver   = excluded.engine_ver,
    engine_build = excluded.engine_build,
    verified_at  = excluded.verified_at;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'written', n);
end $$;

-- ── 批量写成绩 ──
create or replace function public.phm_put_scores(p_secret text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = 'P0001';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r->>'chart_id') is null then continue; end if;
    insert into phm_scores (chart_id, player, score, accuracy, max_combo, perfect, good, bad, miss, speed)
    values (
      (r->>'chart_id')::bigint,
      r->>'player',
      (r->>'score')::integer,
      (r->>'accuracy')::numeric,
      (r->>'max_combo')::integer,
      (r->>'perfect')::integer,
      (r->>'good')::integer,
      (r->>'bad')::integer,
      (r->>'miss')::integer,
      (r->>'speed')::numeric
    );
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'written', n);
end $$;

-- ── 站点统计（公开读；/api/stats 用）──
create or replace function public.phm_stats()
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'charts',   (select count(*) from phm_charts),
    'scores',   (select count(*) from phm_scores),
    'players',  (select count(distinct player) from phm_scores where player is not null),
    'engine',   (select engine_build from phm_charts order by verified_at desc limit 1),
    'updated',  (select max(verified_at) from phm_charts)
  );
$$;

-- ── 某个玩家的成绩（/api/plays 用；参数名是 name_in，代码里就是这么传的）──
create or replace function public.phm_plays(name_in text)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'name', name_in,
    'n',    count(*),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
              'chart_id', chart_id, 'score', score, 'accuracy', accuracy,
              'max_combo', max_combo, 'created_at', created_at
            ) order by created_at desc), '[]'::jsonb)
  )
  from phm_scores where player = name_in;
$$;


-- ── 账号：创建 / 查 / 改密 ──
create or replace function public.hm_account_create(
  p_secret text, p_sub text, p_email text, p_pass_hash text, p_salt text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_sub is null or p_email is null or p_pass_hash is null or p_salt is null then
    raise exception 'missing fields' using errcode = 'P0001';
  end if;
  /* 不加 on conflict：邮箱重复要让唯一索引**炸出 23505**，
     调用方据此区分"邮箱已注册"和"服务端故障"（见 hm-accounts.mjs 的 dup 判断）。 */
  insert into hm_accounts (sub, email, pass_hash, salt) values (p_sub, p_email, p_pass_hash, p_salt);
  return jsonb_build_object('ok', true, 'sub', p_sub);
end $$;

/* ⚠ 返回 setof：调用方解析的是**数组**（`Array.isArray(rows) ? rows[0] : null`），
   返回单个 jsonb 会让它永远拿不到行，登录全部变成 bad_credentials。
   —— 这种"返回值形状不匹配"最难查：不报错，只是静默地谁都登不上。 */
create or replace function public.hm_account_lookup(p_secret text, p_email text)
returns setof public.hm_accounts
language sql security definer set search_path = public, pg_temp as $$
  select * from hm_accounts where email = lower(p_email)
    and p_secret = (select v from phm_secrets where k='writer');
$$;

create or replace function public.hm_account_setpw(p_secret text, p_sub text, p_hash text, p_salt text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  update hm_accounts set pass_hash = p_hash, salt = p_salt, updated_at = now() where sub = p_sub;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end $$;

-- ── 验证码：写 / 取 / 消费 ──
create or replace function public.hm_code_put(
  p_secret text, p_email text, p_purpose text, p_vid text, p_exp bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  insert into hm_email_codes (email, purpose, vid, exp, used, created_at)
  values (lower(p_email), p_purpose, p_vid, p_exp, false, now())
  on conflict (email, purpose) do update set
    vid = excluded.vid, exp = excluded.exp, used = false, created_at = now();
  return jsonb_build_object('ok', true);
end $$;

/* 返回数组形状（同 hm_account_lookup 的理由）：调用方会 JSON.parse 后取 [0] 或判断长度 */
create or replace function public.hm_code_get(p_secret text, p_email text, p_purpose text)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('vid', vid, 'exp', exp, 'used', used)), '[]'::jsonb)
  from hm_email_codes
  where email = lower(p_email) and purpose = p_purpose and not used
    and p_secret = (select v from phm_secrets where k='writer');
$$;

create or replace function public.hm_code_consume(p_secret text, p_email text, p_purpose text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  update hm_email_codes set used = true
  where email = lower(p_email) and purpose = p_purpose and not used;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end $$;


-- ────────────────────────────────────────────────────────────
-- 权限：先收回，再**显式授权给 anon**
-- ⚠ 六张表都开了 RLS 且**没有 policy** —— 于是 anon/authenticated 连 select
--   都会被拒；只有 SECURITY DEFINER 函数（以属主身份跑，属主默认绕过 RLS）
--   和运行期的属主连接能碰数据。这正是我们要的：**表不对外，只走 RPC**。
--   以后要是接 Data API，再按需加 policy；现在加等于凭空开一扇门。
--   站内所有 RPC 都是用网页里那把 key 以 anon 身份调的（没有 service_role 凭据）。
--   安全性靠函数体内的 p_secret 比对，不靠权限位。
--   ⚠ 只 revoke 不 grant = 部署后每次调用 permission denied（2026-10-20 真实事故）。
-- ────────────────────────────────────────────────────────────
revoke all on function public.phm_put_chart(text, jsonb) from public;
revoke all on function public.phm_put_scores(text, jsonb) from public;
revoke all on function public.phm_stats() from public;
revoke all on function public.phm_plays(text) from public;
revoke all on function public.hm_account_create(text, text, text, text, text) from public;
revoke all on function public.hm_account_lookup(text, text) from public;
revoke all on function public.hm_account_setpw(text, text, text, text) from public;
revoke all on function public.hm_code_put(text, text, text, text, bigint) from public;
revoke all on function public.hm_code_get(text, text, text) from public;
revoke all on function public.hm_code_consume(text, text, text) from public;

grant execute on function public.phm_put_chart(text, jsonb) to anon, authenticated;
grant execute on function public.phm_put_scores(text, jsonb) to anon, authenticated;
grant execute on function public.phm_stats() to anon, authenticated;
grant execute on function public.phm_plays(text) to anon, authenticated;
grant execute on function public.hm_account_create(text, text, text, text, text) to anon, authenticated;
grant execute on function public.hm_account_lookup(text, text) to anon, authenticated;
grant execute on function public.hm_account_setpw(text, text, text, text) to anon, authenticated;
grant execute on function public.hm_code_put(text, text, text, text, bigint) to anon, authenticated;
grant execute on function public.hm_code_get(text, text, text) to anon, authenticated;
grant execute on function public.hm_code_consume(text, text, text) to anon, authenticated;
