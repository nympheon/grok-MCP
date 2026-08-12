# GrokMCP maintenance guide

Read this file before changing the Worker. This repository is the source for a
private, single-user Cloudflare deployment; it is not a local stdio package.

## Runtime contract

- Worker/service name: `grokmcp`
- Public route: `GET /healthz`
- MCP route: `/t/<MCP_URL_TOKEN>/mcp`
- Administration route: `/admin/t/<ADMIN_URL_TOKEN>`
- State: one SQLite Durable Object class, `GrokState`, addressed by the stable
  object name `single-user`
- MCP surface: exactly `x_search` and `web_search`
- MCP wire revision: `2026-07-28` only, one JSON response per request
- Workers compatibility date: `2026-08-11`, the newest date supported by the
  complete pinned Cloudflare local toolchain at this release
- Upstream API: xAI Responses API with raw text at
  `output[].content[].output_text.text`
- Default model: the `GROK_X_SEARCH_MODEL` Worker variable, currently
  `grok-4.5`

Do not restore initialize/session-era MCP transport, SSE responses, top-level
xAI `output_text` parsing, or account-management MCP tools. The JSON text block
beside `structuredContent` is intentional: the current MCP specification still
recommends it for human-readable client display.

## Architecture

- `src/worker.ts` authenticates exact URL paths before reading a body. It owns
  public/admin/MCP routing, Host and Origin checks, form parsing, and body
  limits. It never logs a request URL or body.
- `src/mcp.ts` defines the two schemas and tool handlers. Successful calls
  return `structuredContent` that matches `outputSchema`, plus equivalent JSON
  text. Account operations do not belong here.
- `src/grokState.ts` owns SQLite state, encrypted OAuth attempts/tokens,
  refresh serialization, logout ordering, and upstream search calls. Preserve
  the class name, migration history, and stable object name during upgrades.
- `src/cryptoVault.ts` uses Workers Web Crypto AES-256-GCM. Each record gets a
  fresh 96-bit IV and purpose-specific additional authenticated data (AAD).
  Changing record purpose strings or the encryption secret breaks decryption.
- `src/oauth.ts` implements PKCE and token exchange for the current public
  Grok CLI/Hermes-compatible native client. The client ID is public, not a
  secret, but it is an unofficial compatibility dependency that can change.
- `src/xaiClient.ts` validates the current xAI search contract, bounds the raw
  response, and parses only the current REST response structure.
- `src/urlAuth.ts` parses fixed-shape token paths and compares SHA-256 digests
  without an early-exit string comparison.
- `src/admin.ts` renders a script-free, non-cacheable control plane. All
  dynamic values must pass through HTML escaping.
- `scripts/secrets.mjs` creates/migrates the local recovery file atomically,
  keeps mode `0600`, and prints a protected URL only on an explicit command.

## Secrets and state

The deployment requires three independent Worker secrets:

- `MCP_URL_TOKEN` protects the ChatGPT MCP connection.
- `ADMIN_URL_TOKEN` protects login, status, URL recovery, and logout.
- `TOKEN_ENCRYPTION_KEY` encrypts OAuth rows. Never print or archive it.

`.secrets.local` is an ignored recovery copy for a first deployment or explicit
rotation. Cloudflare does not reveal uploaded secret values later. Running
`npm run secrets:init` preserves an existing three-secret file and upgrades an
older two-secret file by adding only the administration token. Never generate a
new file and upload all three values to an existing Worker as a routine upgrade.

`npm run deploy` intentionally supplies no secrets file. Cloudflare validates
the names declared in `wrangler.jsonc` and preserves their remote values.
`npm run deploy:with-secrets` is reserved for a first deployment or intentional
rotation. Worker deployments do not delete secrets unless an explicit secret
delete operation is used.

Changing a URL token rotates only that route. Changing the encryption key makes
existing OAuth rows unreadable; start a new Grok login after such a rotation.
Never rename `GrokState`, delete its `v1` SQLite migration, or change the stable
object name unless a tested data migration is part of the release.

## Login and refresh behavior

Login is performed only from the protected administration page:

1. Start login. The Durable Object stores encrypted PKCE/state material for ten
   minutes and returns a Grok authorization URL.
2. Grok redirects the browser to `http://127.0.0.1:56121/callback`. No local
   listener is required.
3. Paste the complete address-bar URL into the administration form.
4. The Durable Object validates exact origin/path, one `code`, one `state`,
   expiry, and single use before token exchange.

Only explicit permanent refresh rejection (`invalid_grant`, `invalid_token`,
or authentication rejection) deletes stored credentials. Network failures,
timeouts, 429, malformed temporary responses, and 5xx errors preserve the
encrypted login so a later request can retry.

## Search contract

- Query: 1 to 8,000 characters.
- `x_search`: at most 20 allowed or excluded handles; the two lists are
  mutually exclusive; real `YYYY-MM-DD` dates with `from_date <= to_date`;
  optional image/video understanding.
- `web_search`: at most 5 allowed or excluded domains; the two lists are
  mutually exclusive; optional image search and image understanding.
- Upstream timeout: 60 seconds. Maximum response: 2 MiB.
- No search history is persisted.

When xAI changes a request or response contract, verify against its current
official REST documentation and update schema, runtime validation, fixtures,
READMEs, and focused tests together.

## Comment policy

Comment non-obvious security, wire-format, migration, and concurrency
boundaries. Keep comments concise and explain why a constraint exists. Do not
comment routine syntax, paste secret values, or leave stale version claims.

## Verification and deployment

Node.js 22 or later is required. Dependencies are deliberately exact-pinned.
Do not start a local Worker for the production workflow.

```bash
npm ci --cache .npm-cache
npm run types
npm run check
npm run typecheck
npm test
npm audit --audit-level=low --cache .npm-cache
npm run deploy:dry
npm run deploy
```

After changing `wrangler.jsonc`, always regenerate
`worker-configuration.d.ts`. Keep source maps enabled and invocation
observability disabled: protected URL tokens would otherwise appear in request
paths. Before production deployment, confirm `wrangler whoami`, use the
secret-preserving default deployment for an existing Worker, and retain the
previous Worker version ID for rollback.

Remote acceptance must verify health, wrong-token fail-closed behavior, the
administration page, exactly two tool schemas, and real X/web searches without
logging or displaying OAuth/encryption secrets.

## Source archive upgrades

The temporary checkout may not exist. Restore the secret-free source archive,
verify its SHA-256 checksum, extract it into a new private directory, install
with `npm ci`, run every gate above, and deploy with the default
secret-preserving command. Do not run `secrets:init` for an ordinary upgrade.
The archive must exclude `.git`, `node_modules`, `.secrets.local`, Wrangler
state, caches, coverage, and OS metadata.

Keep `README.md`, `README.zh.md`, and `README.ja.md` synchronized whenever
runtime behavior, limits, secret handling, or deployment steps change.
