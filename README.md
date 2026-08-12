# grok-x-search-mcp

An unofficial, private, single-user Grok search MCP server on Cloudflare
Workers. It is designed for ChatGPT web, stores OAuth state in one
SQLite-backed Durable Object, and encrypts credentials with Workers Web Crypto
AES-256-GCM.

**Languages:** English | [日本語](README.ja.md) | [中文](README.zh.md)

> This project is not affiliated with or endorsed by xAI, X, OpenAI, or
> Cloudflare. It reuses a public Grok CLI/Hermes-compatible OAuth client ID.
> Upstream OAuth/API behavior and service terms can change.

## Current contract

- Worker name: `grokmcp`
- Health: `GET /healthz`
- MCP: `https://grokmcp.<account>.workers.dev/t/<MCP_URL_TOKEN>/mcp`
- Administration:
  `https://grokmcp.<account>.workers.dev/admin/t/<ADMIN_URL_TOKEN>`
- MCP protocol: revision `2026-07-28` only, stateless JSON requests/responses
- MCP tools: only `x_search` and `web_search`
- State: one SQLite Durable Object named `single-user`
- Model: `GROK_X_SEARCH_MODEL`, default/current value `grok-4.5`

Old initialize/session MCP clients, SSE transport, account-management MCP
tools, and old raw xAI response fallbacks are intentionally unsupported.

## Free-plan boundary

Web Crypto is built into Workers and has no separate charge. This deployment
uses only a Worker, one SQLite Durable Object, Worker variables, and Worker
secrets. It is intended for low-volume personal use within the current
[Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Objects Free allocation](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Cloudflare quotas can change, and a compatible Grok/X subscription is still
required.

## Install, verify, and deploy

Requirements: a Cloudflare Free account with a `workers.dev` subdomain, one
personal Grok/X account, Node.js 22 or later, and npm.

These commands do not start a local Worker:

```bash
npm ci --cache .npm-cache
npm run secrets:init
npx wrangler login
npm run types
npm run check
npm run typecheck
npm test
npm audit --audit-level=low --cache .npm-cache
npm run deploy:dry
npm run deploy:with-secrets
```

`deploy:with-secrets` is for the first deployment or an intentional secret
rotation. Routine code upgrades use `npm run deploy` without a secrets file;
Cloudflare validates the required names and preserves their existing encrypted
values.

`npm run secrets:init` creates or validates ignored `.secrets.local` with mode
`0600`. It contains three 256-bit values:

- `MCP_URL_TOKEN`: password embedded in the ChatGPT MCP URL
- `ADMIN_URL_TOKEN`: independent password embedded in the administration URL
- `TOKEN_ENCRYPTION_KEY`: AES key for OAuth records in SQLite

The command preserves existing local values and never prints them. Cloudflare
accepts the values during the first deployment but does not reveal them later.
A separate backup is useful but is not required for routine code upgrades,
because ordinary Wrangler deployments never delete existing Worker secrets.

After deployment, use the exact base URL printed by Wrangler:

```bash
npm run url -- https://grokmcp.<account>.workers.dev
npm run admin-url -- https://grokmcp.<account>.workers.dev
```

These two commands intentionally print protected URLs. Treat both URLs as
passwords: never commit, screenshot, log, or share them.

## Connect ChatGPT web

Follow the current [OpenAI custom MCP connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and paste the complete MCP URL ending in `/mcp`. Do not configure an additional
Authorization header or OAuth credential; authentication is already carried by
the URL token.

The client must support MCP `2026-07-28` per-request envelopes and standard
headers. Each successful call returns JSON and does not create an MCP session.

## Log in to Grok

Login, status, callback, and logout are deliberately absent from MCP. Open the
protected administration URL in a browser instead:

1. Select **Start a new Grok login**.
2. Open the generated authorization link and sign in with the intended Grok/X
   account.
3. Grok redirects to `http://127.0.0.1:56121/callback?...`. A browser connection
   error is expected; no local listener is needed.
4. Copy the complete address-bar URL, including exactly one `code` and one
   `state`, and paste it into the Worker administration page within ten minutes.
5. Confirm the page reports **Signed in**.

The callback URL is a short-lived credential. Do not share it or paste only the
authorization code.

## Search tools

Both tools declare an MCP `outputSchema`. A successful call returns matching
`structuredContent` plus an equivalent JSON text block:

```json
{
  "ok": true,
  "text": "answer text",
  "citations": ["https://example.com/source"],
  "model": "grok-4.5"
}
```

| Tool | Input |
|---|---|
| `x_search` | Required `query`; optional `allowed_x_handles` or `excluded_x_handles` (maximum 20, mutually exclusive), real `from_date`/`to_date` with `from_date <= to_date`, `enable_image_understanding`, and `enable_video_understanding` |
| `web_search` | Required `query`; optional `allowed_domains` or `excluded_domains` (maximum 5, mutually exclusive), `enable_image_search`, and `enable_image_understanding` |

Queries are limited to 8,000 characters. Upstream calls time out after 60
seconds, responses are limited to 2 MiB, citations are deduplicated, and search
history is not stored.

## Model and Worker upgrades

Edit `GROK_X_SEARCH_MODEL` in `wrangler.jsonc`, run the complete verification
gate, and redeploy to change models. Invalid model identifiers fall back to
`grok-4.5`.

If this checkout has been deleted, restore the secret-free source archive and
verify its SHA-256 checksum. Extract it into a new private directory, run
`npm ci`, run all verification commands except `secrets:init`, confirm
`npx wrangler whoami`, then run `npm run deploy`. No local secret file is needed
for an existing Worker: required secret names are validated remotely and their
values are preserved. Preserve the `GrokState` class, migration history, and
`single-user` object name so the existing encrypted SQLite state remains
attached.

The authenticated administration page shows the application version, deployed
Worker version, current model, public OAuth compatibility data, login status,
and recoverable MCP URL. It cannot replace the source archive for code changes.

## Secret rotation

- Rotate `MCP_URL_TOKEN` to invalidate the ChatGPT URL; then update the ChatGPT
  connection.
- Rotate `ADMIN_URL_TOKEN` to invalidate the administration URL.
- Rotate `TOKEN_ENCRYPTION_KEY` only when prepared to log in again. Existing
  OAuth ciphertext becomes unreadable by design.

Rotate exactly one named secret in Cloudflare Workers → `grokmcp` → Settings →
Variables and Secrets (or with `wrangler secret put`), then reconstruct/bookmark
the affected protected URL. Never rotate the encryption key merely to rotate a
URL. If the old local recovery file no longer exists, this dashboard/CLI flow is
the supported rotation path.

## Security notes

- Wrong or missing protected paths return `404` before body parsing or Durable
  Object access.
- MCP and administration tokens are separate and cannot be interchanged.
- Administration mutations require same-origin form POSTs; the page is
  script-free, non-cacheable, non-referring, and non-frameable.
- OAuth attempts and token sets are encrypted at rest with purpose-bound
  AES-GCM records.
- Permanent refresh rejection clears unusable credentials; transient OAuth/xAI
  failures preserve them for retry.
- Worker invocation observability is disabled because bearer tokens appear in
  URL paths. Source maps are uploaded for versioned diagnostics.
- This is a single-user design. Do not expose it as a shared or multi-tenant
  service.

## License

[MIT](LICENSE)
