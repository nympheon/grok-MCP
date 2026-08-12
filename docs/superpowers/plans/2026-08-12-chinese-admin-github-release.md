# GrokMCP Chinese Admin and GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Inline execution was explicitly selected by the user; do not dispatch subagents.

**Goal:** Deliver a fully Simplified-Chinese Worker administration page, publish the complete secret-free project to `nympheon/grok-MCP`, connect `main` to the existing `grokmcp` Worker through Workers Builds, and remove every local source backup after recovery verification.

**Architecture:** Keep the MCP data plane, OAuth flow, SQLite Durable Object identity/schema, encryption format, and URL authentication unchanged. Localize only the Worker control plane, use deterministic Beijing-time formatting and error-code mapping at the rendering boundary, then make GitHub `main` the sole source of truth and Cloudflare Workers Builds the routine deployment path.

**Tech Stack:** TypeScript 7, Cloudflare Workers, SQLite Durable Objects, Workers Web Crypto, MCP 2026-07-28, Vitest 4 with `@cloudflare/vitest-pool-workers`, Biome, Wrangler 4, Node.js 22, GitHub Actions, Cloudflare Workers Builds.

## Global Constraints

- All normal user-visible administration text is Simplified Chinese; `Grok`, `MCP`, `OAuth`, `Worker`, URLs, model names, protocol versions, client ID, scope, secret names, and commands remain unchanged.
- Display credential timestamps as `YYYY年MM月DD日 HH:mm:ss（北京时间）`; display missing values as `暂无`.
- Do not change the two MCP tool names, input/output schemas, raw xAI mapping, `GrokState` class, `single-user` Durable Object name, SQLite schema version, AES-GCM record format, or OAuth redirect URI.
- Preserve remote `MCP_URL_TOKEN`, `ADMIN_URL_TOKEN`, `TOKEN_ENCRYPTION_KEY`, and the existing encrypted Grok login. Never commit or print their values.
- Keep the administration page script-free, third-party-resource-free, non-cacheable, non-referring, and non-frameable.
- `main` is the production branch. Workers Builds runs `npm run verify`, then `npm run deploy` without a secrets file.
- The public GitHub repository must contain source, tests, configuration, and complete maintenance documentation, but no local secrets, callback URLs, Wrangler state, dependencies, caches, or generated deployment artifacts.
- After GitHub clone verification and production acceptance, delete the temporary checkout and the three old local archive/handoff files. GitHub becomes the only code backup.

---

### Task 1: Establish the Failing Chinese Administration Contract

**Files:**
- Modify: `test/admin.test.ts`
- Modify: `test-worker/worker.test.ts`

**Interfaces:**
- Consumes: `renderAdminPage(input: AdminPageInput): string`, `adminHtmlResponse(...)`, and the current `/admin/t/<token>` routes.
- Produces: executable acceptance assertions for Chinese HTML, Beijing time, login/callback/logout text, and Chinese administration HTTP errors.

- [ ] **Step 1: Install the exact locked dependencies**

Run `npm ci --cache .npm-cache`. It must use `package-lock.json`, create no `.secrets.local`, and report no known vulnerability.

- [ ] **Step 2: Replace English unit assertions with the Chinese contract**

Add these assertions while retaining all escaping, route action, OAuth-public-data, secret-name, OAuth-secret-absence, CSP, cache, referrer, and frame checks:

```ts
expect(html).toContain('<html lang="zh-CN">');
expect(html).toContain("GrokMCP 管理与登录");
expect(html).toContain("已登录");
expect(html).toContain("2026年08月13日 08:00:00（北京时间）");
expect(html).toContain("开始新的 Grok 登录");
expect(html).toContain("完成浏览器登录");
expect(html).toContain("连接与运行状态");
expect(html).toContain("Cloudflare 运维");
expect(html).toContain("退出 Grok 登录");
expect(html).not.toContain("GrokMCP administration");
expect(html).not.toContain("Start a new Grok login");
expect(html).not.toContain("Signed in");
```

