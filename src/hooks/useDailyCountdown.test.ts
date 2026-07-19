import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDailyCountdown } from "./useDailyCountdown";

describe("useDailyCountdown", () => {
  it("renders the initial readout immediately and ticks it down every second while active", () => {
    vi.useFakeTimers();
    try {
      // 4:59:58 AM Central (CDT) - 2s before the 5:00 AM drop.
      let now = new Date("2026-07-19T09:59:58.000Z");
      const { result } = renderHook(
        ({ active }) => useDailyCountdown({ active, now: () => now }),
        { initialProps: { active: true } },
      );
      expect(result.current).toBe("0:02 left today");

      now = new Date("2026-07-19T09:59:59.000Z");
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(result.current).toBe("0:01 left today");

      now = new Date("2026-07-19T10:00:00.000Z");
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      // At the drop instant itself, the full next-day countdown has begun.
      expect(result.current).toBe("24:00:00 left today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null while inactive, and stops ticking once deactivated", () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-07-19T09:59:58.000Z");
      const { result, rerender } = renderHook(
        ({ active }) => useDailyCountdown({ active, now: () => now }),
        { initialProps: { active: false } },
      );
      expect(result.current).toBeNull();

      rerender({ active: true });
      expect(result.current).toBe("0:02 left today");

      rerender({ active: false });
      expect(result.current).toBeNull();

      // No live interval should remain to move it back off null.
      now = new Date("2026-07-19T10:00:00.000Z");
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(result.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its interval on unmount", () => {
    vi.useFakeTimers();
    try {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const { unmount } = renderHook(() => useDailyCountdown({ active: true }));
      unmount();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
