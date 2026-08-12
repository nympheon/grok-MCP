import { describe, expect, it } from "vitest";
import { bytesToBase64, importEncryptionKey, openJson, sealJson } from "../src/cryptoVault.js";

const keyText = bytesToBase64(new Uint8Array(32).fill(7));

describe("crypto vault", () => {
  it("imports a non-extractable 256-bit AES key", async () => {
    const key = await importEncryptionKey(keyText);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(false);
  });

  it("round-trips JSON only with the same purpose", async () => {
    const key = await importEncryptionKey(keyText);
    const sealed = await sealJson(key, "oauth_tokens:primary:v1", { accessToken: "AT" });
    await expect(openJson(key, "oauth_tokens:primary:v1", sealed)).resolves.toEqual({
      accessToken: "AT",
    });
    await expect(openJson(key, "oauth_attempts:state:v1", sealed)).rejects.toThrow();
  });

  it("uses a unique 96-bit IV for every encrypted record", async () => {
    const key = await importEncryptionKey(keyText);
    const first = await sealJson(key, "record:v1", { value: 1 });
    const second = await sealJson(key, "record:v1", { value: 1 });
    expect(first.iv).toHaveLength(12);
    expect(second.iv).toHaveLength(12);
    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it("rejects corrupted ciphertext", async () => {
    const key = await importEncryptionKey(keyText);
    const sealed = await sealJson(key, "record:v1", { value: 1 });
    const corrupted = {
      ...sealed,
      ciphertext: Uint8Array.from(sealed.ciphertext),
    };
    corrupted.ciphertext[0] ^= 1;
    await expect(openJson(key, "record:v1", corrupted)).rejects.toThrow();
  });

  it("rejects a key that is not exactly 32 bytes", async () => {
    await expect(importEncryptionKey("YQ==")).rejects.toThrow(
      "TOKEN_ENCRYPTION_KEY must decode to 32 bytes",
    );
  });
});
