-- ============================================================
-- P.H.M. 状态页 —— 探测历史（每小时一行）
-- ============================================================
-- 用途：/status 页面的「30 天」视图。
--
-- ⚠ **为什么只存失败与每小时首样本，不存每次探测**
--   9 个目标 × 60 次/小时 = 540 行/小时 = 每月 39 万行。
--   状态页真正有价值的样本是「**出事的时候**」——
--   全绿的每小时没有信息量，写进去只是烧存储。
--   所以写库侧只在两种情况写：本小时第一次、或本小时内有过失败。
--
-- ⚠ **为什么延迟用整数毫秒、可用率用千分比整数**
--   float8 往返有精度误差，同一小时算两次可能差 1e-12，
--   折算成可用率就会在边界上抖动（99.999 vs 100.001），
--   页面上表现为「同一天可用率随机变」。存整数就没这问题。
--
-- 仍遵守本项目规矩：RLS 开启、无直连、只有 SECURITY DEFINER RPC。
-- ============================================================

create table if not exists public.hm_status_hour (
  target   text    not null,
  hour     bigint  not null,          -- unix 小时戳（Date.now()/3.6e6 取整）
  up_milli integer not null,          -- 可用率 × 1000（99.875% → 99875）
  ms       integer,                   -- 该小时最后一个采样点的延迟（ms）
  ok       smallint not null default 0,
  n        integer not null default 0,-- 该小时的采样点数
  primary key (target, hour)
);

-- 只保留 30 天。⚠ 靠 primary key 冲突覆盖来滚动删除 ——
--   不建定时任务（托管环境没有可靠的 cron），改成读的时候顺手清。
comment on table public.hm_status_hour is
  '状态探测历史，每目标每小时一行。超过 30 天的行由 hm_status_get 顺带清理。';

revoke all on public.hm_status_hour from public, anon, authenticated;