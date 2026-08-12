import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testMcpUrlToken = "a".repeat(43);
const testAdminUrlToken = "b".repeat(43);
const testEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
Object.assign(process.env, {
  ["ADMIN_URL_TOKEN"]: testAdminUrlToken,
  ["MCP_URL_TOKEN"]: testMcpUrlToken,
  ["TOKEN_ENCRYPTION_KEY"]: testEncryptionKey,
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_URL_TOKEN: testAdminUrlToken,
          MCP_URL_TOKEN: testMcpUrlToken,
          TOKEN_ENCRYPTION_KEY: testEncryptionKey,
        },
      },
    }),
  ],
  test: {
    include: ["test-worker/**/*.test.ts"],
  },
});
