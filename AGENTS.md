# GrokMCP 维护指南

修改 Worker 前先阅读本文件。GitHub 仓库 `nympheon/grok-MCP` 的 `main` 分支是
唯一源码事实来源；Cloudflare Workers Builds 是现有 `grokmcp` Worker 的常规部署
入口。本项目不是本地 stdio 软件包，也不是多用户服务。

## 不可破坏的运行契约

- Worker/service 名：`grokmcp`；
- 公开路由：`GET /healthz`；
- MCP 路由：`/t/<MCP_URL_TOKEN>/mcp`；
- 中文管理路由：`/admin/t/<ADMIN_URL_TOKEN>`；
- Durable Object 类名：`GrokState`；
- Durable Object 稳定对象名：`single-user`；
- SQLite 初始迁移标签：`v1`；
- MCP 表面：只能有 `x_search`、`web_search`；
- MCP wire revision：仅 `2026-07-28`，每个请求返回一个 JSON 响应；
- 默认模型：Worker 变量 `GROK_X_SEARCH_MODEL`，当前为 `grok-4.5`；
- xAI 输出文本：只接受当前 REST 结构
  `output[].content[].output_text.text`。

不要恢复旧 initialize/session 传输、SSE、顶层 xAI `output_text` 兼容分支、原始
帖子列表或账号管理 MCP 工具。成功结果同时提供 `structuredContent` 和内容相同的
JSON 文本块是当前有意设计，不是旧协议兼容层。

## 源码职责

- `src/worker.ts`：在读取请求体前完成 URL token 鉴权，负责公开/管理/MCP 路由、
  Host/Origin 检查、表单解析和请求体限制。绝不能记录请求 URL 或请求体。
- `src/admin.ts`：生成简体中文、无脚本、不可缓存的控制面。所有运行时值必须经过
  HTML 转义；错误只按 `ToolErrorCode` 映射，不得显示原始上游错误。
- `src/mcp.ts`：定义两个搜索工具、输入 schema、`outputSchema` 和 handler。不得加入
  登录、状态、回调、退出或其他账号工具。
- `src/grokState.ts`：管理 SQLite、加密 OAuth 尝试/token、刷新串行化、退出顺序和
  搜索调用。迁移和加密数据格式属于持久契约。
- `src/cryptoVault.ts`：使用 AES-256-GCM、每条记录独立 96 位 IV 和用途绑定 AAD。
  既有用途字符串不能随意修改。
- `src/oauth.ts`：实现当前公共 Grok CLI/Hermes 兼容 native client 的 PKCE 与 token
  交换。client ID 是公开兼容依赖，不是 secret，但上游可能随时调整。
- `src/xaiClient.ts`：验证 xAI search 契约、限制响应并解析当前 wire 结构。上游
  参数变化时，必须同步更新 schema、运行时验证、fixture、测试和 README。
- `src/urlAuth.ts`：解析固定形状 token 路径并比较 SHA-256 摘要，不能改回提前退出的
  明文字符串比较。
- `scripts/secrets.mjs`：只服务首次部署或主动轮换，原子创建/迁移权限为 `0600` 的
  本地文件。除明确 URL 命令外不得打印任何值。

## Secret 与状态

生产环境必须有三个独立 Worker secret：

- `MCP_URL_TOKEN`：保护 ChatGPT MCP 连接；
- `ADMIN_URL_TOKEN`：保护登录、状态、URL 恢复和退出；
- `TOKEN_ENCRYPTION_KEY`：加密 OAuth 行，绝不能打印、提交或写入日志。

`.secrets.local` 只用于首次部署或明确轮换，必须被 Git 忽略。常规升级不得重新生成
并上传三个值。`npm run deploy` 有意不提供 secrets 文件，Cloudflare 会校验所需名称
并保留远端值；`npm run deploy:with-secrets` 只允许首次部署或经确认的主动轮换。

轮换某个 URL token 只应使对应 URL 失效。轮换 `TOKEN_ENCRYPTION_KEY` 会让现有 OAuth
密文不可读，随后必须重新登录。除非包含经过验证的数据迁移，不得重命名
`GrokState`、删除 `v1` SQLite 迁移、改变 `single-user` 对象名或既有 AAD 用途字符串。

## 登录与刷新行为

登录只能在受保护的中文管理页进行：

1. 开始登录后，Durable Object 保存十分钟有效的加密 PKCE/state 材料；
2. Grok 跳转到 `http://127.0.0.1:56121/callback`，不需要本地 listener；
3. 用户把完整地址栏 URL 粘贴回管理表单；
4. Durable Object 校验精确 origin/path、唯一 `code`、唯一 `state`、过期时间和单次
   使用，再交换 token。

只有明确的永久 refresh 拒绝（`invalid_grant`、`invalid_token` 或身份拒绝）才可
删除凭据。网络失败、超时、429、临时格式异常和 5xx 必须保留加密登录供后续重试。

## 搜索契约