- [ ] **Step 3: Add status and error localization cases**

Cover `已退出`, `已登录`, and `登录已过期`. Add a `LOGIN_EXPIRED` failure and assert `登录请求不存在、已过期或已使用` plus code `LOGIN_EXPIRED`, without rendering its English `error`. Add an `INTERNAL` failure and require its correlation ID.

- [ ] **Step 4: Update Worker-boundary expectations**

Require the actual route to show `已退出`, login to show `打开 Grok 授权页面`, invalid callback to show `提交的回调 URL 无效`, and logout to show `已删除 Grok 登录凭据`. Add direct checks for `请求方法不允许`, `不支持的媒体类型`, `表单格式无效`, and `必须确认退出登录`.

- [ ] **Step 5: Run focused tests and verify RED**

```bash
npx vitest run --config vitest.config.ts test/admin.test.ts
npx vitest run --config vitest.worker.config.ts test-worker/worker.test.ts
```

Expected: assertion failures caused by the existing English UI, not import or runtime errors.

- [ ] **Step 6: Commit only the failing contract**

```bash
git add test/admin.test.ts test-worker/worker.test.ts
git commit -m "test: define Chinese Worker administration contract"
```

---

### Task 2: Implement the Chinese Control Plane

**Files:**
- Modify: `src/admin.ts`
- Modify: `src/worker.ts`
- Modify: `src/constants.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ToolResult<AuthStatus>`, `ToolResult<LoginData>`, `ToolResult<MessageData>`, and `ToolErrorCode`.
- Produces: deterministic Chinese HTML and plain-text administration responses while leaving every MCP and Durable Object interface unchanged.

- [ ] **Step 1: Add deterministic Beijing-time rendering**

Replace `timestamp()` with:

