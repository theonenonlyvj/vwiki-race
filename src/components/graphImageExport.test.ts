import { afterEach, describe, expect, it, vi } from "vitest";
import { shareGraphImage } from "./graphImageExport";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigator(value: Partial<Navigator>) {
  Object.defineProperty(globalThis, "navigator", {
    value: { ...navigator, ...value },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  vi.restoreAllMocks();
});

const blob = () => new Blob(["png"], { type: "image/png" });

describe("shareGraphImage", () => {
  it("hands the file to the OS share sheet when one accepts files", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => true } as Partial<Navigator>);

    await expect(shareGraphImage(blob(), "Opus Film", "Technology")).resolves.toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const [payload] = share.mock.calls[0];
    expect(payload.files[0].name).toBe("opus-film-to-technology.png");
  });

  // Safari exposes navigator.share but rejects file payloads in some contexts.
  // Calling it unguarded rejects only AFTER the user has tapped, so canShare
  // has to be consulted with the actual file.
  it("falls back to a download when the share sheet will not take files", async () => {
    const share = vi.fn();
    setNavigator({ share, canShare: () => false } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "Opus Film", "Technology")).resolves.toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("falls back to a download when there is no share sheet at all", async () => {
    setNavigator({ share: undefined, canShare: undefined } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), null, null)).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(1);
  });

  // Dismissing the share sheet raises AbortError. That is a deliberate "no" -
  // downloading the file anyway would be the opposite of what was asked.
  it("does not download behind the user's back when they dismiss the share sheet", async () => {
    const abort = new Error("dismissed");
    abort.name = "AbortError";
    setNavigator({ share: vi.fn().mockRejectedValue(abort), canShare: () => true } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "A", "B")).resolves.toBe("shared");
    expect(click).not.toHaveBeenCalled();
  });

  it("still delivers the image when the share sheet fails for a real reason", async () => {
    setNavigator({
      share: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      canShare: () => true,
    } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "A", "B")).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("leaves no anchor behind in the document after downloading", async () => {
    setNavigator({ share: undefined, canShare: undefined } as Partial<Navigator>);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await shareGraphImage(blob(), "A", "B");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});
