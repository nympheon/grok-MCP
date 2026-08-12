# grok-x-search-mcp

这是一个部署在 Cloudflare Workers 上的非官方、私有、单用户 Grok 搜索
MCP 服务。它面向 ChatGPT 网页版，使用一个 SQLite Durable Object 保存
OAuth 状态，并通过 Workers 内置 Web Crypto AES-256-GCM 加密凭据。

**语言：** [English](README.md) | [日本語](README.ja.md) | 中文

> 本项目与 xAI、X、OpenAI、Cloudflare 均无隶属或背书关系。它复用了
> Grok CLI/Hermes 兼容流程的公共 OAuth client ID；上游 OAuth、API 和服务
> 条款随时可能变化。

## 当前运行契约

- Worker 名：`grokmcp`
- 健康检查：`GET /healthz`
- MCP：`https://grokmcp.<账户>.workers.dev/t/<MCP_URL_TOKEN>/mcp`
- 管理页：`https://grokmcp.<账户>.workers.dev/admin/t/<ADMIN_URL_TOKEN>`
- MCP 协议：仅支持 `2026-07-28`，每次请求独立并返回 JSON
- MCP 工具：仅 `x_search` 和 `web_search`
- 状态：名为 `single-user` 的唯一 SQLite Durable Object
- 模型：Worker 变量 `GROK_X_SEARCH_MODEL`，当前默认 `grok-4.5`

项目明确不兼容旧的 initialize/session MCP 客户端、SSE 传输、账号管理 MCP
工具，以及旧版 xAI 原始响应兜底。

## 免费额度边界

