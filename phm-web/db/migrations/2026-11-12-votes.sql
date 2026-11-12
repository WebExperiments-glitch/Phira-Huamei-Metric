-- ============================================================
-- 2026-11-12-votes.sql —— 人类难度标注（投票）
-- ============================================================
-- 【为什么做这个】
--   我们有 6,566 万条玩家成绩，但 IRT 只能解释 12% 的难度方差（r2=0.1187）。
--   原因是「行为」推不出「判断」——打了多少分 ≠ 觉得多难。
--   真正缺的是**有人直接说「这谱我觉得 15.8」**。
--
-- 【设计要点】
--   1. 随机抽谱：消除选择性偏差（不是只投自己喜欢的）
--   2. 先打再投：有成本，不是瞎点。`played` 记录是否下载过
--   3. **「打不过」也是有效答案** —— 10 个人说打不过，比 3 个人投 16.0 更有力。
--      如果不收这个信号，用户抽到超纲的谱只会关掉页面，难谱永远没票
--   4. 一人一谱一票（subject + chart_id 唯一），可改不可刷
--   5. 按能力范围抽谱（±1.5），否则抽到远超水平的谱等于劝退
--
-- 【subject 是什么】
--   沿用查询历史那套：cid:<浏览器UUID>，绑定账号后是 acct:<id>。
--   匿名就能投 —— 让用户先注册再投票，等于没人投。
-- ============================================================

begin;

create table if not exists public.hm_votes (
  id          bigserial primary key,
  subject     text        not null,
  chart_id    bigint      not null,
  /* 用户给出的定数（如 15.8）。verdict='too_hard' 时留空 */
  value       numeric(4,1),
  /* 'rated' 给了数值 | 'too_hard' 打不过 | 'too_easy' 明显更简单 */
  verdict     text        not null default 'rated',
  /* 投票前是否点过下载 —— 质量权重，不是防作弊 */
  played      boolean     not null default false,
  /* 该用户自报的能力档（12/14/16/18），用于事后按水平分桶分析 */
  band        integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (subject, chart_id),
  constraint hm_votes_verdict_chk check (verdict in ('rated','too_hard','too_easy')),
  constraint hm_votes_value_chk check (
    (verdict = 'rated' and value is not null and value >= 1 and value <= 25)
    or (verdict <> 'rated' and value is null)
  )
);

create index if not exists hm_votes_chart on public.hm_votes (chart_id);
create index if not exists hm_votes_subject on public.hm_votes (subject, created_at desc);

/* 行级安全：读写全走 SECURITY DEFINER 函数，匿名角色连表级权限都没有 */
alter table public.hm_votes enable row level security;
revoke all on public.hm_votes from anon, authenticated;

/* ── 抽一张「你没投过」的谱 ───────────────────────────────
   随机 + 范围过滤 + 排除已投。
   ⚠ 用 random() 而不是「按 id 递增」：递增会让用户总是打到相邻的谱，
     样本集中在某一批，失去代表性。1.4 万行上 order by random() 完全够快。 */
create or replace function public.hm_vote_pick(
  p_secret text, p_subject text, p_lo numeric default 8, p_hi numeric default 18,
  p_band integer default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; row_out jsonb;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'chart_id', c.chart_id,
    'name', c.name,
    'level', c.level,
    'difficulty', c.difficulty,
    'charter', c.charter,
    'ref_const', c.ref_const,
    'votes', (select count(*) from hm_votes v where v.chart_id = c.chart_id)
  ) into row_out
  from phm_charts c
  where c.difficulty between coalesce(p_lo, 8) and coalesce(p_hi, 18)
    and not exists (
      select 1 from hm_votes v
      where v.chart_id = c.chart_id and v.subject = p_subject
    )
  order by random()
  limit 1;

  return coalesce(row_out, 'null'::jsonb);
end $$;

/* ── 投一票（可改）───────────────────────────────────────── */
create or replace function public.hm_vote_put(
  p_secret text, p_subject text, p_chart_id bigint,
  p_verdict text default 'rated', p_value numeric default null,
  p_played boolean default false, p_band integer default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
/* ⚠ 变量名不能叫 v：phm_secrets 有一列就叫 v，
   `select v into s` 时 PostgreSQL 会报 "column reference v is ambiguous"。
   2026-11-12 实际踩到 —— 投票一直 502，日志里才看到。 */
declare s text; vd text; n int;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;

  vd := coalesce(nullif(p_verdict, ''), 'rated');
  if vd not in ('rated','too_hard','too_easy') then
    return jsonb_build_object('ok', false, 'error', 'bad_verdict');
  end if;

  insert into hm_votes (subject, chart_id, value, verdict, played, band)
  values (p_subject, p_chart_id,
          case when vd = 'rated' then p_value else null end, vd, coalesce(p_played,false), p_band)
  on conflict (subject, chart_id) do update
    set value = case when vd = 'rated' then excluded.value else null end,
        verdict = vd,
        played = hm_votes.played or excluded.played,
        band = coalesce(excluded.band, hm_votes.band),
        updated_at = now();

  /* 返回这张谱当前的聚合，界面上立刻能看到「你的票 vs 大家的」 */
  select count(*) into n from hm_votes where chart_id = p_chart_id;
  return jsonb_build_object(
    'ok', true, 'total', n,
    'avg', (select round(avg(value), 2) from hm_votes
            where chart_id = p_chart_id and verdict = 'rated'),
    'too_hard', (select count(*) from hm_votes
                 where chart_id = p_chart_id and verdict = 'too_hard')
  );
end $$;

/* ── 今日进度（给自己看的激励）──────────────────────────── */
create or replace function public.hm_vote_today(
  p_secret text, p_subject text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; n int;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select count(*) into n from hm_votes
  where subject = p_subject and created_at >= date_trunc('day', now());
  return jsonb_build_object('ok', true, 'today', n);
end $$;

revoke all on function public.hm_vote_pick(text, text, numeric, numeric, integer) from public;
revoke all on function public.hm_vote_put(text, text, bigint, text, numeric, boolean, integer) from public;
revoke all on function public.hm_vote_today(text, text) from public;
grant execute on function public.hm_vote_pick(text, text, numeric, numeric, integer) to anon, authenticated;
grant execute on function public.hm_vote_put(text, text, bigint, text, numeric, boolean, integer) to anon, authenticated;
grant execute on function public.hm_vote_today(text, text) to anon, authenticated;

commit;
