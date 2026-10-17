# 安全策略

## 报告漏洞

请**不要**公开开 Issue。用 GitHub Security Advisories 的私密报告，或直接联系仓库所有者。
请给出：受影响版本/路径、复现步骤、影响面、建议修复。收到后会尽快确认。

## 支持范围

只维护**最新发布版本**（当前线上版本见 `/version`）。旧版本不单独回补安全修复。

## 本仓库的硬约束

- 仓库是公开的：**任何密钥都不进 git**。生产写入凭据只走环境变量 / `.env` /
  `write-secret.txt`（后两者 gitignore），详见 `phm-web/docs/SECURITY.md`。
- 数据库写路径只有 SECURITY DEFINER RPC；表 RLS 开启、任何角色无直连。
- API Key 只存 sha256 哈希 + 掩码，明文只在创建时返回一次。
- 限流键只用 `req.socket.remoteAddress`，**不采信 X-Forwarded-For**。
- 客户端不上传谱面文件（API v1 只接受 chart_id）。

## 自动化防线

- GitHub secret scanning + push protection（公开仓库免费）
- Dependabot alerts / security updates
- CodeQL（JS/TS + Python）
- `review-gate` + pre-push + CI `audit` + 分支保护
