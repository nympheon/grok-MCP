import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importEncryptionKey, openJson } from "../src/cryptoVault.js";
import type { GrokState } from "../src/grokState.js";
import type { PendingAuthPayload } from "../src/types.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const discoveryUrl = "https://auth.x.ai/.well-known/openid-configuration";
const tokenUrl = "https://auth.x.ai/oauth2/token";

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

function installOauthMock() {
  const accessToken = "SENSITIVE_ACCESS_TOKEN_MARKER_5d9f8e";
  const refreshToken = "SENSITIVE_REFRESH_TOKEN_MARKER_4a17c2";
  let tokenRequestBody = "";
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === discoveryUrl) {
      return Response.json({ token_endpoint: tokenUrl });
    }
    if (url === tokenUrl) {
      tokenRequestBody = String(init?.body ?? "");
      return Response.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return {
    accessToken,
    refreshToken,
    mock,
    tokenRequestBody: () => tokenRequestBody,
  };
}

async function storedText(stub: DurableObjectStub<GrokState>): Promise<string> {
  return runInDurableObject(stub, (_instance, state) => {
    const decoder = new TextDecoder();
    const values: string[] = [];
    for (const table of ["oauth_attempts", "oauth_tokens"]) {
      for (const row of state.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${table}`,
      )) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") values.push(value);
          if (value instanceof ArrayBuffer) values.push(decoder.decode(value));
        }
      }
    }
    return values.join("\n");
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("GrokState OAuth lifecycle", () => {
  it("preserves stored authentication status across eviction", async () => {
    const stub = stateStub();
    await expect(stub.getStatus()).resolves.toMatchObject({ ok: true, loggedIn: false });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO oauth_tokens
          (slot, encrypted_payload, iv, expires_at, updated_at)
         VALUES ('primary', ?, ?, ?, ?)`,
        new Uint8Array([1]).buffer,
        new Uint8Array(12).buffer,
        Date.now() + 60_000,
        Date.now(),
      );
    });
    await evictDurableObject(stub);
    await expect(stub.getStatus()).resolves.toMatchObject({ ok: true, loggedIn: true });
  });

  it("completes login once and encrypts every stored secret", async () => {
    const oauth = installOauthMock();
    const stub = stateStub();
    const login = await stub.startLogin();
    assertOk(login);
    expect(login.expiresInSec).toBe(600);

    const stateValue = new URL(login.authorizeUrl).searchParams.get("state");
    expect(stateValue).toBeTruthy();
    if (!stateValue) throw new Error("Missing OAuth state");

    const pending = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          state_hash: string;
          encrypted_payload: ArrayBuffer;
          iv: ArrayBuffer;
        }>("SELECT state_hash, encrypted_payload, iv FROM oauth_attempts")
        .one();
      return {
        stateHash: row.state_hash,
        encryptedPayload: row.encrypted_payload,
        iv: row.iv,
      };
    });
    const key = await importEncryptionKey(encryptionKey);
    const pendingPayload = await openJson<PendingAuthPayload>(
      key,
      `oauth_attempts:${pending.stateHash}:v1`,
      {
        version: 1,
        ciphertext: new Uint8Array(pending.encryptedPayload),
        iv: new Uint8Array(pending.iv),
      },
    );
    const pendingRaw = await storedText(stub);
    expect(pendingRaw).not.toContain(stateValue);
    expect(pendingRaw).not.toContain(pendingPayload.codeVerifier);
    expect(await stub.getStatus()).toMatchObject({ ok: true, loggedIn: false });

    const callback = `http://127.0.0.1:56121/callback?code=SENSITIVE_AUTH_CODE_MARKER_8b31a7&state=${stateValue}`;
    const completed = await stub.completeLogin(callback);
    assertOk(completed);
    expect(oauth.mock).toHaveBeenCalledTimes(2);
    expect(oauth.tokenRequestBody()).toContain(
      `code_verifier=${encodeURIComponent(pendingPayload.codeVerifier)}`,
    );
    expect(await stub.getStatus()).toMatchObject({
      ok: true,
      loggedIn: true,
      expired: false,
    });

    const raw = await storedText(stub);
    expect(raw).not.toContain("SENSITIVE_AUTH_CODE_MARKER_8b31a7");
    expect(raw).not.toContain(oauth.accessToken);
    expect(raw).not.toContain(oauth.refreshToken);
    expect(raw).not.toContain(pendingPayload.codeVerifier);
    expect(raw).not.toContain(stateValue);

    await expect(stub.completeLogin(callback)).resolves.toMatchObject({
      ok: false,
      code: "LOGIN_EXPIRED",
    });
  });

  it("keeps only the newest login attempt", async () => {
    const stub = stateStub();
    const first = await stub.startLogin();
    const second = await stub.startLogin();
    assertOk(first);
    assertOk(second);
    const firstState = new URL(first.authorizeUrl).searchParams.get("state");
    expect(firstState).toBeTruthy();

    await expect(
      stub.completeLogin(`http://127.0.0.1:56121/callback?code=CODE&state=${firstState}`),
    ).resolves.toMatchObject({ ok: false, code: "LOGIN_EXPIRED" });
  });

  it("rejects and consumes an expired login attempt before any OAuth fetch", async () => {
    const oauth = installOauthMock();
    const stub = stateStub();
    const login = await stub.startLogin();
    assertOk(login);
    const stateValue = new URL(login.authorizeUrl).searchParams.get("state");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE oauth_attempts SET expires_at = 0");
    });

    const callback = `http://127.0.0.1:56121/callback?code=CODE&state=${stateValue}`;
    await expect(stub.completeLogin(callback)).resolves.toMatchObject({
      ok: false,
      code: "LOGIN_EXPIRED",
    });
    await expect(stub.completeLogin(callback)).resolves.toMatchObject({
      ok: false,
      code: "LOGIN_EXPIRED",
    });
    expect(oauth.mock).not.toHaveBeenCalled();
  });

  it("logout clears tokens and pending attempts", async () => {
    installOauthMock();
    const stub = stateStub();
    const login = await stub.startLogin();
    assertOk(login);
    const stateValue = new URL(login.authorizeUrl).searchParams.get("state");
    await stub.completeLogin(`http://127.0.0.1:56121/callback?code=CODE&state=${stateValue}`);
    await stub.startLogin();

    await expect(stub.logout()).resolves.toMatchObject({ ok: true });
    await expect(stub.getStatus()).resolves.toEqual({
      ok: true,
      loggedIn: false,
      expired: false,
      expiresAt: null,
      updatedAt: null,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const attempts = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM oauth_attempts")
          .one().count;
        const tokens = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM oauth_tokens")
          .one().count;
        const schemaVersion = state.storage.sql
          .exec<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
          .one().value;
        return { attempts, tokens, schemaVersion };
      }),
    ).resolves.toEqual({ attempts: 0, tokens: 0, schemaVersion: "1" });
  });
});
