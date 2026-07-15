/// <reference types="@cloudflare/vitest-pool-workers/types" />

interface TestD1Migration {
  name: string;
  queries: string[];
}

declare global {
  namespace Cloudflare {
    interface Env {
      VWIKI_RACE_DB: D1Database;
      MIGRATION_TEST_DB: D1Database;
      TEST_MIGRATIONS: TestD1Migration[];
      CLICK_RATE_LIMITER: {
        limit(options: { key: string }): Promise<{ success: boolean }>;
      };
      ACCOUNT_READ_RATE_LIMITER: {
        limit(options: { key: string }): Promise<{ success: boolean }>;
      };
    }
  }
}

export {};
