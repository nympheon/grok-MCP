# GrokMCP Worker Admin and Search-Only Maintenance Design

Date: 2026-08-12

Status: Approved for implementation

This document supersedes the earlier authentication-tool,
local-secret-recovery, and "no browser UI" design. The existing single-user
Worker, encrypted SQLite Durable Object, and URL-authenticated MCP architecture
remain in place. The released repository intentionally retains only this
current design; obsolete design files remain available through Git history.

## 1. Goal

Make the deployed `grokmcp` Worker independently operable after the temporary
local checkout is permanently deleted. Authentication is a Worker control-plane
operation, while the MCP surface contains only the two search capabilities a
model needs.

The release must:

- keep the existing Grok login and encrypted SQLite token state intact;
- expose only `x_search` and `web_search` as MCP tools;
- add MCP output schemas and matching structured results;
- provide an authenticated Worker-hosted page for login, callback submission,
  status, logout, connection recovery, and operational instructions;
- correct current xAI validation and token-refresh reliability gaps;
- document the security and upgrade boundaries directly in the source;
- use only Cloudflare Workers Free, SQLite Durable Objects Free, and Worker
  secrets;
- preserve a small secret-free source archive, then permanently delete only the
  temporary project directory.

## 2. Runtime Boundaries

The deployment has two deliberately separate interfaces.

### 2.1 MCP data plane

`/t/<MCP_URL_TOKEN>/mcp` is the only MCP route. It authenticates the exact
43-character base64url token before parsing the request and exposes exactly:

- `x_search`
- `web_search`

Login, callback, status, and logout are not MCP tools. A model therefore cannot
initiate authorization, consume a callback, inspect account state, or delete
credentials.

Successful tool calls return both:

- `structuredContent` matching the declared `outputSchema`; and
- an equivalent serialized JSON text content item for clients that render tool
  content to a human, as recommended by the current specification.

The common successful result is:

```json
{
  "ok": true,
  "text": "normalized answer text",
  "citations": ["https://example.com/source"],
  "model": "grok-4.5"
}
```

Expected failures remain MCP tool errors with a stable JSON text payload. They
do not claim to match the successful output schema.

### 2.2 Worker control plane

`/admin/t/<ADMIN_URL_TOKEN>` is a server-rendered administration page protected
by a different 256-bit URL token. Its same-origin forms provide:

- current login state and token expiry time;
- creation of a new Grok authorization attempt;
- the authorization URL and copy/paste instructions;
- bounded submission of the complete localhost callback URL;
- logout with an explicit confirmation step;
- current model, application version, deployed Worker version, OAuth public
  client information, health state, and exposed tool summary;
- the complete protected MCP URL so the owner can recover the ChatGPT
  connection after deleting local files;
- concise Cloudflare Dashboard guidance for changing the model or rotating URL
  tokens, plus a warning that changing the encryption key invalidates stored
  ciphertext.

The page may reveal the MCP connection URL because possession of the separate
administration URL is the higher-privilege recovery credential. It must never
reveal the administration token as a standalone value, the encryption key,
OAuth access or refresh tokens, PKCE material, authorization codes, or raw
database records.

The UI uses no external scripts, fonts, stylesheets, images, or analytics. It is
fully useful with plain HTML forms and does not require a local callback server
or local repository.

## 3. HTTP Routing and Browser Security

The Worker keeps `GET /healthz` as a minimal public endpoint. All other unknown,
missing-token, or wrong-token paths return `404`.

MCP and administration tokens are compared with fixed-shape validation and a
constant-time digest comparison. The tokens are not interchangeable.

Authenticated routes apply the following controls:

- validate the request `Host` against the URL host;
- reject a supplied cross-origin `Origin` header;
- allow administration mutations only through `POST`;
- require `application/x-www-form-urlencoded` for administration forms;
- bound MCP request bodies and administration form bodies before parsing;
- return `Cache-Control: no-store` and `Pragma: no-cache`;
- return `Referrer-Policy: no-referrer`;
- use a restrictive Content Security Policy with no third-party origins;
- deny framing and MIME sniffing;
- never log raw request URLs or form bodies.

