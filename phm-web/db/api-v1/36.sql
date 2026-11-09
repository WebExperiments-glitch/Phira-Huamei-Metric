-- 一个人同时只能有一条 pending：靠部分唯一索引在数据库层保证，
-- 不能只靠 RPC 里的 exists 检查（并发两次提交会同时通过）。
create unique index if not exists hm_tier_requests_one_pending
  on public.hm_tier_requests (owner_id) where status = 'pending';
