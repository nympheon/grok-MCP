# GrokMCP

GrokMCP 是一个部署在 Cloudflare Workers 上的非官方、私有、单用户 Grok 搜索
MCP 服务。它面向 ChatGPT 网页版，只暴露 `x_search` 和 `web_search` 两个只读搜索
工具；Grok 登录、状态和退出操作全部放在受保护的中文 Worker 管理页中。

项目使用一个 SQLite Durable Object 保存 OAuth 状态，并用 Workers 内置 Web Crypto
的 AES-256-GCM 加密 OAuth 数据。仓库不包含任何真实 token、callback URL 或
Cloudflare secret。

> 本项目与 xAI、X、OpenAI、Cloudflare 均无隶属或背书关系。它复用了当前
> Grok CLI/Hermes 兼容流程的公共 OAuth client ID。上游 OAuth、API、模型能力、
> 账号套餐和服务条款都可能变化，升级前请重新核对官方文档。

## 当前运行契约

- Worker 名：`grokmcp`
- 健康检查：`GET /healthz`
- MCP URL：`https://grokmcp.<账户>.workers.dev/t/<MCP_URL_TOKEN>/mcp`
- 管理 URL：`https://grokmcp.<账户>.workers.dev/admin/t/<ADMIN_URL_TOKEN>`
- MCP 协议：仅 [`2026-07-28`](https://blog.modelcontextprotocol.io/posts/2026-07-28/)，逐请求 JSON 响应，不创建旧式会话
- MCP 工具：仅 `x_search`、`web_search`
- 状态：类名为 `GrokState`、对象名为 `single-user` 的唯一 SQLite Durable Object
- 模型：Worker 变量 `GROK_X_SEARCH_MODEL`，默认 `grok-4.5`
- Node.js：22
- 应用版本：`0.3.x`

明确不支持旧 initialize/session 客户端、SSE 传输、账号管理 MCP 工具、多账号或
多租户、旧版 xAI 原始响应兜底，以及原始帖子列表分页。

## 架构与数据流

```text
ChatGPT 网页版
  └─ 带 MCP_URL_TOKEN 的 HTTPS 请求
      └─ Worker 路由鉴权与请求体限制
          └─ MCP 2026-07-28 / x_search 或 web_search
              └─ single-user SQLite Durable Object
                  ├─ 解密或刷新 Grok OAuth token
                  └─ xAI Responses API + 对应搜索工具

浏览器
  └─ 带 ADMIN_URL_TOKEN 的中文管理页
      └─ 登录 / 回调 / 状态 / 退出
          └─ 同一个 SQLite Durable Object
```

主要边界如下：

- `src/worker.ts` 在读取请求体或访问 Durable Object 前校验精确 URL 路径，负责
  健康检查、管理路由、MCP 路由、Host/Origin 校验和请求体上限。
- `src/admin.ts` 生成无 JavaScript、无第三方资源、不可缓存的中文管理页。所有
  动态值均经过 HTML 转义；错误页只显示稳定中文说明、错误码和可选参考编号。
- `src/mcp.ts` 定义两个工具的输入 schema、`outputSchema` 和 MCP 处理器，不包含
  任何账号管理工具。
- `src/grokState.ts` 独占 SQLite OAuth 状态、刷新串行化和 xAI 调用。升级时必须
  保留 `GrokState` 类名、`v1` 迁移及 `single-user` 对象名。
- `src/cryptoVault.ts` 使用 AES-256-GCM、每条记录独立的 96 位 IV 和用途绑定 AAD。
  修改加密密钥或既有用途字符串会使当前密文无法读取。
- `src/oauth.ts` 实现 PKCE、严格 loopback callback 校验、OIDC discovery 和 token
  刷新；discovery 返回的 token endpoint 被限制在 HTTPS `x.ai` 域名。
- `src/xaiClient.ts` 构造当前 xAI Responses API 请求，只解析
  `output[].content[].output_text.text` 和引用信息，并限制超时及响应大小。

搜索历史、查询文本和搜索结果不会写入 SQLite；数据库只保存加密的 OAuth 登录
材料和短期登录尝试。

## MCP 工具、参数映射与限制

参数不是未经检查地“原样透传”。MCP 输入先经过 Zod 和运行时双重校验，再映射到
xAI Responses API：`query` 写入 `input[0].content`，过滤器和媒体选项写入
`tools[0]`。

### `x_search`

字段依据当前 [xAI X Search](https://docs.x.ai/developers/tools/x-search) 公共契约。

| MCP 参数 | xAI 请求位置 | 规则 |
|---|---|---|
| `query` | `input[0].content` | 必填，1–8,000 个字符 |
| `allowed_x_handles` | `tools[0].allowed_x_handles` | 可选，最多 20 个非空账号 |
| `excluded_x_handles` | `tools[0].excluded_x_handles` | 可选，最多 20 个非空账号 |
| `from_date` | `tools[0].from_date` | 可选，必须是真实的 `YYYY-MM-DD` 日期 |
| `to_date` | `tools[0].to_date` | 可选，必须不早于 `from_date` |
| `enable_image_understanding` | `tools[0].enable_image_understanding` | 可选布尔值 |
| `enable_video_understanding` | `tools[0].enable_video_understanding` | 可选布尔值 |

`allowed_x_handles` 与 `excluded_x_handles` 不能同时包含值。

### `web_search`

字段依据当前 [xAI Web Search](https://docs.x.ai/developers/tools/web-search) 公共契约。

| MCP 参数 | xAI 请求位置 | 规则 |
|---|---|---|
| `query` | `input[0].content` | 必填，1–8,000 个字符 |
| `allowed_domains` | `tools[0].filters.allowed_domains` | 可选，最多 5 个非空域名 |
| `excluded_domains` | `tools[0].filters.excluded_domains` | 可选，最多 5 个非空域名 |
| `enable_image_search` | `tools[0].enable_image_search` | 可选布尔值 |
| `enable_image_understanding` | `tools[0].enable_image_understanding` | 可选布尔值 |

`allowed_domains` 与 `excluded_domains` 不能同时包含值。本项目当前没有给
`web_search` 暴露日期过滤参数。

### 返回值

两个工具都声明相同的 MCP `outputSchema`。成功时，`structuredContent` 与 JSON
文本块内容一致：

```json
{
  "ok": true,
  "text": "模型综合搜索结果后生成的回答",
  "citations": ["https://example.com/source"],
  "model": "grok-4.5"
}
```

引用 URL 会去重。失败时返回稳定 `code` 和说明，并将 MCP 结果标记为错误。

### “最多搜索多少帖子”

当前 xAI X Search 公共参数和本 MCP 都没有 `max_results`，本项目也没有自行添加
这个参数。上游由 Grok 决定检索范围，再返回综合文本和引用，而不是可分页的原始
帖子数组。因此：

- 不能指定或保证固定检查多少条帖子；
- 20 是账号过滤器条目上限，不是帖子数量上限；
- 返回长度、引用数量和实际检索量会随问题、模型及 xAI 服务变化；
- xAI 账号套餐、[工具调用](https://docs.x.ai/developers/tools/tool-usage-details)和
  [速率限制](https://docs.x.ai/developers/rate-limits)仍然适用，本 Worker 不绕过这些限制。

### 本项目自己的安全上限

- MCP HTTP 请求体：128 KiB；
- 管理表单请求体：16 KiB；
- 单次查询：8,000 字符；
- xAI/OAuth 网络请求超时：60 秒；
- xAI 搜索响应：2 MiB；
- OAuth 响应：64 KiB；
- 待处理的浏览器登录：10 分钟、单次使用；
- 不保存搜索历史。

## 免费资源边界

部署只使用一个 Worker、一个 SQLite Durable Object、Worker 变量、Worker secrets
和 Workers Builds，不需要 KV、D1、R2、Queues、Workers AI 或付费加密服务。
Web Crypto 是 Workers 内置能力，不产生单独费用。

低频个人使用的目标是落在当前 [Workers 免费额度](https://developers.cloudflare.com/workers/platform/limits/)、
[Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)
和 [Workers Builds 免费额度](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
内。撰写本文时，Workers Builds 免费计划提供每月 3,000 构建分钟、1 个并发构建，
单次最长 20 分钟。平台额度可能调整，请以链接中的最新规则为准。

Cloudflare 免费不等于 xAI/Grok 免费；你仍需自行承担 Grok/X 账号套餐、上游工具
调用或速率限制带来的约束。

## 从 GitHub 安装与验证

唯一源码仓库是 `git@github.com:nympheon/grok-MCP.git`。不要依赖本地压缩备份。

```bash
git clone git@github.com:nympheon/grok-MCP.git
cd grok-MCP
npm ci
npm run verify
```

`npm run verify` 是本地、GitHub Actions 和 Workers Builds 共用的发布门禁，依次
执行 Worker 类型生成、Biome、TypeScript、全部测试和 Wrangler dry-run。它不会
启动本地 Worker，也不会部署生产版本。

依赖均精确锁定。更新依赖后必须提交同步生成的 `package-lock.json`，重新执行完整
门禁，并检查 Worker 兼容日期与生成绑定类型。

## 首次部署

前提：Node.js 22、npm、启用了 `workers.dev` 子域的 Cloudflare 账号，以及一个
兼容的个人 Grok/X 账号。

```bash
npm ci
npm run secrets:init
npx wrangler login
npm run verify
npm run deploy:with-secrets
```

`npm run secrets:init` 会创建 Git 已忽略且权限为 `0600` 的 `.secrets.local`，其中
包含三个彼此独立的 256 位随机值：

- `MCP_URL_TOKEN`：嵌入 ChatGPT MCP URL 的密码；
- `ADMIN_URL_TOKEN`：嵌入中文管理 URL 的独立密码；
- `TOKEN_ENCRYPTION_KEY`：加密 SQLite OAuth 记录的 AES 密钥。

命令不会打印这些值，并会保留已有值。`deploy:with-secrets` 仅用于首次部署或明确
轮换；已有 Worker 的普通代码升级绝不能上传新的 secrets 文件。

首次部署后，可在私密终端中构造两条受保护 URL：

```bash
npm run url -- https://grokmcp.<账户>.workers.dev
npm run admin-url -- https://grokmcp.<账户>.workers.dev
```

这两个命令会有意显示完整 bearer URL。请像密码一样保护它们，不要提交、截图、
写入日志或发送给他人。

## 使用中文管理页登录 Grok

登录、状态、callback 和退出均不是 MCP 工具。打开完整管理 URL 后：

1. 点击 **开始新的 Grok 登录**；
2. 点击 **打开 Grok 授权页面**，使用唯一的目标 Grok/X 账号登录；
3. Grok 会跳转到 `http://127.0.0.1:56121/callback?...`。浏览器显示无法连接是
   预期现象，不需要启动本地监听器；
4. 从地址栏复制包含且只包含一个 `code` 和一个 `state` 的完整 URL；
5. 在十分钟内回到管理页，将其粘贴到 **完整回调 URL**，点击
   **完成 Grok 登录**；
6. 确认账号状态显示 **已登录**。

callback URL 和 authorization code 都是短期凭据，不要共享。开始新的登录会替换
尚未完成的登录尝试；成功回调只能使用一次。

管理页还会显示当前模型、应用版本、Worker 版本、凭据时间、完整 MCP URL、公共
OAuth 兼容信息和 Cloudflare 运维说明。管理 URL 与其中显示的 MCP URL 都是密码。
点击退出会删除 OAuth 凭据和待处理登录请求，但不会删除三个 Worker secret。

## 连接 ChatGPT 网页版

按照当前 [OpenAI 自定义 MCP 连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)
添加远程 MCP，并粘贴以 `/mcp` 结尾的完整 MCP URL。不要再配置 Authorization
header 或额外 OAuth 凭据，鉴权已经包含在 URL token 中。

客户端必须支持 MCP `2026-07-28` 的逐请求 envelope 和标准 header。若客户端仍
发送旧 initialize/session 请求，Worker 会返回 `400`，而不是降级到旧协议。

## GitHub Actions 与 Workers Builds

GitHub Actions 对 `main` 推送和 Pull Request 执行：

```text
npm ci
npm run verify
npm audit --audit-level=low
```

现有 Worker 可按 [Workers Builds 配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
在 Cloudflare Dashboard 的 **Workers & Pages → grokmcp → Settings → Builds** 关联
此仓库，设置为：

```text
Production branch: main
Root directory: /
Build command: npm run verify
Deploy command: npm run deploy
```

Workers Builds 只从 GitHub 获取无密钥源码。`npm run deploy` 不提供 secrets 文件，
因此普通 `main` 提交会验证并自动部署代码，同时保留 Cloudflare 中现有的
`MCP_URL_TOKEN`、`ADMIN_URL_TOKEN`、`TOKEN_ENCRYPTION_KEY`、SQLite Durable
Object 数据和 Grok 登录。GitHub Actions 负责独立验证，不持有 Cloudflare 密钥，
也不部署生产版本。

## 日常升级与修改模型

Workers Builds 关联完成后，常规流程是：

```bash
git pull --ff-only
npm ci
npm run verify
git add <明确修改的文件>
git commit -m "说明本次修改"
git push origin main
```

推送后必须同时确认 GitHub Actions 与 Cloudflare Build 成功，再验收 `/healthz`、
中文管理页、`tools/list` 和真实搜索。普通升级不要运行 `secrets:init`、
`deploy:with-secrets` 或批量 secret 上传。

修改模型时，编辑 `wrangler.jsonc` 中的 `GROK_X_SEARCH_MODEL`，执行门禁后提交到
`main`。空值或格式非法的模型名会回退到 `grok-4.5`；格式合法但上游不支持的模型
会由 xAI 返回错误。直接在 Dashboard 修改普通变量可能被后续仓库部署覆盖，因此
仓库配置是长期事实来源。

## Secret 恢复与轮换

Cloudflare 只显示 secret 名称，不会显示已上传原值：

- 只要仍能打开管理页，就能从页面恢复完整 MCP URL；
- 丢失 `MCP_URL_TOKEN` 且无法从管理页恢复时，只能轮换并更新 ChatGPT；
- 丢失 `ADMIN_URL_TOKEN` 时无法从 Worker 读回，只能轮换并保存新的管理 URL；
- `TOKEN_ENCRYPTION_KEY` 永远不应在页面或日志中恢复。丢失本地副本不影响普通
  部署，但轮换后必须重新登录。

可在 Cloudflare Dashboard 的 Worker **Settings → Variables and Secrets** 中只
替换目标名称，也可使用 `wrangler secret put <NAME>`。轮换影响如下：

- `MCP_URL_TOKEN`：旧 ChatGPT URL 立即失效，需要更新连接；
- `ADMIN_URL_TOKEN`：旧管理 URL 立即失效，需要保存新 URL；
- `TOKEN_ENCRYPTION_KEY`：现有 OAuth 密文按设计不可读，必须重新登录 Grok。

一次只轮换实际受影响的 secret。不要为了更换 URL 而更换加密密钥。更详细的泄露
处理见 [SECURITY.md](SECURITY.md)。

## 回滚

若自动部署后的代码异常：

1. 在 Cloudflare Worker 的 Deployments 页面把上一正常版本恢复为 100% 流量；
2. 记录故障版本和上一正常版本 ID；
3. 在 GitHub 修复或回退对应提交，重新通过 `npm run verify` 后推送；
4. 验证现有 secret 名称、Grok 登录和 Durable Object 仍然有效。

普通代码回滚不会轮换 secret，也不会删除 SQLite 数据。未来若新增 Durable Object
迁移，必须先评估数据向后兼容性；恢复旧代码不等于撤销已经执行的数据迁移。

## 故障排查

| 现象 | 优先检查 |
|---|---|
| `/healthz` 正常但 MCP 返回 `404` | MCP URL 是否完整、token 是否被轮换、是否误用了管理 token |
| 管理页返回 `404` | 管理 URL 是否完整、`ADMIN_URL_TOKEN` 是否被轮换 |
| 管理操作返回 `禁止访问` | 浏览器 Origin/Host 是否与 Worker 地址一致，是否经由改写请求的代理 |
| localhost callback 无法打开 | 这是预期行为；复制地址栏完整 URL 回管理页 |
| `提交的回调 URL 无效` | 必须是精确的 `http://127.0.0.1:56121/callback`，且只有一个 `code` 和 `state` |
| `登录请求不存在、已过期或已使用` | 在管理页重新开始登录并于十分钟内完成 |
| `Grok 登录已过期` | 在管理页重新登录；永久 refresh 拒绝会清理无效凭据 |
| `RATE_LIMITED` | 遵循 xAI 限速并稍后重试；本项目不会绕过账号限制 |
| 模型调用失败 | 核对 `GROK_X_SEARCH_MODEL` 与当前 xAI 账号/工具兼容性 |
| 旧 MCP 客户端收到 `400` | 升级到支持 MCP `2026-07-28` 逐请求协议的客户端 |
| GitHub Actions 成功但线上未更新 | 检查 Cloudflare Builds 是否关联 `main`、构建和部署命令是否正确 |
| Build 中 `verify` 失败 | 先在 Node.js 22 的干净 clone 中运行 `npm ci` 和 `npm run verify` |

内部错误会在中文管理页显示 correlation ID。排查时使用该编号和 Cloudflare 的版本
信息，不要记录受保护 URL。由于 URL 路径包含 bearer token，本项目有意关闭 Worker
invocation observability；source map 仍会随版本上传用于诊断。

## 安全要点

- token 缺失、格式错误或路径不匹配时，在解析请求体或访问 Durable Object 前
  返回 `404`；MCP token 与管理 token 不可交叉使用。
- URL token 使用 SHA-256 摘要比较，代码不记录请求 URL 或请求体。
- 管理写操作只接受同源表单 POST；页面设置严格 CSP、`no-store`、`no-referrer`、
  `DENY` frame 和 `nosniff`。
- OAuth 使用 PKCE S256、随机 state/nonce、十分钟过期和单次回调；原始 state 不以
  可查询明文保存。
- OAuth 尝试和 token set 使用用途绑定 AES-GCM 加密落盘。
- 只有明确的永久 refresh 拒绝才删除登录；网络故障、超时、429、临时无效响应和
  5xx 会保留密文供稍后重试。
- 公共仓库必须排除 `.secrets.local`、真实 callback、受保护 URL、OAuth token、
  `.wrangler`、依赖、缓存和部署产物。
- 本项目仅适合一个受信任用户，不应作为共享、多租户或公开搜索代理。

## 仓库结构

```text
src/                    Worker、MCP、OAuth、加密、Durable Object 与 xAI 客户端
test/                   纯单元测试
test-worker/            workerd/Miniflare Worker 与 Durable Object 测试
test-node/              secret 管理脚本测试
scripts/secrets.mjs     首次部署/主动轮换的本地 secret 辅助工具
wrangler.jsonc          Worker、变量、SQLite Durable Object 与迁移配置
.github/workflows/      GitHub Actions 验证
AGENTS.md               后续代码维护约束
SECURITY.md             私密漏洞报告与凭据事故处理
```

## 许可证

[MIT](LICENSE)

使用本项目即表示你自行负责遵守 xAI、X、OpenAI、Cloudflare 和所在地区的适用条款
及法律，并承担非官方 OAuth 兼容流程失效的风险。