The administration token necessarily appears in browser history because URL
authentication was explicitly selected for compatibility. The page tells the
owner to treat both protected URLs as passwords and to rotate a token if it is
shared accidentally.

Cloudflare request observability remains disabled because URL credentials would
otherwise be present in request paths. Application errors remain structured and
redacted. Source maps are uploaded for stack-trace symbolication without
turning on request-log ingestion.

## 4. Durable Object and OAuth Behavior

The existing stable Durable Object name `single-user`, SQLite schema, and
AES-256-GCM record format remain unchanged, so deployment does not require a
token migration or new login.

The Worker administration route invokes the same Durable Object RPC methods
formerly reached through authentication MCP tools:

- `startLogin()`
- `completeLogin(callbackUrl)`
- `getStatus()`
- `logout()`

The OAuth redirect stays `http://127.0.0.1:56121/callback`. After Grok redirects
there, the owner copies the complete address-bar URL into the Worker page.
State, PKCE, ten-minute expiry, callback origin/path validation, single use, and
delete-before-exchange semantics remain mandatory.

Token refresh behavior changes in one important way:

- explicit OAuth rejection such as `invalid_grant` or an authentication 400/401
  clears unusable stored credentials and requests a new login;
- timeouts, discovery failures, malformed temporary upstream responses, 429,
  and 5xx errors preserve encrypted credentials and return a retryable error.

Concurrent refresh deduplication and logout ordering remain in place.

## 5. Search Contract Maintenance

Both search inputs keep the existing query and timeout behavior. Validation is
centralized so the MCP schema and Durable Object checks cannot drift.

`x_search` supports:

- query text up to the existing 8,000-character bound;
- optional `from_date` and `to_date` in real `YYYY-MM-DD` calendar form, with
  `from_date <= to_date`;
- at most 20 allowed X handles or 20 excluded X handles;
- mutual exclusion between allowed and excluded handles;
- optional image-understanding and video-understanding flags supported by the
  current xAI X Search contract.

`web_search` supports:

- the same query bound;
- at most five allowed domains or five excluded domains;
- mutual exclusion between allowed and excluded domains;
- the existing image-search flag;
- the current optional image-understanding flag.

The implementation targets only the current xAI request and raw response
contracts; it does not retain removed field aliases or legacy raw response
fallbacks. No search history is stored. Upstream requests retain the 60-second
timeout and 2 MiB response limit.

## 6. Configuration and Secret Lifecycle

The deployment uses three Worker secrets:

- `MCP_URL_TOKEN`
- `ADMIN_URL_TOKEN`
- `TOKEN_ENCRYPTION_KEY`

The secret helper adds `ADMIN_URL_TOKEN` to an existing two-secret recovery
file without rotating either existing value. It can print the MCP and
administration URLs but never prints the encryption key.

Routine source upgrades intentionally deploy without a secrets file. Cloudflare
validates the three required remote names and preserves their encrypted values;
only a first deployment or deliberate rotation uses `--secrets-file`. This
keeps future archive-based upgrades operable after the temporary recovery file
is deleted and prevents accidental wholesale secret rotation.

`GROK_X_SEARCH_MODEL` remains a normal Worker variable, initially `grok-4.5`.
The public Hermes Agent/Grok CLI OAuth client ID and scope remain centralized
constants with source comments identifying their compatibility role.

The Worker receives a version metadata binding and reports its version ID only
inside the authenticated administration page. An application version constant
is also displayed so a future maintainer can distinguish code releases from
Cloudflare deployment versions.

Changing either URL-token secret rotates only that interface. Changing
`TOKEN_ENCRYPTION_KEY` makes existing OAuth rows undecryptable; the supported
procedure is to replace the key and log in again. Cloudflare secrets are not a
general secret-recovery store, so no endpoint attempts to expose that key.

## 7. Maintenance and Documentation

Comments are required at non-obvious boundaries rather than on self-explanatory
syntax. In particular, source comments explain:

- why authentication is absent from the MCP tool surface;
- why request observability is disabled for path-token routes;
- why the Durable Object owns OAuth and upstream calls;
- SQLite migration and encrypted-record compatibility constraints;
- AES-GCM IV and additional-authenticated-data requirements;
- refresh serialization, permanent-versus-transient failure classification,
  and logout ordering;
