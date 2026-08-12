import type { SealedRecord } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 value");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomBase64Url(length = 32): string {
  return bytesToBase64Url(randomBytes(length));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function importEncryptionKey(value: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  }
  // Non-extractable Worker keys cannot be exported back through application
  // code. Web Crypto itself is available on the Workers Free plan.
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson<T>(
  key: CryptoKey,
  purpose: string,
  value: T,
): Promise<SealedRecord> {
  // AES-GCM requires a fresh IV for every encryption under the same key. The
  // purpose string is AAD, binding ciphertext to its table/slot/schema version
  // so a copied row cannot be decrypted in a different context.
  const iv = randomBytes(12);
  const plaintext = JSON.stringify(value);
  if (plaintext === undefined) throw new Error("Value is not JSON serializable");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(purpose),
      tagLength: 128,
    },
    key,
    encoder.encode(plaintext),
  );
  return { version: 1, ciphertext: new Uint8Array(ciphertext), iv };
}

export async function openJson<T>(
  key: CryptoKey,
  purpose: string,
  record: SealedRecord,
): Promise<T> {
  // Keep validation and the AAD purpose synchronized with sealJson. Changing a
  // purpose string is a data-format migration, not a cosmetic refactor.
  if (record.version !== 1 || record.iv.byteLength !== 12 || record.ciphertext.byteLength < 16) {
    throw new Error("Invalid encrypted record");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: record.iv,
      additionalData: encoder.encode(purpose),
      tagLength: 128,
    },
    key,
    record.ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
