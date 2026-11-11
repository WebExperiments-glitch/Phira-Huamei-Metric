-- ============================================================
-- 2026-11-11-lookups.sql —— 查询历史（留存的地基）
-- ============================================================
-- 【为什么做这张表】
--   现在用户查完一张谱就关掉，没有任何"回来的理由"。
--   搜到的公开经验里最有效的一条是「历史资产库」：
--     只上线这一招，7 日回访从 9% 涨到 34%。
--   原因不复杂 —— 用户下次想复盘时，第一反应是"我上次查的是啥"。
--
-- 【为什么不强制注册】
--   强制登录会把绝大多数人挡在门外（工具类产品的通病）。
--   所以主体用 `subject`：
--     cid:<uuid>   浏览器端的假名化 ID（localStorage 里的 phm_cid，政策里已披露）
--     acct:<id>    绑定账号后的稳定 ID —— 换设备能带走历史
--   匿名也能用，注册后才"升级"为跨设备。
--
-- 【存什么、不存什么】
--   存：chart_id、查过几次、第一次/最后一次时间、**上次看到的参考定数**
--   不存：查询关键词、IP、UA、任何能还原"这个人是谁"的东西
--   最小化是刻意的 —— 多存一样，隐私政策就得多写一行，用户就多一分疑虑。
--
-- 【seen_ref 是干什么的】
--   留存钩子必须讲"变化"，而不是"你查过 N 张"。
--   存下用户上次看到的参考值，下次进来就能算：
--     「Pandemic 的参考定数从 15.30 变成 15.42」
--   这才是让人愿意回来看的东西。
-- ============================================================

begin;

create table if not exists public.hm_lookups (
  id          bigserial primary key,
  subject     text        not null,
  chart_id    bigint      not null,
  times       integer     not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  seen_ref    numeric(8,4),                 -- 上次看到的参考定数
  unique (subject, chart_id)
);

create index if not exists hm_lookups_subject_last
  on public.hm_lookups (subject, last_at desc);

/* ── 记一次查询，并返回"上次的参考值"供前端比对 ──────────────
   用 upsert 而不是先查再插：高频路径上少一次往返（DB 在新加坡）。 */
create or replace function public.hm_lookup_touch(
  p_secret text, p_subject text, p_chart_id bigint, p_ref numeric default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; prev numeric; n int;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if nullif(p_subject, '') is null or p_chart_id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_args');
  end if;

  select seen_ref, times into prev, n
  from hm_lookups where subject = p_subject and chart_id = p_chart_id;

  insert into hm_lookups (subject, chart_id, times, last_at, seen_ref)
  values (p_subject, p_chart_id, 1, now(), p_ref)
  on conflict (subject, chart_id) do update
    set times = hm_lookups.times + 1,
        last_at = now(),
        seen_ref = coalesce(p_ref, hm_lookups.seen_ref);

  return jsonb_build_object('ok', true, 'times', coalesce(n, 0) + 1, 'prev_ref', prev);
end $$;

/* ── 列出最近查过的谱（带"参考值有没有变"）───────────────────── */
create or replace function public.hm_lookup_list(
  p_secret text, p_subject text, p_limit int default 30
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; rows jsonb;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'last_at' desc), '[]'::jsonb) into rows
  from (
    select jsonb_build_object(
      'chart_id', l.chart_id,
      'times',    l.times,
      'last_at',  l.last_at,
      'seen_ref', l.seen_ref,
      'ref_const', c.ref_const,
      -- 参考值变化：只在两边都有值时才给，避免把"首次记录"误报成变化
      'delta',    case when l.seen_ref is not null and c.ref_const is not null
                       then round(c.ref_const - l.seen_ref, 4) else null end,
      'name',     c.name,
      'level',    c.level,
      'difficulty', c.difficulty
    ) as x
    from hm_lookups l
    left join phm_charts c on c.chart_id = l.chart_id
    where l.subject = p_subject
    order by l.last_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 200))
  ) t;

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(rows), 'items', rows);
end $$;

/* ── 把匿名历史并入账号（绑定后调用）────────────────────────── */
create or replace function public.hm_lookup_merge(
  p_secret text, p_from text, p_to text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; moved int := 0;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_from = p_to or nullif(p_from,'') is null or nullif(p_to,'') is null then
    return jsonb_build_object('ok', false, 'error', 'bad_args');
  end if;

  insert into hm_lookups (subject, chart_id, times, first_at, last_at, seen_ref)
  select p_to, chart_id, times, first_at, last_at, seen_ref
  from hm_lookups where subject = p_from
  on conflict (subject, chart_id) do update
    set times   = hm_lookups.times + excluded.times,
        first_at = least(hm_lookups.first_at, excluded.first_at),
        last_at  = greatest(hm_lookups.last_at, excluded.last_at);
  get diagnostics moved = row_count;

  delete from hm_lookups where subject = p_from;
  return jsonb_build_object('ok', true, 'merged', moved);
end $$;

/* ── 删除（用户权利：清空我的查询历史）──────────────────────── */
create or replace function public.hm_lookup_clear(
  p_secret text, p_subject text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; n int;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  delete from hm_lookups where subject = p_subject;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n);
end $$;

revoke all on function public.hm_lookup_touch(text, text, bigint, numeric) from public;
revoke all on function public.hm_lookup_list(text, text, int) from public;
revoke all on function public.hm_lookup_merge(text, text, text) from public;
revoke all on function public.hm_lookup_clear(text, text) from public;
grant execute on function public.hm_lookup_touch(text, text, bigint, numeric) to anon, authenticated;
grant execute on function public.hm_lookup_list(text, text, int) to anon, authenticated;
grant execute on function public.hm_lookup_merge(text, text, text) to anon, authenticated;
grant execute on function public.hm_lookup_clear(text, text) to anon, authenticated;

commit;
