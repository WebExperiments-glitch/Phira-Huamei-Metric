-- ============================================================
-- hm_plays 幂等去重：(chart_id, played_at, score) 唯一
--
-- 【为什么需要】
--   /api/hm/play 改成异步队列之后，有一个新的失败模式：
--     入队成功 → 返回 202 → 进程重启 → 队列没了 → 这局没落库
--
--   客户端收到 202 就认为提交成功、删掉本地记录 —— 但它其实没落库。
--   补救只能靠「下次上传时重传」，而重传要保证**不会插两条**。
--
--   在此之前也有重复风险：504 之后玩家点「重试」，前一次可能其实已经写进去了。
--
-- 【为什么用这三个字段】
--   · chart_id   —— 哪张谱
--   · played_at  —— 哪一局（客户端传的结算时刻，毫秒）
--   · score      —— 打了多少分
--
--   同一张谱、同一毫秒、同一个分数 = 同一局。三次都撞上的概率可以忽略。
--   ⚠ 不把 accuracy 加进来：它是 score 的衍生量，加了只是让唯一键变长。
--
-- 【为什么是 partial index】
--   played_at 可以是 null（旧客户端 / 校验失败收敛成 null）。
--   PostgreSQL 的唯一索引对 null 不生效 —— 多行 null 都算不同值，
--   所以 null 行本来就不会冲突，加 `where` 只是让索引小一点。
--   但要注意：**null 行完全不去重**，重复的旧数据仍可能进来。
--   这是可接受的：新旧混在一起时，null 行本来就是少数。
--
-- 【先查过重复】
--   2026-11-15 加索引前查过：总数 7、重复组 0。
--   不先查就加索引，遇到重复会直接 migration 失败。
-- ============================================================

create unique index if not exists hm_plays_dedup_idx
  on hm_plays (chart_id, played_at, score)
  where played_at is not null;

comment on index hm_plays_dedup_idx is
  '幂等去重：同一张谱、同一结算时刻、同一分数视为同一局。支撑异步队列的「重传不重复插入」。';

-- 让 hm_put_play 在冲突时**静默返回已有 id**，而不是抛异常。
-- 队列的重试逻辑看到异常会继续重试，那对「已经写进去了」是浪费。
create or replace function public.hm_put_play_dedup(p_secret text, p_row jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  new_id bigint;
begin
  begin
    new_id := (public.hm_put_play(p_secret, p_row)->>'play_id')::bigint;
  exception
    when unique_violation then
      /* 已经写过了 —— 按幂等语义返回**已有那条**的 id，当作成功。
         客户端/队列不该为此重试。 */
      select id into new_id from hm_plays
       where chart_id = (p_row->>'chart_id')::bigint
         and played_at = case
               when (p_row->>'played_at') ~ '^[0-9]{11,16}$'
                 then to_timestamp((p_row->>'played_at')::double precision / 1000)
               else (p_row->>'played_at')::timestamptz
             end
         and score = (p_row->>'score')::integer
       limit 1;
      return jsonb_build_object('play_id', new_id, 'duplicate', true);
  end;
  return jsonb_build_object('play_id', new_id);
end;
$function$;
