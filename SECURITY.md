# 安全策略

## 支持范围

当前维护分支为 `main`，支持的发布系列为 `0.3.x`。本项目是非官方、私有、
单用户集成；xAI OAuth、Responses API、MCP 或 Cloudflare 平台发生不兼容变更时，
可能需要先升级源码再恢复服务。

## 私密报告漏洞

请在 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 中提交私密
安全报告。报告应包含受影响版本、可复现步骤、预期影响和已经采取的缓解措施。

不要在公开 Issue、讨论、日志、截图或报告正文中提交以下内容：

- 真实的 `MCP_URL_TOKEN`、`ADMIN_URL_TOKEN` 或完整受保护 URL；
- `TOKEN_ENCRYPTION_KEY` 或 `.secrets.local`；
- OAuth authorization code、callback URL、access token、refresh token 或 ID token；
- Cloudflare API token、GitHub token、私钥或其他账号凭据。

公共 OAuth client ID、变量名、测试中的合成 token 和不含凭据的 `/healthz` URL
不属于秘密。

## 凭据泄露后的处理

- MCP URL 泄露：只轮换 `MCP_URL_TOKEN`，然后更新 ChatGPT 连接。
- 管理 URL 泄露：只轮换 `ADMIN_URL_TOKEN`，然后保存新的管理 URL。
- OAuth callback 或 authorization code 泄露：立即重新开始登录，不再使用原回调。
- Grok OAuth token 可能泄露：先在管理页退出，再重新登录；必要时在上游账号中撤销会话。
- `TOKEN_ENCRYPTION_KEY` 泄露：轮换该密钥，并立即重新登录 Grok。旧 SQLite 密文
  将按设计无法解密。
- Cloudflare 或 GitHub 管理凭据泄露：在对应平台撤销并轮换，同时检查审计记录和
  未知部署。

一次事故只轮换受影响的凭据。不要为了更换 URL token 而更换加密密钥；普通代码
部署和 Workers Builds 也不应上传或替换任何现有 Worker secret。
