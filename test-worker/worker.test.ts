import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrokState } from "../src/grokState.js";

const configuredToken = "a".repeat(43);
const adminToken = "b".repeat(43);
const baseUrl = `https://grokmcp.example.workers.dev/t/${configuredToken}/mcp`;
const adminBaseUrl = `https://grokmcp.example.workers.dev/admin/t/${adminToken}`;

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string; outputSchema?: Record<string, unknown> }>;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const requestParams = {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "grokmcp-test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Host: "grokmcp.example.workers.dev",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  });
  if (method === "tools/call" && typeof params.name === "string") {
    headers.set("Mcp-Name", params.name);
  }
  const response = await exports.default.fetch(
    new Request(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: requestParams,
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as JsonRpcResponse;
}

function adminRequest(
  action = "",
  init: { method?: string; body?: string; contentType?: string; origin?: string } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = new Headers({ Host: "grokmcp.example.workers.dev" });
  if (method === "POST") {
    headers.set("Content-Type", init.contentType ?? "application/x-www-form-urlencoded");
    headers.set("Origin", init.origin ?? "https://grokmcp.example.workers.dev");
  }
  return exports.default.fetch(
    new Request(`${adminBaseUrl}${action}`, {
      method,
      headers,
      body: method === "POST" ? (init.body ?? "") : undefined,
    }),
  );
}

function toolText(response: JsonRpcResponse): Record<string, unknown> {
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

function optionalToolText(response: JsonRpcResponse): Record<string, unknown> | undefined {
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stateStub(): DurableObjectStub<GrokState> {
  return env.GROK_STATE.get(env.GROK_STATE.idFromName("single-user"));
}

async function installLoggedInSearchMock(): Promise<{
  responseRequests: () => Array<Record<string, unknown>>;
}> {
  const responseRequests: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://auth.x.ai/.well-known/openid-configuration") {
      return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
    }
    if (url === "https://auth.x.ai/oauth2/token") {
      return Response.json({
        access_token: "ACCESS_TOKEN",
        refresh_token: "REFRESH_TOKEN",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (url === "https://api.x.ai/v1/responses") {
      const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> & {
        input?: Array<{ content?: string }>;
      };
      responseRequests.push(request);
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: `answer:${request.input?.[0]?.content ?? ""}`,
                annotations: [],
              },
            ],
          },
        ],
        citations: ["https://example.com/source"],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const stub = stateStub();
  const started = await stub.startLogin();
  if (!started.ok) throw new Error(started.error);
  const stateValue = new URL(started.authorizeUrl).searchParams.get("state");
  if (!stateValue) throw new Error("Missing OAuth state");
  const completed = await stub.completeLogin(
    `http://127.0.0.1:56121/callback?code=AUTH_CODE&state=${stateValue}`,
  );
  if (!completed.ok) throw new Error(completed.error);
  return { responseRequests: () => responseRequests };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Worker HTTP boundary", () => {
  it("exposes a minimal public health endpoint", async () => {
    const response = await exports.default.fetch("https://example.com/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "grokmcp" });
  });

  it("returns 404 before MCP parsing when the path token is absent or wrong", async () => {
    const absent = await exports.default.fetch("https://example.com/mcp");
    const wrong = await exports.default.fetch(`https://example.com/t/${"b".repeat(43)}/mcp`);
    expect(absent.status).toBe(404);
    expect(wrong.status).toBe(404);
  });

  it("rejects mismatched Host and Origin headers after URL authentication", async () => {
    const wrongHost = await exports.default.fetch(
      new Request(baseUrl, { headers: { Host: "attacker.example" } }),
    );
    const wrongOrigin = await exports.default.fetch(
      new Request(baseUrl, {
        headers: {
          Host: "grokmcp.example.workers.dev",
          Origin: "https://attacker.example",
        },
      }),
    );

    expect(wrongHost.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
  });

  it("shows account status and the recoverable MCP URL only on the admin route", async () => {
    const response = await adminRequest();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Signed out");
    expect(html).toContain(baseUrl);

    const wrong = await exports.default.fetch(
      `https://grokmcp.example.workers.dev/admin/t/${configuredToken}`,
    );
    const crossed = await exports.default.fetch(
      `https://grokmcp.example.workers.dev/t/${adminToken}/mcp`,
    );
    expect(wrong.status).toBe(404);
    expect(crossed.status).toBe(404);
  });

  it("starts login and routes callback and confirmed logout through same-origin forms", async () => {
    const started = await adminRequest("/login", { method: "POST" });
    const startHtml = await started.text();
    expect(started.status).toBe(200);
    expect(startHtml).toContain("Open Grok authorization");
    expect(startHtml).toContain("auth.x.ai/oauth2/authorize");
    expect(startHtml).not.toContain("grok_auth_callback");

    const callback = await adminRequest("/callback", {
      method: "POST",
      body: new URLSearchParams({
        callback_url: "https://attacker.example/callback?code=CODE&state=STATE",
      }).toString(),
    });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("unexpected origin or path");

    const loggedOut = await adminRequest("/logout", {
      method: "POST",
      body: "confirm=yes",
    });
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.text()).toContain(
      "Grok credentials and pending login attempts were removed.",
    );
  });

  it("rejects unsafe administration methods, origins, content types, and forms", async () => {
    const wrongMethod = await adminRequest("/login");
    const wrongOrigin = await adminRequest("/login", {
      method: "POST",
      origin: "https://attacker.example",
    });
    const wrongType = await adminRequest("/callback", {
      method: "POST",
      contentType: "application/json",
      body: "{}",
    });
    const duplicate = await adminRequest("/callback", {
      method: "POST",
      body: "callback_url=one&callback_url=two",
    });

    expect(wrongMethod.status).toBe(405);
    expect(wrongOrigin.status).toBe(403);
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("cache-control")).toBe("no-store");
    expect(wrongType.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(duplicate.status).toBe(400);
  });

  it("rejects oversized administration and MCP bodies before parsing", async () => {
    const oversizedAdmin = await adminRequest("/callback", {
      method: "POST",
      body: `callback_url=${"x".repeat(16 * 1024)}`,
    });
    const oversizedMcp = await exports.default.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "grokmcp.example.workers.dev",
        },
        body: "x".repeat(128 * 1024 + 1),
      }),
    );

    expect(oversizedAdmin.status).toBe(413);
    expect(oversizedMcp.status).toBe(413);
  });

  it("rejects legacy MCP requests that omit the 2026-07-28 per-request envelope", async () => {
    const response = await exports.default.fetch(
      new Request(baseUrl, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: "grokmcp.example.workers.dev",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "legacy", method: "tools/list", params: {} }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("2026-07-28");
  });

  it("lists exactly two search tools with explicit success output schemas", async () => {
    const response = await rpc("tools/list", {});
    expect(response.result?.tools?.map((tool) => tool.name)).toEqual(["x_search", "web_search"]);
    for (const tool of response.result?.tools ?? []) {
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        properties: {
          ok: { const: true, type: "boolean" },
          text: { type: "string" },
          citations: { type: "array", items: { type: "string" } },
          model: { type: "string" },
        },
        required: ["ok", "text", "citations", "model"],
      });
    }
  });

  it("does not expose account operations as MCP tools", async () => {
    const response = await rpc("tools/call", {
      name: "grok_status",
      arguments: {},
    });
    expect(response.result?.isError ?? response.error).toBeTruthy();
  });

  it("returns matching structured and serialized results for a successful search", async () => {
    await installLoggedInSearchMock();
    const response = await rpc("tools/call", {
      name: "x_search",
      arguments: { query: "structured result" },
    });
    const expected = {
      ok: true,
      text: "answer:structured result",
      citations: ["https://example.com/source"],
      model: "grok-4.5",
    };

    expect(response.result?.isError).toBe(false);
    expect(response.result?.structuredContent).toEqual(expected);
    expect(toolText(response)).toEqual(expected);
  });

  it("directs a signed-out search caller to the Worker administration page", async () => {
    const response = await rpc("tools/call", {
      name: "web_search",
      arguments: { query: "requires login" },
    });
    const error = toolText(response);

    expect(response.result?.isError).toBe(true);
    expect(error.error).toContain("Worker administration page");
    expect(error.error).not.toContain("grok_login");
  });

  it("accepts 20 X handles but rejects conflicting filters and invalid dates", async () => {
    const twentyHandles = Array.from({ length: 20 }, (_, index) => `user${index + 1}`);
    const accepted = await rpc("tools/call", {
      name: "x_search",
      arguments: { query: "twenty handles", allowed_x_handles: twentyHandles },
    });
    const conflicting = await rpc("tools/call", {
      name: "x_search",
      arguments: {
        query: "conflicting",
        allowed_x_handles: ["wanted"],
        excluded_x_handles: ["blocked"],
      },
    });
    const impossibleDate = await rpc("tools/call", {
      name: "x_search",
      arguments: { query: "date", from_date: "2026-02-30" },
    });
    const reversedRange = await rpc("tools/call", {
      name: "x_search",
      arguments: { query: "range", from_date: "2026-08-13", to_date: "2026-08-12" },
    });

    expect(optionalToolText(accepted)).toMatchObject({ code: "NO_AUTH" });
    expect(optionalToolText(conflicting)?.code).not.toBe("NO_AUTH");
    expect(optionalToolText(impossibleDate)?.code).not.toBe("NO_AUTH");
    expect(optionalToolText(reversedRange)?.code).not.toBe("NO_AUTH");
  });

  it("forwards current media options from MCP inputs to both xAI search tools", async () => {
    const network = await installLoggedInSearchMock();
    await rpc("tools/call", {
      name: "x_search",
      arguments: {
        query: "x media",
        enable_image_understanding: true,
        enable_video_understanding: true,
      },
    });
    await rpc("tools/call", {
      name: "web_search",
      arguments: {
        query: "web media",
        enable_image_search: true,
        enable_image_understanding: true,
      },
    });

    expect(network.responseRequests().map((request) => request.tools)).toEqual([
      [
        {
          type: "x_search",
          enable_image_understanding: true,
          enable_video_understanding: true,
        },
      ],
      [
        {
          type: "web_search",
          enable_image_search: true,
          enable_image_understanding: true,
        },
      ],
    ]);
  });

  it("rejects an invalid search schema without an upstream fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await rpc("tools/call", {
      name: "x_search",
      arguments: { query: "x".repeat(8_001) },
    });
    expect(response.result?.isError ?? response.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
