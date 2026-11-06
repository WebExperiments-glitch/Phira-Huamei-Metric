-- 2026-11-06 · 建 hm_plays 与 hm_put_play
--
-- 为什么需要这个迁移：
--   客户端 `phira-huamei` 每次打完都会把**逐音符判定**（8 字节/条：line_id /
--   note_id / 早晚毫秒 / 判定码）编码成 base64，POST 到 `/api/hm/play`。
--   服务端 server.mjs:575 校验后调用 `/rpc/hm_put_play`。
--   但**这个函数在库里不存在**（全库只有 hm_* 账号类函数与 phm_* 写入函数），
--   也没有任何表能放下逐音符 blob（全库无 judge / judgements / payload 列）。
--   → 每一次上报都落空，phm_scores 至今只有 15 行。
--
-- 幂等：全部 if not exists / create or replace，可重复执行。
--
-- 回滚：
--   drop function if exists public.hm_put_play(text, jsonb);
--   drop table if exists public.hm_plays;

begin;

create table if not exists public.hm_plays (
  id            bigserial primary key,
  chart_id      bigint      not null,
  chart_level   text,
  chart_digest  text,                       -- 客户端算的谱面摘要，用于对齐同一张谱的多个版本
  chart_notes   integer,
  score         integer,
  accuracy      numeric(8,6),
  max_combo     integer,
  perfect       integer,
  good          integer,
  bad           integer,
  miss          integer,
  speed         numeric(6,3),
  mods          integer,
  keyboard      boolean     not null default false,
  client_ver    text,
  judge_ver     smallint    not null default 1,
  judge_blob    text        not null,       -- base64，解码见 tools/decode_judge.py
  played_at     timestamptz,
  owner_id      text,                       -- huamei 账号 sub；匿名上报为 null
  created_at    timestamptz not null default now()
);

-- 按谱查：解码某张谱的所有逐音符记录
create index if not exists hm_plays_chart_idx    on public.hm_plays (chart_id, created_at desc);
-- 按人查：某个玩家的成绩曲线
create index if not exists hm_plays_owner_idx    on public.hm_plays (owner_id, created_at desc) where owner_id is not null;
-- 去重：同一账号对同一张谱的多次上报（保留全部，但常用"最近一次"）
create index if not exists hm_plays_dedup_idx    on public.hm_plays (chart_id, owner_id, played_at desc);

comment on table  public.hm_plays is 'huamei 客户端上报的逐音符成绩；judge_blob 见 tools/decode_judge.py';
comment on column public.hm_plays.judge_blob is 'base64；byte0=judge_ver，其后每 8 字节一条判定记录';

create or replace function public.hm_put_play(p_secret text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  new_id bigint;
begin
  -- 与 phm_put_scores 同一套鉴权：同一个 writer secret
  if p_secret is null or p_secret <> (select v from phm_secrets where k = 'writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'row must be an object' using errcode = 'P0001';
  end if;
  -- 服务端已校验过，这里只做最后一道：没有逐音符数据就不写
  if coalesce(p_row->>'judge_blob', '') = '' then
    raise exception 'judge_blob required' using errcode = 'P0001';
  end if;

  insert into hm_plays (
    chart_id, chart_level, chart_digest, chart_notes,
    score, accuracy, max_combo,
    perfect, good, bad, miss,
    speed, mods, keyboard, client_ver, judge_ver, judge_blob,
    played_at, owner_id
  ) values (
    (p_row->>'chart_id')::bigint,
    nullif(p_row->>'chart_level', ''),
    nullif(p_row->>'chart_digest', ''),
    nullif(p_row->>'chart_notes', '')::integer,
    nullif(p_row->>'score', '')::integer,
    nullif(p_row->>'accuracy', '')::numeric,
    nullif(p_row->>'max_combo', '')::integer,
    coalesce(nullif(p_row->>'perfect', '')::integer, 0),
    coalesce(nullif(p_row->>'good',    '')::integer, 0),
    coalesce(nullif(p_row->>'bad',     '')::integer, 0),
    coalesce(nullif(p_row->>'miss',    '')::integer, 0),
    coalesce(nullif(p_row->>'speed', '')::numeric, 1),
    coalesce(nullif(p_row->>'mods', '')::integer, 0),
    coalesce((p_row->>'keyboard')::boolean, false),
    nullif(p_row->>'client_ver', ''),
    coalesce(nullif(p_row->>'judge_ver', '')::smallint, 1),
    p_row->>'judge_blob',
    -- 客户端给的是 unix 秒；越界或空则记 null
    case when nullif(p_row->>'played_at', '') is null then null
         else to_timestamp((p_row->>'played_at')::double precision) end,
    nullif(p_row->>'owner_id', '')
  )
  returning id into new_id;

  return jsonb_build_object('play_id', new_id);
end;
$function$;

-- 只给服务端角色执行，不给匿名
revoke all on function public.hm_put_play(text, jsonb) from public;
grant execute on function public.hm_put_play(text, jsonb) to authenticated;

commit;
