# API v2 迁移（逐步执行）

在 `../api-v1` 全部执行完之后，按顺序执行 `01.sql` → `15.sql`。
新增 `hm_api_key_meta` 表与 4 个函数；旧 Key 无 meta 行时默认全部 scope、永不过期。
