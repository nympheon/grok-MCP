// Public native-app OAuth identifier currently used by Grok CLI/Hermes-style
// login. It is not a secret; upstream can rotate or retire it without notice.
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_REDIRECT_URI = "http://127.0.0.1:56121/callback";
export const XAI_OAUTH_REFERRER = "grok-x-search-mcp";
export const XAI_OAUTH_PLAN = "generic";

export const XAI_API_RESPONSES_URL = "https://api.x.ai/v1/responses";

export const APP_VERSION = "0.3.0";

export const TOKEN_REFRESH_SKEW_MS = 120_000;
export const PENDING_AUTH_TTL_MS = 600_000;
export const HTTP_TIMEOUT_MS = 60_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_REQUEST_BYTES = 128 * 1024;
export const MAX_ADMIN_FORM_BYTES = 16 * 1024;
export const MAX_QUERY_LENGTH = 8_000;
export const MAX_X_HANDLE_FILTER_ENTRIES = 20;
export const MAX_WEB_DOMAIN_FILTER_ENTRIES = 5;

export const DEFAULT_MODEL = "grok-4.5";
