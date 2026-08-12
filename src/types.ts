export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  tokenType: string;
}

export interface PendingAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
}

export interface ParsedCallback {
  code: string;
  state: string;
}

export interface SealedRecord {
  version: 1;
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

export type ToolErrorCode =
  | "NO_AUTH"
  | "EXPIRED"
  | "FORBIDDEN_403"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_ERROR"
  | "HTTP_ERROR"
  | "STATE_MISMATCH"
  | "LOGIN_EXPIRED"
  | "BAD_REQUEST"
  | "INTERNAL";

export type ToolResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; code: ToolErrorCode; error: string; correlationId?: string };

export interface LoginData {
  authorizeUrl: string;
  expiresInSec: number;
  message: string;
}

export interface MessageData {
  message: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  expired: boolean;
  expiresAt: number | null;
  updatedAt: number | null;
}

export type SearchTool = "x_search" | "web_search";

export interface SearchRequest {
  tool: SearchTool;
  query: string;
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  allowedDomains?: string[];
  excludedDomains?: string[];
  fromDate?: string;
  toDate?: string;
  enableImageSearch?: boolean;
  enableImageUnderstanding?: boolean;
  enableVideoUnderstanding?: boolean;
}

export interface SearchData {
  text: string;
  citations: string[];
  model: string;
}

export interface PendingAuthPayload {
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
}

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
