import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTextWithTimeout } from "./challengeShare";

describe("challenge sharing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects when a clipboard write never settles", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => new Promise<void>(() => undefined));
    const result = writeTextWithTimeout(writeText, "https://example.test", 1_200);
    const rejection = expect(result).rejects.toThrow("Clipboard write timed out.");

    await vi.advanceTimersByTimeAsync(1_200);

    await rejection;
    expect(writeText).toHaveBeenCalledWith("https://example.test");
    expect(vi.getTimerCount()).toBe(0);
  });
});
