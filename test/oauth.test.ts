import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  discoverTokenEndpoint,
  exchangeCode,
  OAuthTokenError,
  parseCallbackUrl,
  refreshTokens,
} from "../src/oauth.js";
import { ToolError } from "../src/types.js";

describe("buildAuthorizeUrl", () => {
  it("includes all required parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://127.0.0.1:56121/callback",
        codeChallenge: "chal",
        state: "st",
        nonce: "no",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(p.get("code_challenge")).toBe("chal");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st");
    expect(p.get("nonce")).toBe("no");
    expect(p.get("plan")).toBe("generic");
    expect(p.get("referrer")).toBe("grok-x-search-mcp");
    expect(p.get("scope")).toContain("grok-cli:access");
  });
});

describe("parseCallbackUrl", () => {
  it("accepts the exact loopback callback with code and state", () => {
    expect(parseCallbackUrl("http://127.0.0.1:56121/callback?code=abc&state=state-1")).toEqual({
      code: "abc",
      state: "state-1",
    });
  });

  it.each([
    "abc",
    "?code=abc&state=state-1",
    "http://localhost:56121/callback?code=abc&state=state-1",
    "http://127.0.0.1:56121/other?code=abc&state=state-1",
    "https://127.0.0.1:56121/callback?code=abc&state=state-1",
    "http://127.0.0.1:56121/callback?code=abc&code=def&state=state-1",
    "http://127.0.0.1:56121/callback?code=abc&state=state-1&state=state-2",
  ])("rejects an untrusted callback form: %s", (value) => {
    expect(() => parseCallbackUrl(value)).toThrow(ToolError);
  });

  it.each([
    "http://127.0.0.1:56121/callback?state=state-1",
    "http://127.0.0.1:56121/callback?code=abc",
  ])("requires both code and state: %s", (value) => {
    expect(() => parseCallbackUrl(value)).toThrow(/code and state/);
  });

  it("sanitizes an authorization denial", () => {
    expect(() =>
      parseCallbackUrl(
        "http://127.0.0.1:56121/callback?error=access_denied&error_description=SECRET_RESPONSE_BODY",
      ),
    ).toThrow("Authorization was denied: access_denied");
    expect(() =>
      parseCallbackUrl(
        "http://127.0.0.1:56121/callback?error=access_denied&error_description=SECRET_RESPONSE_BODY",
      ),
    ).not.toThrow(/SECRET_RESPONSE_BODY/);
  });
});

function mockFetch(
  responses: Array<{ ok: boolean; status: number; body: unknown; headers?: HeadersInit }>,
): typeof fetch {
  let i = 0;
  return async () => {
    const r = responses[i++];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
}

describe("discoverTokenEndpoint", () => {
  it("returns the token_endpoint", async () => {
    const f = mockFetch([
      { ok: true, status: 200, body: { token_endpoint: "https://auth.x.ai/oauth2/token" } },
    ]);
    const ep = await discoverTokenEndpoint(f);
    expect(ep).toBe("https://auth.x.ai/oauth2/token");
  });

  it("rejects a discovered endpoint outside x.ai", async () => {
    const f = mockFetch([
      { ok: true, status: 200, body: { token_endpoint: "https://example.com/token" } },
    ]);
    await expect(discoverTokenEndpoint(f)).rejects.toThrow(/valid token_endpoint/);
  });
});

describe("exchangeCode", () => {
  it("returns a TokenSet with access/refresh tokens", async () => {
    const f = mockFetch([
      {
        ok: true,
        status: 200,
        body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" },
      },
    ]);
    const t = await exchangeCode({
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      code: "c",
      redirectUri: "http://127.0.0.1:56121/callback",
      codeVerifier: "v",
      codeChallenge: "ch",
      fetchImpl: f,
    });
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("RT");
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });
  it("sanitizes token endpoint failures without returning the raw body", async () => {
    const marker = "SECRET_RESPONSE_BODY";
    const f = mockFetch([
      { ok: false, status: 400, body: { error: "invalid_grant", error_description: marker } },
    ]);
    let thrown: unknown;
    try {
      await exchangeCode({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        code: "c",
        redirectUri: "r",
        codeVerifier: "v",
        codeChallenge: "ch",
        fetchImpl: f,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as Error).message).toContain("invalid_grant");
    expect((thrown as Error).message).not.toContain(marker);
  });
});

describe("refreshTokens", () => {
  it("carries over the original refresh_token when none is returned", async () => {
    const f = mockFetch([
      { ok: true, status: 200, body: { access_token: "AT2", expires_in: 3600 } },
    ]);
    const t = await refreshTokens({
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      refreshToken: "RT_OLD",
      fetchImpl: f,
    });
    expect(t.accessToken).toBe("AT2");
    expect(t.refreshToken).toBe("RT_OLD");
  });

  it.each([400, 401])("classifies invalid_grant HTTP %s as permanent", async (status) => {
    const marker = "SECRET_REFRESH_DESCRIPTION";
    const f = mockFetch([
      {
        ok: false,
        status,
        body: { error: "invalid_grant", error_description: marker },
      },
    ]);

    let thrown: unknown;
    try {
      await refreshTokens({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        refreshToken: "RT_OLD",
        fetchImpl: f,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthTokenError);
    expect(thrown).toMatchObject({ code: "EXPIRED", permanent: true });
    expect((thrown as Error).message).not.toContain(marker);
  });

  it.each([
    {
      name: "rate limit",
      status: 429,
      body: { error: "temporarily_rate_limited" },
      headers: { "retry-after": "120" },
      code: "RATE_LIMITED",
    },
    {
      name: "server failure",
      status: 503,
      body: { error: "temporarily_unavailable" },
      code: "UPSTREAM_ERROR",
    },
  ])("classifies $name as retryable", async ({ status, body, headers, code }) => {
    const f = mockFetch([{ ok: false, status, body, headers }]);

    let thrown: unknown;
    try {
      await refreshTokens({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        refreshToken: "RT_OLD",
        fetchImpl: f,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthTokenError);
    expect(thrown).toMatchObject({ code, permanent: false });
  });

  it("classifies a malformed success response as retryable", async () => {
    const f = mockFetch([{ ok: true, status: 200, body: { expires_in: 3600 } }]);

    let thrown: unknown;
    try {
      await refreshTokens({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        refreshToken: "RT_OLD",
        fetchImpl: f,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OAuthTokenError);
    expect(thrown).toMatchObject({ code: "UPSTREAM_ERROR", permanent: false });
  });
});