- callback validation and replay prevention;
- body-size limits, source-map use, and secrets that must never be logged.

`AGENTS.md` is rewritten for the deployed Worker architecture and no longer
forbids source comments. English, Japanese, and Chinese READMEs document only
the search tools and the Worker administration flow. They include an upgrade
runbook that starts from the sanitized source archive rather than assuming the
temporary checkout still exists.

Dependencies remain pinned to current stable releases. The maintenance release
updates only packages or CI actions found stale in the audit and avoids
unrelated framework changes. The compatibility date remains `2026-08-11`, the
maximum supported by the coherent Wrangler 4.121.0 / vitest-pool 0.21.1 /
Miniflare / workerd release set. A newer standalone workerd was rejected because
the current test pool injects flags that are invalid in that runtime; advance
the date only after Cloudflare publishes the matching complete toolchain.

MCP transport is equally strict: only protocol revision `2026-07-28` is
accepted. Each request must carry its modern `_meta` envelope plus
`MCP-Protocol-Version`, `Mcp-Method`, and (for tool calls) `Mcp-Name` headers.
Responses use JSON mode. Initialize/session-era requests and SSE response mode
are rejected rather than bridged.

## 8. Verification and Deployment

Implementation is test-first and runs in the current session. No local Worker
server or `wrangler dev` deployment is used.

Automated verification covers:

- exact two-tool MCP listing and advertised output schemas;
- matching structured and serialized successful results;
- rejection of all former authentication MCP tool names;
- separate MCP/admin token routing and non-interchangeability;
- administration security headers, method/content-type/origin rules, and form
  body bounds;
- login, callback, status, logout, and escaped HTML output;
- correct X and Web filter limits, mutual exclusion, and date ordering;
- preservation of credentials on transient refresh failure and deletion on
  permanent rejection;
- migration of an existing two-secret local file without token rotation;
- generated bindings, formatting, type checking, all test suites, dependency
  audit, and Wrangler dry-run bundle/source-map limits.

The production deployment reuses the current `MCP_URL_TOKEN`, encryption key,
Durable Object class, and object ID, and adds only `ADMIN_URL_TOKEN`. Remote
acceptance verifies:

1. public health succeeds;
2. missing, wrong, and cross-interface tokens fail closed;
3. MCP lists exactly two tools with output schemas;
4. both live Grok searches return matching structured results using
   `grok-4.5`;
5. the administration page reports the existing logged-in account and complete
   MCP URL;
6. no deployment or smoke-test request produces Worker CPU-limit error 1102.

The release does not intentionally log out or replace the current Grok login.

## 9. Archive and Permanent Cleanup

After production acceptance, create a compact source archive under the
workspace `outputs` directory. It includes source, tests, documentation,
configuration, package manifests, and a checksum/restore note. It excludes:

- `.git` and version-control metadata;
- `node_modules`;
- `.secrets.local` and all secret values;
- Wrangler state, dry-run output, caches, coverage, and generated temporary
  artifacts.

The archive is not required at runtime; it is the small, auditable source of
truth for future code upgrades. Operational login and recovery remain inside
the Worker administration page.

Only after the archive and all live checks pass, permanently delete exactly:

`/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/work/grok-x-search-mcp`

Do not delete the workspace parent, `outputs`, unrelated files, or Cloudflare
state. Permanent deletion is intentional to reclaim disk space and is not
recoverable from the temporary directory.

## 10. Acceptance Criteria

The maintenance release is complete when:

1. the MCP server exposes only the two search tools;
2. both tools advertise and return valid structured outputs plus the current
   specification's recommended equivalent text content;
3. all Grok account operations work from the protected Worker administration
   page without local code;
4. the authenticated page can recover the complete MCP connection URL but no
   cryptographic or OAuth credential is exposed;
5. transient refresh failures do not destroy a valid login;
6. current official xAI limits and input relationships are enforced;
7. source comments and runbooks are sufficient to explain future upgrades;
8. all automated and remote production checks pass on free Cloudflare
   resources;
9. a secret-free compact source archive exists in `outputs`;
10. the exact temporary project directory has been permanently deleted.