- `query`：1–8,000 字符；
- `x_search`：最多 20 个允许或排除账号，两类列表互斥；日期必须是真实
  `YYYY-MM-DD`，且 `from_date <= to_date`；支持图像/视频理解开关；
- `web_search`：最多 5 个允许或排除域名，两类列表互斥；支持图像搜索和图像理解；
- 上游超时：60 秒；最大 xAI 响应：2 MiB；
- MCP 请求体：128 KiB；管理表单：16 KiB；
- 不持久化查询、结果或搜索历史；
- 不存在 `max_results`，不能宣称固定搜索帖子数量。

工具的输入 schema 和 `buildToolEntry()` 运行时检查应保持一致。任何一个限制或字段
变化都必须同时添加单元测试与 Worker 边界测试。

## 中文控制面

管理页所有正常用户可见说明均使用简体中文；技术标识、命令、URL、模型名、协议
版本、OAuth scope、client ID 和 secret 名称保持原值。凭据时间固定显示为北京时间，
缺失值显示 `暂无`。

页面必须保持：

- `lang="zh-CN"`；
- 无客户端 JavaScript、无外部样式、字体、图片或其他第三方请求；
- `Cache-Control: no-store`、`Pragma: no-cache`；
- 严格 CSP、`no-referrer`、禁止 iframe、`nosniff`；
- 所有动态值 HTML 转义；
- 原始 `ToolResult.error` 不进入 HTML；
- 内部错误只显示稳定中文信息、代码和 correlation ID。

管理页成功文案在 HTTP 边界本地化，不要为了中文页面改变 Durable Object 或 MCP
数据面的英文错误契约。

## 注释原则

为安全边界、wire format、迁移、加密和并发行为写清楚“为什么”。不要注释普通语法，
不要粘贴 secret，不要写容易过期的无来源版本断言。修改敏感逻辑时，优先补充短小、
靠近约束位置的注释与回归测试。

## 依赖与 Cloudflare 兼容性

Node.js 22 是仓库、GitHub Actions 和 Workers Builds 的统一版本。运行依赖与开发依赖
均精确锁定。升级时必须：

1. 阅读相关官方发布说明；
2. 保持 Wrangler、workerd/Miniflare、vitest pool 和 compatibility date 的组合一致；
3. 运行 `npm install` 更新 lockfile，不能手工只改版本文本；
4. 重新运行类型生成、全部测试、dry-run 和审计；
5. 只在确认确有需要时添加 compatibility flag，尤其不要盲目加入
   `nodejs_compat`。

修改 `wrangler.jsonc` 后必须重新生成并检查 `worker-configuration.d.ts`。保留 source
map 上传。因为受保护 URL token 位于路径中，invocation observability 必须保持关闭。

## 强制验证门禁

每个生产候选必须从锁文件安装并运行：

```bash
npm ci
npm run verify
npm audit --audit-level=low
```

`npm run verify` 依次执行：

```text
npm run types
npm run check
npm run typecheck
npm test
npm run deploy:dry
```

不得用单个聚焦测试替代全量验证。生成类型后检查工作树；若生成文件有确定性差异，
必须审查并提交。宣称完成、提交发布或部署前，都要基于本次运行的新输出，而不是
之前运行结果。

远端验收必须覆盖：健康检查、错误 token fail-closed、中文管理页、仅两个工具及其
`outputSchema`、真实 X Search、真实 Web Search，并确认登录与三个 secret 均未变化。

## GitHub 与部署流程

`main` 是生产分支和唯一恢复来源。常规改动流程：

1. 从 GitHub 干净 clone 或对现有 clone 执行 `git pull --ff-only`；
2. 明确检查 `git status`，保留用户已有改动；
3. 修改、测试、运行完整门禁和 secret 扫描；
4. 只提交本任务文件，推送 `main`；
5. 等待 GitHub Actions 与 Workers Builds 均成功；
6. 执行生产验收并记录新、旧 Worker version ID。

Workers Builds 固定配置：

```text
Production branch: main
Root directory: /
Build command: npm run verify
Deploy command: npm run deploy
```

GitHub Actions 不持有 Cloudflare 凭据，只做独立验证。Workers Builds 使用 Cloudflare
提供的部署身份，普通部署不得上传 secrets 文件。禁止提交 `.secrets.local`、真实
callback、OAuth token、完整受保护 URL、`.wrangler`、`node_modules`、缓存、日志、
coverage 或部署产物。

## 回滚与恢复

线上异常先在 Cloudflare Deployments 将上一正常版本恢复到 100% 流量，再修复
GitHub `main`。不要使用破坏性 Git 命令隐藏问题。普通 Worker 版本回滚不应删除
SQLite 数据或轮换 secret；但 Durable Object 数据迁移一旦执行，必须单独评估旧代码
是否仍能读取新结构。

本地源码不存在时，只从 GitHub 恢复：

```bash
git clone git@github.com:nympheon/grok-MCP.git
cd grok-MCP
npm ci
npm run verify
```

不要创建或维护本地压缩备份作为替代事实来源。README、SECURITY、运行配置、测试和
源码必须在同一个提交中保持一致。
