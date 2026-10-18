-- ── 写入探测历史（同 (target,hour) 覆盖） ──
create or replace function public.hm_status_put(
  p_secret text, p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; n int := 0;
begin
  if p_secret is null or p_secret <> (select v from phm_secrets where k='writer') then
    raise exception 'unauthorized writer' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = 'P0001';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    /* ⚠ 每行单独校验而不是信任调用方：这是 SECURITY DEFINER 函数，
       一旦这里放过脏值，脏数据会带着函数的权限落库。 */
    if r->>'target' is null or (r->>'hour')::bigint is null then
      continue;
    end if;
    insert into hm_status_hour (target, hour, up_milli, ms, ok, n)
    values (
      r->>'target',
      (r->>'hour')::bigint,
      greatest(0, least(100000, coalesce((r->>'up_milli')::int, 0))),
      case when (r->>'ms') ~ '^[0-9]+$' then (r->>'ms')::int else null end,
      case when coalesce((r->>'ok')::int, 0) = 1 then 1 else 0 end,
      greatest(0, coalesce((r->>'n')::int, 0))
    )
    on conflict (target, hour) do update set
      up_milli = excluded.up_milli,
      ms       = excluded.ms,
      ok       = excluded.ok,
      n        = excluded.n;
    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'written', n);
end $$;