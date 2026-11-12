-- 修 hm_vote_has 的参数格式
-- 原签名 p_ids bigint[] 在 PostgREST 里会被当成 PG 数组字面量解析，
-- 而前端传的是 JSON 数组 [1,2,3] → "malformed array literal"。
-- 改成逗号分隔字符串，内部再转数组 —— 少一层格式猜测。
begin;

drop function if exists public.hm_vote_has(text, text, bigint[]);

create or replace function public.hm_vote_has(
  p_secret text, p_subject text, p_ids text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; arr jsonb; id_arr bigint[];
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if nullif(p_ids, '') is null then return '[]'::jsonb; end if;
  id_arr := string_to_array(p_ids, ',')::bigint[];
  select coalesce(jsonb_agg(chart_id), '[]'::jsonb) into arr
  from hm_votes where subject = p_subject and chart_id = any(id_arr);
  return arr;
end $$;

revoke all on function public.hm_vote_has(text, text, text) from public;
grant execute on function public.hm_vote_has(text, text, text) to anon, authenticated;

commit;
