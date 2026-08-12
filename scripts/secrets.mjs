import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const urlTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const encryptionKeyPattern = /^[A-Za-z0-9+/]{43}=$/;
const dotenvLinePattern = /^(MCP_URL_TOKEN|ADMIN_URL_TOKEN|TOKEN_ENCRYPTION_KEY)="([^"\r\n]*)"$/;

function missingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateUrlToken(value, name) {
  if (
    !urlTokenPattern.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error(`${name} must be canonical base64url encoding of 32 bytes`);
  }
}

function validateEncryptionKey(value) {
  if (
    !encryptionKeyPattern.test(value) ||
    Buffer.from(value, "base64").length !== 32 ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be canonical base64 encoding of 32 bytes");
  }
}

function requireRegularFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Secrets path must be a regular file: ${path}`);
  }
}

function parseSecrets(filePath, allowLegacy) {
  const path = resolve(filePath);
  requireRegularFile(path);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const values = {};
  for (const line of lines) {
    const match = dotenvLinePattern.exec(line);
    if (!match) throw new Error(`Malformed secrets file: ${path}`);
    const [, key, value] = match;
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate ${key} in secrets file`);
    values[key] = value;
  }
  if (
    !Object.hasOwn(values, "MCP_URL_TOKEN") ||
    !Object.hasOwn(values, "TOKEN_ENCRYPTION_KEY") ||
    (!allowLegacy && !Object.hasOwn(values, "ADMIN_URL_TOKEN"))
  ) {
    throw new Error(`Secrets file is missing a required key: ${path}`);
  }
  const expectedCount = allowLegacy && !Object.hasOwn(values, "ADMIN_URL_TOKEN") ? 2 : 3;
  if (Object.keys(values).length !== expectedCount) {
    throw new Error(`Unexpected secrets entry: ${path}`);
  }
  validateUrlToken(values.MCP_URL_TOKEN, "MCP_URL_TOKEN");
  if (Object.hasOwn(values, "ADMIN_URL_TOKEN")) {
    validateUrlToken(values.ADMIN_URL_TOKEN, "ADMIN_URL_TOKEN");
  }
  validateEncryptionKey(values.TOKEN_ENCRYPTION_KEY);
  return {
    MCP_URL_TOKEN: values.MCP_URL_TOKEN,
    ADMIN_URL_TOKEN: values.ADMIN_URL_TOKEN,
    TOKEN_ENCRYPTION_KEY: values.TOKEN_ENCRYPTION_KEY,
  };
}

export function readSecrets(filePath = ".secrets.local") {
  return parseSecrets(resolve(filePath), false);
}

function writeSecrets(path, values) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const contents = [
    `MCP_URL_TOKEN="${values.MCP_URL_TOKEN}"`,
    `ADMIN_URL_TOKEN="${values.ADMIN_URL_TOKEN}"`,
    `TOKEN_ENCRYPTION_KEY="${values.TOKEN_ENCRYPTION_KEY}"`,
  ]
    .join("\n")
    .concat("\n");
  // Write a new mode-0600 inode and atomically rename it into place so an
  // interrupted command cannot leave a partial recovery file.
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

export function ensureSecrets(filePath = ".secrets.local") {
  const path = resolve(filePath);
  try {
    requireRegularFile(path);
    const values = parseSecrets(path, true);
    if (values.ADMIN_URL_TOKEN) {
      chmodSync(path, 0o600);
      return values;
    }
    // One-time migration from the deployed two-secret layout: preserve the MCP
    // token and encryption key byte-for-byte, adding only the admin credential.
    writeSecrets(path, {
      ...values,
      ADMIN_URL_TOKEN: randomBytes(32).toString("base64url"),
    });
    return readSecrets(path);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }

  const values = {
    MCP_URL_TOKEN: randomBytes(32).toString("base64url"),
    ADMIN_URL_TOKEN: randomBytes(32).toString("base64url"),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  writeSecrets(path, values);
  return readSecrets(path);
}

function workerOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Worker base URL must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Worker base URL must be an HTTPS origin without a path, query, or fragment");
  }
  return url.origin;
}

export function buildMcpUrl(baseUrl, token) {
  validateUrlToken(token, "MCP_URL_TOKEN");
  return `${workerOrigin(baseUrl)}/t/${token}/mcp`;
}

export function buildAdminUrl(baseUrl, token) {
  validateUrlToken(token, "ADMIN_URL_TOKEN");
  return `${workerOrigin(baseUrl)}/admin/t/${token}`;
}

function printUsage() {
  console.error(
    "Usage: node scripts/secrets.mjs init [path] | url <workers-dev-base-url> [path] | admin-url <workers-dev-base-url> [path]",
  );
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init" && args.length <= 1) {
    const path = resolve(args[0] ?? ".secrets.local");
    ensureSecrets(path);
    console.log(`Secrets recovery file ready: ${path}`);
    console.log("Keep this mode-0600 file private; Cloudflare will not reveal uploaded values.");
    return;
  }
  if (command === "url" && args.length >= 1 && args.length <= 2) {
    const values = readSecrets(args[1] ?? ".secrets.local");
    console.log(buildMcpUrl(args[0], values.MCP_URL_TOKEN));
    return;
  }
  if (command === "admin-url" && args.length >= 1 && args.length <= 2) {
    const values = readSecrets(args[1] ?? ".secrets.local");
    console.log(buildAdminUrl(args[0], values.ADMIN_URL_TOKEN));
    return;
  }
  printUsage();
  process.exitCode = 1;
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (mainPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}
