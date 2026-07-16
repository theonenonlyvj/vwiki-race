import { describe, expect, it, vi } from "vitest";
import { resolveVGamesFetch } from "./worker";

describe("VGames identity transport", () => {
  it("uses the Cloudflare service binding when one is configured", async () => {
    const response = Response.json({ valid: false });
    const bindingFetch = vi.fn(async () => response);
    const transport = resolveVGamesFetch({ fetch: bindingFetch });

    await expect(transport(
      "https://vgames-identity.theonenonlyvj.workers.dev/auth/introspect",
      { method: "POST" },
    )).resolves.toBe(response);
    expect(bindingFetch).toHaveBeenCalledOnce();
  });
});