Web Crypto 是 Workers 内置能力，不会产生单独费用。部署只使用 Worker、一个
SQLite Durable Object、Worker 变量和 Worker secrets，目标是让低频个人使用
落在当前 [Workers 免费额度](https://developers.cloudflare.com/workers/platform/limits/)
和 [Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)
内。Cloudflare 的额度以后可能改变；你仍须拥有兼容的 Grok/X 订阅。

## 安装、校验与部署

需要：已开通 `workers.dev` 子域的 Cloudflare 免费账户、唯一的个人 Grok/X
账号、Node.js 22 或更高版本，以及 npm。

以下命令不会启动本地 Worker：

```bash
npm ci --cache .npm-cache
npm run secrets:init
npx wrangler login
npm run types
npm run check
npm run typecheck
npm test
npm audit --audit-level=low --cache .npm-cache
npm run deploy:dry
npm run deploy:with-secrets
```

`deploy:with-secrets` 只用于首次部署或明确的 secret 轮换。普通代码升级应使用
不带 secrets 文件的 `npm run deploy`；Cloudflare 会校验必需名称并保留现有加密值。

`npm run secrets:init` 会创建或校验 Git 已忽略、权限为 `0600` 的
`.secrets.local`，其中有三个独立的 256 位值：

- `MCP_URL_TOKEN`：嵌入 ChatGPT MCP 地址的密码
- `ADMIN_URL_TOKEN`：嵌入管理页地址的独立密码
- `TOKEN_ENCRYPTION_KEY`：用于加密 SQLite OAuth 记录的 AES 密钥

命令会保留已有本地值且不会打印它们。Cloudflare 在首次部署时接收这些值，但
以后不会显示原值。单独备份很有用，但普通代码升级不依赖该文件，因为 Wrangler
部署不会删除已有 Worker secrets。

部署后使用 Wrangler 输出的真实基础地址：

```bash
npm run url -- https://grokmcp.<账户>.workers.dev
npm run admin-url -- https://grokmcp.<账户>.workers.dev
```

这两个命令会有意打印受保护地址。请把两条 URL 都当作密码，不要提交、截图、
写入日志或转发。

## 连接 ChatGPT 网页版

按照当前 [OpenAI 自定义 MCP 连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)，
粘贴以 `/mcp` 结尾的完整 MCP URL。不要再配置 Authorization header 或 OAuth
凭据；鉴权信息已经包含在 URL token 中。

客户端必须支持 MCP `2026-07-28` 的逐请求 envelope 和标准 header。成功调用
直接返回 JSON，不会建立 MCP 会话。

## 登录 Grok

登录、状态、回调和登出均不作为 MCP 工具暴露。请在浏览器打开受保护管理页：

1. 点击 **Start a new Grok login**。
2. 打开生成的授权链接，并使用目标 Grok/X 账号登录。
3. Grok 会跳转到 `http://127.0.0.1:56121/callback?...`。浏览器显示无法连接
   是预期行为，不需要运行本地监听器。
4. 从地址栏复制完整 URL，确保恰好包含一个 `code` 和一个 `state`，并在十分钟
   内粘贴到 Worker 管理页。
5. 确认页面显示 **Signed in**。

回调 URL 是短期凭据。不要分享，也不要只复制授权 code。

## 搜索工具

两个工具都声明了 MCP `outputSchema`。成功调用会返回与其匹配的
`structuredContent`，以及内容相同的 JSON 文本块：

```json
{
  "ok": true,
  "text": "回答内容",
  "citations": ["https://example.com/source"],
  "model": "grok-4.5"
}
```

| 工具 | 输入 |
|---|---|
| `x_search` | 必填 `query`；可选 `allowed_x_handles` 或 `excluded_x_handles`（最多 20 个且互斥）、真实日期 `from_date`/`to_date`（`from_date <= to_date`）、`enable_image_understanding`、`enable_video_understanding` |
| `web_search` | 必填 `query`；可选 `allowed_domains` 或 `excluded_domains`（最多 5 个且互斥）、`enable_image_search`、`enable_image_understanding` |

查询最长 8,000 字符。上游调用 60 秒超时，响应上限 2 MiB，引用链接会去重，
且不会保存搜索历史。

## 修改模型与升级 Worker

修改 `wrangler.jsonc` 中的 `GROK_X_SEARCH_MODEL`，执行完整校验后重新部署即可
切换模型。无效模型名会回退到 `grok-4.5`。

如果临时项目已被删除，先恢复无密钥源代码归档并验证 SHA-256。解压到新的私有
目录，运行 `npm ci`，执行除 `secrets:init` 外的全部校验，确认
`npx wrangler whoami` 后运行 `npm run deploy`。已有 Worker 的普通升级不需要本地
secret 文件：Cloudflare 会在远端校验必需名称并保留原值。必须保留 `GrokState`
类、迁移历史和 `single-user` 对象名，才能继续使用现有加密 SQLite 状态。

受保护管理页会显示应用版本、部署版本、当前模型、公共 OAuth 兼容信息、登录
状态和可恢复的 MCP URL；但修改代码仍需要源代码归档。

## 密钥轮换

- 更换 `MCP_URL_TOKEN` 会使旧 ChatGPT URL 失效，随后更新 ChatGPT 连接。
- 更换 `ADMIN_URL_TOKEN` 会使旧管理页 URL 失效。
- 只有准备重新登录 Grok 时才更换 `TOKEN_ENCRYPTION_KEY`；旧 OAuth 密文按设计
  将无法读取。

在 Cloudflare Workers → `grokmcp` → 设置 → 变量和 Secrets 中只轮换目标名称
（也可使用 `wrangler secret put`），随后重新构造并收藏受影响的保护 URL。不要
为了轮换 URL 而更换加密密钥。本地恢复文件已不存在时，这就是受支持的轮换方式。

## 安全说明

- 路径缺少 token 或 token 错误时，在解析请求体或访问 Durable Object 前返回
  `404`。
- MCP 与管理 token 完全独立，不可交叉使用。
- 管理操作只接受同源表单 POST；页面无脚本、不可缓存、不会发送 Referer、不可
  被 iframe 嵌入。
- OAuth 尝试和 token set 使用带用途绑定的 AES-GCM 记录加密落盘。
- 永久性 refresh 拒绝会清除无效凭据；临时 OAuth/xAI 故障会保留凭据以便重试。
- 因 URL 路径内含 bearer token，Worker invocation observability 保持关闭；部署
  会上传 source map 用于版本化诊断。
- 这是单用户设计，不应作为共享或多租户服务公开。

## 许可证

[MIT](LICENSE)
