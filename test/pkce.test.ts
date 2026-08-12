import { describe, expect, it } from "vitest";
import { generatePkce, randomToken } from "../src/pkce.js";

describe("pkce", () => {
  it("challenge equals base64url(sha256(verifier))", async () => {
    const { verifier, challenge } = await generatePkce();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = Buffer.from(digest).toString("base64url");
    expect(challenge).toBe(expected);
  });
  it("verifier contains only base64url characters (no + / =)", async () => {
    const { verifier } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("randomToken differs every call", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