```ts
function timestamp(value: number | null): string {
  if (value === null) return "暂无";
  const date = new Date(value + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(date.valueOf())) return "暂无";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}年${part(date.getUTCMonth() + 1)}月${part(date.getUTCDate())}日 ${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(date.getUTCSeconds())}（北京时间）`;
}
```

- [ ] **Step 2: Localize stable error codes**

Import `ToolErrorCode` and add an exhaustive `satisfies Record<ToolErrorCode, string>` map:

```ts
const adminErrorMessages = {
  NO_AUTH: "尚未登录 Grok。",
  EXPIRED: "Grok 登录已过期，请重新登录。",
  FORBIDDEN_403: "xAI 拒绝了当前请求。",
  RATE_LIMITED: "xAI 请求过于频繁，请稍后重试。",
  UPSTREAM_TIMEOUT: "上游服务响应超时，请稍后重试。",
  UPSTREAM_TOO_LARGE: "上游响应超过安全大小限制。",
  UPSTREAM_ERROR: "上游服务暂时不可用，请稍后重试。",
  HTTP_ERROR: "请求处理失败。",
  STATE_MISMATCH: "登录状态校验失败，请重新开始登录。",
  LOGIN_EXPIRED: "登录请求不存在、已过期或已使用，请重新开始登录。",
  BAD_REQUEST: "提交的回调 URL 无效，请复制完整的 localhost 回调地址。",
  INTERNAL: "Worker 内部错误，请使用下方参考编号排查。",
} satisfies Record<ToolErrorCode, string>;
```

Render only the stable Chinese message, code, and optional correlation ID; never render raw upstream/admin error strings.

- [ ] **Step 3: Translate the complete HTML surface**

Use `lang="zh-CN"` and these primary labels: `GrokMCP 管理与登录`, `账号状态`, `开始新的 Grok 登录`, `完成浏览器登录`, `连接与运行状态`, `OAuth 兼容信息`, `Cloudflare 运维`, and `退出 Grok 登录`. Translate every other visible instruction and warning while preserving technical identifiers. Ignore `login.message` and render a fixed Chinese ten-minute instruction.

- [ ] **Step 4: Translate administration responses and success notices**

In `src/worker.ts`, translate only control-plane strings: `禁止访问`, `请求方法不允许`, `请求体过大`, `不支持的媒体类型`, `表单格式无效`, `必须确认退出登录`, and Worker-version fallback `暂无`. Wrap successful callback/logout results as `Grok 登录成功。` and `已删除 Grok 登录凭据和待处理的登录请求。`; preserve failure codes for `admin.ts`.

- [ ] **Step 5: Bump release metadata to `0.3.0`**

Set both `APP_VERSION` and the npm package version to `0.3.0`, then run `npm install --package-lock-only --ignore-scripts` to update lockfile metadata only.

- [ ] **Step 6: Verify GREEN and full regression**

```bash
npx vitest run --config vitest.config.ts test/admin.test.ts
npx vitest run --config vitest.worker.config.ts test-worker/worker.test.ts
npm test
```

Expected: all focused and full tests pass with zero failures.

- [ ] **Step 7: Commit implementation**

```bash
git add src/admin.ts src/worker.ts src/constants.ts package.json package-lock.json
git commit -m "feat: localize Worker administration in Chinese"
```

---

### Task 3: Make GitHub the Complete Maintenance Source

**Files:**
- Create: `.node-version`
- Create: `SECURITY.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.zh.md`
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: existing scripts, Worker configuration, current search limits, and the GitHub/Workers Builds contract.
- Produces: one `npm run verify` gate shared by local work, GitHub Actions, and Workers Builds plus complete clone-first operations documentation.

- [ ] **Step 1: Add shared verification and Node version**

Add `"verify": "npm run types && npm run check && npm run typecheck && npm test && npm run deploy:dry"` to `package.json`. Create `.node-version` containing `22`. Replace separate CI type/check/test/dry steps with `npm run verify`, retain `npm ci`, and run `npm audit --audit-level=low` after verification.

- [ ] **Step 2: Rewrite the Chinese primary documentation**

`README.zh.md` must contain: project scope; architecture/data flow; supported and unsupported behavior; MCP parameter mapping and limits; free-resource boundary; first deployment; Chinese admin/login; ChatGPT connection; GitHub Actions/Workers Builds; model changes; ordinary upgrade; secret rotation; rollback; troubleshooting; security; GitHub recovery; license/disclaimer.

Document that X Search has no `max_results`, returns synthesized text/citations rather than raw post pages, and cannot guarantee a fixed inspected-post count. Include 8,000 characters, 20 handles, 5 domains, 60 seconds, 2 MiB, and 128 KiB. Replace archive recovery with:

```bash
git clone git@github.com:nympheon/grok-MCP.git
cd grok-MCP
npm ci
npm run verify
```

Document Workers Builds settings: branch `main`, root `/`, build `npm run verify`, deploy `npm run deploy`.

- [ ] **Step 3: Synchronize English and Japanese documentation**

Update `README.md` and `README.ja.md` with the Chinese Worker UI, GitHub recovery, shared verification, automatic secret-preserving Workers Builds deployment, X/Web parameter mapping, and absence of a deterministic post count.

- [ ] **Step 4: Rewrite maintainer guidance and add security policy**

Update `AGENTS.md` so GitHub `main` is canonical, Workers Builds is routine deployment, `npm run verify` is mandatory, and archive maintenance is removed. Preserve auth/crypto/DO/MCP/observability warnings. Create `SECURITY.md` for supported `0.3.x`, GitHub Security Advisories, forbidden secret disclosures, targeted URL-token rotation, and mandatory re-login after encryption-key rotation.

- [ ] **Step 5: Validate docs and automation**

```bash
rg -n "source archive|源码归档|source-archive|Start a new Grok login|Signed in" README.md README.zh.md README.ja.md AGENTS.md SECURITY.md
npm run check
```

Expected: no obsolete archive workflow or old English Chinese-UI labels remain in current instructions; Biome passes.

- [ ] **Step 6: Commit documentation and CI**

```bash
git add .node-version SECURITY.md package.json .github/workflows/ci.yml README.md README.zh.md README.ja.md AGENTS.md
git commit -m "docs: make GitHub the complete deployment source"
```

---

### Task 4: Run Release Gates and Audit the Public Diff

**Files:**
- Verify: every tracked file
- Modify only if deterministic: `worker-configuration.d.ts`

**Interfaces:**
- Consumes: finished implementation and documentation.
- Produces: fresh evidence that the repository is safe, reproducible, and deployable without local runtime secrets.

- [ ] **Step 1: Retrieve current Cloudflare references**

Read the current Workers best-practices documentation and fetch the latest published `@cloudflare/workers-types` into a disposable directory. Compare only APIs used by `src/worker.ts` and `src/grokState.ts`; do not update pinned dependencies without an actual incompatibility.

- [ ] **Step 2: Run all release gates**

```bash
npm run verify
npm audit --audit-level=low --cache .npm-cache
```

Expected: Biome and TypeScript succeed, all tests pass, audit reports zero vulnerabilities, and Wrangler dry-run remains within the Workers Free script limit.

- [ ] **Step 3: Inspect the complete change**

```bash
git status -sb
git diff --check
git diff HEAD~3..HEAD --stat
git log --oneline --decorate -8
```

Review full `src/admin.ts`, `src/worker.ts`, `wrangler.jsonc`, `package.json`, CI, and all READMEs. Confirm no unrelated protocol, OAuth, storage, or search behavior changed.

- [ ] **Step 4: Scan worktree and history for forbidden material**

Search tracked files and commit patches for `.secrets.local`, actual protected URL tokens, OAuth credential values, callback query values, `.wrangler`, `node_modules`, `.npm-cache`, and private-key markers. Expected matches are only explanatory field names or explicit synthetic test fixtures.

- [ ] **Step 5: Handle generated bindings**

If `npm run types` changes `worker-configuration.d.ts`, inspect and commit only that deterministic diff as `chore: refresh Worker binding types`. Otherwise require a clean tree without an empty generated-file commit.

---

### Task 5: Publish the Complete Project to GitHub

**Files:**
- Publish: the full tracked repository

**Interfaces:**
- Consumes: clean verified `main` and `git@github.com:nympheon/grok-MCP.git`.
- Produces: public canonical repository with CI, description, topics, and exact release commit.

- [ ] **Step 1: Confirm scope and remote**

```bash
git status -sb
git remote -v
gh repo view nympheon/grok-MCP --json nameWithOwner,isEmpty,isPrivate,viewerPermission,defaultBranchRef
```

Expected: clean `main`, requested SSH remote, public empty repository, ADMIN permission.

- [ ] **Step 2: Push initial complete `main`**

Run `git push -u origin main`. The remote must point at the locally verified HEAD. A PR is intentionally omitted because the user requested first publication into an empty repository.

- [ ] **Step 3: Configure repository metadata**

Set a concise description, homepage `https://grokmcp.aemeath.workers.dev/healthz`, issues enabled, and topics `cloudflare-workers`, `mcp`, `grok`, `xai`, `durable-objects`, `chatgpt` with `gh repo edit`.

