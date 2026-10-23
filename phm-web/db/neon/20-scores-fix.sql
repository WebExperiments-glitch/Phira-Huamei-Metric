-- ============================================================
-- 20-scores-fix.sql —— 重建 phm_scores（字段按**真实白名单**来）
-- ============================================================
-- 【为什么要重建】
--   10-core.sql 里这张表是我在没有旧库的情况下**猜**出来的：当时只看到
--   lib/hm.mjs 的 validatePlay 里有 score/accuracy/max_combo/perfect/good…
--   就照着建了。但那套字段是 **Phira 成绩校验**用的，跟"数据飞轮"实际提交的
--   完全不是一回事。
--
--   真实契约在 server.mjs 的 LIMITS / TEXTS 里（那是唯一会过滤入库字段的地方）：
--     数值：chart_id difficulty ref_const ps_score nps hold_ratio notes
--           stair_avg speed_peak acc song_rks official_const phira_user_id
--     文本：name level chart_name chart_diff chart_level phira_user_name
--           engine_ver client_id source
--   所以这张表要按那份白名单建 —— 一一对应，不多不少。
--
-- 【症状回顾】
--   线上点「全部进入数据飞轮」→ 红字「服务端未写入任何行」。
--   根因有两层：
--     ① lib/db-pg.mjs 把 JS 数组按 **Postgres 数组字面量** 传给 jsonb 参数
--        → `invalid input syntax for type json`（已修）
--     ② 即使写进去，player 列也是空的（提交的是 phira_user_name）
--        → /api/plays 查不到自己的成绩
--   两层都不报错到前端，只表现为「没数据」。
-- ============================================================

/* ⚠ 重建前必须确认表是空的。这不是洁癖：一旦有真实成绩，drop 就是永久丢失。
   本项目已经因为"没有备份"丢过一次数据了（2026-10-21 腾讯隔离库）。 */
do $$
declare n int;
begin
  select count(*) into n from public.phm_scores;
  if n > 0 then
    raise exception 'phm_scores 里已有 % 行，拒绝重建。先导出再手工处理', n;
  end if;
end $$;

drop table if exists public.phm_scores;

create table public.phm_scores (
  id              bigserial primary key,
  chart_id        bigint,
  chart_name      text,
  chart_diff      text,
  chart_level     text,
  name            text,
  level           text,
  difficulty      numeric,
  ref_const       numeric,
  ps_score        numeric,
  nps             numeric,
  hold_ratio      numeric,
  notes           integer,
  stair_avg       numeric,
  speed_peak      numeric,
  acc             numeric,
  song_rks        numeric,
  official_const  numeric,
  phira_user_id   bigint,
  phira_user_name text,
  engine_ver      text,
  client_id       text,
  source          text,
  created_at      timestamptz not null default now()
);

/* 同一个玩家、同一张谱只留最好的一次 —— /user 页写的就是「每谱取最好一次」。
   没有这个唯一索引，每点一次「全部进入数据飞轮」就整批重复一遍。 */
create unique index if not exists phm_scores_player_chart_uidx
  on public.phm_scores (phira_user_id, chart_id) where chart_id is not null and phira_user_id is not null;
create index if not exists phm_scores_name_idx on public.phm_scores (phira_user_name);
create index if not exists phm_scores_chart_idx on public.phm_scores (chart_id);
create index if not exists phm_scores_time_idx on public.phm_scores (created_at desc);

alter table public.phm_scores enable row level security;
revoke all on public.phm_scores from public, anon, authenticated;
comment on table public.phm_scores is '数据飞轮提交的玩家成绩。字段与 server.mjs 的 LIMITS/TEXTS 白名单一一对应；只能经 phm_put_scores() 写';

-- ── 写：一条一条插，冲突时只在更好成绩时更新 ──
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
    /* 没有曲名或准确度的行不算成绩（与 server.mjs 的必填口径一致） */
    if (r->>'chart_name') is null or (r->>'acc') is null then continue; end if;

    insert into phm_scores (
      chart_id, chart_name, chart_diff, chart_level, name, level, difficulty,
      ref_const, ps_score, nps, hold_ratio, notes, stair_avg, speed_peak,
      acc, song_rks, official_const, phira_user_id, phira_user_name,
      engine_ver, client_id, source
    ) values (
      nullif(r->>'chart_id','')::bigint,
      r->>'chart_name',
      r->>'chart_diff',
      r->>'chart_level',
      r->>'name',
      r->>'level',
      nullif(r->>'difficulty','')::numeric,
      nullif(r->>'ref_const','')::numeric,
      nullif(r->>'ps_score','')::numeric,
      nullif(r->>'nps','')::numeric,
      nullif(r->>'hold_ratio','')::numeric,
      nullif(r->>'notes','')::integer,
      nullif(r->>'stair_avg','')::numeric,
      nullif(r->>'speed_peak','')::numeric,
      nullif(r->>'acc','')::numeric,
      nullif(r->>'song_rks','')::numeric,
      nullif(r->>'official_const','')::numeric,
      nullif(r->>'phira_user_id','')::bigint,
      r->>'phira_user_name',
      r->>'engine_ver',
      r->>'client_id',
      r->>'source'
    )
    on conflict (phira_user_id, chart_id) where chart_id is not null and phira_user_id is not null
    do update set
      acc        = greatest(phm_scores.acc, excluded.acc),
      song_rks   = greatest(phm_scores.song_rks, excluded.song_rks),
      /* 其它字段只在这次更好时覆盖 —— 保留"最好那一次"的上下文 */
      chart_name = case when excluded.acc >= coalesce(phm_scores.acc, -1) then excluded.chart_name else phm_scores.chart_name end,
      official_const = case when excluded.acc >= coalesce(phm_scores.acc, -1) then excluded.official_const else phm_scores.official_const end,
      source     = case when excluded.acc >= coalesce(phm_scores.acc, -1) then excluded.source else phm_scores.source end;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'written', n);
end $$;

-- ── 读：某个 Phira 玩家的成绩（/api/plays?name=…）──
--     ⚠ 按 phira_user_name 查，不是 player —— 飞轮提交的就是这个字段。
create or replace function public.phm_plays(name_in text)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'name', name_in,
    'n',    count(*),
    'rows', coalesce(jsonb_agg(to_jsonb(t) - 'id' order by t.acc desc), '[]'::jsonb)
  )
  from (
    select * from phm_scores where phira_user_name = name_in
  ) t;
$$;

revoke all on function public.phm_put_scores(text, jsonb) from public;
revoke all on function public.phm_plays(text) from public;
grant execute on function public.phm_put_scores(text, jsonb) to anon, authenticated;
grant execute on function public.phm_plays(text) to anon, authenticated;
