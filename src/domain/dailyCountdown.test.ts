import { describe, expect, it } from "vitest";
import { formatCountdown, msUntilNextCentralDrop } from "./dailyCountdown";

describe("msUntilNextCentralDrop", () => {
  it("counts down to today's 5:00 AM Central drop while still ahead of it", () => {
    // 2026-07-19T09:59:59Z is 4:59:59 AM Central (CDT, UTC-5 in July).
    expect(msUntilNextCentralDrop(new Date("2026-07-19T09:59:59.000Z"))).toBe(1_000);
  });

  it("wraps to tomorrow's drop once today's has already passed", () => {
    // 2026-07-19T10:00:01Z is 5:00:01 AM Central - 1s past the drop, so
    // almost the full 24h remains until the NEXT drop.
    expect(msUntilNextCentralDrop(new Date("2026-07-19T10:00:01.000Z"))).toBe(86_399_000);
  });

  it("stays correct across the US spring-forward transition (2026-03-08, Central skips 2:00-3:00 AM)", () => {
    // 1:00 AM CST, before the jump - offset is still UTC-6.
    expect(msUntilNextCentralDrop(new Date("2026-03-08T07:00:00.000Z"))).toBe(4 * 3_600_000);
    // 4:00 AM CDT, after the jump - offset is now UTC-5, but this function
    // never touches the offset directly, only the wall-clock hour Intl
    // reports, so the transition itself is invisible to the arithmetic.
    expect(msUntilNextCentralDrop(new Date("2026-03-08T09:00:00.000Z"))).toBe(1 * 3_600_000);
  });

  it("stays correct across the US fall-back transition (2026-11-01)", () => {
    // 3:00 AM CST, after the fall-back (America/Chicago has already
    // resumed standard time by mid-morning UTC on the transition day).
    expect(msUntilNextCentralDrop(new Date("2026-11-01T09:00:00.000Z"))).toBe(2 * 3_600_000);
  });

  it("rejects an invalid date, matching centralDateKey's own convention", () => {
    expect(() => msUntilNextCentralDrop(new Date(Number.NaN))).toThrow(
      "A valid date is required.",
    );
  });
});

describe("formatCountdown", () => {
  it("formats sub-hour remainders as M:SS, matching the ratified mockup's '1:23 left today'", () => {
    expect(formatCountdown(83_000)).toBe("1:23 left today");
    expect(formatCountdown(5_000)).toBe("0:05 left today");
  });

  it("formats hour-plus remainders as H:MM:SS", () => {
    expect(formatCountdown(3_661_000)).toBe("1:01:01 left today");
    expect(formatCountdown(13 * 3_600_000 + 47 * 60_000 + 22_000)).toBe("13:47:22 left today");
  });

  it("floors a negative/invalid remainder to a zero readout rather than a negative one", () => {
    expect(formatCountdown(-500)).toBe("0:00 left today");
  });
});
