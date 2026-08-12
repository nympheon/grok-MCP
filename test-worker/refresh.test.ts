import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importEncryptionKey, openJson } from "../src/cryptoVault.js";
import type { GrokState } from "../src/grokState.js";
import type { TokenSet } from "../src/types.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const discoveryUrl = "https://auth.x.ai/.well-known/openid-configuration";
const tokenUrl = "https://auth.x.ai/oauth2/token";
const responsesUrl = "https://api.x.ai/v1/responses";

interface NetworkOptions {
  initialExpiresIn?: number;
  initialRefreshToken?: string;
  discoveryResponse?: () => Response | Promise<Response>;
  refreshResponse?: () => Response | Promise<Response>;
  searchResponse?: (query: string) => Response | Promise<Response>;
}

function stateStub(): DurableObjectStub<GrokState> {
  const namespace = env.GROK_STATE as DurableObjectNamespace<GrokState>;
  return namespace.get(namespace.idFromName("single-user"));
}

function assertOk<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    const message = "error" in result && typeof result.error === "string" ? result.error : "Failed";
    throw new Error(message);
  }
}

function installNetwork(options: NetworkOptions = {}) {
  const counts = { discovery: 0, authorization: 0, refresh: 0, search: 0 };
  let authorizationCompleted = false;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === discoveryUrl) {
      counts.discovery += 1;
      return (
        (authorizationCompleted ? await options.discoveryResponse?.() : undefined) ??
        Response.json({ token_endpoint: tokenUrl })
      );
    }
    if (url === tokenUrl) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") === "authorization_code") {
        counts.authorization += 1;
        authorizationCompleted = true;
        return Response.json({
          access_token: "INITIAL_ACCESS_TOKEN",
          refresh_token: options.initialRefreshToken ?? "INITIAL_REFRESH_TOKEN",
          expires_in: options.initialExpiresIn ?? 3600,
          token_type: "Bearer",
        });
      }
      if (body.get("grant_type") === "refresh_token") {
        counts.refresh += 1;
        return (
          (await options.refreshResponse?.()) ??
          Response.json({
            access_token: "REFRESHED_ACCESS_TOKEN",
            refresh_token: "ROTATED_REFRESH_TOKEN",
            expires_in: 3600,
            token_type: "Bearer",
          })
        );
      }
    }
    if (url === responsesUrl) {
      counts.search += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: Array<{ content?: string }>;
      };
      const query = body.input?.[0]?.content ?? "";
      return (
        (await options.searchResponse?.(query)) ??
        Response.json({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: `result:${query}`, annotations: [] }],
            },
          ],
          citations: [],
        })
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    counts,
    mock,
    resetCounts() {
      counts.discovery = 0;
      counts.authorization = 0;
      counts.refresh = 0;
      counts.search = 0;
    },
  };
}

async function login(stub: DurableObjectStub<GrokState>): Promise<void> {
  const started = await stub.startLogin();
  assertOk(started);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("Missing OAuth state");
  const completed = await stub.completeLogin(
    `http://127.0.0.1:56121/callback?code=AUTH_CODE&state=${state}`,
  );
  assertOk(completed);
}

