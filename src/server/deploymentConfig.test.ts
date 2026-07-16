import { describe, expect, it } from "vitest";
import config from "../../wrangler.api.toml?raw";

const canonicalIdentityOrigin =
  "https://vgames-identity.theonenonlyvj.workers.dev";

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
});
