import { describe, expect, it } from "vitest";
import {
  formatMinutesSeconds,
  formatStatDuration,
  formatTimeAndClicks,
  truncateTitle,
} from "./formatting";

/**
 * You's stat figures span three orders of magnitude — a best race of 8.1
 * seconds, an average of 4:41, a lifetime total of 2h 48m — and
 * `formatMinutesSeconds` only holds the middle one honestly: it renders a
 * lifetime total as "379:09" and throws away the tenth of a second that is
 * the entire interest of a sub-minute best. Rather than add a second and
 * third named format beside the file's self-declared "one source of truth",
 * this is ONE function that picks the unit the magnitude deserves.
 */
describe("formatStatDuration", () => {
  it("keeps a tenth of a second under a minute, where it is the whole story", () => {
    expect(formatStatDuration(8_100)).toBe("8.1s");
    expect(formatStatDuration(500)).toBe("0.5s");
    expect(formatStatDuration(59_900)).toBe("59.9s");
  });

  it("switches to m:ss at exactly one minute", () => {
    expect(formatStatDuration(60_000)).toBe("1:00");
    expect(formatStatDuration(281_000)).toBe("4:41");
    expect(formatStatDuration(3_599_000)).toBe("59:59");
  });

  it("switches to h/m at an hour, where m:ss stops being readable", () => {
    // The bug this exists to prevent: 2h48m as "168:26".
    expect(formatStatDuration(3_600_000)).toBe("1h 0m");
    expect(formatStatDuration(10_106_000)).toBe("2h 48m");
    expect(formatStatDuration(22_740_000)).toBe("6h 19m");
  });

  it("clamps negative input to zero instead of throwing", () => {
    expect(formatStatDuration(-50)).toBe("0.0s");
  });
});

describe("formatMinutesSeconds", () => {
  it("formats sub-minute durations as 0:ss", () => {
    expect(formatMinutesSeconds(1_500)).toBe("0:01");
    expect(formatMinutesSeconds(38_400)).toBe("0:38");
  });

  it("carries whole minutes and zero-pads seconds", () => {
    expect(formatMinutesSeconds(65_000)).toBe("1:05");
    expect(formatMinutesSeconds(600_000)).toBe("10:00");
  });

  it("floors partial seconds rather than rounding up", () => {
    expect(formatMinutesSeconds(1_999)).toBe("0:01");
  });

  it("clamps negative input to zero instead of throwing", () => {
    expect(formatMinutesSeconds(-50)).toBe("0:00");
  });
});

describe("formatTimeAndClicks", () => {
  it("always renders both time and click count (invariant 1)", () => {
    expect(formatTimeAndClicks(42_000, 6)).toBe("0:42 · 6 clk");
    expect(formatTimeAndClicks(1_500, 1)).toBe("0:01 · 1 clk");
    expect(formatTimeAndClicks(0, 0)).toBe("0:00 · 0 clk");
  });
});

describe("truncateTitle", () => {
  it("leaves titles at or under the max length untouched", () => {
    expect(truncateTitle("Fruit")).toBe("Fruit");
    expect(truncateTitle("Sixteen char ttl")).toBe("Sixteen char ttl");
    expect(truncateTitle("Fruit", 5)).toBe("Fruit");
  });

  it("truncates longer titles to the max length plus an ellipsis", () => {
    expect(truncateTitle("Voynich manuscript")).toBe("Voynich manuscri…");
    expect(truncateTitle("Voynich manuscript", 7)).toBe("Voynich…");
  });
});
