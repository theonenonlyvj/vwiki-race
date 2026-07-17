import { describe, expect, it } from "vitest";
import config from "../../wrangler.api.toml?raw";

const canonicalIdentityOrigin =
  "https://vgames-identity.theonenonlyvj.workers.dev";
const productionDailyAdminAccountId =
  "c02875a7-0470-5ef3-b87a-38abcbdcd952";

describe("production deployment configuration", () => {
  it("routes VGames identity through the canonical identity service", () => {
    expect(config).toContain(`VGAMES_URL = "${canonicalIdentityOrigin}"`);
    expect(config).not.toContain("viota-worker.theonenonlyvj.workers.dev");
    expect(config).toContain('binding = "VGAMES_IDENTITY"');
    expect(config).toContain('service = "vgames-identity"');
  });

  it("covers 5:00 AM Central plus bounded due-job retries", () => {
    expect(config).toContain(
      'crons = ["0 10 * * *", "0 11 * * *", "17 * * * *"]',
    );
    expect(config).not.toContain('crons = ["7 * * * *"]');
    expect(config).toContain('name = "CHALLENGE_CREATE_RATE_LIMITER"');
  });

  it("pins the production Daily administrator and low-volume limiter", () => {
    expect(config).toContain(
      `DAILY_ADMIN_ACCOUNT_IDS = "${productionDailyAdminAccountId}"`,
    );
    expect(config.match(/DAILY_ADMIN_ACCOUNT_IDS\s*=/g)).toHaveLength(1);
    expect(config).toMatch(
      /\[\[ratelimits\]\]\s*name = "DAILY_ADMIN_RATE_LIMITER"\s*namespace_id = "51005"\s*simple = \{ limit = 30, period = 60 \}/,
    );
  });
});