async function storedTokens(stub: DurableObjectStub<GrokState>): Promise<TokenSet | null> {
  const stored = await runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ encrypted_payload: ArrayBuffer; iv: ArrayBuffer }>(
        "SELECT encrypted_payload, iv FROM oauth_tokens WHERE slot = 'primary'",
      )
      .toArray();
    const row = rows[0];
    return row ? { encryptedPayload: row.encrypted_payload, iv: row.iv } : null;
  });
  if (!stored) return null;
  const key = await importEncryptionKey(encryptionKey);
  return openJson<TokenSet>(key, "oauth_tokens:primary:v1", {
    version: 1,
    ciphertext: new Uint8Array(stored.encryptedPayload),
    iv: new Uint8Array(stored.iv),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("GrokState token refresh and search", () => {
  it("shares one refresh across concurrent searches", async () => {
    const network = installNetwork({ initialExpiresIn: 1 });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    const [first, second] = await Promise.all([
      stub.search({ tool: "web_search", query: "first" }),
      stub.search({ tool: "web_search", query: "second" }),
    ]);

    assertOk(first);
    assertOk(second);
    expect(first.text).toBe("result:first");
    expect(second.text).toBe("result:second");
    expect(network.counts).toEqual({
      discovery: 1,
      authorization: 0,
      refresh: 1,
      search: 2,
    });
  });

  it("uses a fresh token without refreshing", async () => {
    const network = installNetwork({ initialExpiresIn: 3600 });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    const result = await stub.search({ tool: "x_search", query: "fresh" });
    assertOk(result);
    expect(network.counts).toEqual({
      discovery: 0,
      authorization: 0,
      refresh: 0,
      search: 1,
    });
  });

  it("persists a rotated refresh token", async () => {
    const network = installNetwork({ initialExpiresIn: 1 });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    assertOk(await stub.search({ tool: "x_search", query: "rotate" }));
    await expect(storedTokens(stub)).resolves.toMatchObject({
      accessToken: "REFRESHED_ACCESS_TOKEN",
      refreshToken: "ROTATED_REFRESH_TOKEN",
    });
  });

  it("retains the old refresh token when xAI omits a replacement", async () => {
    const network = installNetwork({
      initialExpiresIn: 1,
      initialRefreshToken: "KEEP_THIS_REFRESH_TOKEN",
      refreshResponse: () =>
        Response.json({
          access_token: "REFRESHED_WITHOUT_ROTATION",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    assertOk(await stub.search({ tool: "x_search", query: "retain" }));
    await expect(storedTokens(stub)).resolves.toMatchObject({
      accessToken: "REFRESHED_WITHOUT_ROTATION",
      refreshToken: "KEEP_THIS_REFRESH_TOKEN",
    });
  });

  it("clears credentials when token refresh is rejected", async () => {
    const network = installNetwork({
      initialExpiresIn: 1,
      refreshResponse: () => Response.json({ error: "invalid_grant" }, { status: 401 }),
    });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    await expect(stub.search({ tool: "x_search", query: "expired" })).resolves.toMatchObject({
      ok: false,
      code: "EXPIRED",
    });
    await expect(storedTokens(stub)).resolves.toBeNull();
    expect(network.counts.search).toBe(0);
  });

  it.each([
    {
      name: "token endpoint server failure",
      options: {
        refreshResponse: () => Response.json({ error: "temporary" }, { status: 503 }),
      },
      code: "UPSTREAM_ERROR",
    },
    {
      name: "token endpoint rate limit",
      options: {
        refreshResponse: () =>
          Response.json(
            { error: "temporarily_rate_limited" },
            { status: 429, headers: { "retry-after": "120" } },
          ),
      },
      code: "RATE_LIMITED",
    },
    {
      name: "malformed token success",
      options: {
        refreshResponse: () => Response.json({ expires_in: 3600 }),
      },
      code: "UPSTREAM_ERROR",
    },
    {
      name: "discovery server failure",
      options: {
        discoveryResponse: () => Response.json({ error: "temporary" }, { status: 503 }),
      },
      code: "UPSTREAM_ERROR",
    },
    {
      name: "refresh network timeout",
      options: {
        refreshResponse: () => Promise.reject(new DOMException("timed out", "AbortError")),
      },
      code: "UPSTREAM_TIMEOUT",
    },
  ])("preserves credentials after $name", async ({ options, code }) => {
    const network = installNetwork({ initialExpiresIn: 1, ...options });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    await expect(stub.search({ tool: "x_search", query: "retry later" })).resolves.toMatchObject({
      ok: false,
      code,
    });
    await expect(storedTokens(stub)).resolves.toMatchObject({
      accessToken: "INITIAL_ACCESS_TOKEN",
      refreshToken: "INITIAL_REFRESH_TOKEN",
    });
    expect(network.counts.search).toBe(0);
  });

  it("clears credentials after a search 401", async () => {
    const network = installNetwork({
      searchResponse: () => Response.json({ error: "invalid token" }, { status: 401 }),
    });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    await expect(stub.search({ tool: "web_search", query: "unauthorized" })).resolves.toMatchObject(
      { ok: false, code: "EXPIRED" },
    );
    await expect(storedTokens(stub)).resolves.toBeNull();
  });

  it("preserves credentials after a transient search failure", async () => {
    const network = installNetwork({
      searchResponse: () => Response.json({ error: "temporary" }, { status: 500 }),
    });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    await expect(stub.search({ tool: "web_search", query: "temporary" })).resolves.toMatchObject({
      ok: false,
      code: "UPSTREAM_ERROR",
    });
    await expect(storedTokens(stub)).resolves.toMatchObject({
      accessToken: "INITIAL_ACCESS_TOKEN",
    });
  });

  it("rejects invalid input and missing login before any upstream search", async () => {
    const network = installNetwork();
    const stub = stateStub();

    await expect(
      stub.search({ tool: "x_search", query: "x".repeat(8_001) }),
    ).resolves.toMatchObject({ ok: false, code: "BAD_REQUEST" });
    await expect(stub.search({ tool: "x_search", query: "not logged in" })).resolves.toMatchObject({
      ok: false,
      code: "NO_AUTH",
    });
    expect(network.counts).toEqual({ discovery: 0, authorization: 0, refresh: 0, search: 0 });
  });

  it("makes a queued logout win over an in-flight refresh", async () => {
    const network = installNetwork({
      initialExpiresIn: 1,
      refreshResponse: async () => {
        await scheduler.wait(100);
        return Response.json({
          access_token: "RACING_ACCESS_TOKEN",
          refresh_token: "RACING_REFRESH_TOKEN",
          expires_in: 3600,
        });
      },
    });
    const stub = stateStub();
    await login(stub);
    network.resetCounts();

    const search = stub.search({ tool: "web_search", query: "race" });
    for (let attempt = 0; attempt < 100 && network.counts.refresh === 0; attempt += 1) {
      await scheduler.wait(1);
    }
    expect(network.counts.refresh).toBe(1);
    const logout = stub.logout();

    assertOk(await search);
    assertOk(await logout);
    await expect(storedTokens(stub)).resolves.toBeNull();
  });
});
