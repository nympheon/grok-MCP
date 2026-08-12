# GrokMCP Worker Admin and Search-Only Maintenance Implementation Plan

> **For Codex:** REQUIRED SUB-SKILLS: Use `superpowers:test-driven-development`
> for behavior changes, `superpowers:executing-plans` for checkpointed execution,
> and `superpowers:verification-before-completion` before claiming success.
> Execute inline in this session; do not create subagents and do not run
> `wrangler dev`.

**Goal:** Ship a search-only MCP data plane and a separate URL-authenticated
Worker administration page, preserve the existing Grok login, deploy it to the
owner's free Cloudflare account, archive a secret-free source copy, and delete
the exact temporary checkout.

**Architecture:** The stateless Worker authenticates either the MCP path or the
administration path before parsing a body. The MCP server registers only two
search tools and returns schema-validated structured output. Server-rendered
administration forms call the existing single `GrokState` SQLite Durable Object
for login/status/logout operations. The Durable Object continues to own all
OAuth secrets, token encryption, refresh serialization, and xAI network calls.

**Tech Stack:** TypeScript 7, Cloudflare Workers/workerd, SQLite Durable Objects,
MCP TypeScript SDK 2, Zod 4, Web Crypto, Wrangler 4, Vitest 4, Biome 2, Node 22.

**Approved constraints:** Keep service name `grokmcp`, model variable
`GROK_X_SEARCH_MODEL=grok-4.5`, stable Durable Object ID `single-user`, current
OAuth client compatibility constants, free Cloudflare resources, URL-token
authentication, and the existing encrypted database. Never print or archive
OAuth tokens or `TOKEN_ENCRYPTION_KEY`.

---

## Task 1: Record the baseline and add failing secret/route tests

**Files:**

- Modify: `test/urlAuth.test.ts`
- Modify: `test-node/secrets.test.mjs`
- Modify: `scripts/secrets.mjs`
- Modify: `src/urlAuth.ts`

- [ ] Run the current baseline and preserve its output in the task log:

  ```bash
  npm test
  npm run typecheck
  npm run check
  ```

- [ ] Add failing unit tests for exact 43-character MCP and administration
  paths, malformed percent encoding, token non-interchangeability, and unknown
  administration actions.
- [ ] Add failing Node tests showing that `ensureSecrets()` migrates an existing
  two-key file by adding `ADMIN_URL_TOKEN` without changing either existing
  value, keeps mode `0600`, builds both protected URLs, rejects unknown keys, and
  never prints the encryption key.
- [ ] Run only those tests and confirm the intended failures:

  ```bash
  npx vitest run --config vitest.config.ts test/urlAuth.test.ts
  node --test test-node/secrets.test.mjs
  ```

- [ ] Implement exact path parsing and constant-time token checks in
  `src/urlAuth.ts`. Add migration-safe three-secret handling plus MCP/admin URL
  CLI output in `scripts/secrets.mjs`.
- [ ] Re-run both focused suites and make them pass.
- [ ] Commit:

  ```bash
  git add src/urlAuth.ts scripts/secrets.mjs test/urlAuth.test.ts test-node/secrets.test.mjs
  git commit -m "feat: separate Worker admin URL authentication"
  ```

## Task 2: Build and test the server-rendered administration page

**Files:**

- Create: `src/admin.ts`
- Create: `test/admin.test.ts`
- Modify: `src/constants.ts`

- [ ] Add failing pure unit tests for HTML escaping, security headers, status
  rendering, complete MCP URL recovery, authorization-link rendering, safe
  public error rendering, and the absence of OAuth/encryption values.
- [ ] Run and confirm failure because `src/admin.ts` does not exist:

  ```bash
  npx vitest run --config vitest.config.ts test/admin.test.ts
  ```

- [ ] Implement a dependency-free HTML renderer with `APP_VERSION`, bounded
  public messages, localized timestamps, no external assets, and forms for
  start-login, callback submission, and confirmed logout.
