import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.VWIKI_RACE_DB, env.TEST_MIGRATIONS);
