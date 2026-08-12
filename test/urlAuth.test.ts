import { describe, expect, it } from "vitest";
import {
  extractAdminRoute,
  extractPresentedToken,
  isAuthorizedAdminPath,
  isAuthorizedMcpPath,
} from "../src/urlAuth.js";

const mcpToken = "a".repeat(43);
const adminToken = "b".repeat(43);

describe("URL token authentication", () => {
  it("extracts only the exact protected MCP path", () => {
    expect(extractPresentedToken(`/t/${mcpToken}/mcp`)).toBe(mcpToken);
    expect(extractPresentedToken(`/t/${mcpToken}/mcp/`)).toBeNull();
    expect(extractPresentedToken("/mcp")).toBeNull();
    expect(extractPresentedToken("/t/a/b/mcp")).toBeNull();
    expect(extractPresentedToken(`/t/${mcpToken}a/mcp`)).toBeNull();
  });

  it("rejects malformed percent encoding", () => {
    expect(extractPresentedToken("/t/%E0%A4%A/mcp")).toBeNull();
  });

  it("accepts the configured token and rejects another token", async () => {
    expect(await isAuthorizedMcpPath(`/t/${mcpToken}/mcp`, mcpToken)).toBe(true);
    expect(await isAuthorizedMcpPath(`/t/${adminToken}/mcp`, mcpToken)).toBe(false);
  });

  it("rejects a configured token with less than 256 bits of entropy", async () => {
    expect(await isAuthorizedMcpPath("/t/short/mcp", "short")).toBe(false);
  });

  it("extracts only supported administration actions", () => {
    expect(extractAdminRoute(`/admin/t/${adminToken}`)).toEqual({
      token: adminToken,
      action: "view",
    });
    expect(extractAdminRoute(`/admin/t/${adminToken}/login`)).toEqual({
      token: adminToken,
      action: "login",
    });
    expect(extractAdminRoute(`/admin/t/${adminToken}/callback`)).toEqual({
      token: adminToken,
      action: "callback",
    });
    expect(extractAdminRoute(`/admin/t/${adminToken}/logout`)).toEqual({
      token: adminToken,
      action: "logout",
    });
    expect(extractAdminRoute(`/admin/t/${adminToken}/unknown`)).toBeNull();
    expect(extractAdminRoute(`/admin/t/${adminToken}/`)).toBeNull();
    expect(extractAdminRoute(`/admin/t/${adminToken}a`)).toBeNull();
  });

  it("keeps MCP and administration routes non-interchangeable", async () => {
    expect(await isAuthorizedAdminPath(`/admin/t/${adminToken}`, adminToken)).toBe(true);
    expect(await isAuthorizedAdminPath(`/admin/t/${mcpToken}`, adminToken)).toBe(false);
    expect(await isAuthorizedAdminPath(`/t/${adminToken}/mcp`, adminToken)).toBe(false);
    expect(await isAuthorizedMcpPath(`/admin/t/${mcpToken}`, mcpToken)).toBe(false);
  });
});