- [ ] Apply `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy:
  no-referrer`, restrictive CSP, frame denial, and MIME-sniffing protection to
  every administration response.
- [ ] Keep styles inline under the explicit CSP exception and escape every
  dynamic value before insertion.
- [ ] Re-run the focused tests and commit:

  ```bash
  git add src/admin.ts src/constants.ts test/admin.test.ts
  git commit -m "feat: render secure Worker administration page"
  ```

## Task 3: Route Worker administration actions and bound request bodies

**Files:**

- Modify: `src/worker.ts`
- Modify: `test-worker/worker.test.ts`
- Modify: `vitest.worker.config.ts` if a version-metadata test binding is needed

- [ ] Add failing Worker tests for:
  - admin GET status;
  - wrong/admin-as-MCP/MCP-as-admin tokens returning `404`;
  - same-origin login, callback, and confirmed logout POSTs;
  - cross-origin, wrong method, wrong content type, oversized form, and malformed
    form rejection;
  - full MCP URL visibility only after admin authentication;
  - MCP request rejection above its configured body limit.
- [ ] Run the Worker suite and confirm failures:

  ```bash
  npm run test:worker -- --run test-worker/worker.test.ts
  ```

- [ ] Refactor `src/worker.ts` into an explicit router that authenticates before
  body parsing, shares Host/Origin validation, reads bounded bodies, reconstructs
  the MCP request, and calls `GrokState` directly for admin actions.
- [ ] Keep `GET /healthz` minimal, return `404` for unknown protected paths, and
  return safe HTML errors without redirecting secrets into query strings.
- [ ] Re-run the focused Worker tests and commit:

  ```bash
  git add src/worker.ts test-worker/worker.test.ts vitest.worker.config.ts
  git commit -m "feat: host Grok authentication in the Worker"
  ```

## Task 4: Expose only schema-described search tools

**Files:**

- Modify: `src/mcp.ts`
- Modify: `src/types.ts`
- Modify: `test-worker/worker.test.ts`

- [ ] Add failing Worker assertions that `tools/list` returns exactly
  `x_search` and `web_search`, both contain an `outputSchema`, and former auth
  tool calls fail as unknown tools without touching the Durable Object.
- [ ] Add a mocked successful search assertion that the result contains matching
  `structuredContent` and serialized JSON text.
- [ ] Run the focused test and confirm failure.
- [ ] Remove all four authentication tool registrations. Add a shared successful
  output Zod schema, return `structuredContent` for successes, include the
  current specification's recommended equivalent JSON text, and keep expected
  failures as `isError` text results.
- [ ] Update login-required messages to direct the owner to the Worker admin
  page rather than a removed MCP tool.
- [ ] Re-run the Worker tests and commit:

  ```bash
  git add src/mcp.ts src/types.ts test-worker/worker.test.ts
  git commit -m "feat: expose structured search-only MCP tools"
  ```

## Task 5: Synchronize current xAI search validation and capabilities

**Files:**

- Modify: `src/constants.ts`
- Modify: `src/types.ts`
- Modify: `src/mcp.ts`
- Modify: `src/xaiClient.ts`
- Modify: `test/xaiClient.test.ts`
- Modify: `test-worker/worker.test.ts`

- [ ] Add failing tests for 20 X handles, rejection of a 21st handle, the five
  domain limit, allowed/excluded mutual exclusion, impossible calendar dates,
  `from_date > to_date`, and the current image/video understanding flags.
- [ ] Confirm failures in the unit and Worker suites.
- [ ] Replace the shared filter limit with separate X-handle and Web-domain
  constants. Centralize date and mutual-exclusion checks so MCP and Durable
  Object validation use the same limits and relationships.
- [ ] Map optional `enable_image_understanding` and X-only
  `enable_video_understanding` to the current xAI request shape while preserving
  existing fields and defaults.
