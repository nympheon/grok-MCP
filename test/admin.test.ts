import { describe, expect, it } from "vitest";
import { adminHtmlResponse, renderAdminPage } from "../src/admin.js";

const adminToken = "a".repeat(43);
const mcpToken = "b".repeat(43);
const adminBasePath = `/admin/t/${adminToken}`;
const mcpUrl = `https://grokmcp.example.workers.dev/t/${mcpToken}/mcp`;

function baseInput() {
  return {
    adminBasePath,
    mcpUrl,
    model: "grok-4.5",
    workerVersion: 'version-1<&"',
    status: {
      ok: true as const,
      loggedIn: true,
      expired: false,
      expiresAt: Date.UTC(2026, 7, 13),
      updatedAt: Date.UTC(2026, 7, 12),
    },
  };
}

describe("renderAdminPage", () => {
  it("renders recoverable operational information and escapes every dynamic value", () => {
    const html = renderAdminPage(baseInput());

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("GrokMCP 管理与登录");
    expect(html).toContain("已登录");
    expect(html).toContain(mcpUrl);
    expect(html).toContain("grok-4.5");
    expect(html).toContain("MCP 2026-07-28");
    expect(html).toContain("最多 20 个 X 账号");
    expect(html).toContain("最多 5 个 Web 域名");
    expect(html).toContain("GitHub");
    expect(html).toContain("2026年08月13日 08:00:00（北京时间）");
    expect(html).toContain("开始新的 Grok 登录");
    expect(html).toContain("完成浏览器登录");
    expect(html).toContain("连接与运行状态");
    expect(html).toContain("Cloudflare 运维");
    expect(html).toContain("退出 Grok 登录");
    expect(html).toContain("version-1&lt;&amp;&quot;");
    expect(html).not.toContain('version-1<&"');
    expect(html).not.toContain("GrokMCP administration");
    expect(html).not.toContain("Start a new Grok login");
    expect(html).not.toContain("Signed in");
    expect(html).toContain(`action="${adminBasePath}/login"`);
    expect(html).toContain(`action="${adminBasePath}/callback"`);
    expect(html).toContain(`action="${adminBasePath}/logout"`);
  });

  it("renders a safe Grok authorization link and a localized public error", () => {
    const html = renderAdminPage({
      ...baseInput(),
      login: {
        ok: true,
        authorizeUrl: "https://auth.x.ai/oauth2/authorize?state=a&code_challenge=b",
        expiresInSec: 600,
        message: "Open the link",
      },
      notice: {
        ok: false,
        code: "BAD_REQUEST",
        error: "Invalid <script>alert(1)</script> callback",
      },
    });

    expect(html).toContain("https://auth.x.ai/oauth2/authorize?state=a&amp;code_challenge=b");
    expect(html).toContain("打开 Grok 授权页面");
    expect(html).toContain("提交的回调 URL 无效");
    expect(html).toContain("BAD_REQUEST");
    expect(html).not.toContain("Invalid &lt;script&gt;alert(1)&lt;/script&gt; callback");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it.each([
    [false, false, "已退出"],
    [true, false, "已登录"],
    [true, true, "登录已过期"],
  ])("renders the localized account state", (loggedIn, expired, expected) => {
    const html = renderAdminPage({
      ...baseInput(),
      status: {
        ok: true,
        loggedIn,
        expired,
        expiresAt: null,
        updatedAt: null,
      },
    });

    expect(html).toContain(expected);
    expect(html).toContain("暂无");
  });

  it("renders a stable internal-error reference without exposing the raw error", () => {
    const html = renderAdminPage({
      ...baseInput(),
      notice: {
        ok: false,
        code: "INTERNAL",
        error: "Sensitive upstream detail <script>alert(1)</script>",
        correlationId: "reference-123",
      },
    });

    expect(html).toContain("Worker 内部错误");
    expect(html).toContain("INTERNAL");
    expect(html).toContain("reference-123");
    expect(html).not.toContain("Sensitive upstream detail");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("contains public compatibility and secret names but no OAuth credential fields", () => {
    const html = renderAdminPage(baseInput());

    expect(html).toContain("b1a00492-073a-47ea-816f-4c329264a828");
    expect(html).toContain("http://127.0.0.1:56121/callback");
    expect(html).toContain("grok-cli:access");
    expect(html).toContain("MCP_URL_TOKEN");
    expect(html).toContain("ADMIN_URL_TOKEN");
    expect(html).toContain("TOKEN_ENCRYPTION_KEY");
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("refresh_token");
  });
});

describe("adminHtmlResponse", () => {
  it("returns non-cacheable HTML with a restrictive browser policy", async () => {
    const response = adminHtmlResponse(baseInput());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(await response.text()).toContain("GrokMCP 管理与登录");
  });
});