- [ ] **Step 4: Verify Actions and remote contents**

Use `gh run list` and `gh run watch <run-id> --exit-status`. Verify `README.zh.md`, `SECURITY.md`, `wrangler.jsonc`, source, tests, and workflow through `gh api`; confirm ignored paths are absent.

---

### Task 6: Connect Workers Builds and Prove Automatic Deployment

**Files:**
- No source file for connection settings
- Create: one intentional empty Git commit

**Interfaces:**
- Consumes: GitHub `main`, existing Worker `grokmcp`, current remote secrets and Durable Object.
- Produces: future `main` pushes verify and deploy while retaining all secrets and state.

- [ ] **Step 1: Connect the existing Worker**

Open Cloudflare Dashboard `Workers & Pages → grokmcp → Settings → Builds → Connect`, choose `nympheon/grok-MCP`, and configure:

```text
Production branch: main
Root directory: /
Build command: npm run verify
Deploy command: npm run deploy
```

Grant the Cloudflare GitHub App only required repository access. If a first-time authorization page requires user confirmation, pause there and continue after approval.

- [ ] **Step 2: Trigger the first connected build**

```bash
git commit --allow-empty -m "ci: verify Cloudflare Workers Builds"
git push
```

Expected: GitHub Actions and Workers Builds start for the same commit.

