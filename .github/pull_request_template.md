# 改动说明

<!-- 一句话说清「改了什么、为什么」。不要把 diff 抄一遍。 -->

## 类型
- [ ] 用户可见功能 / UI
- [ ] 后端 / API
- [ ] 数据库 / 迁移
- [ ] 测试 / CI / 工具
- [ ] 文档
- [ ] 安全修复

## 自检（缺一不可）
- [ ] `cd phm-web && npm run preflight` 通过（review-gate + OpenAPI 契约 + 16 项离线检查）
- [ ] CI 的 `check` **和** `audit` 都通过（分支保护会强制）
- [ ] 没有提交任何密钥：`.env` / `write-secret.txt` / token / 私钥 / 带密码的连接串
- [ ] 用户可见改动：版本号（`bump-version.py`）、`CHANGELOG.md`、`versions.js` 已同步
- [ ] API 改动：`/developers` 文档、OpenAPI、测试至少同步一处
- [ ] 数据库改动：迁移有 RLS + REVOKE + SECURITY DEFINER，且更新了 `docs/DATA-MODEL.md`
- [ ] 新增页面：已加进 `PUBLIC_FILES` + `CLEAN` + `ARCHITECTURE.md`

## 风险与回滚
- 影响范围：
- 回滚方式：
- 需要人工验证的点：
