-- 2026-11-12-vote-has.sql —— 投票页改为「实时从 Phira 抽谱」
--
-- 【为什么加这个函数】
--   原本 hm_vote_pick 依赖本地 phm_charts 表，但线上那张表只有 16 行（测试残留），
--   导入 13,916 行要跨境跑几分钟且要一直同步。
--   改成实时从 Phira 列表接口抽：一次拉 30 条，只需要知道「这 30 条里哪几条我投过」。
--
-- 【限制】/chart 列表只返回 tags 含 regular 的谱（9,758 张 / 326 页）。
--   plain 与 troll 拿不到 —— 这是上游端点的硬限制，不是我们的选择。
--   对「标定难度」来说 regular 类是主体，够用。
begin;

create or replace function public.hm_vote_has(
  p_secret text, p_subject text, p_ids bigint[]
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; arr jsonb;
begin
  select v into s from phm_secrets where k = 'writer';
  if s is null or p_secret is null or p_secret <> s then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(chart_id), '[]'::jsonb) into arr
  from hm_votes where subject = p_subject and chart_id = any(p_ids);
  return arr;
end $$;

revoke all on function public.hm_vote_has(text, text, bigint[]) from public;
grant execute on function public.hm_vote_has(text, text, bigint[]) to anon, authenticated;

commit;
