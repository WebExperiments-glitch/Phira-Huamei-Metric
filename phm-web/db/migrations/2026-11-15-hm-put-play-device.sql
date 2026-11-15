-- ============================================================
-- hm_put_play：写入 device，并修正 played_at 的单位歧义
--
-- 【改动 1：device】
--   validatePlay 已经把 body.device 收敛成白名单对象（sanitizeDevice），
--   但原函数是逐字段 p_row->>'xxx' 显式提取的，device 没在列里，直接丢了。
--   这里加一列 —— 注意用 p_row->'device'（jsonb）而不是 ->>（text），
--   否则 jsonb 列会被写成字符串。
--
-- 【改动 2：played_at】
--   原写法：to_timestamp((p_row->>'played_at')::double precision)
--   注释写「客户端给的是 unix 秒」，但**实际是毫秒**：
--       prpr/src/huamei.rs:176
--           played_at: chrono::Utc::now().timestamp_millis()
--   1.76e12 秒 ≈ 58600 年，第一局就落成了 +058842-04-15。
--
--   validatePlay 现在会转成 ISO 字符串，但这条函数也要能自保 ——
--   万一服务端旧版本部署、或别处直接调这个 RPC，纯数字也必须按毫秒解释。
--   所以按形态分流：
--     · 纯数字 → 当毫秒，/1000 再 to_timestamp
--     · 其它   → 当 timestamptz 字面量（ISO 等）
--
-- 【为什么两件事放一个 migration】
--   它们改的是同一个函数体，拆成两个文件会让第二次 create or replace
--   覆盖第一次的结果 —— 必须一次写完。
--
-- 本文件是从 pg_get_functiondef() 导出的原文，只改了 insert 的列、values、
-- 以及 played_at 那个 case 表达式。鉴权与前置校验一字未动。
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
    played_at, owner_id, device
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
    case when jsonb_typeof(p_row->'device') = 'object' then p_row->'device' else null end
  )
  returning id into new_id;

  return jsonb_build_object('play_id', new_id);
end;
$function$;
