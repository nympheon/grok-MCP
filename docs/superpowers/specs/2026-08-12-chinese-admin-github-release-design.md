# GrokMCP 中文管理页与 GitHub 发布设计

日期：2026-08-12

状态：已确认方案 A；等待书面规格复核

## 1. 目标

在不改变 MCP、OAuth、SQLite Durable Object、URL token 鉴权和现有 Grok
登录状态的前提下，将 Worker 管理与登录页面完整改为简体中文，并把当前完整、
无密钥、可独立维护的项目发布到公开仓库
`https://github.com/nympheon/grok-MCP`。发布后，该 GitHub 仓库成为唯一源码来源，
本地临时源码、压缩归档、校验文件和交接文档全部删除。

## 2. 中文化边界

管理页面采用方案 A：

- `<html lang="zh-CN">`，页面标题、区块标题、状态、按钮、表单标签、提示、
  警告、维护说明及管理路由的纯文本错误响应全部使用简体中文；
- 保留 `Grok`、`MCP`、`OAuth`、`Worker`、URL、模型名、协议版本、client ID、
  scope、Secret 名称和命令等技术标识，不翻译或改写；
- 登录状态使用“已登录”“已退出”“登录已过期”，无时间值显示“暂无”；
- 凭据到期和最后更新时间按 `Asia/Shanghai` 时区显示，并明确标注“北京时间”；
- 已知 `ToolErrorCode` 在管理页映射为中文错误说明；内部错误保留 correlation ID，
  但页面不输出 OAuth token、加密密钥、授权 code、PKCE 或数据库原始记录；
- Grok 授权页链接、localhost 回调粘贴流程、MCP URL 恢复能力和登出确认步骤保持
  原有行为；
- 页面继续不加载 JavaScript、第三方字体、样式、图片或分析代码。

中文化只作用于 Worker 控制面。MCP 工具名、输入输出 schema、JSON 字段名和搜索
错误契约保持不变，避免界面翻译影响 ChatGPT 调用。

## 3. 实现边界

`src/admin.ts` 负责所有中文文案、北京时间格式化、管理页错误码映射和 HTML 转义。
`src/worker.ts` 只将管理路由上的 HTTP 错误文本及 Worker 版本兜底值改为中文。
Durable Object 的持久化 schema、AES-GCM 格式、OAuth 方法和搜索逻辑不修改。

现有响应安全头保持不变：`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、
限制性 CSP、禁止 framing、禁止 MIME sniffing。URL token 仍在路由匹配和常量时间
比较通过后才允许读取请求体或 Durable Object 状态。

## 4. 测试设计

实施采用测试先行：

1. 先修改 `test/admin.test.ts`，要求 `lang="zh-CN"`、中文状态、北京时间、中文按钮、
   中文安全警告和中文维护指引，并断言旧的主要英文 UI 文案不存在；
2. 修改 `test-worker/worker.test.ts`，从真实 Worker 管理路由验证中文未登录状态、
   中文授权入口、中文回调错误、中文登出结果和中文 HTTP 错误；
3. 先运行目标测试并确认因旧英文页面而失败，再实施最小中文化；
4. 完成后运行 Biome、TypeScript、全部 Node/Worker/单元测试、依赖审计和 Wrangler
   dry-run；
5. 部署时不提供本地 secrets 文件，以保留 Cloudflare 中现有的
   `MCP_URL_TOKEN`、`ADMIN_URL_TOKEN`、`TOKEN_ENCRYPTION_KEY` 和 Grok 登录；
6. 线上验证中文标记、登录状态、模型、MCP URL、两项工具 schema 以及至少一次真实
   搜索。

## 5. 项目文档

根据用户后续要求，GitHub 根目录只维护一份中文 `README.md`；删除原有
`README.zh.md` 和 `README.ja.md`，不再维护重复翻译。文档必须覆盖：

- 架构、免费资源边界和数据流；
- ChatGPT URL-token 连接方式；
- Worker 中文管理页的登录、回调、状态、退出和 MCP URL 恢复流程；
- SQLite Durable Object 与 AES-256-GCM 安全边界；
- 当前 MCP 2026-07-28 和 xAI search 契约；
- 所有环境变量、Secret、模型修改、首次部署、日常升级、主动轮换、回滚和故障排查；
- GitHub Actions、Workers Builds 和本地验证命令；
- 非官方单用户集成及上游 OAuth/API 变更风险；
- 明确禁止提交 `.secrets.local`、回调 URL、OAuth token 和任何真实 URL token。

## 6. GitHub 发布与 Cloudflare 关联

远端 `nympheon/grok-MCP` 当前为空、公开，当前账号具有 ADMIN 权限。发布采用：

- 默认分支 `main`；
- 首个基线提交保存此前已部署且通过验收的无密钥源代码；
- 后续提交分别保存本设计、中文化实现和完整文档；
- 推送前扫描 Git 历史和工作树，确认不存在当前 MCP/admin token、OAuth 凭据、
  `.secrets.local`、Wrangler 状态、依赖目录或缓存；
- 推送后从 GitHub 重新读取分支、提交和文件树，并在新的临时目录 `git clone` 后
  执行完整验证，证明 GitHub 可以作为唯一恢复源。

将现有 Cloudflare Worker `grokmcp` 通过 Workers Builds 连接到该 GitHub 仓库：

- production branch：`main`；
- root directory：仓库根目录；
- build command：`npm run verify`；
- deploy command：`npm run deploy`；
- Worker 名必须继续为 `grokmcp`；
- runtime Secrets 继续只保存在 Cloudflare，不配置成 GitHub 文件或普通变量；
- 自动构建失败时不得替换当前生产部署或轮换 Secret。

关联完成后，每次推送到 `main` 都先验证、再自动更新现有 Worker。首次关联发生在首批
源码已经推送之后，因此使用一个有明确说明的空提交触发第一次 Workers Builds，验证
此后不需要本地部署且三个运行时 Secret 保持原值。

如果 GitHub App/Cloudflare Dashboard 首次授权必须由用户交互确认，停在授权界面并明确
说明所需操作；除此之外自动完成关联和验证。

## 7. 发布与清理顺序

顺序不可颠倒：

1. 本地测试和 dry-run 全部通过；
2. 完整项目推送到 GitHub `main`；
3. Cloudflare Workers Builds 关联到 `main`；
4. 推送一次说明性的空提交，由自动构建执行无 secrets 文件的 `npm run deploy`；
5. 线上中文页、现有登录、真实搜索和 Secret 保留验收通过；
6. 从 GitHub 全新 clone 后再次通过完整验证；
7. 删除临时 clone；
8. 永久删除工作目录 `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/work/grok-MCP`；
9. 删除 `outputs` 中旧的源码归档、SHA-256 文件和本地交接文档；
10. 最后确认 GitHub 仓库、Cloudflare Worker、Durable Object 和公开 `/healthz` 仍正常。

本地删除不触碰 Cloudflare Worker、Durable Object、运行时 Secret、GitHub 仓库或其
提交历史。

## 8. 验收标准

1. 管理页所有正常可见操作信息使用简体中文，技术标识保持原值；
2. 北京时间、三种登录状态、登录/回调/退出和错误状态均有自动测试；
3. MCP 路由、工具清单、schema、URL token 和 Grok 登录状态没有回归；
4. GitHub 公开仓库包含完整源码、测试、配置和运维文档，但不包含任何秘密；
5. `main` 可通过 Workers Builds 自动验证并部署到同名 Worker；
6. 从 GitHub 全新 clone 可以安装、检查、测试和 dry-deploy；
7. 完成后本地不保留项目源码、压缩源码归档或交接文档。