- [ ] Run focused tests and commit:

  ```bash
  git add src/constants.ts src/types.ts src/mcp.ts src/xaiClient.ts test/xaiClient.test.ts test-worker/worker.test.ts
  git commit -m "fix: align search contracts with current xAI limits"
  ```

## Task 6: Preserve credentials across transient refresh failures

**Files:**

- Modify: `src/types.ts`
- Modify: `src/oauth.ts`
- Modify: `src/grokState.ts`
- Modify: `test/oauth.test.ts`
- Modify: `test-worker/refresh.test.ts`

- [ ] Add failing OAuth tests that distinguish permanent refresh rejection
  (`invalid_grant`/authentication rejection) from timeout, discovery failure,
  429, malformed success, and 5xx failures.
- [ ] Add failing Durable Object tests proving permanent rejection deletes the
  token row while transient failures preserve the encrypted row and return a
  retryable public error.
- [ ] Run the two focused suites and confirm failures.
- [ ] Add a non-secret-bearing error classification from `postToken()` and use
  it in `getValidTokens()` to delete credentials only after explicit permanent
  rejection. Keep refresh deduplication and queued logout behavior unchanged.
- [ ] Replace all removed-tool guidance with administration-page guidance.
- [ ] Re-run focused tests and commit:

  ```bash
  git add src/types.ts src/oauth.ts src/grokState.ts test/oauth.test.ts test-worker/refresh.test.ts
  git commit -m "fix: retain Grok login on transient refresh errors"
  ```

## Task 7: Update configuration, dependencies, CI, comments, and runbooks

**Files:**

