import { DurableObject } from "cloudflare:workers";
import { PENDING_AUTH_TTL_MS, TOKEN_REFRESH_SKEW_MS, XAI_OAUTH_REDIRECT_URI } from "./constants.js";
import { importEncryptionKey, openJson, sealJson, sha256Base64Url } from "./cryptoVault.js";
import {
  buildAuthorizeUrl,
  discoverTokenEndpoint,
  exchangeCode,
  OAuthTokenError,
  parseCallbackUrl,
  refreshTokens,
} from "./oauth.js";
import { generatePkce, randomToken } from "./pkce.js";
import {
  type AuthStatus,
  type LoginData,
  type MessageData,
  type PendingAuthPayload,
  type SealedRecord,
  type SearchData,
  type SearchRequest,
  type TokenSet,
  ToolError,
  type ToolErrorCode,
  type ToolResult,
} from "./types.js";
import { buildToolEntry, callResponses, resolveModel } from "./xaiClient.js";

interface AttemptRow extends Record<string, SqlStorageValue> {
  encrypted_payload: ArrayBuffer;
  iv: ArrayBuffer;
  created_at: number;
  expires_at: number;
}

interface StatusRow extends Record<string, SqlStorageValue> {
  expires_at: number;
  updated_at: number;
}

interface TokenRow extends StatusRow {
  encrypted_payload: ArrayBuffer;
  iv: ArrayBuffer;
}

function exactArrayBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function failure<T extends object>(code: ToolErrorCode, error: string): ToolResult<T> {
  return { ok: false, code, error };
}

