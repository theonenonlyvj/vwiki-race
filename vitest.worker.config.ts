import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-07-08",
        d1Databases: ["VWIKI_RACE_DB", "MIGRATION_TEST_DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            resolve("d1/migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["src/**/*.worker.test.ts"],
    setupFiles: ["./src/test/setup-worker.ts"],
  },
});