- [ ] **Step 3: Require both pipelines to pass**

GitHub Actions must succeed. Cloudflare Builds must install dependencies, run `npm run verify`, then run `npm run deploy`. Record the new Worker version and immediate rollback version.

- [ ] **Step 4: Verify secret and deployment state**

Use Cloudflare API to confirm the required secret names remain without requesting values. Confirm the new deployment receives 100% traffic and `GrokState` remains attached.

- [ ] **Step 5: Run production acceptance**

Verify all of:

```text
GET /healthz -> 200
wrong, missing, and cross-interface tokens -> 404
admin -> lang zh-CN, Chinese headings, 已登录, grok-4.5, recoverable MCP URL
admin -> no encryption key or OAuth credential value
legacy MCP request -> 400
tools/list -> exactly x_search and web_search, both with outputSchema
x_search -> successful matching structured/text result
web_search -> successful matching structured/text result with citations
```

Confirm the existing Grok login remains active and no secret rotation or Durable Object migration occurred.

---

### Task 7: Prove GitHub Recovery and Remove All Local Backups

**Files:**
- Delete: `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/work/grok-MCP`
- Delete: `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-source-2026-08-12.tar.gz`
- Delete: `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-source-2026-08-12.sha256`
- Delete: `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/outputs/grokmcp-worker-handoff.md`

**Interfaces:**
- Consumes: public GitHub `main`, successful Workers Builds deployment, production acceptance.
- Produces: GitHub-only recovery with no local project backup.

- [ ] **Step 1: Clone GitHub into a disposable exact path**

Create `mktemp -d /private/tmp/grokmcp-github-check.XXXXXX`, clone the SSH repository, and require clone HEAD to equal remote `main` and the deployed build commit.

- [ ] **Step 2: Run the complete recovery gate**

```bash
npm ci --cache .npm-cache
npm run verify
npm audit --audit-level=low --cache .npm-cache
```

Expected: install, generated types, Biome, TypeScript, all tests, dry deploy, and audit pass without `.secrets.local`.

- [ ] **Step 3: Scan and remove the disposable clone**

Confirm no protected token, OAuth credential, callback code/state, `.secrets.local`, Wrangler state, dependency directory, or cache is tracked. Resolve the clone `realpath`, require prefix `/private/tmp/grokmcp-github-check.`, delete only that directory, and confirm absence.

- [ ] **Step 4: Verify permanent deletion targets**

Require the worktree realpath to equal `/Users/qiaofanxing/Documents/Codex/2026-08-12/new-chat-2/work/grok-MCP`, confirm `.git`, `package.json`, and the requested origin, and confirm the three exact `outputs` files exist. Reconfirm GitHub and production health immediately before deletion.

- [ ] **Step 5: Permanently delete local code and archives**

Delete only the four exact targets above. Do not delete the `work` or `outputs` parent, unrelated workspace files, Cloudflare state, or GitHub state.

- [ ] **Step 6: Perform final remote-only verification**

Confirm all four local targets are absent, GitHub `main` remains readable with the recorded commit and files, Cloudflare still routes the recorded version, and `GET https://grokmcp.aemeath.workers.dev/healthz` returns `200`.
