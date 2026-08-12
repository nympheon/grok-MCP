import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAdminUrl, buildMcpUrl, ensureSecrets, readSecrets } from "../scripts/secrets.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/secrets.mjs", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
let temporaryDirectory;
let secretsPath;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "grokmcp-secrets-"));
  secretsPath = join(temporaryDirectory, ".secrets.local");
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("init creates three recoverable 256-bit secrets with mode 0600", () => {
  ensureSecrets(secretsPath);
  const values = readSecrets(secretsPath);

  assert.equal(Buffer.from(values.MCP_URL_TOKEN, "base64url").length, 32);
  assert.equal(Buffer.from(values.ADMIN_URL_TOKEN, "base64url").length, 32);
  assert.equal(Buffer.from(values.TOKEN_ENCRYPTION_KEY, "base64").length, 32);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
  assert.match(
    readFileSync(secretsPath, "utf8"),
    /^MCP_URL_TOKEN="[A-Za-z0-9_-]{43}"\nADMIN_URL_TOKEN="[A-Za-z0-9_-]{43}"\nTOKEN_ENCRYPTION_KEY="[A-Za-z0-9+/]{43}="\n$/,
  );
});

test("init adds an admin token without rotating a legacy two-secret file", () => {
  const mcpToken = "A".repeat(43);
  const encryptionKey = `${"A".repeat(43)}=`;
  writeFileSync(
    secretsPath,
    `MCP_URL_TOKEN="${mcpToken}"\nTOKEN_ENCRYPTION_KEY="${encryptionKey}"\n`,
    { mode: 0o644 },
  );

  const values = ensureSecrets(secretsPath);

  assert.equal(values.MCP_URL_TOKEN, mcpToken);
  assert.equal(values.TOKEN_ENCRYPTION_KEY, encryptionKey);
  assert.equal(Buffer.from(values.ADMIN_URL_TOKEN, "base64url").length, 32);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
});

test("init preserves existing values and restores mode 0600", () => {
  ensureSecrets(secretsPath);
  const first = readSecrets(secretsPath);
  chmodSync(secretsPath, 0o644);

  ensureSecrets(secretsPath);

  assert.deepEqual(readSecrets(secretsPath), first);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
});

test("url builds the protected endpoint from the recoverable token", () => {
  ensureSecrets(secretsPath);
  const values = readSecrets(secretsPath);

  assert.equal(
    buildMcpUrl("https://grokmcp.example.workers.dev", values.MCP_URL_TOKEN),
    `https://grokmcp.example.workers.dev/t/${values.MCP_URL_TOKEN}/mcp`,
  );
  assert.equal(
    buildAdminUrl("https://grokmcp.example.workers.dev", values.ADMIN_URL_TOKEN),
    `https://grokmcp.example.workers.dev/admin/t/${values.ADMIN_URL_TOKEN}`,
  );
});

test("read rejects unknown, duplicate, missing, or malformed dotenv entries", () => {
  const invalidFiles = [
    'MCP_URL_TOKEN="abc"\nADMIN_URL_TOKEN="abc"\nTOKEN_ENCRYPTION_KEY="abc"\n',
    'MCP_URL_TOKEN="one"\nMCP_URL_TOKEN="two"\nADMIN_URL_TOKEN="abc"\nTOKEN_ENCRYPTION_KEY="abc"\n',
    'MCP_URL_TOKEN="abc"\nADMIN_URL_TOKEN="abc"\nUNKNOWN="value"\nTOKEN_ENCRYPTION_KEY="abc"\n',
    'MCP_URL_TOKEN="abc"\n',
    `MCP_URL_TOKEN="${"A".repeat(43)}"\nTOKEN_ENCRYPTION_KEY="${"A".repeat(43)}="\n`,
  ];

  for (const [index, contents] of invalidFiles.entries()) {
    const path = join(temporaryDirectory, `.invalid-${index}`);
    writeFileSync(path, contents, { mode: 0o600 });
    assert.throws(() => readSecrets(path));
  }
});

test("CLI init hides all values and URL commands disclose only their own URL token", () => {
  const initialized = spawnSync(process.execPath, [scriptPath, "init", secretsPath], {
    cwd: dirname(scriptPath),
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const values = readSecrets(secretsPath);
  assert.equal(initialized.stdout.includes(values.MCP_URL_TOKEN), false);
  assert.equal(initialized.stdout.includes(values.ADMIN_URL_TOKEN), false);
  assert.equal(initialized.stdout.includes(values.TOKEN_ENCRYPTION_KEY), false);

  const printed = spawnSync(
    process.execPath,
    [scriptPath, "url", "https://grokmcp.example.workers.dev", secretsPath],
    { cwd: dirname(scriptPath), encoding: "utf8" },
  );
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(
    printed.stdout.trim(),
    `https://grokmcp.example.workers.dev/t/${values.MCP_URL_TOKEN}/mcp`,
  );
  assert.equal(printed.stdout.includes(values.ADMIN_URL_TOKEN), false);
  assert.equal(printed.stdout.includes(values.TOKEN_ENCRYPTION_KEY), false);

  const adminPrinted = spawnSync(
    process.execPath,
    [scriptPath, "admin-url", "https://grokmcp.example.workers.dev", secretsPath],
    { cwd: dirname(scriptPath), encoding: "utf8" },
  );
  assert.equal(adminPrinted.status, 0, adminPrinted.stderr);
  assert.equal(
    adminPrinted.stdout.trim(),
    `https://grokmcp.example.workers.dev/admin/t/${values.ADMIN_URL_TOKEN}`,
  );
  assert.equal(adminPrinted.stdout.includes(values.MCP_URL_TOKEN), false);
  assert.equal(adminPrinted.stdout.includes(values.TOKEN_ENCRYPTION_KEY), false);
});

test("normal upgrades preserve remote secrets and explicit rotation is a separate command", () => {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

  assert.equal(packageJson.scripts.deploy.includes("--secrets-file"), false);
  assert.equal(packageJson.scripts["deploy:dry"].includes("--secrets-file"), false);
  assert.equal(packageJson.scripts["deploy:with-secrets"].includes("--secrets-file"), true);
});
