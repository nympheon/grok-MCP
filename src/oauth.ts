import {
  HTTP_TIMEOUT_MS,
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_PLAN,
  XAI_OAUTH_REFERRER,
  XAI_OAUTH_SCOPE,
} from "./constants.js";
import { type ParsedCallback, type TokenSet, ToolError, type ToolErrorCode } from "./types.js";

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

export class OAuthTokenError extends ToolError {
  // Only permanent=true authorizes the Durable Object to erase a stored login.
  // Transient upstream failures must leave ciphertext available for retry.
  constructor(
    code: ToolErrorCode,
    message: string,
    public readonly permanent: boolean,
  ) {
    super(code, message);
    this.name = "OAuthTokenError";
  }
}

export function buildAuthorizeUrl(input: {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(XAI_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", XAI_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("plan", XAI_OAUTH_PLAN);
  url.searchParams.set("referrer", XAI_OAUTH_REFERRER);
  return url.toString();
}

function safeValue(value: unknown): string {
  const input = String(value ?? "").slice(0, 320);
  let output = "";
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    output += code < 32 || code === 127 ? " " : character;
  }
  return output.trim().slice(0, 160);
}

export function parseCallbackUrl(input: string): ParsedCallback {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ToolError("BAD_REQUEST", "Paste the complete callback URL from the browser.");
  }
  // Accept only the registered loopback redirect. This also rejects userinfo,
  // alternate localhost spellings, and paths that could smuggle credentials.
  if (
    url.origin !== "http://127.0.0.1:56121" ||
    url.pathname !== "/callback" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ToolError("BAD_REQUEST", "The callback URL has an unexpected origin or path.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    throw new ToolError("HTTP_ERROR", `Authorization was denied: ${safeValue(error)}`);
  }
  const codes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  const code = codes[0]?.trim();
  const state = states[0]?.trim();
  if (codes.length !== 1 || states.length !== 1 || !code || !state) {
    throw new ToolError("BAD_REQUEST", "The callback URL must contain code and state.");
  }
  return { code, state };
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OAUTH_RESPONSE_BYTES) {
    throw new ToolError("HTTP_ERROR", "OAuth response exceeded the allowed size.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OAUTH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ToolError("HTTP_ERROR", "OAuth response exceeded the allowed size.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseObject(text: string, context: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new ToolError("HTTP_ERROR", `${context} returned invalid JSON.`);
}

function upstreamErrorCode(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return safeValue(record.error ?? record.code) || "unknown_error";
    }
  } catch {}
  return "unknown_error";
}

export async function discoverTokenEndpoint(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ToolError("HTTP_ERROR", `OIDC discovery failed (HTTP ${res.status})`);
  }
  const json = parseObject(await readBoundedText(res), "OIDC discovery");
  const ep = String(json.token_endpoint ?? "").trim();
  // Discovery is upstream-controlled input. Pin token exchange to HTTPS x.ai
  // hosts so a compromised response cannot turn this Worker into an SSRF proxy.
  try {
    const u = new URL(ep);
    if (u.protocol !== "https:" || !(u.hostname === "x.ai" || u.hostname.endsWith(".x.ai"))) {
      throw new Error();
    }
  } catch {
    throw new ToolError("HTTP_ERROR", "Discovery did not return a valid token_endpoint.");
  }
  return ep;
}

function toTokenSet(
  payload: Record<string, unknown>,
  startedAt: number,
  fallbackRefresh = "",
): TokenSet {
  const accessToken = String(payload.access_token ?? "").trim();
  const refreshToken = String(payload.refresh_token ?? fallbackRefresh).trim();
  if (!accessToken) throw new ToolError("HTTP_ERROR", "Response is missing access_token.");
  if (!refreshToken) throw new ToolError("HTTP_ERROR", "Response is missing refresh_token.");
  const parsedExpiresIn = Number(payload.expires_in ?? 3600);
  const expiresInSec =
    Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0 ? parsedExpiresIn : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: startedAt + expiresInSec * 1000,
    idToken: String(payload.id_token ?? "").trim() || undefined,
    tokenType: String(payload.token_type ?? "Bearer").trim() || "Bearer",
  };
}

async function postToken(
  tokenEndpoint: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  fallbackRefresh = "",
): Promise<TokenSet> {
  const refreshing = fallbackRefresh.length > 0;
  const startedAt = Date.now();
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await readBoundedText(res);
  if (!res.ok) {
    const errorCode = upstreamErrorCode(text);
    if (refreshing) {
      // Authentication rejection is terminal. Rate limits and server failures
      // are retryable and deliberately use permanent=false.
      const permanent =
        res.status === 401 || errorCode === "invalid_grant" || errorCode === "invalid_token";
      if (permanent) {
        throw new OAuthTokenError(
          "EXPIRED",
          "The OAuth service rejected the refresh token. Sign in again from the Worker administration page.",
          true,
        );
      }
      if (res.status === 429) {
        throw new OAuthTokenError(
          "RATE_LIMITED",
          "The OAuth service rate limited token refresh. Retry later.",
          false,
        );
      }
      throw new OAuthTokenError(
        "UPSTREAM_ERROR",
        `The OAuth service could not refresh the token (HTTP ${res.status}). Retry later.`,
        false,
      );
    }
    throw new ToolError(
      "HTTP_ERROR",
      `Token endpoint rejected the request (HTTP ${res.status}, error ${errorCode}).`,
    );
  }
  try {
    return toTokenSet(parseObject(text, "Token endpoint"), startedAt, fallbackRefresh);
  } catch (error) {
    if (refreshing && error instanceof ToolError) {
      throw new OAuthTokenError(
        "UPSTREAM_ERROR",
        "The OAuth service returned an invalid refresh response. Retry later.",
        false,
      );
    }
    throw error;
  }
}

export function exchangeCode(input: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  codeChallenge: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return postToken(input.tokenEndpoint, body, input.fetchImpl ?? fetch);
}

export function refreshTokens(input: {
  tokenEndpoint: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: input.refreshToken,
  });
  return postToken(input.tokenEndpoint, body, input.fetchImpl ?? fetch, input.refreshToken);
}