- Modify: `wrangler.jsonc`
- Regenerate: `worker-configuration.d.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `README.zh.md`
- Modify: relevant `src/*.ts` files for boundary comments

- [ ] Require `ADMIN_URL_TOKEN`, add the Worker version-metadata binding, enable
  source-map upload, and document why observability remains disabled. Use the
  newest compatibility date supported by the complete pinned Cloudflare
  toolchain; keep `2026-08-11` if the same-day runtime lacks matching
  Miniflare/vitest-pool support.
- [ ] Update only the audited stale stable dependencies and lockfile entries;
  keep Node 22 compatibility. Change CI to the current official
  `actions/checkout@v6` and `actions/setup-node@v7` pairing.
- [ ] Configure the MCP SDK for revision `2026-07-28` only (`legacy: "reject"`,
  JSON response mode), update Worker tests to use the required per-request
  envelope/headers, and prove an initialize/session-era request is rejected.
- [ ] Parse only the current raw xAI Responses `output[].content[]` structure;
  reject the removed top-level `output_text` fallback while retaining the
  current top-level `citations` field.
- [ ] Run `npm run types` and adjust typed bindings without manual drift.
- [ ] Rewrite `AGENTS.md` for the Worker/SQLite architecture and replace the
  stale no-comment rule with the approved boundary-comment policy.
- [ ] Rewrite all three READMEs together: only two MCP tools, Worker admin login,
  three-secret lifecycle, model changes, source archive restore/deploy, token
  rotation, encryption-key warning, free-plan boundaries, and unofficial OAuth
  compatibility risk.
- [ ] Remove superseded design/plan files so a restored source archive contains
  only the current strict-latest architecture; Git history remains the archive
  for prior decisions.
- [ ] Add concise explanatory comments at crypto, OAuth, SQLite, refresh,
  request-routing, schema, and log-redaction boundaries. Do not comment trivial
  syntax or include secret values.
- [ ] Make ordinary `deploy`/dry-run commands independent of local secret files
  so restored archives preserve Cloudflare's existing secrets. Keep an explicit
  `deploy:with-secrets` command only for first deployment or intentional
  rotation, and test this package-script boundary.
- [ ] Run formatting and focused documentation/config checks, then commit:

  ```bash
  npm run format
  npm run types
  git diff --check
  git add AGENTS.md README.md README.ja.md README.zh.md package.json package-lock.json wrangler.jsonc worker-configuration.d.ts .github/workflows/ci.yml src test test-worker scripts test-node
  git commit -m "docs: make deployed Worker independently maintainable"
  ```

## Task 8: Run the complete local verification gate

**Files:** No intended source changes; fix only evidence-backed failures.

- [ ] Run from a clean dependency state where practical, using the project-local
  npm cache to avoid the unrelated system-cache ownership issue:

  ```bash
  npm ci --cache .npm-cache
  npm run types
  npm run check
  npm run typecheck
  npm test
  npm audit --audit-level=low --cache .npm-cache
  npm run deploy:dry
  git diff --check
  git status --short
  ```

- [ ] Inspect the dry-run bundle and source map sizes, confirm uploaded source
  maps remain below Cloudflare's limit, and scan generated output for accidental
  secret-file inclusion.
- [ ] Review the complete diff against the approved design, then commit any
  narrowly required verification fixes separately.

## Task 9: Preserve production state, deploy, and run remote acceptance

**Files:**

- Modify locally ignored: `.secrets.local` only through `scripts/secrets.mjs`
- Produce temporary remote-test output without storing credentials

- [ ] Query the active Worker deployment and authenticated admin-independent
  state needed for a before/after comparison without printing secret values.
- [ ] Run `npm run secrets:init`; assert the current MCP token and encryption key
  did not change and a new independent admin token was added.
- [ ] Deploy through the locked project Wrangler using `.secrets.local`. Preserve
  the service name, Durable Object binding/class, migration tag, and stable
  object name.
- [ ] Verify remotely:
  - `/healthz` succeeds;
  - absent/wrong/cross-interface tokens return `404`;
  - the administration page reports the existing logged-in state, model, Worker
    version, and recoverable complete MCP URL;
  - MCP lists exactly two tools with output schemas;
  - MCP requests use the required `2026-07-28` envelope and standard headers;
  - live `x_search` and `web_search` return matching structured/text results on
    `grok-4.5`;
  - no login/logout is triggered and no test output contains OAuth or encryption
    secrets.
- [ ] Record the deployed version ID and retain the immediately previous version
  ID for Cloudflare rollback. Do not enable request observability.

## Task 10: Create the deliverable archive and delete the temporary checkout

**Files:**

- Create:
  `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-source-2026-08-12.tar.gz`
- Create:
  `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-source-2026-08-12.sha256`
- Create:
  `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-handoff.md`
- Permanently delete only:
  `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/work/grok-x-search-mcp`

- [ ] Ensure all source changes are committed and the worktree is clean.
- [ ] Create a deterministic source archive excluding `.git`, `node_modules`,
  `.secrets.local`, `.wrangler*`, `.npm-cache`, dry-run output, coverage, OS
  metadata, and every generated secret value.
- [ ] Generate a SHA-256 checksum and a handoff document containing restore,
  install, test, deploy, login, model-change, token-rotation, and rollback
  instructions. The handoff may link to the protected URLs in chat but must not
  embed any secret token or encryption key in the archive.
- [ ] Extract the archive into a fresh temporary directory and run a manifest
  scan proving required source/config/docs exist and excluded material does not.
- [ ] Re-run minimal remote health, admin-status, tool-list, and one search check
  immediately before cleanup.
- [ ] Resolve the deletion target to the exact approved path, verify it contains
  this repository, then permanently delete that directory only.
- [ ] Confirm the temporary checkout no longer exists and all three deliverables
  still exist under `outputs`.

## Final Completion Evidence

Report only after `superpowers:verification-before-completion` confirms:

- full local verification output from Task 8;
- deployed version and rollback version IDs;
- remote search/admin/MCP acceptance results;
- final MCP and administration URLs, treated as passwords;
- archive/checksum/handoff paths and archive verification;
- exact deleted directory and its non-recoverable status;
- confirmation that the Worker and encrypted SQLite Durable Object continue to
  operate independently of the deleted checkout.
