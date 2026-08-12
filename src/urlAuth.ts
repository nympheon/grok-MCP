const encoder = new TextEncoder();
const urlTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type AdminAction = "view" | "login" | "callback" | "logout";

export interface AdminRoute {
  token: string;
  action: AdminAction;
}

type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBufferView, right: ArrayBufferView): boolean;
};

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(left, right);
  }
  // workerd supplies timingSafeEqual. The full-length XOR fallback keeps unit
  // environments from reintroducing an early-exit secret string comparison.
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function extractPresentedToken(pathname: string): string | null {
  return /^\/t\/([A-Za-z0-9_-]{43})\/mcp$/.exec(pathname)?.[1] ?? null;
}

export function extractAdminRoute(pathname: string): AdminRoute | null {
  const match = /^\/admin\/t\/([A-Za-z0-9_-]{43})(?:\/(login|callback|logout))?$/.exec(pathname);
  const token = match?.[1];
  if (!token) return null;
  return { token, action: (match[2] as AdminAction | undefined) ?? "view" };
}

async function tokensMatch(presented: string | null, configuredToken: string): Promise<boolean> {
  // Validate fixed-length canonical token syntax before hashing. Hash equality
  // keeps comparison work independent of the first mismatching character.
  if (!presented || !urlTokenPattern.test(configuredToken)) return false;
  const [left, right] = await Promise.all([digest(presented), digest(configuredToken)]);
  return timingSafeEqual(left, right);
}

export async function isAuthorizedMcpPath(
  pathname: string,
  configuredToken: string,
): Promise<boolean> {
  return tokensMatch(extractPresentedToken(pathname), configuredToken);
}

export async function isAuthorizedAdminPath(
  pathname: string,
  configuredToken: string,
): Promise<boolean> {
  return tokensMatch(extractAdminRoute(pathname)?.token ?? null, configuredToken);
}
