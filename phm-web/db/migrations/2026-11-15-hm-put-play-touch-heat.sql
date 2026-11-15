-- ============================================================
-- hm_put_play 补 touch_heat
--
-- 这个函数今天已经改过两次（device、max_touch_points），每次都是
-- 新文件重新 create or replace 全量定义 —— 因为旧文件已执行，改它不会重跑。
--
-- 改的就一处：insert 的列和 values 各加 touch_heat。
-- 空串统一转 null（服务端已按 88 字符长度校验过，这里只防脏值）。
-- ============================================================

CREATE OR REPLACE FUNCTION public.hm_put_play(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    played_at, owner_id, device, max_touch_points, touch_heat
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
    /* played_at：纯数字按**毫秒**，其它按 timestamptz 字面量。
       ⚠ 不要写回 to_timestamp(x::double precision) 而不管形态 ——
         那正是 58600 年那个 bug 的来源。 */
    case
      when nullif(p_row->>'played_at', '') is null then null
      when (p_row->>'played_at') ~ '^[0-9]{11,16}$'
        then to_timestamp((p_row->>'played_at')::double precision / 1000)
      else (p_row->>'played_at')::timestamptz
    end,
    nullif(p_row->>'owner_id', ''),
    /* device：用 -> 而不是 ->>，保留 jsonb 类型。
       jsonb_typeof 兜一道，防止客户端塞进来的是字符串。 */
    case when jsonb_typeof(p_row->'device') = 'object' then p_row->'device' else null end,
    /* max_touch_points：null 与 0 语义不同 ——
       null = 旧客户端没这个字段；0 = 键盘模式（确实没有触控事件）。 */
    nullif(p_row->>'max_touch_points', '')::smallint,
    /* touch_heat：base64(64 字节) = 88 字符。服务端已校验长度，
       这里只挡空串 —— 空串会让「有没有数据」变得难以判断。 */
    nullif(p_row->>'touch_heat', '')
  )
  returning id into new_id;

  return jsonb_build_object('play_id', new_id);
end;
$function$;
