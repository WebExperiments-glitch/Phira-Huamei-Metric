-- ── 权限：只给 anon EXECUTE（服务端用 publishable key 调；凭据在函数内校验）──
revoke all on function public.hm_api_key_create(text,text,text,text,text) from public;
