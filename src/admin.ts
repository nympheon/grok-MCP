import {
  APP_VERSION,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPE,
} from "./constants.js";
import type { AuthStatus, LoginData, MessageData, ToolResult } from "./types.js";

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
  if (value === null) return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "Not available";
}

function statusMarkup(status: ToolResult<AuthStatus>): string {
  if (!status.ok) {
    return `<p class="error">Status unavailable: ${escapeHtml(status.error)}</p>`;
  }
  const state = status.loggedIn ? (status.expired ? "Expired" : "Signed in") : "Signed out";
  return `<dl>
    <dt>Grok account</dt><dd>${state}</dd>
    <dt>Credential expiry</dt><dd>${escapeHtml(timestamp(status.expiresAt))}</dd>
    <dt>Last credential update</dt><dd>${escapeHtml(timestamp(status.updatedAt))}</dd>
  </dl>`;
}

function loginMarkup(login: ToolResult<LoginData> | undefined): string {
  if (!login) return "";
  if (!login.ok) return `<p class="error">${escapeHtml(login.error)}</p>`;
  return `<section class="callout">
    <h2>Authorization ready</h2>
    <p><a href="${escapeHtml(login.authorizeUrl)}" target="_blank" rel="noreferrer noopener">Open Grok authorization</a></p>
    <p>${escapeHtml(login.message)}</p>
    <p>This authorization attempt expires in ${escapeHtml(login.expiresInSec)} seconds.</p>
  </section>`;
}

function noticeMarkup(notice: ToolResult<MessageData> | undefined): string {
  if (!notice) return "";
  return notice.ok
    ? `<p class="success">${escapeHtml(notice.message)}</p>`
    : `<p class="error">${escapeHtml(notice.error)}</p>`;
}

export function renderAdminPage(input: AdminPageInput): string {
  const basePath = escapeHtml(input.adminBasePath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GrokMCP administration</title>
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
  <h1>GrokMCP administration</h1>
  <p class="warning">Treat this administration URL and the MCP URL as passwords. This page is never cached and uses no third-party assets.</p>
  ${noticeMarkup(input.notice)}
  ${loginMarkup(input.login)}

  <section>
    <h2>Account status</h2>
    ${statusMarkup(input.status)}
    <form method="post" action="${basePath}/login">
      <button type="submit">Start a new Grok login</button>
    </form>
  </section>

  <section>
    <h2>Finish browser login</h2>
    <p>After Grok redirects to the localhost callback, copy the complete address-bar URL and paste it here within ten minutes.</p>
    <form method="post" action="${basePath}/callback">
      <label for="callback_url">Complete callback URL</label>
      <input id="callback_url" name="callback_url" type="url" maxlength="8192" required autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:56121/callback?code=...&amp;state=...">
      <button type="submit">Complete login</button>
    </form>
  </section>

  <section>
    <h2>Connection and runtime</h2>
    <dl>
      <dt>MCP URL</dt><dd><code>${escapeHtml(input.mcpUrl)}</code></dd>
      <dt>Configured model</dt><dd><code>${escapeHtml(input.model)}</code></dd>
      <dt>Application version</dt><dd><code>${APP_VERSION}</code></dd>
      <dt>Worker version</dt><dd><code>${escapeHtml(input.workerVersion)}</code></dd>
      <dt>MCP protocol</dt><dd><code>MCP 2026-07-28</code> only (JSON responses; no legacy sessions)</dd>
      <dt>MCP tools</dt><dd><code>x_search</code>, <code>web_search</code></dd>
    </dl>
    <p>Search limits match the current xAI API: at most 20 X handles or 5 web domains per filter. Allow and exclude filters cannot be combined.</p>
  </section>

  <section>
    <h2>OAuth compatibility</h2>
    <dl>
      <dt>Public client ID</dt><dd><code>${XAI_OAUTH_CLIENT_ID}</code></dd>
      <dt>Scope</dt><dd><code>${escapeHtml(XAI_OAUTH_SCOPE)}</code></dd>
      <dt>Loopback redirect</dt><dd><code>${escapeHtml(XAI_OAUTH_REDIRECT_URI)}</code></dd>
    </dl>
    <p>This is an unofficial single-user integration. A future upstream OAuth or API change may require a Worker source upgrade.</p>
  </section>

  <section>
    <h2>Cloudflare operations</h2>
    <p>Change <code>GROK_X_SEARCH_MODEL</code> in Worker variables to select another compatible model.</p>
    <dl>
      <dt><code>MCP_URL_TOKEN</code></dt><dd>Rotates the ChatGPT MCP URL.</dd>
      <dt><code>ADMIN_URL_TOKEN</code></dt><dd>Rotates this administration URL.</dd>
      <dt><code>TOKEN_ENCRYPTION_KEY</code></dt><dd>Encrypts OAuth rows and must not be exposed.</dd>
    </dl>
    <p>For a routine source upgrade, deploy without a secrets file: Cloudflare validates and preserves the existing secret values. Supply or replace a secret only for a first deployment or an intentional rotation.</p>
    <p class="warning">Replacing <code>TOKEN_ENCRYPTION_KEY</code> makes the current encrypted login unreadable. After such a replacement, start a new Grok login here.</p>
    <p>Code upgrades require the secret-free source archive: restore it, run the full test and dry-deploy gates, then deploy with Wrangler. Durable Object data remains attached to <code>GrokState</code> while the class and migration history are preserved.</p>
  </section>

  <section>
    <h2>Sign out</h2>
    <form method="post" action="${basePath}/logout">
      <label><input type="checkbox" name="confirm" value="yes" required> Delete stored Grok credentials and pending login attempts</label><br>
      <button type="submit">Sign out</button>
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
