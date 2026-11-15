-- ============================================================
-- hm_plays 增加 device 列（设备与系统信息）
--
-- 【为什么用 jsonb 而不是 6 个独立列】
--   这批字段是「探索性采集」：os_version / model / screen / lat / lon / gyro，
--   后面很可能增删（比如再加 battery、thermal_state、network_type）。
--   6 个列每次改动都要 migration + 改所有查询；jsonb 加字段零成本，
--   分析时用 `device->>'model'` 取即可。
--
--   代价是：
--     · 没法直接建普通索引 —— 真要按机型聚合时建 GIN 或表达式索引：
--         create index on hm_plays ((device->>'model'));
--     · 类型不受约束 —— 由服务端 validatePlay 保证形状。
--
-- 【为什么可空】
--   权限被拒（定位/陀螺仪）、平台不支持（非 iOS）、旧客户端都会是 null。
--   收了 1 条真实数据（2026-11-15）之后才加这一列，所以历史行是 null。
-- ============================================================

alter table hm_plays
  add column if not exists device jsonb;

comment on column hm_plays.device is
  '设备与系统信息：{os_version, model, screen:[w,h,dpr], lat, lon, gyro:[mean,std,peak]}。全部可空，未授权或旧客户端为 null。';
