import { randomBase64Url, sha256Base64Url } from "./cryptoVault.js";

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<Pkce> {
  const verifier = randomBase64Url(48);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function randomToken(bytes = 32): string {
  return randomBase64Url(bytes);
}
