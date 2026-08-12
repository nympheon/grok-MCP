import {
  APP_VERSION,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPE,
} from "./constants.js";
import type { AuthStatus, LoginData, MessageData, ToolErrorCode, ToolResult } from "./types.js";

export interface AdminPageInput {
  adminBasePath: string;
  mcpUrl: string;
  model: string;
  workerVersion: string;
  status: ToolResult<AuthStatus>;
  login?: ToolResult<LoginData>;
  notice?: ToolResult<MessageData>;
}

function escapeHtml(value: unknown): string {
  // Every runtime value is escaped before interpolation. The page deliberately
  // has no client-side JavaScript or third-party resource to reduce token leaks.
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timestamp(value: number | null): string {
  if (value === null) return "暂无";
  // Format with UTC getters after applying a fixed UTC+8 offset. This keeps the
  // output deterministic across Worker and test runtimes without depending on
  // ICU time-zone data or the executing machine's locale.
  const date = new Date(value + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(date.valueOf())) return "暂无";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}年${part(date.getUTCMonth() + 1)}月${part(
    date.getUTCDate(),
  )}日 ${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(
    date.getUTCSeconds(),
  )}（北京时间）`;
}

// Management-page errors are intentionally derived from stable codes instead
// of raw upstream messages. Raw messages can contain implementation details,
// provider responses, or other data that should not be rendered in a browser.
const adminErrorMessages = {
  NO_AUTH: "尚未登录 Grok。",
  EXPIRED: "Grok 登录已过期，请重新登录。",
  FORBIDDEN_403: "xAI 拒绝了当前请求。",
  RATE_LIMITED: "xAI 请求过于频繁，请稍后重试。",
  UPSTREAM_TIMEOUT: "上游服务响应超时，请稍后重试。",
  UPSTREAM_TOO_LARGE: "上游响应超过安全大小限制。",
  UPSTREAM_ERROR: "上游服务暂时不可用，请稍后重试。",
  HTTP_ERROR: "请求处理失败。",
  STATE_MISMATCH: "登录状态校验失败，请重新开始登录。",
  LOGIN_EXPIRED: "登录请求不存在、已过期或已使用，请重新开始登录。",
  BAD_REQUEST: "提交的回调 URL 无效，请复制完整的 localhost 回调地址。",
  INTERNAL: "Worker 内部错误，请使用下方参考编号排查。",
} satisfies Record<ToolErrorCode, string>;

function errorMarkup(result: { code: ToolErrorCode; correlationId?: string }): string {
  const reference = result.correlationId
    ? `<br>参考编号：<code>${escapeHtml(result.correlationId)}</code>`
    : "";
  return `<p class="error" role="alert">${adminErrorMessages[result.code]}<br>错误代码：<code>${escapeHtml(
    result.code,
  )}</code>${reference}</p>`;
}

function statusMarkup(status: ToolResult<AuthStatus>): string {
  if (!status.ok) {
    return errorMarkup(status);
  }
  const state = status.loggedIn ? (status.expired ? "登录已过期" : "已登录") : "已退出";
  return `<dl>
    <dt>Grok 账号</dt><dd>${state}</dd>
    <dt>凭据到期时间</dt><dd>${escapeHtml(timestamp(status.expiresAt))}</dd>
    <dt>凭据最后更新时间</dt><dd>${escapeHtml(timestamp(status.updatedAt))}</dd>
  </dl>`;
}

function loginMarkup(login: ToolResult<LoginData> | undefined): string {
  if (!login) return "";
  if (!login.ok) return errorMarkup(login);
  return `<section class="callout">
    <h2>Grok 授权已就绪</h2>
    <p><a href="${escapeHtml(login.authorizeUrl)}" target="_blank" rel="noreferrer noopener">打开 Grok 授权页面</a></p>
    <p>请在新页面登录 Grok；浏览器跳转到 localhost 后，返回本页并粘贴完整回调 URL。</p>
    <p>本次授权将在 ${escapeHtml(login.expiresInSec)} 秒后失效。</p>
  </section>`;
}

function noticeMarkup(notice: ToolResult<MessageData> | undefined): string {
  if (!notice) return "";
  return notice.ok ? `<p class="success">${escapeHtml(notice.message)}</p>` : errorMarkup(notice);
}

export function renderAdminPage(input: AdminPageInput): string {
  const basePath = escapeHtml(input.adminBasePath);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GrokMCP 管理与登录</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
    body { max-width: 54rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
    h1, h2 { line-height: 1.2; }
    section { border-top: 1px solid #8886; margin-top: 2rem; padding-top: 1rem; }
    dl { display: grid; grid-template-columns: minmax(10rem, 1fr) 2fr; gap: .5rem 1rem; }
    dt { font-weight: 700; }
    dd { margin: 0; overflow-wrap: anywhere; }
    input[type="url"] { box-sizing: border-box; width: 100%; padding: .65rem; }
    button, a { font: inherit; }
    button { margin-top: .75rem; padding: .55rem .8rem; }
    code { overflow-wrap: anywhere; }
    .callout { border: 1px solid #8886; border-radius: .5rem; padding: 1rem; }
    .success { color: #16823b; font-weight: 700; }
    .error { color: #c62828; font-weight: 700; }
    .warning { border-left: .25rem solid #c78300; padding-left: .75rem; }
  </style>
</head>
<body>
  <h1>GrokMCP 管理与登录</h1>
  <p class="warning">请将本管理 URL 和 MCP URL 都视为密码。此页面不会被缓存，也不加载任何第三方资源。</p>
  ${noticeMarkup(input.notice)}
  ${loginMarkup(input.login)}

  <section>
    <h2>Grok 账号状态</h2>
    ${statusMarkup(input.status)}
    <form method="post" action="${basePath}/login">
      <button type="submit">开始新的 Grok 登录</button>
    </form>
  </section>

  <section>
    <h2>完成浏览器登录</h2>
    <p>Grok 跳转到 localhost 回调地址后，请在十分钟内复制浏览器地址栏中的完整 URL，并粘贴到这里。</p>
    <form method="post" action="${basePath}/callback">
      <label for="callback_url">完整回调 URL</label>
      <input id="callback_url" name="callback_url" type="url" maxlength="8192" required autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:56121/callback?code=...&amp;state=...">
      <button type="submit">完成 Grok 登录</button>
    </form>
  </section>

  <section>
    <h2>连接与运行状态</h2>
    <dl>
      <dt>MCP URL</dt><dd><code>${escapeHtml(input.mcpUrl)}</code></dd>
      <dt>当前模型</dt><dd><code>${escapeHtml(input.model)}</code></dd>
      <dt>应用版本</dt><dd><code>${APP_VERSION}</code></dd>
      <dt>Worker 版本</dt><dd><code>${escapeHtml(input.workerVersion)}</code></dd>
      <dt>MCP 协议</dt><dd>仅支持 <code>MCP 2026-07-28</code>（JSON 响应，不兼容旧会话）</dd>
      <dt>MCP 工具</dt><dd><code>x_search</code>、<code>web_search</code></dd>
    </dl>
    <p>搜索限制与当前 xAI API 一致：每个过滤器最多 20 个 X 账号或最多 5 个 Web 域名；同一类“允许”和“排除”过滤器不能同时使用。</p>
  </section>

  <section>
    <h2>OAuth 兼容信息</h2>
    <dl>
      <dt>公共 client ID</dt><dd><code>${XAI_OAUTH_CLIENT_ID}</code></dd>
      <dt>授权范围</dt><dd><code>${escapeHtml(XAI_OAUTH_SCOPE)}</code></dd>
      <dt>本机回调地址</dt><dd><code>${escapeHtml(XAI_OAUTH_REDIRECT_URI)}</code></dd>
    </dl>
    <p class="warning">这是非官方的单用户集成。xAI 将来调整 OAuth 或 API 后，可能需要升级 Worker 源码并重新登录。</p>
  </section>

  <section>
    <h2>Cloudflare 运维</h2>
    <p>如需切换兼容模型，请在 Worker 变量中修改 <code>GROK_X_SEARCH_MODEL</code>；当前默认值为 <code>grok-4.5</code>。</p>
    <dl>
      <dt><code>MCP_URL_TOKEN</code></dt><dd>用于生成 ChatGPT MCP URL；轮换后 URL 会改变。</dd>
      <dt><code>ADMIN_URL_TOKEN</code></dt><dd>用于生成本管理 URL；轮换后 URL 会改变。</dd>
      <dt><code>TOKEN_ENCRYPTION_KEY</code></dt><dd>用于加密 OAuth 数据，绝不能泄露。</dd>
    </dl>
    <p>本项目以 GitHub 仓库 <code>git@github.com:nympheon/grok-MCP.git</code> 为唯一源码。向 <code>main</code> 分支提交后，Cloudflare Workers Builds 会先执行完整验证，再自动部署；普通代码升级不会改变现有密钥。</p>
    <p class="warning">替换 <code>TOKEN_ENCRYPTION_KEY</code> 后，当前加密登录将无法解密，必须在本页重新登录 Grok。</p>
    <p>后续升级请从 GitHub 克隆源码。只要保留 <code>GrokState</code> 类名和 Durable Object 迁移历史，SQLite 数据会继续保留。</p>
  </section>

  <section>
    <h2>退出 Grok 登录</h2>
    <form method="post" action="${basePath}/logout">
      <label><input type="checkbox" name="confirm" value="yes" required> 删除已保存的 Grok 凭据和待处理登录请求</label><br>
      <button type="submit">退出 Grok 登录</button>
    </form>
  </section>
</body>
</html>`;
}

function adminHeaders(): Headers {
  // URL tokens are bearer credentials. The response must never be cached,
  // framed, referred, or allowed to load attacker-controlled content.
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

export function adminHtmlResponse(input: AdminPageInput, status = 200): Response {
  return new Response(renderAdminPage(input), { status, headers: adminHeaders() });
}

export function adminTextResponse(message: string, status: number, allow?: string): Response {
  const headers = adminHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  if (allow) headers.set("Allow", allow);
  return new Response(message, { status, headers });
}
