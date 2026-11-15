-- ============================================================
-- hm_plays 补上 max_touch_points
--
-- 【为什么现在才发现】
--   客户端 prpr/src/huamei.rs:175 从 2026-11-14（JUDGE_VER=2）就在传这个字段：
--       max_touch_points: if keyboard { 0 } else { result.max_touch.min(255) as u8 }
--
--   但服务端两处都没接：
--     · validatePlay 的 row 对象里没有它
--     · hm_put_play 的 insert 列里也没有它
--
--   于是它一路被静默丢弃 —— 没有报错、没有告警，因为「多传字段」在 HTTP
--   层面是合法的。直到 2026-11-15 第一次查库（想按触点数分层看数据）才撞上
--   `column "max_touch_points" does not exist`。
--
-- 【这个字段值不值得单独一列】
--   值得。它是行为特征不是成绩：同样 100 万分的两个人，指法结构可能完全不同
--   （单指糊 vs 四指交替）。分析时按它分层能直接看出「这个谱的难点是手速
--   还是多指协调」。
--
--   ⚠ 不能塞进 device jsonb：device 是可空的环境信息（权限/平台相关），
--     这个是每局必有的玩法特征。混在一起会让「哪些局没有触控数据」变得
--     难以查询（jsonb 里区分「字段不存在」和「值为 null」很别扭）。
--
-- 【0 的语义】
--   0 = 键盘模式（没有触控事件），不是「没采到」。
--   旧客户端（judge_ver=1）没有这个字段 → 落库为 null，与 0 区分开。
-- ============================================================

alter table hm_plays
  add column if not exists max_touch_points smallint;

comment on column hm_plays.max_touch_points is
  '本局最大同时触点数。0 = 键盘模式；null = 旧客户端未上报（judge_ver=1）。';

-- 分析时经常按它分组，且绝大多数行会是 1~4，选择性不高 —— 但配合
-- chart_id 就很有用（同一张谱不同指法的成绩分布）。
create index if not exists hm_plays_chart_touch_idx
  on hm_plays (chart_id, max_touch_points)
  where max_touch_points is not null;