export class GrokState extends DurableObject<Env> {
  private readonly encryptionKey: Promise<CryptoKey>;
  private authTail: Promise<void> = Promise.resolve();
  private refreshInFlight: Promise<TokenSet> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.encryptionKey = importEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
    // Import the encryption key and establish the SQLite schema before the DO
    // accepts RPC. A key/configuration error must fail closed.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.encryptionKey;
      this.initializeSchema();
    });
  }

  async startLogin(): Promise<ToolResult<LoginData>> {
    try {
      const createdAt = Date.now();
      const expiresAt = createdAt + PENDING_AUTH_TTL_MS;
      const [{ verifier, challenge }, state, nonce, key] = await Promise.all([
        generatePkce(),
        Promise.resolve(randomToken()),
        Promise.resolve(randomToken()),
        this.encryptionKey,
      ]);
      const stateHash = await sha256Base64Url(state);
      const pending: PendingAuthPayload = {
        nonce,
        codeVerifier: verifier,
        codeChallenge: challenge,
        redirectUri: XAI_OAUTH_REDIRECT_URI,
        createdAt,
      };
      // Hash state for lookup and encrypt PKCE material with per-attempt AAD;
      // neither the raw state nor verifier is stored as searchable plaintext.
      const sealed = await sealJson(key, `oauth_attempts:${stateHash}:v1`, pending);
      this.ctx.storage.sql.exec("DELETE FROM oauth_attempts");
      this.ctx.storage.sql.exec(
        `INSERT INTO oauth_attempts
          (state_hash, encrypted_payload, iv, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        stateHash,
        exactArrayBuffer(sealed.ciphertext),
        exactArrayBuffer(sealed.iv),
        createdAt,
        expiresAt,
      );
      return {
        ok: true,
        authorizeUrl: buildAuthorizeUrl({
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          state,
          nonce: pending.nonce,
        }),
        expiresInSec: Math.floor(PENDING_AUTH_TTL_MS / 1000),
        message:
          "Open authorizeUrl, sign in to Grok, then return to this Worker administration page and paste the complete callback URL within 10 minutes.",
      };
    } catch (error) {
      return this.internalFailure("startLogin", error);
    }
  }

  async completeLogin(callbackUrl: string): Promise<ToolResult<MessageData>> {
    try {
      const callback = parseCallbackUrl(callbackUrl);
      const stateHash = await sha256Base64Url(callback.state);
      const rows = this.ctx.storage.sql
        .exec<AttemptRow>(
          `SELECT encrypted_payload, iv, created_at, expires_at
           FROM oauth_attempts
           WHERE state_hash = ?`,
          stateHash,
        )
        .toArray();
      const row = rows[0];
      if (!row) {
        return failure(
          "LOGIN_EXPIRED",
          "This login attempt is missing, expired, or already used. Start a new login from the Worker administration page.",
        );
      }
      // Delete before token exchange so a callback stays single-use even if the
      // upstream exchange fails or the client retries the same URL.
      this.ctx.storage.sql.exec("DELETE FROM oauth_attempts WHERE state_hash = ?", stateHash);
      if (row.expires_at <= Date.now()) {
        return failure(
          "LOGIN_EXPIRED",
          "This login attempt is missing, expired, or already used. Start a new login from the Worker administration page.",
        );
      }

      const key = await this.encryptionKey;
      const pending = await openJson<PendingAuthPayload>(
        key,
        `oauth_attempts:${stateHash}:v1`,
        this.sealedRecord(row.encrypted_payload, row.iv),
      );
      let tokens: TokenSet;
      try {
        const tokenEndpoint = await discoverTokenEndpoint();
        tokens = await exchangeCode({
          tokenEndpoint,
          code: callback.code,
          redirectUri: pending.redirectUri,
          codeVerifier: pending.codeVerifier,
          codeChallenge: pending.codeChallenge,
        });
      } catch (error) {
        return this.oauthFailure(error);
      }

      await this.runAuthMutation(() => this.persistTokens(tokens));
      return { ok: true, message: "Grok login completed successfully." };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.code, error.message);
      return this.internalFailure("completeLogin", error);
    }
  }

  async getStatus(): Promise<ToolResult<AuthStatus>> {
    try {
      const rows = this.ctx.storage.sql
        .exec<StatusRow>(
          `SELECT expires_at, updated_at
           FROM oauth_tokens
           WHERE slot = 'primary'`,
        )
        .toArray();
      const row = rows[0];
      if (!row) {
        return {
          ok: true,
          loggedIn: false,
          expired: false,
          expiresAt: null,
          updatedAt: null,
        };
      }
      return {
        ok: true,
        loggedIn: true,
        expired: row.expires_at <= Date.now(),
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      return this.internalFailure("getStatus", error);
    }
  }

  async logout(): Promise<ToolResult<MessageData>> {
    try {
      return await this.runAuthMutation(async () => {
        this.ctx.storage.sql.exec("DELETE FROM oauth_attempts");
        this.deleteTokens();
        return { ok: true, message: "Grok credentials and pending login attempts were removed." };
      });
    } catch (error) {
      return this.internalFailure("logout", error);
    }
  }

  async search(input: SearchRequest): Promise<ToolResult<SearchData>> {
    try {
      buildToolEntry(input);
      const tokens = await this.getValidTokens();
      try {
        const result = await callResponses({
          accessToken: tokens.accessToken,
          model: resolveModel(this.env.GROK_X_SEARCH_MODEL),
          request: input,
        });
        return { ok: true, ...result };
      } catch (error) {
        if (error instanceof ToolError) {
          if (error.code === "EXPIRED") {
            await this.runAuthMutation(async () => this.deleteTokens());
          }
          return failure(error.code, error.message);
        }
        return this.internalFailure("search", error);
      }
    } catch (error) {
      if (error instanceof ToolError) return failure(error.code, error.message);
      return this.internalFailure("search", error);
    }
  }

  private initializeSchema(): void {
    // The v1 tables and purpose strings are a persisted data contract. Add a
    // new explicit migration/version instead of editing existing columns in place.
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_attempts (
      state_hash TEXT PRIMARY KEY,
      encrypted_payload BLOB NOT NULL,
      iv BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (
      slot TEXT PRIMARY KEY CHECK (slot = 'primary'),
      encrypted_payload BLOB NOT NULL,
      iv BLOB NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1')");
    const version = sql
      .exec<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .one().value;
    if (version !== "1") throw new Error("Unsupported schema version");
  }

  private sealedRecord(ciphertext: ArrayBuffer, iv: ArrayBuffer): SealedRecord {
    return {
      version: 1,
      ciphertext: new Uint8Array(ciphertext),
      iv: new Uint8Array(iv),
    };
  }

  private runAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize token writes, refreshes, and logout. This makes a queued logout
    // win after an already-running refresh instead of letting refresh resurrect data.
    const result = this.authTail.then(operation, operation);
    this.authTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getValidTokens(): Promise<TokenSet> {
    // Multiple concurrent searches share one refresh promise and therefore one
    // upstream refresh-token use/rotation.
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.runAuthMutation(async () => {
      const tokens = await this.loadTokens();
      if (!tokens) {
        throw new ToolError(
          "NO_AUTH",
          "Not logged in. Open the Worker administration page and sign in to Grok.",
        );
      }
      if (tokens.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) return tokens;
      let refreshed: TokenSet;
      try {
        const tokenEndpoint = await discoverTokenEndpoint();
        refreshed = await refreshTokens({
          tokenEndpoint,
          refreshToken: tokens.refreshToken,
        });
      } catch (error) {
        if (error instanceof OAuthTokenError && error.permanent) {
          // Do not delete on network, discovery, 429, malformed success, or 5xx
          // failures; only an explicit permanent rejection invalidates the row.
          this.deleteTokens();
          throw new ToolError(
            "EXPIRED",
            "Grok login expired. Open the Worker administration page and sign in again.",
          );
        }
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          throw new ToolError("UPSTREAM_TIMEOUT", "The OAuth service timed out. Retry later.");
        }
        if (error instanceof ToolError && error.code === "RATE_LIMITED") throw error;
        throw new ToolError(
          "UPSTREAM_ERROR",
          "The OAuth service could not refresh the login. Retry later.",
        );
      }
      await this.persistTokens(refreshed);
      return refreshed;
    });
    const shared = operation.finally(() => {
      if (this.refreshInFlight === shared) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = shared;
    return shared;
  }

  private async loadTokens(): Promise<TokenSet | null> {
    const rows = this.ctx.storage.sql
      .exec<TokenRow>(
        `SELECT encrypted_payload, iv, expires_at, updated_at
         FROM oauth_tokens
         WHERE slot = 'primary'`,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    return openJson<TokenSet>(
      await this.encryptionKey,
      "oauth_tokens:primary:v1",
      this.sealedRecord(row.encrypted_payload, row.iv),
    );
  }

  private async persistTokens(tokens: TokenSet): Promise<void> {
    const sealed = await sealJson(await this.encryptionKey, "oauth_tokens:primary:v1", tokens);
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_tokens
        (slot, encrypted_payload, iv, expires_at, updated_at)
       VALUES ('primary', ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
        encrypted_payload = excluded.encrypted_payload,
        iv = excluded.iv,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
      exactArrayBuffer(sealed.ciphertext),
      exactArrayBuffer(sealed.iv),
      tokens.expiresAt,
      Date.now(),
    );
  }

  private deleteTokens(): void {
    this.ctx.storage.sql.exec("DELETE FROM oauth_tokens");
  }

  private oauthFailure(error: unknown): ToolResult<MessageData> {
    if (error instanceof ToolError) return failure(error.code, error.message);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return failure("UPSTREAM_TIMEOUT", "The OAuth service timed out. Start a new login.");
    }
    return failure("UPSTREAM_ERROR", "The OAuth service could not be reached. Start a new login.");
  }

  private internalFailure<T extends object>(operation: string, error: unknown): ToolResult<T> {
    const correlationId = crypto.randomUUID();
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ correlationId, operation, errorName }));
    return {
      ok: false,
      code: "INTERNAL",
      error: `Internal error. Reference: ${correlationId}`,
      correlationId,
    };
  }
}
