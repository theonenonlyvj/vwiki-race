import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type {
  CreateChallengeOutcome,
  DailyNomination,
  DailyQueueEntry,
} from "./domain/dailyEditorial";
import type { Challenge, ServerPathStep } from "./domain/types";
import type { VGamesIdentityRepository, VGamesIdentitySession } from "./services/vgamesIdentity";
import { appleParseResponse, fruitParseResponse } from "./test/fixtures";

const apiOrigin = "http://localhost:8787";
const apiUrl = (path: string) => `${apiOrigin}${path}`;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("VWiki Race app", () => {
  it("renders when the browser blocks access to localStorage", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });

    try {
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} />);
      expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });

  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the challenge catalog without requiring identity at page entry", async () => {
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    expect(await screen.findByRole("heading", { name: "VWiki Race" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.queryByText(/enter vwiki race/i)).toBeNull();
  });

  it("keeps an unauthenticated direct admin visit in the ordinary game without loading moderation data", async () => {
    window.history.pushState({}, "", "/admin/dailies");
    const fetchImpl = createFetchMock();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.getByRole("status", { name: "Authorization notice" })).toHaveTextContent(
      "This page is not available.",
    );
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/v2/admin/dailies")),
    ).toBe(false);
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/v2/accounts/me/capabilities")),
    ).toBe(false);
  });

  it("shows Daily moderation full-screen for daily managers, bypassing the bottom-nav shell entirely", async () => {
    // Migration note (ii): the admin route is a pathname-gated bypass, not
    // a fifth nav item - an authorized visit replaces the whole shell
    // (nav included), the same way the race takeover does.
    window.history.pushState({}, "", "/admin/dailies");
    const fetchImpl = createFetchMock({ canManageDailies: true });

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("heading", { name: "Daily moderation" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl("/api/v2/accounts/me/capabilities"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer jwt-claimed" }) }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl("/api/v2/admin/dailies"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer jwt-claimed" }) }),
    );
  });

  it("keeps a non-admin claimed direct visit out of moderation data", async () => {
    window.history.pushState({}, "", "/admin/dailies");
    const fetchImpl = createFetchMock({ canManageDailies: false });

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("status", { name: "Authorization notice" })).toHaveTextContent(
      "This page is not available.",
    );
    expect(screen.getByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Daily moderation" })).toBeNull();
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/v2/admin/dailies")),
    ).toBe(false);
  });

  it("preserves the selected-challenge query param across a direct Daily moderation visit and exit", async () => {
    // There's no more in-app "Admin" nav button to click through (migration
    // note ii) - the route is only ever reached by a direct pathname visit
    // (e.g. an out-of-band link), so this exercises that entry directly and
    // then the new bypass-screen exit link.
    window.history.pushState({}, "", "/admin/dailies?challenge=challenge-0001");
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ canManageDailies: true })}
        storage={claimedStorage()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Daily moderation" })).toBeVisible();
    expect(window.location.pathname).toBe("/admin/dailies");
    expect(window.location.search).toBe("?challenge=challenge-0001");

    await userEvent.click(screen.getByRole("button", { name: /back to vwiki race/i }));
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?challenge=challenge-0001");
  });

  it("links back to the portfolio on every view except gameplay", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );

    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);

    const feedback = await screen.findByRole("link", { name: "Tell us" });
    expect(feedback).toHaveAttribute(
      "href",
      "https://theonenonlyvj.github.io/personal-site/contact",
    );
    expect(feedback).toHaveAttribute("target", "_blank");
    expect(feedback.getAttribute("rel")).toContain("noopener");
    const portfolio = screen.getByRole("link", { name: "More VGames" });
    expect(portfolio).toHaveAttribute(
      "href",
      "https://theonenonlyvj.github.io/personal-site",
    );
    expect(portfolio).toHaveAttribute("target", "_blank");
    expect(portfolio.getAttribute("rel")).toContain("noopener");

    const tabbar = screen.getByRole("navigation", { name: /vwiki race views/i });
    for (const tab of ["Stats", "Challenges", "You"]) {
      await userEvent.click(within(tabbar).getByRole("button", { name: tab }));
      expect(screen.getByRole("link", { name: "Tell us" })).toBeVisible();
      expect(screen.getByRole("link", { name: "More VGames" })).toBeVisible();
    }

    await userEvent.click(within(tabbar).getByRole("button", { name: "Home" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /▶ race/i }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Tell us" })).toBeNull();
    expect(screen.queryByRole("link", { name: "More VGames" })).toBeNull();
  });

  it("shows the first-visit teaching gate rules strip before start (supersedes the old how-to-play line)", async () => {
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(
      screen.getByText(/two articles\. links only\. beat the clock\./i),
    ).toBeVisible();
  });

  it("retains a compact in-game target reference during the race (the target-preview panel itself now lives only in the pre-race preview beat)", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /target preview/i })).toBeNull();
    const targetReference = screen.getByRole("group", { name: /target reference/i });
    expect(within(targetReference).getByText("Fruit")).toBeVisible();
    expect(within(targetReference).getByText(/seed-bearing structure/i)).toBeInTheDocument();
  });

  it("selects and labels today's daily challenge when no deep link is present", async () => {
    const challenges: Challenge[] = [
      ...twoChallenges(),
      {
        id: "challenge-0016",
        label: "Challenge #16",
        sortOrder: 16,
        isActive: true,
        mode: "daily",
        start: { title: "Maraba coffee" },
        target: { title: "Moon landing conspiracy theories" },
        ruleset: "ranked_classic",
        origin: "daily",
        dailyDate: "2026-07-15",
        source: "wikipedia_random",
      },
    ];

    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ challenges })}
        storage={memoryStorage()}
        todayUtc={() => "2026-07-15"}
      />,
    );

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.getByText(/maraba coffee/i)).toBeVisible();
    expect(screen.getByText(/moon landing conspiracy theories/i)).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0016");
  });

  it("does not reload the challenge catalog on every render with the default fetch", async () => {
    const fetchImpl = createFetchMock();
    vi.stubGlobal("fetch", fetchImpl);

    const storage = memoryStorage();
    const { rerender } = render(<App apiOrigin={apiOrigin} storage={storage} />);

    expect(
      await screen.findByRole("button", { name: /▶ race/i }),
    ).toBeVisible();
    await waitFor(() => {
      expect(challengeCatalogCalls(fetchImpl)).toBe(1);
    });
    rerender(<App apiOrigin={apiOrigin} storage={storage} />);
    await waitFor(() => {
      expect(challengeCatalogCalls(fetchImpl)).toBe(1);
    });
  });

  it("refreshes the challenge catalog once when the window regains focus", async () => {
    const fetchImpl = createFetchMock();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);
    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(1));

    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(2));
  });

  it("QF-06: self-heals across the 5:00 AM Central daily-drop boundary for a tab left foregrounded through it, with no focus/blur needed", async () => {
    // Deliberately no `screen.findByRole`/`waitFor` anywhere in this test -
    // both poll via real timers under the hood, which never fire while
    // `vi.useFakeTimers()` is active. The catalog-fetch call itself is
    // synchronous (only its Promise resolves later), so a plain call-count
    // check right after `render()`/`advanceTimersByTimeAsync` is both
    // sufficient and hang-proof.
    vi.useFakeTimers();
    try {
      // 4:59:58 AM Central (CDT) - 2s before the drop, mirrors
      // useDailyCountdown.test.ts's own boundary fixture.
      vi.setSystemTime(new Date("2026-07-17T09:59:58.000Z"));
      const fetchImpl = createFetchMock();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);
      expect(challengeCatalogCalls(fetchImpl)).toBe(1);

      // Cross the boundary purely via the clock - no focus/visibilitychange
      // event dispatched at all.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      expect(challengeCatalogCalls(fetchImpl)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("QF-06: the 5:00 AM self-heal keeps re-arming for the following day's drop too (not a one-shot)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T09:59:58.000Z"));
      const fetchImpl = createFetchMock();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);
      expect(challengeCatalogCalls(fetchImpl)).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(challengeCatalogCalls(fetchImpl)).toBe(2);

      // A full day later (the next 5:00 AM Central drop) - proves the timer
      // rescheduled itself rather than firing once and going silent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      });
      expect(challengeCatalogCalls(fetchImpl)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a plain load on Home through a focus/visibilitychange catalog refresh (regression: B1 - was force-navigating to Challenges -> Detail)", async () => {
    // A plain load of today's daily replace-syncs the URL to
    // /?challenge=<daily-id> (unrelated to this bug, already covered by
    // "selects and labels today's daily challenge..." above). B1: the
    // *second* catalog pass (from this focus/visibilitychange refresh) must
    // not misread that app-synced URL as a genuine share-link request and
    // force-navigate into Challenges -> Detail.
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-daily", { dailyDate: "2026-07-15" })],
    });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={memoryStorage()}
        todayUtc={() => "2026-07-15"}
      />,
    );

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-daily");
    expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();

    act(() => window.dispatchEvent(new Event("focus")));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(2));

    expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();
    expect(screen.getByRole("button", { name: /▶ race/i })).toBeVisible();
  });

  it("does not silently move mode to Challenges -> Detail during an active race takeover, even after a focus/visibilitychange catalog refresh (regression: B1)", async () => {
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-daily", { dailyDate: "2026-07-15" })],
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-15"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("button", { name: /^end run$/i })).toBeVisible();

    act(() => window.dispatchEvent(new Event("focus")));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(2));

    // Still mid-race takeover, unaffected by the refresh.
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeVisible();

    // End the run (0 clicks) and return to the shell - if the buggy
    // refresh above had silently flipped `mode` to "challenges" -> "detail"
    // underneath the race takeover, it would surface right here: landing on
    // Challenge Detail instead of back on Home.
    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    await user.click(await screen.findByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByRole("button", { name: /try again/i })).toBeVisible();
    expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();
  });

  it("prompts for identity before starting when no session exists", async () => {
    const storage = memoryStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const identityDialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(identityDialog).toBeVisible();
    expect(within(identityDialog).getByRole("group", { name: /identity options/i })).toBeVisible();
    await user.click(within(identityDialog).getByRole("button", { name: /^guest$/i }));
    await user.type(screen.getByLabelText(/display name/i), "Vijay");
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.getByRole("region", { name: /wikipedia article/i })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(JSON.parse(storage.getItem("vwiki-race:vgames-session") ?? "{}")).toEqual({
      accountId: "acc-guest",
      displayName: "Vijay",
      token: "jwt-guest",
      status: "ghost",
    });
  });

  it("discloses that names and winning paths are public and suggests a nickname", async () => {
    const storage = memoryStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(
      await screen.findByRole("button", { name: /▶ race/i }),
    );
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    expect(
      await screen.findByRole("dialog", { name: /save your stats/i }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    expect(screen.getByLabelText(/display name/i)).toHaveAttribute(
      "placeholder",
      "e.g. a nickname",
    );
    expect(
      screen.getByText(/appear on the public leaderboard/i),
    ).toBeVisible();

    // QF-01: the Guest tab's copy no longer instructs account creation -
    // that pitch stays on Create/Log-in only.
    expect(screen.getByText(/pick a name and go/i)).toBeVisible();
    expect(screen.queryByText(/create a vgames account before the timer starts/i)).toBeNull();
    expect(screen.queryByText(/one account works across every vgames title/i)).toBeNull();
  });

  it("defaults the start gate to a VGames Create account flow", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    const options = within(dialog).getByRole("group", { name: /identity options/i });
    expect(within(options).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Guest",
      "Create account",
      "Log in",
    ]);
    expect(within(options).getByRole("button", { name: /create account/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByText(/one account works across every vgames title/i)).toBeVisible();
    expect(within(dialog).getByLabelText(/vgames username/i)).toBeVisible();
    expect(within(dialog).getByLabelText(/confirm password/i)).toBeVisible();
    expect(within(dialog).queryByLabelText(/^display name$/i)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /continue as guest/i })).toBeNull();
  });

  it("creates a VGames account with the username as its display name", async () => {
    const storage = memoryStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(createAccountSubmitButton());

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(JSON.parse(storage.getItem("vwiki-race:vgames-session") ?? "{}")).toEqual({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/guest"),
      expect.objectContaining({ body: expect.stringContaining('"displayName":"vijay"') }),
    );
  });

  it("blocks mismatched account passwords without making an identity request", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "different-pass");
    await user.click(createAccountSubmitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/passwords do not match/i);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/guest"),
      expect.anything(),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/secure"),
      expect.anything(),
    );
  });

  it("shows the app's friendly error for an invalid username instead of silently blocking submission", async () => {
    // Regression test: the username input carries native pattern="[a-z0-9_]{3,20}",
    // which browsers (and jsdom) use to block form submission before onSubmit runs,
    // so the app's own validation message never rendered. The <form> needs noValidate
    // so this handler-level check always executes.
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "Mike Smith");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(createAccountSubmitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /use 3-20 lowercase letters, numbers, or underscores/i,
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/guest"),
      expect.anything(),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/secure"),
      expect.anything(),
    );
  });

  it("shows the app's friendly error for a too-short password instead of silently blocking submission", async () => {
    // Regression test: the password/confirm-password inputs carry native minLength={6},
    // which blocks form submission before onSubmit runs on a too-short password, so the
    // app's own validation message never rendered. See noValidate fix on the form.
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "abc");
    await user.type(screen.getByLabelText(/confirm password/i), "abc");
    await user.click(createAccountSubmitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /use a password between 6 and 128 characters/i,
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/guest"),
      expect.anything(),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/secure"),
      expect.anything(),
    );
  });

  it("explains when a VGames username is already taken", async () => {
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/identity/secure")) {
        return jsonError("username_taken", "username_taken", 409);
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(createAccountSubmitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That VGames username is already taken.",
    );
  });

  it("explains that a claimed VGames name cannot be used by a guest", async () => {
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/identity/guest")) {
        return jsonError("name_reserved", "name_reserved", 409);
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.type(screen.getByLabelText(/display name/i), "vijay");
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /belongs to an existing vgames account/i,
    );
  });

  it("submits password-manager autofill values even when React change events did not fire", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^log in$/i }));
    const username = screen.getByLabelText(/^username$/i) as HTMLInputElement;
    const password = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(username, "vijay");
    valueSetter?.call(password, "secret-pass");

    fireEvent.submit(password.closest("form") as HTMLFormElement);

    await waitFor(() => {
      const loginCall = fetchImpl.mock.calls.find(
        ([input]) => String(input) === apiUrl("/api/v2/identity/login"),
      );
      expect(readJsonBody(loginCall?.[1])).toMatchObject({
        username: "vijay",
        password: "secret-pass",
      });
    });
  });

  it("locks duplicate login submissions and shows visible progress", async () => {
    const pendingLogin = createDeferredResponse({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/identity/login")) {
        return pendingLogin.promise;
      }
      return baseFetch(input, init);
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^log in$/i }));
    await user.type(screen.getByLabelText(/^username$/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    const form = screen.getByLabelText(/^password$/i).closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchImpl.mock.calls.filter(
      ([input]) => String(input) === apiUrl("/api/v2/identity/login"),
    )).toHaveLength(1);
    expect(screen.getByRole("button", { name: /logging in/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^guest$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^create account$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^log in$/i })).toBeDisabled();

    pendingLogin.resolve();
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
  });

  // QF-07: continueAsGuest/createVGamesAccount had no synchronous guard of
  // their own (only the async `authBusy` state setter, which has a real
  // window before re-render for a second tap/Enter to fire a second
  // request) - mirrors the "locks duplicate login submissions" test above,
  // which already covers `login`'s existing `loginRequestLock`.
  it("locks duplicate continue-as-guest submissions (no double-fire)", async () => {
    const pendingGuest = createDeferredResponse({
      accountId: "acc-guest-1",
      displayName: "Vijay",
      token: "jwt-guest-1",
      status: "ghost",
    });
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/identity/guest")) {
        return pendingGuest.promise;
      }
      return baseFetch(input, init);
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.type(screen.getByLabelText(/display name/i), "Vijay");
    const form = screen.getByLabelText(/display name/i).closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchImpl.mock.calls.filter(
      ([input]) => String(input) === apiUrl("/api/v2/identity/guest"),
    )).toHaveLength(1);
    expect(screen.getByRole("button", { name: /continue as guest/i })).toBeDisabled();

    pendingGuest.resolve();
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
  });

  it("locks duplicate create-account submissions (no double-fire)", async () => {
    const pendingGuest = createDeferredResponse({
      accountId: "acc-guest-2",
      displayName: "vijay",
      token: "jwt-guest-2",
      status: "ghost",
    });
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/identity/guest")) {
        return pendingGuest.promise;
      }
      return baseFetch(input, init);
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    // Fresh visitor: dialog defaults to Create account (QF-01 ratified
    // default) - no tab click needed.
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    const form = screen.getByLabelText(/vgames username/i).closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchImpl.mock.calls.filter(
      ([input]) => String(input) === apiUrl("/api/v2/identity/guest"),
    )).toHaveLength(1);
    expect(createAccountSubmitButton()).toBeDisabled();

    pendingGuest.resolve();
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
  });

  it("keeps a successful login in memory when browser storage rejects the write", async () => {
    const repository: VGamesIdentityRepository = {
      clearSession: vi.fn(),
      getDeviceCredential: () => "device-credential",
      getSession: () => null,
      saveSession: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    };
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        identityRepository={repository}
        storage={memoryStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^log in$/i }));
    await user.type(screen.getByLabelText(/^username$/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    // Scoped to the login form itself: the mode-switcher tab is ALSO named
    // "Log in" while this tab is active (PKG-11's account-verb unification),
    // so an unscoped query is ambiguous here.
    const loginForm = screen.getByLabelText(/^password$/i).closest("form");
    await user.click(within(loginForm as HTMLFormElement).getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
  });

  it("starts immediately for claimed sessions", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );

    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);

    await userEvent.click(await screen.findByRole("button", { name: /▶ race/i }));
    await userEvent.click(await screen.findByRole("button", { name: /start race/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
    expect(screen.getByRole("link", { name: /source revision/i })).toHaveAttribute(
      "href",
      expect.stringContaining("oldid="),
    );
    expect(screen.getByRole("link", { name: /cc by-sa 4\.0/i })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });

  it("clears the article cache between completed runs", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /play again/i }));

    await waitFor(() => {
      expect(wikipediaArticleCalls(fetchImpl, "Apple")).toBe(2);
    });
  });

  it("defaults a returning ghost to the one-tap guest continue path before each challenge start, with Create still one tap away", async () => {
    // QF-01 (owner-proxy ruling, 2026-07-19): a returning ghost already has
    // a name to play under, so the identity gate now defaults to the Guest
    // tab - "Continue as guest" with zero typing - instead of the
    // Create-account tab. A brand-new visitor (no prior session) still
    // defaults to Create; see "defaults the start gate to a VGames Create
    // account flow" above.
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-guest",
        displayName: "Vijay",
        token: "jwt-guest",
        status: "ghost",
      }),
    );
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    const options = within(dialog).getByRole("group", { name: /identity options/i });
    expect(within(options).getByRole("button", { name: /^guest$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).queryByLabelText(/vgames username/i)).toBeNull();
    expect(within(dialog).getByText("Playing as")).toBeVisible();
    expect(within(dialog).getByText("Vijay")).toBeVisible();

    // Create account is still one tap away, prefilled with a suggested
    // username derived from the ghost's display name.
    await user.click(within(options).getByRole("button", { name: /create account/i }));
    expect(screen.getByLabelText(/vgames username/i)).toHaveValue("vijay");
    await user.click(within(options).getByRole("button", { name: /^guest$/i }));

    await user.click(within(dialog).getByRole("button", { name: /continue as guest/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(fetchImpl).not.toHaveBeenCalledWith(
      apiUrl("/api/v2/identity/guest"),
      expect.anything(),
    );
  });

  it("tracks the run on the server with the VGames session token", async () => {
    let now = 1000;
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-guest",
        displayName: "Vijay",
        token: "jwt-guest",
        status: "ghost",
      }),
    );

    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        now={() => now}
        storage={storage}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /▶ race/i }),
    );
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.click(await screen.findByRole("button", { name: /continue as guest/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();

    now = 2500;
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(screen.getAllByText(/1 clk/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/0:01/).length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        apiUrl("/api/v2/runs/run-1/click"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer jwt-guest",
          }),
          method: "POST",
        }),
      );
    });
  });

  it("shows immediate navigation feedback after clicking an article link", async () => {
    const fruitArticle = createDeferredResponse(fruitParseResponse);
    const fetchImpl = createFetchMock({ delayedFruitArticle: fruitArticle.promise });
    const user = userEvent.setup();
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(
      await screen.findByRole("button", { name: /▶ race/i }),
    );
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();

    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(
      within(screen.getByRole("banner")).getByText(/opening fruit/i),
    ).toBeVisible();
    fruitArticle.resolve();
    // Fruit is this challenge's target, so this click completes the run and
    // Results' own frozen WikipediaArticlePanel takes over from RaceMode's -
    // same component either way. Results' own headline also reads "Fruit"
    // (the target title), so scope to the article panel's own heading.
    await screen.findByText(/you reached it/i);
    expect(
      await within(screen.getByRole("article")).findByRole("heading", { name: "Fruit" }),
    ).toHaveFocus();
  });

  it("opens the real Wikipedia article in a new tab on a modifier-click, without counting a click or navigating in-app (PKG-12)", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();

    // The anchor's own href is the in-app synthetic `#article:Fruit` hash
    // (there is no hash router) - a bare skip of preventDefault would open a
    // new tab to nothing useful, so this must read the real Wikipedia URL
    // from data-vwiki-race-href instead.
    fireEvent.click(screen.getByRole("link", { name: /fruit/i }), { ctrlKey: true });

    expect(openSpy).toHaveBeenCalledWith(
      "https://en.wikipedia.org/wiki/Fruit",
      "_blank",
      "noopener",
    );
    // Still mid-race on Apple - the in-app SPA nav never fired alongside the
    // new tab, during an ACTIVE, timed run (a stray Cmd-click must not
    // silently cost the player a move).
    expect(screen.getByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Fruit" })).toBeNull();
    expect(clickRequestBodies(fetchImpl)).toHaveLength(0);

    openSpy.mockRestore();
  });

  it("scrolls to the accepted article top, not an unaccepted optimistic page", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const clickResponse = createDeferredResponse(completedClickResponse());
    try {
      const fetchImpl = createFetchMock({ delayedClickResponse: clickResponse.promise });
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
      scrollIntoView.mockClear();

      await user.click(screen.getByRole("link", { name: /fruit/i }));
      expect(await screen.findByRole("heading", { name: "Fruit" })).toBeVisible();
      expect(scrollIntoView).not.toHaveBeenCalled();

      clickResponse.resolve();
      expect(await screen.findByText(/you reached it/i)).toBeVisible();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "start",
      }));
    } finally {
      if (originalScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  it("blocks browser Find only while a timed run is active or syncing", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    const beforeStart = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(beforeStart);
    expect(beforeStart.defaultPrevented).toBe(false);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    const duringRun = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(duringRun);
    expect(duringRun.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    const afterFinish = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(afterFinish);
    expect(afterFinish.defaultPrevented).toBe(false);
  });

  it("keeps End Run visible but disabled while a click mutation is unresolved", async () => {
    const clickResponse = createDeferredResponse(completedClickResponse());
    const fetchImpl = createFetchMock({ delayedClickResponse: clickResponse.promise });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    await waitFor(() => expect(clickRequestBodies(fetchImpl)).toHaveLength(1));

    expect(screen.getByRole("button", { name: /^end run$/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
    expect(screen.getByRole("region", { name: /wikipedia article/i })).toHaveAttribute("inert");
    expect(screen.getByText(/loading next article/i)).toBeVisible();
    clickResponse.resolve();
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
  });

  it("keeps End Run disabled while an exact click retry remains pending", async () => {
    const fetchImpl = createFetchMock({ clickSyncFailureOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByRole("button", { name: /retry click/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeDisabled();
  });

  it("keeps End Run as a prominent, styled control that opens the confirmation during an active run", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const endRun = screen.getByRole("button", { name: /^end run$/i });
    expect(endRun).toBeEnabled();
    // Locks in the dedicated styling hook so the control reads as an obvious,
    // actionable "end / give up" affordance rather than a bare header button.
    expect(endRun).toHaveClass("end-run-button");
    // Zero global chrome during an active race: End Run lives in the slim
    // race HUD inside the full-screen takeover, not the old app header/
    // tabbar (which no longer render at all while engaged - see (a) below).
    expect(endRun.closest(".race-takeover")).not.toBeNull();
    expect(endRun.closest(".race-hud")).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();

    await user.click(endRun);
    const dialog = screen.getByRole("dialog", { name: /end this run/i });
    expect(dialog).toBeVisible();
    // QF-04: coral (`.end-run-button`, same hook as the HUD trigger above)
    // is reserved for the commit action - "Continue run" stays neutral so
    // the two aren't identically styled on an irreversible choice.
    expect(within(dialog).getByRole("button", { name: /confirm end run/i })).toHaveClass(
      "end-run-button",
    );
    expect(within(dialog).getByRole("button", { name: /continue run/i })).not.toHaveClass(
      "end-run-button",
    );
  });

  it("shows the always-visible time+clicks HUD row and freezes it throughout syncing and completion", async () => {
    let now = 1_000;
    const fruitArticle = createDeferredResponse(fruitParseResponse);
    const fetchImpl = createFetchMock({ delayedFruitArticle: fruitArticle.promise });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        now={() => now}
        storage={claimedStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const metrics = screen.getByLabelText(/current run/i);
    // PKG-02: was three chips (Clicks/Timer/Target) - collapsed to one
    // "Run" chip carrying the same invariant-1 `formatTimeAndClicks` string
    // ("0:00 · 0 clk") everywhere else a run's time+clicks appear.
    const runMetric = within(metrics).getByText("Run").nextElementSibling;
    expect(runMetric).toHaveTextContent("0:00 · 0 clk");

    now = 2_500;
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/opening fruit/i)).toBeVisible();
    await waitFor(() => expect(runMetric).toHaveTextContent("0:01 · 0 clk"));
    now = 9_000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runMetric).toHaveTextContent("0:01 · 0 clk");

    fruitArticle.resolve();
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(runMetric).toHaveTextContent("0:01 · 0 clk");
  });

  it("keeps the HUD's time+clicks chip visible, non-empty, and updated with the real click count throughout an active run (PKG-02 regression guard)", async () => {
    // Council 2026-07-19 PKG-02: live prod showed an empty grid row where
    // this chip should be - `.run-metrics` never painted even though its
    // sibling PathStrip (gated on the same `session` truthy check) did.
    // Root cause traced to a stale deploy, not a code defect (see PKG-02
    // brief), but nothing previously asserted this chip's actual on-screen
    // text - so a real future regression here could land silently. This
    // locks in: present immediately at Start, non-empty, and reflects both
    // time and click count (invariant 1) throughout an active run.
    const fetchImpl = createFetchMock({ clickStaysActive: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const metrics = screen.getByLabelText(/current run/i);
    expect(metrics).toBeVisible();
    const runValue = () => within(metrics).getByText("Run").nextElementSibling;
    expect(runValue()).not.toBeEmptyDOMElement();
    expect(runValue()).toHaveTextContent(/^\d+:\d{2} · 0 clk$/);

    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    // Still mounted, still non-empty, and the click count moved from 0 to
    // 1 - proof the HUD isn't just present but wired to the real session.
    expect(metrics).toBeVisible();
    expect(runValue()).not.toBeEmptyDOMElement();
    expect(runValue()).toHaveTextContent(/^\d+:\d{2} · 1 clk$/);
  });

  it("keeps playable article nodes connected while the timer updates", async () => {
    let now = 1_000;
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock()}
        now={() => now}
        storage={claimedStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const link = await screen.findByRole("link", { name: /fruit/i });
    now = 2_000;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(link.isConnected).toBe(true);
    expect(screen.getByRole("link", { name: /fruit/i })).toBe(link);
  });

  it("refreshes the completed challenge leaderboard exactly once after acceptance, gives Play Again/View leaderboard hierarchy classes, and routes 'View leaderboard' to that challenge's own board (not Boards) since it isn't today's daily", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    // Invariant 1 ("Time AND clicks, always") + placement from the
    // server-returned leaderboardContext.rank (spec: Race flow beat 3).
    // This fixture challenge isn't flagged as today's daily (no
    // dailyFeature/origin), so the copy reads "on this board", not "today".
    expect(screen.getByText(/#1 on this board · 0:01 · 1 clk/)).toBeVisible();
    const result = screen.getByText(/you reached it/i).closest("aside");
    const article = screen.getByRole("article");
    expect(result?.compareDocumentPosition(article)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // PKG-05: hierarchy - the clock-commit "Play Again" gets the coral
    // `.start-race-button` class (same as PreRacePreview's "Start race"),
    // "View leaderboard" gets the existing `.secondary-button` treatment,
    // neither is a bare default-cyan button anymore.
    const playAgain = screen.getByRole("button", { name: /play again/i });
    expect(playAgain).toBeVisible();
    expect(playAgain).toHaveClass("start-race-button");
    const viewLeaderboard = screen.getByRole("button", { name: /view leaderboard/i });
    expect(viewLeaderboard).toHaveClass("secondary-button");
    expect(viewLeaderboard).not.toHaveClass("start-race-button");

    // PKG-05: this fixture challenge isn't flagged as today's daily (no
    // dailyFeature/origin) - "View leaderboard" now routes to ITS OWN
    // Challenge Detail leaderboard via exitCompletedRaceToChallenge, not
    // global Boards. (Previously this test asserted a "Boards" landing that
    // only happened to look right because of Boards' daily-or-fallback hero
    // mechanism, not because the routing was actually challenge-aware - see
    // the PKG-05 council brief and its Judge B amendment.)
    await user.click(viewLeaderboard);
    expect(await screen.findByRole("region", { name: "Challenge detail" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Stats" })).toBeNull();
    // Home's own hero board read on initial mount, plus Results' own
    // deduped-board self-fetch for its snippet (PKG-03), plus Challenge
    // Detail's own board-fetch effect on landing here (PKG-05).
    await waitFor(() => expect(boardCalls(fetchImpl, "challenge-0001")).toBe(3));
    expect(completeRunCalls(fetchImpl)).toBe(0);
  });

  it("routes 'View leaderboard' to Boards' Today segment when the raced challenge really is today's actual daily (PKG-05)", async () => {
    // The genuine-daily half of the routing split above: proves the fix is
    // actually challenge-aware in both directions, not just "always
    // Challenge Detail now."
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" })],
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/#1 today · 0:01 · 1 clk/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /view leaderboard/i }));
    expect(screen.getByRole("heading", { name: "Stats" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
    expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();
  });

  it("routes 'View leaderboard' from a DNF to that challenge's own Challenge Detail leaderboard, same as a completed non-daily run (PKG-05 remainder fix)", async () => {
    // The DNF half of the challenge-aware routing split above
    // (`onShowLeaderboard`'s `session?.challenge ?? dnfResult?.challenge`
    // fallback) - untested until now. `useRaceController.endRun` wipes
    // `session` on a genuine abandon, so this branch is only exercised via
    // a real DNF (>=1 click, then End Run/Confirm End Run), never a
    // completed run - the two tests above only cover the `session` half.
    const fetchImpl = createFetchMock({ clickStaysActive: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await screen.findByRole("heading", { name: "Apple" });
    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));
    expect(await screen.findByText(/that one got away/i)).toBeVisible();

    // Same non-daily fixture challenge (challenge-0001, no dailyFeature) the
    // completed-run routing test above uses - so this must land on
    // Challenge Detail too, not Boards/Stats.
    await user.click(screen.getByRole("button", { name: /view leaderboard/i }));
    expect(await screen.findByRole("region", { name: "Challenge detail" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Stats" })).toBeNull();
  });

  it("exits the results takeover to Challenges when Browse all challenges is clicked", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));

    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
    expect(screen.queryByText(/you reached it/i)).toBeNull();
  });

  it("exits the results takeover to Home when the low-emphasis Home link is clicked (PKG-05)", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^home$/i }));

    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
    expect(screen.queryByText(/you reached it/i)).toBeNull();
  });

  it("locks solution-bearing views throughout an active run", async () => {
    // PKG-03: path disclosure moved from the main board (now the deduped,
    // runId-less `/board` endpoint) to Challenge Detail's own "Your
    // history" strip, which only ever shows YOUR OWN attempts - so this
    // needs a completed row for claimedStorage's "acc-1" to have anything
    // to disclose. Keyed to challenge #2 (not #1, the one this test races)
    // so Home's own pre-race leaderboard read for challenge #1 doesn't
    // mistake it for "I've already finished today's daily" and hide the
    // Race button.
    const fetchImpl = createFetchMock({
      challenges: twoChallenges(),
      leaderboardRowsByChallenge: {
        "challenge-0002": [leaderboardRow({ challengeId: "challenge-0002", accountId: "acc-1" })],
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    // Path disclosure lives on Challenge Detail now, not Boards (Increment 3
    // rebuild removed per-run path disclosure from Boards entirely). Scoped
    // to "Your history" - PKG-03 remainder fix also surfaces a "View
    // winning path" disclosure on the main Leaderboard panel now that
    // acc-1's own board row carries a runId too, so an unscoped query would
    // be ambiguous (both panels show the same account's one run here).
    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #2/i }));
    const historyRegion = await screen.findByRole("region", { name: /your history/i });
    expect(within(historyRegion).getByText(/view winning path/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^home$/i }));
    await user.click(screen.getByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    // Zero chrome, not "disabled" chrome: the full-screen race takeover
    // deletes the "why are Leaderboard/Stats visible-but-disabled mid-race?"
    // problem at the root by not rendering the tabbar/header at all.
    await screen.findByRole("heading", { name: "Apple" });
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^boards$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^challenges$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^you$/i })).toBeNull();
    expect(screen.queryByText(/view winning path/i)).toBeNull();
  });

  it("always shows this run's server-provided placement, personal best or not", async () => {
    // Race flow spec beat 3 + task brief: the placement line is shown
    // unconditionally, never gated on `isPersonalBest` (false here). The
    // NUMBER itself is resolved against the deduped board (PKG-03 remainder
    // fix), not read verbatim off the server's raw per-attempt
    // `leaderboardContext.rank` - so three other accounts, all genuinely
    // faster than the mock's fixed 1500ms completion response, make the
    // just-finished run truly place 4th.
    const fetchImpl = createFetchMock({
      leaderboardContext: { isPersonalBest: false, rank: 4 },
      boardByChallenge: {
        "challenge-0001": {
          placements: [
            { accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 500, clickCount: 1 },
            { accountId: "acc-bo", displayName: "Bo", placement: 2, elapsedMs: 800, clickCount: 1 },
            { accountId: "acc-cy", displayName: "Cy", placement: 3, elapsedMs: 1_100, clickCount: 1 },
          ],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    // Same non-daily fixture challenge as elsewhere - "on this board", not
    // "today" (see the daily-aware variant below).
    expect(await screen.findByText(/#4 on this board · 0:01 · 1 clk/)).toBeVisible();
  });

  it("never fabricates '#1' from the loading-placeholder board while the board fetch is in flight or after it fails (REMAINDERS fix)", async () => {
    // `dedupedRankForJustFinished` can't tell "the board hasn't loaded yet"
    // apart from "zero placements are genuinely better than this run" - both
    // look like an empty `placements` array - so running it against
    // Results' initial `emptyBoard()` placeholder always yields #1 for any
    // completed run with a server-provided rank. This holds the board fetch
    // open (never resolving it), reusing the same "truly #4" fixture as the
    // test above, and asserts the header/Share text read the server's raw
    // rank instead of a fabricated #1 - then rejects the fetch outright and
    // asserts the same holds permanently, not just during the load window.
    let failBoard!: (reason: unknown) => void;
    const boardPromise = new Promise<Response>((_resolve, reject) => {
      failBoard = reject;
    });
    // Real fetch rejections are unhandled-rejection candidates once the
    // promise itself is replaced by state; attach a no-op handler so the
    // test doesn't also have to fight an unrelated unhandled-rejection
    // warning.
    boardPromise.catch(() => {});
    const baseFetch = createFetchMock({
      leaderboardContext: { isPersonalBest: false, rank: 4 },
      boardByChallenge: {
        "challenge-0001": {
          placements: [
            { accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 500, clickCount: 1 },
            { accountId: "acc-bo", displayName: "Bo", placement: 2, elapsedMs: 800, clickCount: 1 },
            { accountId: "acc-cy", displayName: "Cy", placement: 3, elapsedMs: 1_100, clickCount: 1 },
          ],
          dnfs: [],
        },
      },
    });
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/challenges/challenge-0001/board")) {
        return boardPromise;
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;

    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      await user.click(await screen.findByRole("link", { name: /fruit/i }));

      // The board fetch is still pending - if the header were reading the
      // placeholder-derived rank it would show #1 forever (this promise
      // never resolves), so `findByText` timing out on #4 is exactly the
      // pre-fix failure mode.
      expect(await screen.findByText(/#4 on this board · 0:01 · 1 clk/)).toBeVisible();
      expect(screen.queryByText(/#1 on this board/)).toBeNull();

      await user.click(screen.getByRole("button", { name: /share result/i }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          `VWiki Race — Challenge #1 — #4 · 0:01 · 1 clk — ${window.location.origin}/?challenge=challenge-0001`,
        );
      });

      // Now the fetch fails outright - `boardLoaded` must never latch true
      // off a failure, so the header/share text keep reading the same raw
      // #4 rather than a fabricated #1 that persists forever.
      await act(async () => {
        failBoard(new Error("network down"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByText(/#4 on this board · 0:01 · 1 clk/)).toBeVisible();
      expect(screen.queryByText(/#1 on this board/)).toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("falls back to a plain time+clicks line when the server returns no rank", async () => {
    // Invariant 1 must hold even in the edge case where leaderboardContext
    // has no rank (e.g. the row lookup failed server-side) - never fabricate
    // a placement, but never drop time/clicks either.
    const fetchImpl = createFetchMock({
      leaderboardContext: { isPersonalBest: true, rank: null },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    await screen.findByText(/you reached it/i);
    expect(document.querySelector(".result-score")).toHaveTextContent("0:01 · 1 clk");
  });

  it("unlocks challenge selection after a completed run - Browse's card now opens Detail (plan-drift fix)", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));
    const challengeTwo = screen.getByRole("button", { name: /challenge #2/i });
    expect(challengeTwo).toBeEnabled();
    await user.click(challengeTwo);

    await waitFor(() => {
      expect(window.location.search).toBe("?challenge=challenge-0002");
    });
    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByRole("button", { name: /^▶ race$/i })).toBeEnabled();
  });

  it("clears the completed result when another challenge is opened from Browse (plan-drift fix: opens Detail)", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));
    await user.click(screen.getByRole("button", { name: /challenge #2/i }));

    expect(screen.queryByText(/you reached it/i)).toBeNull();
    expect(screen.queryByRole("navigation", { name: /run path/i })).toBeNull();
    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText(/water/i)).toBeVisible();
  });

  it("clears a stale 401 identity, retains Start intent, and resumes after login", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ startUnauthorizedOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    const startButton = await screen.findByRole("button", { name: /▶ race/i });
    await user.click(startButton);
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(dialog).toBeVisible();
    expect(storage.getItem("vwiki-race:vgames-session")).toBeNull();

    await user.type(screen.getByLabelText(/username/i), "vijay");
    await user.type(screen.getByLabelText(/password/i), "secret-pass");
    const loginForm = screen.getByLabelText(/password/i).closest("form");
    expect(loginForm).not.toBeNull();
    await user.click(within(loginForm as HTMLFormElement).getByRole("button", { name: /^log in$/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(startRunCalls(fetchImpl)).toBe(2);
  });

  it("retains an exact pending click through 401 login and retries without refetching", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ clickUnauthorizedOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const fruitCallsBeforeClick = wikipediaArticleCalls(fetchImpl, "Fruit");
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /retry click/i })).toBeVisible();
    expect(storage.getItem("vwiki-race:vgames-session")).toBeNull();
    const firstBody = clickRequestBodies(fetchImpl)[0];
    expect(firstBody).toMatchObject({ clientEventId: expect.any(String) });

    await user.type(screen.getByLabelText(/username/i), "vijay");
    await user.type(screen.getByLabelText(/password/i), "secret-pass");
    const loginForm = screen.getByLabelText(/password/i).closest("form");
    await user.click(within(loginForm as HTMLFormElement).getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    const bodies = clickRequestBodies(fetchImpl);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(firstBody);
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(firstBody));
    expect(wikipediaArticleCalls(fetchImpl, "Fruit")).toBe(fruitCallsBeforeClick + 1);
  });

  it("contains identity-dialog focus, closes on Escape, and restores the trigger", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    const trigger = await screen.findByRole("button", { name: /start race/i });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(document.body.style.overflow).toBe("hidden");
    // PKG-12 (council 2026-07-19, Judge B): this dialog opens from
    // PreRacePreview, i.e. while RaceFlow's `.race-takeover` - not
    // AppShell - is the sibling behind it. A named-class inert list
    // (`.shell-topbar`/`.content-shell`/`.site-footer`) would be a no-op
    // here; the generic "inert my own backdrop's siblings" approach must
    // cover this mount point too.
    const raceTakeover = document.querySelector(".race-takeover");
    expect(raceTakeover).toHaveAttribute("inert");
    const close = screen.getByRole("button", { name: /close identity prompt/i });
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.type(screen.getByLabelText(/display name/i), "Vijay");
    const continueButton = screen.getByRole("button", { name: /continue as guest/i });
    continueButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
    expect(raceTakeover).not.toHaveAttribute("inert");
  });

  it("offers End Old Run for protocol-1 recovery and sends the recovery abandon", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ activeRun: activeRunFixture({ protocolVersion: 1 }) });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    const endOldRun = await screen.findByRole("button", { name: /end old run/i });
    await user.click(endOldRun);
    const dialog = screen.getByRole("dialog", { name: /end this run/i });
    expect(dialog.parentElement).toHaveClass("modal-backdrop");
    await user.click(screen.getByRole("button", { name: /confirm end old run/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl("/api/v2/runs/run-old/abandon"),
      expect.objectContaining({
        body: JSON.stringify({ recoveryProtocolVersion: 1 }),
        method: "POST",
      }),
    ));
    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeEnabled();
  });

  it("locks out challenge browsing during active-run recovery and honors the back-gesture lock", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({
      activeRun: activeRunFixture({ protocolVersion: 1 }),
      challenges: twoChallenges(),
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    expect(await screen.findByRole("button", { name: /end old run/i })).toBeVisible();
    // Zero chrome during recovery (spec: "control is not released to
    // Home/bottom-nav until it resolves") - no tabbar, no reachable
    // challenge browser/creation form to route around the gate through.
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByLabelText(/start article/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /challenge #2/i })).toBeNull();
    expect(createChallengeCalls(fetchImpl)).toBe(0);

    // Migration note (i): the back-gesture/history lock must keep working
    // through the restructuring - popstate during a locked (recovering) run
    // re-syncs the URL instead of navigating away.
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.search).toBe("?challenge=challenge-0001"));
  });

  it("keeps the race takeover engaged until authenticated active-run discovery settles", async () => {
    const storage = claimedStorage();
    const activeDiscovery = createDeferredResponse({ run: null });
    const fetchImpl = createFetchMock({ delayedActiveRun: activeDiscovery.promise });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await waitFor(() => expect(activeRunCalls(fetchImpl)).toBe(1));
    // Spec: "On load, recovery takes priority over everything else" - the
    // existing recoverActiveRun check runs before any mode shell renders,
    // so the takeover is engaged (Start/tabbar unreachable) until it
    // settles, even for the common "nothing to recover" outcome.
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    // recoverActiveRun's own "preparing" tick (no session yet, checking
    // whether there's anything to recover) must not be mislabeled as if an
    // article were loading - that copy belongs to a fresh challenge start.
    expect(screen.getByText(/checking for an active run/i)).toBeVisible();
    expect(screen.queryByText(/loading article/i)).toBeNull();

    await act(async () => {
      activeDiscovery.resolve();
      await activeDiscovery.promise;
    });

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeEnabled();
  });

  it("offers End Old Run when Start receives active_run_exists", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({
      activeRun: activeRunFixture({ protocolVersion: 1 }),
      activeRunAfterConflict: true,
      startConflictOnce: true,
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    expect(await screen.findByRole("button", { name: /end old run/i })).toBeVisible();
    expect(screen.getByText(/end the old run/i)).toBeVisible();
    expect(startRunCalls(fetchImpl)).toBe(1);
  });

  it("offers Retry Resume after a protocol-2 active-run conflict", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({
      activeRun: activeRunFixture({ protocolVersion: 2 }),
      activeRunAfterConflict: true,
      startConflictOnce: true,
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const retry = await screen.findByRole("button", { name: /retry resume/i });
    expect(screen.getByRole("button", { name: /end old run/i })).toBeVisible();
    expect(screen.getByText(/resume or end the active run/i)).toBeVisible();
    await user.click(retry);

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry resume/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeVisible();
  });

  it("resumes a validated protocol-2 article and accepted path with its challenge URL locked", async () => {
    const storage = claimedStorage();
    const resumableChallenge = {
      ...twoChallenges()[0],
      target: { title: "Water" },
    };
    const acceptedPath = [{
      stepNumber: 1,
      sourceTitle: "Apple",
      clickedAnchorText: "fruit",
      destinationTitle: "Fruit",
      destinationPageId: 10843,
      elapsedSinceStartMs: 500,
      createdAt: "2026-07-14T01:00:00.500Z",
    }];
    const fetchImpl = createFetchMock({
      activeRun: activeRunFixture({
        clickCount: 1,
        lastPageId: 10843,
        lastTitle: "Fruit",
        targetTitle: "Water",
      }),
      challenges: [resumableChallenge],
      runOldPath: acceptedPath,
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    expect(await screen.findByRole("heading", { name: "Fruit" })).toBeVisible();
    const path = screen.getByRole("navigation", { name: /run path/i });
    expect(within(path).getByText("Apple")).toBeVisible();
    expect(within(path).getByText("Fruit")).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0001");
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeVisible();
    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl("/api/v2/runs/run-old/recovery-path"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-claimed" }),
      }),
    );
  });

  it("locks challenge history to the active run and honors popstate while idle", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.search).toBe("?challenge=challenge-0001"));

    await user.click(screen.getByRole("button", { name: /end run/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));
    await waitFor(() => expect(leaderboardCalls(fetchImpl, "challenge-0001")).toBe(2));
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect((await screen.findAllByText(/mars → water/i)).length).toBeGreaterThan(0);
    await waitFor(() => expect(leaderboardCalls(fetchImpl, "challenge-0002")).toBeGreaterThan(0));
  });

  it("loads a winning path only when disclosed and memoizes repeat disclosure", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ leaderboardRows: [leaderboardRow()] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    // Path disclosure lives on Challenge Detail now - Boards dropped
    // per-run path disclosure entirely this increment (spec: "paths hidden
    // until you've played"; invariant 5).
    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(0);
    // PKG-03 remainder fix: the viewer's own single run now surfaces a "View
    // winning path" disclosure in BOTH "Your history" AND the main
    // Leaderboard panel (their board row carries the same runId) - scope to
    // "Your history" so the query stays unambiguous; this test is about
    // disclosure/memoization mechanics, not which panel renders it.
    const history = screen.getByRole("region", { name: /your history/i });
    const disclosure = within(history).getByText(/view winning path/i);
    await user.click(disclosure);
    expect((await screen.findAllByText(/apple → fruit/i)).length).toBeGreaterThan(0);
    await user.click(disclosure);
    await user.click(disclosure);
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(1);
  });

  it("shows a tap-to-reveal Historical badge in Your history for pre-migration runs, never a Server tracked or Repeat run pill", async () => {
    // PKG-03: the main board swapped to the deduped `/board` endpoint
    // (no `runId`/`protocolVersion` to hang a provenance pill on at all),
    // so "Server tracked"/"Historical" provenance moved to "Your history" -
    // the one place a real per-run `protocolVersion` still exists. Both
    // fixture rows share the default accountId ("acc-1", claimedStorage's
    // identity) - two of YOUR OWN attempts, one pre-migration.
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({ runId: "run-old", protocolVersion: 1, elapsedMs: 20_000, clickCount: 3 }),
        leaderboardRow({ rank: 2, runId: "run-new", protocolVersion: 2, elapsedMs: 25_000, clickCount: 4 }),
      ],
      // The server's real deduped board would only ever carry the account's
      // best attempt (one row, not two) - modeled explicitly here since the
      // mock's generic `/board` fallback (derived straight from
      // `leaderboardRows`) doesn't dedupe by account on its own.
      boardByChallenge: {
        "challenge-0001": {
          placements: [{ accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 20_000, clickCount: 3 }],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));

    // One deduped row on the main board - not the pre-PKG-03 duplicate-rank
    // bug (the same account at two ranks at once) - and it's highlighted
    // "(you)" (change 4), same `.is-you` treatment Boards/Home already use.
    const board = screen.getByRole("region", { name: "Leaderboard placements" });
    const boardRows = await within(board).findAllByRole("listitem");
    expect(boardRows).toHaveLength(1);
    expect(within(boardRows[0]).getByText(/\(you\)/i)).toBeVisible();
    expect(boardRows[0]).toHaveClass("is-you");

    const history = screen.getByRole("region", { name: /your history/i });
    const historicalBadge = within(history).getByText("Historical");
    expect(historicalBadge).toBeVisible();
    // Tap-to-reveal (a `<details>`), not a hover-only `title` attribute -
    // mobile has no hover.
    await user.click(historicalBadge);
    expect(
      within(history).getByText(/recorded before the server-tracked race protocol/i),
    ).toBeVisible();
    expect(screen.queryByText(/server tracked/i)).toBeNull();
    expect(screen.queryByText(/repeat run/i)).toBeNull();
  });

  it("shows every repeat attempt (including a DNF) in Your history, with the main board deduped to your best", async () => {
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({ isRepeatRun: true }),
        leaderboardRow({
          rank: 2,
          runId: "run-dnf",
          status: "abandoned",
          isRepeatRun: true,
          elapsedMs: 15_000,
          clickCount: 2,
          completedAt: undefined,
          abandonedAt: "2026-07-14T01:02:15.000Z",
        }),
      ],
      boardByChallenge: {
        "challenge-0001": {
          // Invariant 2 ("a completion supersedes DNF"): the account's DNF
          // attempt never also shows up as a separate deduped DNF row once
          // they have a completed one - PKG-03's main board is one row per
          // account, period, not "one row per account per outcome".
          placements: [{ accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 1_500, clickCount: 1 }],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    // "Repeat run"/"Server tracked" provenance pills are gone entirely
    // (PKG-03 change 3) - repeats now live as separate "Your history" rows,
    // not extra board entries with a badge calling them out.
    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));

    const board = screen.getByRole("region", { name: "Leaderboard placements" });
    expect(await within(board).findAllByRole("listitem")).toHaveLength(1);
    expect(within(board).getByText("#1")).toBeVisible();
    expect(screen.getByRole("region", { name: "DNF" })).toHaveTextContent(/no dnfs/i);

    const history = screen.getByRole("region", { name: /your history/i });
    expect(within(history).getByText("#1")).toBeVisible();
    expect(within(history).getByText("DNF")).toBeVisible();
    expect(within(history).getByText("View winning path")).toBeVisible();
    expect(within(history).getByText("View path")).toBeVisible();
    expect(screen.queryByText(/repeat run/i)).toBeNull();
    expect(screen.queryByText(/server tracked/i)).toBeNull();
    // Invariant 5: once you've finished the challenge, the anti-spoiler
    // copy stands down (paths are no longer hidden - see the next test for
    // OTHER players' paths becoming disclosable too, not just your own).
    expect(screen.queryByText(/paths hidden until you've played/i)).toBeNull();
  });

  it("PKG-03 remainder fix: once you've played, OTHER players' winning paths become disclosable too, not just your own", async () => {
    // Invariant 5 is "paths stay hidden until YOU'VE played," not "until
    // each row's own player has played" - once the viewer has a completed
    // run on this challenge, every placement row on the main Leaderboard
    // panel (any account) becomes disclosable, keyed off the deduped
    // board's `runId` (added this fix - see ChallengeBoardPlacement's doc
    // comment, domain/types.ts). Ari never appears in "Your history" (that
    // strip only ever shows the viewer's own attempts) - her disclosure
    // only exists on the main board.
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({ accountId: "acc-other", displayName: "Ari", runId: "run-ranked", rank: 1, elapsedMs: 20_000, clickCount: 3 }),
        leaderboardRow({ accountId: "acc-1", displayName: "Vijay", runId: "run-you", rank: 2, elapsedMs: 25_000, clickCount: 4 }),
      ],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));

    expect(screen.queryByText(/paths hidden until you've played/i)).toBeNull();
    const board = screen.getByRole("region", { name: "Leaderboard placements" });
    const ariRow = (await within(board).findByText("Ari")).closest("li");
    expect(ariRow).not.toBeNull();
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(0);
    await user.click(within(ariRow as HTMLElement).getByText("View winning path"));
    expect((await within(ariRow as HTMLElement).findAllByText(/apple → fruit/i)).length).toBeGreaterThan(0);
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(1);

    // Ari never shows up in "Your history" - that strip is the viewer's own
    // attempts only.
    const history = screen.getByRole("region", { name: /your history/i });
    expect(within(history).queryByText("Ari")).toBeNull();
  });

  it("hides all path disclosure and shows the anti-spoiler copy for a never-played challenge", async () => {
    const fetchImpl = createFetchMock({
      boardByChallenge: {
        "challenge-0001": {
          placements: [{ accountId: "acc-other", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 }],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));

    expect(await screen.findByText("Ari")).toBeVisible();
    expect(screen.getByText(/paths hidden until you've played/i)).toBeVisible();
    expect(screen.queryByText(/view winning path/i)).toBeNull();
    expect(screen.queryByText(/view path/i)).toBeNull();
    expect(screen.getByText(/you haven't tried this one yet/i)).toBeVisible();
  });

  it("keeps paths hidden after a DNF-only history - invariant 5's 'played' means finished, not merely started/DNF'd", async () => {
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({
          status: "abandoned",
          clickCount: 2,
          elapsedMs: 5_000,
          completedAt: undefined,
          abandonedAt: "2026-07-14T01:02:00.000Z",
        }),
      ],
      boardByChallenge: { "challenge-0001": { placements: [], dnfs: [{ accountId: "acc-1", displayName: "Vijay", clickCount: 2, elapsedMs: 5_000 }] } },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));

    const history = await screen.findByRole("region", { name: /your history/i });
    expect(within(history).getByText("DNF")).toBeVisible();
    expect(screen.getByText(/paths hidden until you've played/i)).toBeVisible();
    expect(screen.queryByText(/view path/i)).toBeNull();
    expect(screen.queryByText(/view winning path/i)).toBeNull();
  });

  it("loads account stats only from the authenticated account-stats projection", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ accountAttempts: 7 });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /^you$/i }));

    expect(await screen.findByText("7")).toBeVisible();
    expect(accountStatsCalls(fetchImpl)).toBe(1);
  });

  it("keeps Stats unreachable while a timed run is active", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    await screen.findByRole("heading", { name: "Apple" });
    expect(screen.queryByRole("button", { name: /^you$/i })).toBeNull();
  });

  it("keys account stats by identity and ignores an older token response", async () => {
    const friendBStats = deferredValue<Response>();
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl("/api/v2/accounts/me/stats")) {
        const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (token === "Bearer token-a") return Promise.resolve(jsonResponse({ stats: accountStatsFixture(7) }));
        if (token === "Bearer token-b") return friendBStats.promise;
        if (token === "Bearer token-c") return Promise.resolve(jsonResponse({ stats: accountStatsFixture(2) }));
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const repositoryA = identityRepository(identity("Friend A", "token-a"));
    const repositoryB = identityRepository(identity("Friend B", "token-b"));
    const repositoryC = identityRepository(identity("Friend C", "token-c"));
    const user = userEvent.setup();
    const view = render(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} identityRepository={repositoryA} />,
    );

    await user.click(await screen.findByRole("button", { name: /^you$/i }));
    expect(await screen.findByText("7")).toBeVisible();
    view.rerender(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} identityRepository={repositoryB} />);
    await waitFor(() => expect(screen.getByRole("status", { name: /current player/i })).toHaveTextContent("Friend B"));
    expect(screen.queryByText("7")).toBeNull();

    view.rerender(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} identityRepository={repositoryC} />);
    expect(await screen.findByText("2")).toBeVisible();
    friendBStats.resolve(jsonResponse({ stats: accountStatsFixture(9) }));
    await act(async () => { await friendBStats.promise; });
    await waitFor(() => expect(screen.queryByText("9")).toBeNull());
    expect(screen.getByText("2")).toBeVisible();
  });

  it("clears stale identity and prior stats when the stats projection returns 401", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ accountAttempts: 7, statsUnauthorizedAfterFirst: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /^you$/i }));
    expect(await screen.findByText("7")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^home$/i }));
    await user.click(screen.getByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("button", { name: /^end run$/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));
    await user.click(screen.getByRole("button", { name: /^you$/i }));

    await waitFor(() => expect(storage.getItem("vwiki-race:vgames-session")).toBeNull());
    expect(screen.getByRole("status", { name: /current player/i })).toHaveTextContent("Guest");
    expect(screen.queryByText("7")).toBeNull();
  });

  it("clears a stale Create 401 identity and resumes the exact intent after login", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ createUnauthorizedOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /challenges/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(dialog).toBeVisible();
    expect(storage.getItem("vwiki-race:vgames-session")).toBeNull();
    await user.type(screen.getByLabelText(/username/i), "vijay");
    await user.type(screen.getByLabelText(/password/i), "secret-pass");
    const loginForm = screen.getByLabelText(/password/i).closest("form");
    await user.click(within(loginForm as HTMLFormElement).getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByRole("region", { name: /challenge detail/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
    expect(createChallengeCalls(fetchImpl)).toBe(2);
    expect(createChallengeBodies(fetchImpl)).toEqual([
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: true },
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: true },
    ]);
  });

  it("traps End Run focus, closes on Escape, and restores its trigger", async () => {
    const storage = claimedStorage();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);
    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const trigger = screen.getByRole("button", { name: /^end run$/i });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: /end this run/i });
    expect(dialog.parentElement).toHaveClass("modal-backdrop");
    const cancel = within(dialog).getByRole("button", { name: /continue run/i });
    const confirm = within(dialog).getByRole("button", { name: /confirm end run/i });
    confirm.focus();
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /end this run/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("confirms that an ended attempt was saved", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);
    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/attempt was saved to your stats/i)).toBeVisible();
  });

  it("keeps End Run open and restores the active phase after an abandon failure", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ abandonFailsOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);
    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));

    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/i);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /confirm end run/i })).toBeEnabled());
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeVisible();
  });

  it("retains End Run intent through a stale 401 and resumes after login", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ abandonUnauthorizedOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);
    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));

    const identityDialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(identityDialog).toBeVisible();
    expect(storage.getItem("vwiki-race:vgames-session")).toBeNull();
    await user.type(screen.getByLabelText(/username/i), "vijay");
    await user.type(screen.getByLabelText(/password/i), "secret-pass");
    const loginForm = screen.getByLabelText(/password/i).closest("form");
    await user.click(within(loginForm as HTMLFormElement).getByRole("button", { name: /^log in$/i }));

    // Home's DNF sub-state (spec: "an end-run this session") - a voluntary
    // 0-click End Run still counts as "attempted, not finished" today.
    expect(await screen.findByRole("button", { name: /try again/i })).toBeEnabled();
    expect(abandonRunCalls(fetchImpl, "run-1")).toBe(2);
  });

  it("ignores stale catalog and leaderboard responses", async () => {
    const staleCatalog = createDeferredResponse({ challenges: [twoChallenges()[0]] });
    const staleFetch = createFetchMock({ delayedChallenges: staleCatalog.promise });
    const currentFetch = createFetchMock({ challenges: [twoChallenges()[1]] });
    const catalogStorage = memoryStorage();
    const catalogView = render(<App apiOrigin={apiOrigin} fetchImpl={staleFetch} storage={catalogStorage} />);
    catalogView.rerender(<App apiOrigin={apiOrigin} fetchImpl={currentFetch} storage={catalogStorage} />);
    // A function matcher, not a plain regex: Home's hero wraps the arrow in
    // its own <span> (for the spec's "teal arrow" styling), so the route's
    // text is split across element boundaries - RTL's default text matcher
    // only concatenates a node's direct text-node children, not text
    // contributed by child elements (see fullTextMatch's doc comment).
    expect((await screen.findAllByText(fullTextMatch(/mars → water/i))).length).toBeGreaterThan(0);
    await act(async () => {
      staleCatalog.resolve();
      await staleCatalog.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByText(/apple → fruit/i)).toBeNull());
    catalogView.unmount();

    const staleLeaderboard = createDeferredResponse({ leaderboard: [leaderboardRow({ displayName: "Apple Runner", runId: "run-apple" })] });
    const baseFetch = createFetchMock({ challenges: twoChallenges() });
    let delayedOldLeaderboard = true;
    const racingFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (delayedOldLeaderboard && String(input) === apiUrl("/api/v2/challenges/challenge-0001/leaderboard")) {
        delayedOldLeaderboard = false;
        return staleLeaderboard.promise;
      }
      if (String(input) === apiUrl("/api/v2/challenges/challenge-0002/leaderboard")) {
        return Promise.resolve(jsonResponse({ leaderboard: [leaderboardRow({ challengeId: "challenge-0002", displayName: "Mars Runner", runId: "run-mars" })] }));
      }
      // Challenge Detail's main board now self-fetches the deduped `/board`
      // endpoint too (PKG-03) - mirror the same "Mars Runner" row there so
      // this test's Detail visit has something to find, same as the
      // pre-PKG-03 `/leaderboard` branch above.
      if (String(input) === apiUrl("/api/v2/challenges/challenge-0002/board")) {
        return Promise.resolve(jsonResponse({
          challengeId: "challenge-0002",
          placements: [{ accountId: "acc-mars", displayName: "Mars Runner", placement: 1, elapsedMs: 1500, clickCount: 1 }],
          dnfs: [],
        }));
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    const view = render(<App apiOrigin={apiOrigin} fetchImpl={racingFetch} storage={memoryStorage()} />);
    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    // Challenge Detail is the per-challenge board surface now (Boards only
    // ever shows Today/Yesterday's daily) - opening challenge-0002's card
    // exercises the exact same leaderboardProjection staleness guard the
    // old Boards v0 selector used to.
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #2/i }));
    expect(await screen.findByText("Mars Runner")).toBeVisible();
    await act(async () => {
      staleLeaderboard.resolve();
      await staleLeaderboard.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByText("Apple Runner")).toBeNull());
    view.unmount();
  });

  it("invalidates a pre-create catalog load before selecting the created challenge", async () => {
    const staleCatalog = deferredValue<Response>();
    const createdChallenge: Challenge = {
      id: "challenge-0002",
      label: "Challenge #2",
      sortOrder: 2,
      isActive: true,
      mode: "solo",
      start: { title: "Mars" },
      target: { title: "Water" },
      ruleset: "ranked_classic",
      origin: "manual",
      dailyDate: null,
      dailyFeature: null,
      source: "curated",
    };
    const baseFetch = createFetchMock({
      creationOutcome: {
        challenge: createdChallenge,
        disposition: "created",
        nomination: "not_requested",
      },
    });
    // The recovery-first gate (spec: "Race flow" lead paragraph) needs the
    // catalog to load once before it can even attempt recoverActiveRun for
    // this claimed identity, so the very first catalog GET must resolve
    // promptly - a background refetch (window focus, App.tsx's
    // queueCatalogRefresh) is what stands in for the original "stale
    // pre-create catalog load" here.
    let challengeRequestCount = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      const method = init?.method ?? "GET";
      if (requestUrl === apiUrl("/api/v2/challenges") && method === "GET") {
        challengeRequestCount += 1;
        if (challengeRequestCount === 1) {
          return Promise.resolve(jsonResponse({ challenges: [twoChallenges()[0]] }));
        }
        return staleCatalog.promise;
      }
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0002/leaderboard")) {
        return Promise.resolve(jsonResponse({
          leaderboard: [leaderboardRow({
            challengeId: "challenge-0002",
            displayName: "Mars Runner",
            runId: "run-mars",
          })],
        }));
      }
      // Challenge Detail's main board now self-fetches the deduped `/board`
      // endpoint too (PKG-03) - mirror the same "Mars Runner" row there.
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0002/board")) {
        return Promise.resolve(jsonResponse({
          challengeId: "challenge-0002",
          placements: [{ accountId: "acc-1", displayName: "Mars Runner", placement: 1, elapsedMs: 1500, clickCount: 1 }],
          dnfs: [],
        }));
      }
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0001/leaderboard")) {
        return Promise.resolve(jsonResponse({
          leaderboard: [leaderboardRow({ displayName: "Apple Runner", runId: "run-apple" })],
        }));
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await screen.findByLabelText(/start article/i);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(challengeRequestCount).toBeGreaterThanOrEqual(2));

    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    // Plan-drift fix: a created challenge now lands on its own Detail, not
    // Home (see App.tsx's createChallengeWithSession) - "Race this" is the
    // Detail-native stand-in for the old "Start Challenge #2" button.
    expect(await screen.findByRole("region", { name: /challenge detail/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
    expect(within(nav).getByRole("button", { name: "Challenges" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.location.search).toBe("?challenge=challenge-0002");

    staleCatalog.resolve(jsonResponse({
      challenges: [{
        ...twoChallenges()[0],
        origin: "daily",
        dailyDate: "2026-07-17",
        source: "wikipedia_random",
      }],
    }));
    await act(async () => { await staleCatalog.promise; });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
      expect(window.location.search).toBe("?challenge=challenge-0002");
    });
    expect(within(nav).getByRole("button", { name: "Challenges" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Detail is already showing the just-created challenge-0002 (Boards
    // only ever shows Today/Yesterday's daily, so it plays no part in
    // confirming this) - the late-resolving stale catalog above must not
    // have clobbered it back to challenge-0001's board.
    expect(await screen.findByText("Mars Runner")).toBeVisible();
    expect(screen.queryByText("Apple Runner")).toBeNull();
  });

  it("never renders a prior challenge leaderboard while the current one loads or fails", async () => {
    const challengeTwoLeaderboard = deferredValue<Response>();
    const baseFetch = createFetchMock({ challenges: twoChallenges() });
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0001/leaderboard")) {
        return Promise.resolve(jsonResponse({
          leaderboard: [leaderboardRow({ displayName: "Apple Runner", runId: "run-apple" })],
        }));
      }
      // Challenge Detail's main board now self-fetches the deduped `/board`
      // endpoint too (PKG-03) - mirror the same "Apple Runner" row there.
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0001/board")) {
        return Promise.resolve(jsonResponse({
          challengeId: "challenge-0001",
          placements: [{ accountId: "acc-1", displayName: "Apple Runner", placement: 1, elapsedMs: 1500, clickCount: 1 }],
          dnfs: [],
        }));
      }
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0002/leaderboard")) {
        return challengeTwoLeaderboard.promise;
      }
      // The challenge-0002 board fetch races the same way the leaderboard
      // one does above, but this test only cares that it never briefly
      // shows challenge-0001's board while switching - an empty board (the
      // generic mock fallback, no explicit override) exercises that fine.
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    // Challenge Detail is the per-challenge board surface now (Boards only
    // ever shows Today/Yesterday's daily), so this exercises the same
    // leaderboardProjection staleness guard through Detail instead.
    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #1/i }));
    expect(await screen.findByText("Apple Runner")).toBeVisible();
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(screen.getByRole("button", { name: /challenge #2/i }));
    expect(screen.queryByText("Apple Runner")).toBeNull();
    expect(screen.getByText(/no completed runs yet/i)).toBeVisible();

    challengeTwoLeaderboard.resolve(jsonError("leaderboard_unavailable", "Leaderboard unavailable.", 400));
    await act(async () => { await challengeTwoLeaderboard.promise; });
    expect(await screen.findByRole("alert")).toHaveTextContent(/leaderboard unavailable/i);
    expect(screen.queryByText("Apple Runner")).toBeNull();
  });

  it("creates the next numbered challenge from the Challenges tab", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /challenges/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    // Plan-drift fix: lands on the new challenge's own Detail, not Home.
    expect(
      await screen.findByRole("region", { name: /challenge detail/i }),
    ).toBeVisible();
    expect((await screen.findAllByText(/mars → water/i)).length).toBeGreaterThan(
      0,
    );
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        apiUrl("/api/v2/challenges"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer jwt-claimed",
          }),
          body: JSON.stringify({
            startTitle: "Mars",
            targetTitle: "Water",
            nominateForDaily: false,
          }),
        }),
      );
    });
  });

  it("shows Daily nomination only in a claimed session's creation form", async () => {
    const claimedView = render(
      <App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />,
    );

    await userEvent.setup().click(await screen.findByRole("button", { name: /^challenges$/i }));
    expect(screen.getByRole("checkbox", { name: /nominate for a future daily/i })).toBeVisible();
    claimedView.unmount();

    const ghostStorage = memoryStorage();
    ghostStorage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({ accountId: "acc-guest", displayName: "Guest", token: "jwt-guest", status: "ghost" }),
    );
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={ghostStorage} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /^challenges$/i }));
    expect(screen.queryByRole("checkbox", { name: /nominate for a future daily/i })).toBeNull();
  });

  it("keeps ordinary guest challenge creation available without a Daily nomination", async () => {
    const ghostStorage = memoryStorage();
    ghostStorage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({ accountId: "acc-guest", displayName: "Guest", token: "jwt-guest", status: "ghost" }),
    );
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={ghostStorage} />);

    await user.click(await screen.findByRole("button", { name: /^challenges$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByText(/challenge created/i)).toBeVisible();
    expect(createChallengeBodies(fetchImpl)).toEqual([
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: false },
    ]);
    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
  });

  it("clears nomination intent when a claimed session becomes a ghost", async () => {
    const fetchImpl = createFetchMock();
    const claimedRepository = identityRepository({
      accountId: "account-claimed",
      displayName: "Vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    const ghostRepository = identityRepository({
      accountId: "account-ghost",
      displayName: "Guest",
      token: "jwt-guest",
      status: "ghost",
    });
    const user = userEvent.setup();
    const view = render(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} identityRepository={claimedRepository} />,
    );

    await user.click(await screen.findByRole("button", { name: /^challenges$/i }));
    await user.click(await screen.findByRole("checkbox", { name: /nominate for a future daily/i }));
    view.rerender(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} identityRepository={ghostRepository} />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("checkbox", { name: /nominate for a future daily/i })).toBeNull();
    });
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    await waitFor(() => expect(createChallengeCalls(fetchImpl)).toBe(1));
    expect(createChallengeBodies(fetchImpl)).toEqual([
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: false },
    ]);
  });

  it.each([
    ["pending", "created", "pending", /daily nomination pending review/i],
    ["duplicate", "existing", "already_exists", /already exists as challenge #12/i],
    ["previously featured", "existing", "previously_featured", /already been featured as a daily/i],
    ["account required", "created", "account_required", /claim or log in to nominate/i],
    ["not requested", "created", "not_requested", /challenge created/i],
  ] as const)("selects the returned challenge and reports %s nomination outcome", async (
    _case,
    disposition,
    nomination,
    notice,
  ) => {
    const fetchImpl = createFetchMock({
      creationOutcome: {
        challenge: {
          id: "challenge-0012",
          label: "Challenge #12",
          sortOrder: 12,
          isActive: true,
          mode: "solo",
          start: { title: "Mars" },
          target: { title: "Water" },
          ruleset: "ranked_classic",
          origin: "manual",
          dailyDate: null,
          dailyFeature: null,
          source: "curated",
          createdBy: { accountId: "acc-1", displayName: "Vijay", identityStatus: "claimed" },
        },
        disposition,
        nomination,
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /^challenges$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    if (nomination !== "not_requested") {
      await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    }
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByText(notice)).toBeVisible();
    // Plan-drift fix: lands on the new/existing challenge's own Detail.
    expect(await screen.findByRole("region", { name: /challenge detail/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
  });

  it("preserves authoritative catalog Daily metadata from a legacy duplicate outcome", async () => {
    const featuredChallenge: Challenge = {
      id: "challenge-0012",
      label: "Challenge #12",
      sortOrder: 12,
      isActive: true,
      mode: "daily",
      start: { title: "Mars" },
      target: { title: "Water" },
      ruleset: "ranked_classic",
      origin: "daily",
      dailyDate: "2026-07-20",
      dailyFeature: {
        dailyDate: "2026-07-20",
        flavor: "recognizable",
        selectionSource: "admin",
      },
      source: "curated",
    };
    const fetchImpl = createFetchMock({
      challenges: [featuredChallenge],
      creationOutcome: {
        challenge: {
          ...featuredChallenge,
          mode: "solo",
          origin: "manual",
          dailyDate: null,
          dailyFeature: null,
        },
        disposition: "existing",
        nomination: "previously_featured",
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-20"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /^challenges$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByText(/already been featured as a daily/i)).toBeVisible();
    // Plan-drift fix: lands on Detail, which shows the catalog's authoritative
    // Daily badge (not the stripped-down create-response) - "Today" surviving
    // here is the proxy for "the merge preserved dailyFeature metadata".
    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText("Today")).toBeVisible();
  });

  it("refreshes the existing challenge leaderboard after duplicate creation", async () => {
    const existingChallenge: Challenge = {
      id: "challenge-0012",
      label: "Challenge #12",
      sortOrder: 12,
      isActive: true,
      mode: "solo",
      start: { title: "Mars" },
      target: { title: "Water" },
      ruleset: "ranked_classic",
      origin: "manual",
      dailyDate: null,
      dailyFeature: null,
      source: "curated",
    };
    const fetchImpl = createFetchMock({
      challenges: [existingChallenge],
      creationOutcome: {
        challenge: existingChallenge,
        disposition: "existing",
        nomination: "already_exists",
      },
      leaderboardRows: [leaderboardRow({
        challengeId: existingChallenge.id,
        displayName: "Existing Runner",
      })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await waitFor(() => expect(leaderboardCalls(fetchImpl, existingChallenge.id)).toBe(1));
    await user.click(screen.getByRole("button", { name: /^challenges$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));
    await waitFor(() => expect(leaderboardCalls(fetchImpl, existingChallenge.id)).toBe(2));

    // A duplicate creation lands directly on the existing challenge's
    // Detail (plan-drift fix) - no extra navigation needed to see its
    // refreshed leaderboard.
    expect(await screen.findByText("Existing Runner")).toBeVisible();
  });

  it("keeps a duplicate selected when its leaderboard refresh fails", async () => {
    const existingChallenge: Challenge = {
      id: "challenge-0012",
      label: "Challenge #12",
      sortOrder: 12,
      isActive: true,
      mode: "solo",
      start: { title: "Mars" },
      target: { title: "Water" },
      ruleset: "ranked_classic",
      origin: "manual",
      dailyDate: null,
      dailyFeature: null,
      source: "curated",
    };
    const baseFetch = createFetchMock({
      challenges: [existingChallenge],
      creationOutcome: {
        challenge: existingChallenge,
        disposition: "existing",
        nomination: "already_exists",
      },
    });
    let leaderboardReads = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === apiUrl(`/api/v2/challenges/${existingChallenge.id}/leaderboard`)) {
        leaderboardReads += 1;
        if (leaderboardReads > 1) {
          return Promise.resolve(jsonError(
            "leaderboard_unavailable",
            "Leaderboard unavailable.",
            503,
          ));
        }
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await waitFor(() => expect(leaderboardReads).toBe(1));
    await user.click(screen.getByRole("button", { name: /^challenges$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/leaderboard unavailable/i);
    expect(screen.getByText(/already exists as challenge #12/i)).toBeVisible();
    // Plan-drift fix: still lands on Detail even when the leaderboard
    // refresh itself failed - the selection/navigation isn't gated on it.
    expect(await screen.findByRole("region", { name: /challenge detail/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0012");
  });

  it("keeps the selected challenge in the URL and honors challenge deep links, landing on Detail", async () => {
    // Migration note (iv): a challenge share link opens Challenges mode ->
    // Detail for that id, not Home directly - "Race this" enters the same
    // preview/Start race flow Home's button always has.
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      }),
    );
    const fetchImpl = createFetchMock({
      challenges: [
        {
          id: "challenge-0001",
          label: "Challenge #1",
          sortOrder: 1,
          isActive: true,
          mode: "daily",
          start: { title: "Apple" },
          target: { title: "Fruit" },
          ruleset: "ranked_classic",
          source: "curated",
        },
        {
          id: "challenge-0002",
          label: "Challenge #2",
          sortOrder: 2,
          isActive: true,
          mode: "daily",
          start: { title: "Mars" },
          target: { title: "Water" },
          ruleset: "ranked_classic",
          source: "curated",
        },
      ],
    });
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    expect((await screen.findAllByText(/mars → water/i)).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: /← challenges/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /start challenge #2/i })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /^▶ race$/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        apiUrl("/api/v2/runs/start"),
        expect.objectContaining({
          body: JSON.stringify({
            challengeId: "challenge-0002",
          }),
        }),
      );
    });
    expect(window.location.search).toBe("?challenge=challenge-0002");
  });

  it("copies a permanent link for the deep-linked challenge from its Detail screen", async () => {
    // Migration note (iv): the deep link lands on Detail now, so this
    // exercises Detail's own "Copy link" chip (ChallengeShareButton reused
    // verbatim) rather than Home's target-preview one - see the plain-load
    // copy-link tests below for that still-unchanged Home coverage.
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock({ challenges: twoChallenges() })}
          storage={claimedStorage()}
        />,
      );

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      await user.click(
        within(detail).getByRole("button", { name: /copy challenge link/i }),
      );

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/?challenge=challenge-0002`,
        );
      });
      expect(await within(detail).findByRole("status")).toHaveTextContent(
        /challenge link copied/i,
      );
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("QF-10: Copy challenge link opens the native OS share sheet when navigator.share is available, without touching the clipboard", async () => {
    // Ruling widened QF-10 to ChallengeShareButton too (same file, same
    // useClipboardShare hook, same clipboard-only gap ShareResultButton
    // had).
    window.history.pushState({}, "", "/?challenge=challenge-0002");
    const user = userEvent.setup();
    const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    try {
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock({ challenges: twoChallenges() })}
          storage={claimedStorage()}
        />,
      );

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      await user.click(
        within(detail).getByRole("button", { name: /copy challenge link/i }),
      );

      await waitFor(() => {
        expect(share).toHaveBeenCalledWith({
          text: `${window.location.origin}/?challenge=challenge-0002`,
        });
      });
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      if (shareDescriptor) {
        Object.defineProperty(navigator, "share", shareDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "share");
      }
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("shares a composed placement/time/clicks line from the results screen", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      await user.click(await screen.findByRole("link", { name: /fruit/i }));

      expect(await screen.findByText(/you reached it/i)).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: /share result/i }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          `VWiki Race — Challenge #1 — #1 · 0:01 · 1 clk — ${window.location.origin}/?challenge=challenge-0001`,
        );
      });
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("QF-10: Share result opens the native OS share sheet with the same composed text when navigator.share is available, without touching the clipboard", async () => {
    const user = userEvent.setup();
    const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    try {
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      await user.click(await screen.findByRole("link", { name: /fruit/i }));

      expect(await screen.findByText(/you reached it/i)).toBeVisible();
      await user.click(screen.getByRole("button", { name: /share result/i }));

      await waitFor(() => {
        // `text` only - never a separate `url` field, which would risk some
        // share targets (iOS Messages) rendering the link twice.
        expect(share).toHaveBeenCalledWith({
          text: `VWiki Race — Challenge #1 — #1 · 0:01 · 1 clk — ${window.location.origin}/?challenge=challenge-0001`,
        });
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText(/result copied/i)).toBeNull();
    } finally {
      if (shareDescriptor) {
        Object.defineProperty(navigator, "share", shareDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "share");
      }
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("QF-10: a user-cancelled native share (AbortError) is a no-op on Share result - no error state, no clipboard fallback", async () => {
    const user = userEvent.setup();
    const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    // Per spec, a cancelled share() rejects with an AbortError DOMException
    // - which does NOT extend Error, so this also exercises the duck-typed
    // `.name` check in shareOrCopy rather than an `instanceof Error` guard.
    const share = vi.fn().mockRejectedValue(new DOMException("Share cancelled.", "AbortError"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    try {
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      await user.click(await screen.findByRole("link", { name: /fruit/i }));

      expect(await screen.findByText(/you reached it/i)).toBeVisible();
      await user.click(screen.getByRole("button", { name: /share result/i }));

      await waitFor(() => expect(share).toHaveBeenCalled());
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText(/automatic copy was blocked/i)).toBeNull();
      expect(screen.queryByText(/result copied/i)).toBeNull();
    } finally {
      if (shareDescriptor) {
        Object.defineProperty(navigator, "share", shareDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "share");
      }
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("uses the legacy copy fallback when the Clipboard API is blocked", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException("Blocked")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    try {
      window.history.pushState({}, "", "/?challenge=challenge-0001");
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      await user.click(
        within(detail).getByRole("button", { name: /copy challenge link/i }),
      );

      expect(await within(detail).findByRole("status")).toHaveTextContent(
        /challenge link copied/i,
      );
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(within(detail).queryByRole("textbox", { name: /challenge link/i })).toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("reveals a selectable challenge link when automatic copying is blocked", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException("Blocked")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    try {
      window.history.pushState({}, "", "/?challenge=challenge-0001");
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      await user.click(
        within(detail).getByRole("button", { name: /copy challenge link/i }),
      );

      const fallbackLink = await within(detail).findByRole("textbox", {
        name: /challenge link/i,
      });
      expect(fallbackLink).toHaveValue(
        `${window.location.origin}/?challenge=challenge-0001`,
      );
      expect(within(detail).getByRole("status")).toHaveTextContent(
        /select the link below/i,
      );
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("ignores a pending copy result after another challenge is selected", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => new Promise<void>(() => undefined)) },
    });

    try {
      window.history.pushState({}, "", "/?challenge=challenge-0001");
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock({ challenges: twoChallenges() })}
          storage={claimedStorage()}
        />,
      );

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      const copyButton = within(detail).getByRole("button", {
        name: /copy challenge link/i,
      });
      await user.click(copyButton);
      expect(within(detail).getByRole("status")).toHaveTextContent(
        /copying challenge link/i,
      );
      expect(copyButton).toBeDisabled();

      const nav = screen.getByRole("navigation", { name: /vwiki race views/i });
      await user.click(within(nav).getByRole("button", { name: "Challenges" }));
      await user.click(screen.getByRole("button", { name: /challenge #2/i }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));

      const nextDetail = screen.getByRole("region", { name: /challenge detail/i });
      expect(within(nextDetail).getByText(/water/i)).toBeVisible();
      expect(within(nextDetail).queryByRole("status")).toBeNull();
      expect(within(nextDetail).queryByRole("textbox", { name: /challenge link/i })).toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  describe("Bottom-nav mode shell (Increment 2)", () => {
    it("renders exactly the four modes and switches between them", async () => {
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

      const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
      const items = within(nav).getAllByRole("button");
      expect(items.map((item) => item.textContent)).toEqual(["Home", "Stats", "Challenges", "You"]);

      // Home is the default landing mode.
      expect(within(nav).getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
      const heroRace = screen.getByRole("button", { name: /▶ race/i });
      expect(heroRace).toBeVisible();
      // PKG-04 (owner-proxy ruling): opening the preview is non-committal -
      // the hero shares Boards'/Detail's teal `.race-preview-button` class,
      // never the coral `.start-race-button` clock-commit class.
      expect(heroRace).toHaveClass("race-preview-button");
      expect(heroRace).not.toHaveClass("start-race-button");

      await user.click(within(nav).getByRole("button", { name: "Stats" }));
      expect(within(nav).getByRole("button", { name: "Stats" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Stats" })).toBeVisible();

      await user.click(within(nav).getByRole("button", { name: "Challenges" }));
      expect(within(nav).getByRole("button", { name: "Challenges" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();

      await user.click(within(nav).getByRole("button", { name: "You" }));
      expect(within(nav).getByRole("button", { name: "You" })).toHaveAttribute("aria-pressed", "true");
      // QF-09: You's own heading is "Your stats", not "Stats" - the nav
      // tab literally labeled "Stats" points at Boards (PKG-14), one tap
      // away from here.
      expect(screen.getByRole("heading", { name: "Your stats" })).toBeVisible();

      await user.click(within(nav).getByRole("button", { name: "Home" }));
      expect(within(nav).getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /▶ race/i })).toBeVisible();
    });

    it("lands a challenge share link on Detail with that challenge's own board", async () => {
      window.history.pushState({}, "", "/?challenge=challenge-0001");
      const fetchImpl = createFetchMock({ leaderboardRows: [leaderboardRow({ displayName: "Ari" })] });
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      expect(within(detail).getByRole("button", { name: /^▶ race$/i })).toBeVisible();
      // The fixture row's accountId defaults to claimedStorage's own "acc-1"
      // - it shows up on BOTH the main deduped board (by display name, "Ari")
      // and "Your history" (a plain "#1 · 0:01 · 1 clk" line, no name) -
      // scope to the main board so the shared "0:01 · 1 clk" text isn't
      // ambiguous between the two sections.
      const board = within(detail).getByRole("region", { name: "Leaderboard placements" });
      expect(await within(board).findByText("Ari")).toBeVisible();
      expect(within(board).getByText("0:01 · 1 clk")).toBeVisible();
    });

    it("enters the pre-race preview from Detail's Race this button", async () => {
      window.history.pushState({}, "", "/?challenge=challenge-0001");
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

      const detail = await screen.findByRole("region", { name: /challenge detail/i });
      const raceThis = within(detail).getByRole("button", { name: /^▶ race$/i });
      // PKG-04 (owner-proxy ruling): Detail's "Race this" only opens the
      // preview - it's non-committal, same as Home's hero and Boards' CTA,
      // so it carries their shared teal `.race-preview-button` class, never
      // the coral `.start-race-button` clock-commit class (guards against
      // silently reintroducing the two-color-CTA bug this package fixed).
      expect(raceThis).toHaveClass("race-preview-button");
      expect(raceThis).not.toHaveClass("start-race-button");
      await user.click(raceThis);

      const startButton = await screen.findByRole("button", { name: /start race/i });
      expect(startButton).toBeVisible();
      expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();
      // The clock-committing action downstream is the one true coral CTA.
      expect(startButton).toHaveClass("start-race-button");
    });

    it("shows the account's stats in You", async () => {
      const fetchImpl = createFetchMock({ accountAttempts: 9 });
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: "You" }));

      expect(screen.getByRole("heading", { name: "Your stats" })).toBeVisible();
      expect(await screen.findByText("9")).toBeVisible();
    });

    it("gives an unclaimed guest a persistent claim CTA in You", async () => {
      const storage = memoryStorage();
      storage.setItem(
        "vwiki-race:vgames-session",
        JSON.stringify({
          accountId: "acc-guest",
          displayName: "Guest-42",
          token: "jwt-guest",
          status: "ghost",
        }),
      );
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);

      await user.click(await screen.findByRole("button", { name: "You" }));

      // PKG-11 remainder fix: You's claim CTA now uses the app-wide
      // "Create account"/"Log in" pair (RaceResults.tsx's `ClaimCta`
      // pattern), not its own third "Claim your stats" verb - the section
      // itself keeps that framing as its aria-label only.
      const claimCta = screen.getByRole("region", { name: /claim your stats/i });
      await user.click(within(claimCta).getByRole("button", { name: /^create account$/i }));
      expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();

      // PKG-12 (council 2026-07-19): here AppShell (not RaceFlow) is the
      // sibling behind the dialog - covers the other real mount point the
      // generic inert-my-backdrop's-siblings approach must handle.
      expect(document.querySelector(".shell-topbar")).toHaveAttribute("inert");
      expect(document.querySelector(".content-shell")).toHaveAttribute("inert");
      expect(document.querySelector(".site-footer")).toHaveAttribute("inert");
    });

    it("routes You's 'Log in' claim button directly to the login tab, not create (PKG-11 remainder fix)", async () => {
      const storage = memoryStorage();
      storage.setItem(
        "vwiki-race:vgames-session",
        JSON.stringify({
          accountId: "acc-guest",
          displayName: "Guest-42",
          token: "jwt-guest",
          status: "ghost",
        }),
      );
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);

      await user.click(await screen.findByRole("button", { name: "You" }));
      const claimCta = screen.getByRole("region", { name: /claim your stats/i });
      await user.click(within(claimCta).getByRole("button", { name: /^log in$/i }));

      // Opens straight on the login form (a password field, no "VGames
      // username"/confirm-password create fields) - not the create tab
      // "Log in" would have defaulted to before this fix widened
      // `onClaimIdentity` to carry a mode.
      const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
      expect(within(dialog).getByLabelText(/password/i)).toBeVisible();
      expect(within(dialog).queryByLabelText(/vgames username/i)).toBeNull();
    });

    it("does not show the claim CTA in You for an already-claimed account", async () => {
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: "You" }));

      expect(screen.queryByRole("region", { name: /claim your stats/i })).toBeNull();
    });

    it("QF-09: collapses a never-played guest's You tab into one message + a Home CTA, not ten repeated placeholders", async () => {
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

      await user.click(await screen.findByRole("button", { name: "You" }));

      expect(screen.getByText(/play your first race to start building stats/i)).toBeVisible();
      // Zero repeated "No data yet." strings - not the old 7-tile grid +
      // 3 list sections' placeholder-times-ten.
      expect(screen.queryByText(/no data yet/i)).toBeNull();
      expect(screen.queryByRole("heading", { name: /your stats/i })).toBeNull();
      // Scoped to the true never-played-guest case only: no identitySession
      // at all, so there's nothing yet to "claim" either.
      expect(screen.queryByRole("region", { name: /claim your stats/i })).toBeNull();

      // Scoped to the empty state itself - the bottom-nav's own "Home" tab
      // is also on screen and shares the accessible name.
      const emptyState = document.querySelector(".you-empty-state") as HTMLElement;
      await user.click(within(emptyState).getByRole("button", { name: /^home$/i }));
      expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    });

    it("QF-09: a played account's You tab shows Avg speed/Avg clicks tiles alongside the existing grid", async () => {
      const fetchImpl = createFetchMock({
        accountAttempts: 9,
        accountAverages: { averageClicks: 4.5, averageElapsedMs: 12300 },
      });
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: "You" }));
      await screen.findByText("Attempts");

      const grid = document.querySelector(".stat-grid") as HTMLElement;
      const valueFor = (label: string) =>
        within(grid).getByText(label).nextElementSibling?.textContent;

      await waitFor(() => expect(valueFor("Attempts")).toBe("9"));
      expect(valueFor("Avg speed")).toBe("12.3s");
      expect(valueFor("Avg clicks")).toBe("4.5");
    });
  });
});

describe("Race flow: full-screen takeover", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the pre-race preview beat with target, attribution, and start-article label before Start", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));

    const preview = await screen.findByRole("region", { name: /pre-race preview/i });
    expect(within(preview).getByText(/your target/i)).toBeVisible();
    expect(within(preview).getByRole("heading", { name: "Fruit" })).toBeVisible();
    await within(preview).findByText(/seed-bearing structure/i);
    expect(within(preview).getByRole("link", { name: /source revision/i })).toHaveAttribute(
      "href",
      expect.stringContaining("oldid=78910"),
    );
    expect(within(preview).getByText(/start: apple/i)).toBeVisible();
    // QF-05: the rules restated here, one screen before the clock can start
    // - the only other place they live (the first-visit teaching gate
    // popup) is gone for good after an account's first completed race.
    expect(
      within(preview).getByText(/click links inside the article — no search, no back button/i),
    ).toBeVisible();
    expect(within(preview).getByRole("button", { name: /^back$/i })).toBeVisible();
    expect(within(preview).getByRole("button", { name: /start race/i })).toBeEnabled();
    expect(within(preview).getByRole("button", { name: /see other challenges/i })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Apple" })).toBeNull();
  });

  it("keeps Start race enabled from the preview when the target preview is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ targetPreviewFailure: true })}
        storage={claimedStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));

    const preview = await screen.findByRole("region", { name: /pre-race preview/i });
    await within(preview).findByText(/preview unavailable/i);
    expect(within(preview).getByRole("button", { name: /start race/i })).toBeEnabled();
  });

  it("(b) creates no run when backing out of the preview", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /^back$/i }));

    expect(startRunCalls(fetchImpl)).toBe(0);
    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.queryByRole("region", { name: /pre-race preview/i })).toBeNull();
  });

  it("(c) lands on the Challenges view via 'See other challenges' without creating a run", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /see other challenges/i }));

    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /pre-race preview/i })).toBeNull();
    expect(startRunCalls(fetchImpl)).toBe(0);
  });

  it("(d) calls the same run-start API from the preview's Start race button", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        apiUrl("/api/v2/runs/start"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ challengeId: "challenge-0001" }),
        }),
      );
    });
    expect(startRunCalls(fetchImpl)).toBe(1);
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
  });

  it("returns to the preview (not home) when the identity prompt is closed mid-Start", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    await user.click(within(dialog).getByRole("button", { name: /close identity prompt/i }));

    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
    expect(await screen.findByRole("region", { name: /pre-race preview/i })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Apple" })).toBeNull();
  });

  it("(a) + (e) renders zero global chrome and the full-screen takeover once race.phase is active", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const heading = await screen.findByRole("heading", { name: "Apple" });
    expect(heading.closest(".race-takeover")).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "VWiki Race" })).toBeNull();
    expect(screen.queryByRole("status", { name: /current player/i })).toBeNull();
  });

  it("keeps the takeover engaged and shows Results (not the shell) immediately on completion", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    const result = await screen.findByText(/you reached it/i);
    expect(result.closest(".race-takeover")).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
  });

  it("recovery outcome 'recovered' boots straight into RaceMode - the shell never renders, not even once", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ activeRun: activeRunFixture() });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    // Spec: "On load, recovery takes priority over everything else" - for a
    // cached identity, the shell must be absent from the very first paint,
    // not merely hidden once recovery happens to resolve.
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "VWiki Race" })).toBeNull();
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
  });

  it("recovery outcome 'recovery-required' boots straight into the interstitial - resolving it releases the shell", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ activeRun: activeRunFixture({ protocolVersion: 1 }) });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "VWiki Race" })).toBeNull();

    const endOldRun = await screen.findByRole("button", { name: /end old run/i });
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();

    await user.click(endOldRun);
    await user.click(screen.getByRole("button", { name: /confirm end old run/i }));

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
  });

  it("releases the recovery gate and falls back to the shell when the initial catalog load fails", async () => {
    // Before the fix: an identified user whose very first GET
    // /api/v2/challenges fails was stuck forever on the zero-chrome
    // "Checking for an active run..." interstitial - recoverActiveRun needs
    // challenges.length > 0 to ever run, so a catalog error meant the
    // recovery effect (and therefore the gate) never resolved. A catalog
    // error must release the gate and fall back to the shell, where the
    // existing error banner + focus-refetch affordances live.
    const baseFetch = createFetchMock();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      const method = init?.method ?? "GET";
      if (requestUrl === apiUrl("/api/v2/challenges") && method === "GET") {
        return jsonError("server_error", "Boom.", 500);
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
    expect(screen.queryByText(/checking for an active run/i)).toBeNull();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
  });

  it("offers a Retry control while the recovery gate is waiting on the challenge catalog", async () => {
    // A catalog that resolves successfully but empty leaves the recovery
    // effect permanently stuck too (its own guard needs challenges.length >
    // 0) without ever throwing - so FIX 1(a)'s error-driven gate release
    // doesn't apply here. This is exactly the case Retry exists for: no
    // exception to hang a fix off of, just an indefinite wait.
    const fetchImpl = createFetchMock({ challenges: [] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/checking for an active run/i)).toBeVisible();
    const retryButton = screen.getByRole("button", { name: /^retry$/i });
    expect(retryButton).toBeVisible();

    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(1));
    await user.click(retryButton);
    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(2));
  });

  it("shows the unclaimed-guest claim CTA directly above Share result, opening the identity dialog", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-guest",
        displayName: "Guest-42",
        token: "jwt-guest",
        status: "ghost",
      }),
    );
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    // Invariant 4 exception aside, a ghost session is still prompted before
    // Start (asked to claim or continue) - continue as the same guest here,
    // the claim CTA below is what surfaces the deferred claim opportunity.
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.click(await screen.findByRole("button", { name: /continue as guest/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    const claimCta = await screen.findByRole("region", { name: /keep your spot/i });
    expect(within(claimCta).getByText(/guest-42/i)).toBeVisible();
    const shareButton = screen.getByRole("button", { name: /share result/i });
    expect(claimCta.compareDocumentPosition(shareButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(within(claimCta).getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
  });

  it("shows the claim CTA and Share result for a guest's DNF too, not just a completed race (PKG-05)", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({
        accountId: "acc-guest",
        displayName: "Guest-42",
        token: "jwt-guest",
        status: "ghost",
      }),
    );
    const fetchImpl = createFetchMock({ clickStaysActive: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.click(await screen.findByRole("button", { name: /continue as guest/i }));
    await screen.findByRole("heading", { name: "Apple" });
    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/that one got away/i)).toBeVisible();
    const claimCta = await screen.findByRole("region", { name: /keep your spot/i });
    expect(within(claimCta).getByText(/guest-42/i)).toBeVisible();
    const shareButton = screen.getByRole("button", { name: /share result/i });
    expect(claimCta.compareDocumentPosition(shareButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("does not show the claim CTA for an already-claimed session", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    await screen.findByText(/you reached it/i);
    expect(screen.queryByRole("region", { name: /keep your spot/i })).toBeNull();
  });

  it("shows the first-finish ritual hook on Results when this is the account's first completed race ever", async () => {
    // M2: showFirstFinishRitual is driven by a snapshot of totals.completed
    // taken at race START (App.tsx's preRaceCompletionsRef), not by
    // whatever accountStats live-reads whenever Results happens to render -
    // model the real server sequence explicitly (0 before this race, 1
    // after) rather than relying on a single static value.
    // QF-06: raced challenge must be a genuine daily (dailyDateForChallenge
    // !== null) - the ritual hook is now gated on daily-ness, not just
    // first-finish.
    const fetchImpl = createFetchMock({
      accountCompletedSequence: [0, 1],
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-01-01" })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    // QF-06: "come defend your spot" replaced with "come back tomorrow" -
    // nonsensical wording once this same screen is reachable from a DNF or
    // a non-first finish too.
    expect(
      await screen.findByText(
        /🔥 day 1 · new daily drops 5:00 am central — come back tomorrow for the next one/i,
      ),
    ).toBeVisible();
  });

  it("regression: M2 - does not show the Day-1 ritual hook for a veteran's second finish even if the post-race stats refetch never advances past the stale pre-race reading, but still shows the generic drop-time cue (QF-06)", async () => {
    // Pre-race: this account already has 1 completed race (from a prior
    // session). The stats endpoint keeps reporting "1" after this race too
    // (a stale/unhelpful refetch, e.g. cache or replica lag) - the old
    // "accountStats live-read === 1" check would misread that as "just
    // transitioned 0 -> 1" and wrongly show the Day-1 hook on this account's
    // SECOND finish. The fix must snapshot the pre-race value (1) and key
    // off that instead, hiding the Day-1 hook regardless of what the
    // refetch (eventually, or never) reports. QF-06: un-gating means a
    // later completion still gets the plain drop-time cue, just without the
    // Day-1 framing.
    const fetchImpl = createFetchMock({
      accountCompletedSequence: [1, 1],
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-01-01" })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    await waitFor(() => expect(accountStatsCalls(fetchImpl)).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/🔥 day 1/i)).toBeNull();
    expect(screen.getByText(/new daily drops 5:00 am central\./i)).toBeVisible();
  });

  it("regression: M2 - shows the first-finish ritual hook immediately for a true first finish, without waiting on a post-race stats refetch that never resolves", async () => {
    // Pre-race: a genuine brand-new account (0 completions). The post-race
    // stats refetch (triggered by bumpStatsRefresh) is modeled as never
    // resolving at all - if showFirstFinishRitual depended on that live
    // refetch (the old bug), the hook would never appear. The fix must show
    // it immediately from the pre-race snapshot (0), independent of whether
    // the refetch ever completes.
    const stuckRefetch = new Promise<Response>(() => {});
    const fetchImpl = createFetchMock({
      accountCompleted: 0,
      delayedStatsAfterFirst: stuckRefetch,
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-01-01" })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(
      await screen.findByText(
        /🔥 day 1 · new daily drops 5:00 am central — come back tomorrow for the next one/i,
      ),
    ).toBeVisible();
  });

  it("does not show the Day-1 ritual hook on Results for a later completion (not the account's first), but still shows the generic drop-time cue (QF-06)", async () => {
    const fetchImpl = createFetchMock({
      accountCompleted: 4,
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-01-01" })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(screen.queryByText(/🔥 day 1/i)).toBeNull();
    expect(screen.getByText(/new daily drops 5:00 am central\./i)).toBeVisible();
  });

  it("QF-06: shows the generic drop-time cue on a DNF Results for a daily challenge too, not just a completed race", async () => {
    const fetchImpl = createFetchMock({
      clickStaysActive: true,
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-01-01" })],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await screen.findByRole("heading", { name: "Apple" });

    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/that one got away/i)).toBeVisible();
    expect(screen.queryByText(/🔥 day 1/i)).toBeNull();
    expect(screen.getByText(/new daily drops 5:00 am central\./i)).toBeVisible();
  });

  it("QF-06: shows no drop-time cadence line at all on Results for a non-daily challenge", async () => {
    // The default fixture challenge (mode: 'daily' ranked ruleset, but no
    // dailyFeature/origin/dailyDate) is NOT a real daily per
    // `dailyDateForChallenge` - confirmed elsewhere in this file by its
    // header reading "on this board", never "today". The cadence line is
    // gated on that same signal, so it shouldn't appear here either.
    const fetchImpl = createFetchMock({ accountCompleted: 4 });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(screen.queryByText(/new daily drops/i)).toBeNull();
    expect(screen.queryByText(/🔥 day 1/i)).toBeNull();
  });

  it("shows a top-3 board snippet with the player's own row highlighted", async () => {
    const fetchImpl = createFetchMock({
      // PKG-03: Results' snippet now reads the deduped `/board` endpoint for
      // everyone ELSE, and pins the viewer's own row to the run that
      // literally just finished. The mock's fixed click-completion response
      // (`completedClickResponse`) always echoes elapsedMs: 1500 - so the
      // three "other" accounts here are all deliberately FASTER (500/800/
      // 1100ms) than that, making the just-finished run genuinely place 4th
      // once the rank is derived from real elapsed/clicks comparison against
      // the deduped board (PKG-03 remainder fix), not from an arbitrarily
      // chosen raw `leaderboardContext.rank` decoupled from elapsedMs.
      // `leaderboardContext.rank` only needs to be non-null here (it gates
      // "is this ranked at all," never the displayed number).
      leaderboardContext: { isPersonalBest: false, rank: 4 },
      boardByChallenge: {
        "challenge-0001": {
          placements: [
            { accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 500, clickCount: 2 },
            { accountId: "acc-bo", displayName: "Bo", placement: 2, elapsedMs: 800, clickCount: 3 },
            { accountId: "acc-cy", displayName: "Cy", placement: 3, elapsedMs: 1_100, clickCount: 4 },
          ],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    // This fixture challenge isn't flagged as today's daily, so the board
    // reads "Leaderboard", not "Today's board" (see the daily-aware variant
    // below).
    const board = await screen.findByRole("region", { name: /^leaderboard$/i });
    const rows = await within(board).findAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[3]).getByText(/vijay/i)).toBeVisible();
    expect(rows[3]).toHaveClass("is-you");
    // Change 5's "one source of truth": the header above and this exact
    // row both read the same `outcome`/`leaderboardContext` data, so they
    // can't disagree - same time·clicks string in both places.
    expect(screen.getByText(/#4 on this board · 0:01 · 1 clk/)).toBeVisible();
    expect(within(rows[3]).getByText("0:01 · 1 clk")).toBeVisible();
  });

  it("labels the result line and board 'today'/'Today's board' when the raced challenge is today's actual daily", async () => {
    const dailyChallenge: Challenge = {
      id: "challenge-0001",
      label: "Challenge #1",
      sortOrder: 1,
      isActive: true,
      mode: "daily",
      start: { title: "Apple" },
      target: { title: "Fruit" },
      ruleset: "ranked_classic",
      source: "wikipedia_random",
      origin: "daily",
      dailyDate: "2026-07-17",
    };
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge],
      // Not "acc-1" (claimedStorage's identity) - see the top-3 board test
      // above for why: Home's own pre-race leaderboard read would otherwise
      // misread this static fixture as an already-finished today's daily
      // before the race in this test even starts.
      leaderboardRows: [leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-other-device", displayName: "Vijay" })],
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/#1 today · 0:01 · 1 clk/)).toBeVisible();
    expect(screen.getByRole("region", { name: /today's board/i })).toBeVisible();
  });

  it("keeps the original End Run confirm copy when no clicks have been made yet", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^end run$/i }));

    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    expect(
      within(dialog).getByText(/this cannot be resumed after the server accepts it\./i),
    ).toBeVisible();
    // PKG-12 (council 2026-07-19, Judge B): End Run is the dialog that most
    // needs backgrounding - it interrupts a live timed race, and its
    // sibling is `.race-takeover` (RaceMode), not any AppShell class.
    expect(document.querySelector(".race-takeover")).toHaveAttribute("inert");
  });

  it("shows the DNF Results variant, DNF-aware End Run confirm copy, and elapsed time after abandoning a run with clicks", async () => {
    let now = 1_000;
    const fetchImpl = createFetchMock({ clickStaysActive: true });
    const user = userEvent.setup();
    render(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} now={() => now} storage={claimedStorage()} />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await screen.findByRole("heading", { name: "Apple" });
    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    const metrics = screen.getByLabelText(/current run/i);
    const runMetric = within(metrics).getByText("Run").nextElementSibling;
    now = 9_000;
    await waitFor(() => expect(runMetric).toHaveTextContent("0:08 · 1 clk"));

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    expect(
      within(dialog).getByText(/it'll count as a dnf — did not finish — with 1 click\./i),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/that one got away/i)).toBeVisible();
    // PKG-12 (council 2026-07-19): unlike a completed run (which has an
    // article panel whose own heading takes focus), a DNF had nothing to
    // receive focus at all - the result heading is now the landing spot.
    expect(screen.getByRole("heading", { name: /that one got away/i })).toHaveFocus();
    // Invariant 1 ("Time AND clicks, always") - the DNF headline must carry
    // elapsed time too, not just click count.
    expect(screen.getByText(/dnf · 0:08 · 1 clk/i)).toBeVisible();
    // PKG-05: "DNF" is never spelled out anywhere else in the app - the
    // kicker expands it for a first-time viewer.
    expect(screen.getByText("DNF — Did not finish")).toBeVisible();

    // PKG-05: hierarchy - "Try again" (a clock-commit, same as Start) gets
    // the coral `.start-race-button` class; "View leaderboard" gets the
    // existing `.secondary-button` treatment. Neither is a bare
    // default-cyan button anymore.
    const tryAgain = screen.getByRole("button", { name: /try again/i });
    expect(tryAgain).toBeVisible();
    expect(tryAgain).toHaveClass("start-race-button");
    const viewLeaderboard = screen.getByRole("button", { name: /view leaderboard/i });
    expect(viewLeaderboard).toHaveClass("secondary-button");
    expect(viewLeaderboard).not.toHaveClass("start-race-button");

    // PKG-05: a DNF is no longer a dead end - Share is un-gated from
    // `status === "completed"` and renders for a DNF too, directly under
    // the header.
    expect(screen.getByRole("button", { name: /share result/i })).toBeVisible();

    expect(screen.getByRole("button", { name: /browse all challenges/i })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));
    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
  });

  it("shows the server-confirmed elapsed time on a DNF, not the client's pre-call timer reading", async () => {
    // PKG-03 (council 2026-07-19): the header and the eventual board row
    // for the same just-ended run used to read two independent sources -
    // the client's own timer at the moment "End Run" was clicked (0:08
    // here) vs. the server's own abandoned_at-based elapsed_ms (0:09,
    // simulating the extra time the abandon request actually took in
    // flight) - a real, structural mismatch, not a rounding edge case. The
    // header must show the server's number, one source of truth with
    // whatever the board row will read.
    let now = 1_000;
    const fetchImpl = createFetchMock({ clickStaysActive: true, abandonElapsedMs: 9_200 });
    const user = userEvent.setup();
    render(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} now={() => now} storage={claimedStorage()} />,
    );

    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await screen.findByRole("heading", { name: "Apple" });
    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    const metrics = screen.getByLabelText(/current run/i);
    const runMetric = within(metrics).getByText("Run").nextElementSibling;
    now = 9_000;
    await waitFor(() => expect(runMetric).toHaveTextContent("0:08 · 1 clk"));

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/that one got away/i)).toBeVisible();
    expect(screen.getByText(/dnf · 0:09 · 1 clk/i)).toBeVisible();
    expect(screen.queryByText(/dnf · 0:08 · 1 clk/i)).toBeNull();
  });

});

describe("Home v2: stateful daily hub + teaching gate (Increment 2 Task 2)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the not-attempted pre-play hero with a flavor badge and yesterday's-results card, from mocked leaderboard data", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      start: "Apple",
      target: "Fruit",
    });
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      flavor: "weird",
      start: "Mars",
      target: "Water",
      label: "Yesterday's Daily",
    });
    const fetchImpl = createFetchMock({
      challenges: [todayChallenge, yesterdayChallenge],
      leaderboardRowsByChallenge: {
        "challenge-0001": [],
        "challenge-0002": [
          leaderboardRow({
            rank: 1,
            runId: "run-y1",
            challengeId: "challenge-0002",
            accountId: "acc-other",
            displayName: "Ari",
            elapsedMs: 20_000,
            clickCount: 3,
          }),
          leaderboardRow({
            rank: 2,
            runId: "run-y2",
            challengeId: "challenge-0002",
            accountId: "acc-1",
            displayName: "Vijay",
            elapsedMs: 25_000,
            clickCount: 4,
          }),
        ],
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.getByText("Recognizable")).toBeVisible();
    expect(screen.getByText(/apple/i)).toBeVisible();

    const yesterdayCard = await screen.findByRole("region", { name: /yesterday's results/i });
    expect(within(yesterdayCard).getByText(/ari/i)).toBeVisible();
    expect(within(yesterdayCard).getByText(/0:20 · 3 clk/i)).toBeVisible();
    expect(within(yesterdayCard).getByText(/vijay/i)).toBeVisible();
    expect(within(yesterdayCard).getByText(/\(you\)/i)).toBeVisible();

    // "see full board" lands on Boards' Yesterday segment specifically
    // (goToBoardsFor) - Boards computes that segment's daily itself from the
    // catalog now, rather than syncing a shared challenge-selection URL
    // param the old v0 selector needed.
    await user.click(within(yesterdayCard).getByRole("button", { name: /see full board/i }));
    expect(screen.getByRole("heading", { name: "Stats" })).toBeVisible();
    expect(await screen.findByText(/ari/i)).toBeVisible();
    expect(screen.getByText(/vijay/i)).toBeVisible();
    expect(screen.getByText(/\(you\)/i)).toBeVisible();
  });

  it("omits the yesterday's-results card when no yesterday daily exists in the catalog (it only carries active challenges)", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.queryByRole("region", { name: /yesterday's results/i })).toBeNull();
  });

  it("shows the DNF sub-state from a server-recorded DNF row (>=1 click) on first mount", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({
          status: "abandoned",
          accountId: "acc-1",
          clickCount: 3,
          elapsedMs: 12_000,
          runId: "run-dnf",
          completedAt: undefined,
          abandonedAt: "2026-07-14T01:02:00.000Z",
        }),
      ],
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/last try: dnf/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
  });

  it("shows the finished post-play state - done hero, today's board, share, play-another, ritual line - from a completed leaderboard row", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-a", accountId: "acc-ari", displayName: "Ari", elapsedMs: 30_000, clickCount: 4 }),
        leaderboardRow({ rank: 2, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/done · you finished #2 · 0:42 · 6 clk/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

    const todaysBoard = screen.getByRole("region", { name: /today's board/i });
    expect(within(todaysBoard).getByText(/ari/i)).toBeVisible();
    expect(within(todaysBoard).getByText(/\(you\)/i)).toBeVisible();

    expect(screen.getByRole("button", { name: /share result/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /play another challenge/i })).toBeVisible();
    expect(screen.getByText(/new daily drops 5:00 am central/i)).toBeVisible();
    // Finished takes precedence over the pre-play yesterday card, per spec.
    expect(screen.queryByRole("region", { name: /yesterday's results/i })).toBeNull();
  });

  it("composes and copies the same result line from Home's post-play Share result as Results does", async () => {
    // userEvent.setup() installs its own clipboard stub, so it must run
    // BEFORE this test's Object.defineProperty override, not after (matches
    // the ordering already established by the other clipboard tests in this
    // file) - otherwise userEvent's setup silently clobbers the mock.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const fetchImpl = createFetchMock({
        challenges: [twoChallenges()[0]],
        leaderboardRows: [
          leaderboardRow({ rank: 3, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
        ],
      });
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: /share result/i }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(
        `VWiki Race — Challenge #1 — #3 · 0:42 · 6 clk — ${window.location.origin}/?challenge=challenge-0001`,
      ));
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("PKG-07 (owner-proxy ruling (c)): a daily's share text leads with 'Daily #N', not its generic 'Challenge #N' label", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const todayChallenge = dailyChallenge("challenge-0001", {
        dailyDate: "2026-07-17",
        flavor: "weird",
        dailyNumber: 7,
      });
      const fetchImpl = createFetchMock({
        challenges: [todayChallenge],
        leaderboardRows: [
          leaderboardRow({ rank: 3, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
        ],
      });
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={fetchImpl}
          storage={claimedStorage()}
          todayUtc={() => "2026-07-17"}
        />,
      );

      await user.click(await screen.findByRole("button", { name: /share result/i }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(
        `VWiki Race — Daily #7 — #3 · 0:42 · 6 clk — ${window.location.origin}/?challenge=challenge-0001`,
      ));
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("composes DNF share text with an explicit DNF marker - not indistinguishable from a win (PKG-05, owner-proxy ruling)", async () => {
    // Un-gating ShareResultButton for DNF alone would produce a bare
    // "time · clicks" line with no rank - reading exactly like a real (if
    // unranked) win, not a failed 1-click abandon. composeShareText must
    // carry an explicit "DNF" marker for this outcome.
    let now = 1_000;
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const fetchImpl = createFetchMock({ clickStaysActive: true });
      render(
        <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} now={() => now} storage={claimedStorage()} />,
      );

      await user.click(await screen.findByRole("button", { name: /▶ race/i }));
      await user.click(await screen.findByRole("button", { name: /start race/i }));
      await screen.findByRole("heading", { name: "Apple" });
      await user.click(await screen.findByRole("link", { name: /apple tree/i }));
      await screen.findByRole("heading", { name: "Apple tree" });

      const metrics = screen.getByLabelText(/current run/i);
      const runMetric = within(metrics).getByText("Run").nextElementSibling;
      now = 9_000;
      await waitFor(() => expect(runMetric).toHaveTextContent("0:08 · 1 clk"));

      await user.click(screen.getByRole("button", { name: /^end run$/i }));
      const dialog = await screen.findByRole("dialog", { name: /end this run/i });
      await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));
      expect(await screen.findByText(/that one got away/i)).toBeVisible();

      await user.click(screen.getByRole("button", { name: /share result/i }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(
        `VWiki Race — Challenge #1 — DNF · 0:08 · 1 clk — beat that — ${window.location.origin}/?challenge=challenge-0001`,
      ));
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("PKG-06: the teaching gate strip carries the spec's 'No account needed to look around.' footer line, and it hides along with the strip once accountStats reports a finish", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges(), accountCompleted: 0 });
    const view = render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    expect(await screen.findByText(/two articles\. links only\. beat the clock\./i)).toBeVisible();
    expect(screen.getByText(/no account needed to look around\./i)).toBeVisible();
    view.unmount();
    window.history.pushState({}, "", "/");

    const finishedFetch = createFetchMock({ challenges: twoChallenges(), accountCompleted: 1 });
    render(<App apiOrigin={apiOrigin} fetchImpl={finishedFetch} storage={claimedStorage()} />);
    await screen.findByRole("button", { name: /▶ race/i });
    await waitFor(() => expect(
      screen.queryByText(/no account needed to look around\./i),
    ).toBeNull());
  });

  it("shows the first-visit teaching gate on Home AND Challenge Detail for a zero-finish account, and hides it once accountStats reports a finish", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges(), accountCompleted: 0 });
    const user = userEvent.setup();
    const view = render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/two articles\. links only\. beat the clock\./i)).toBeVisible();

    const nav = screen.getByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(screen.getByRole("button", { name: /challenge #1/i }));
    await screen.findByRole("region", { name: /challenge detail/i });
    expect(screen.getByText(/two articles\. links only\. beat the clock\./i)).toBeVisible();
    view.unmount();
    window.history.pushState({}, "", "/");

    const finishedFetch = createFetchMock({ challenges: twoChallenges(), accountCompleted: 1 });
    render(<App apiOrigin={apiOrigin} fetchImpl={finishedFetch} storage={claimedStorage()} />);
    await screen.findByRole("button", { name: /▶ race/i });
    await waitFor(() => expect(
      screen.queryByText(/two articles\. links only\. beat the clock\./i),
    ).toBeNull());
  });

  it("does not re-trigger the teaching gate on the DNF sub-state", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({
          status: "abandoned",
          accountId: "acc-1",
          clickCount: 2,
          elapsedMs: 8_000,
          runId: "run-dnf",
          completedAt: undefined,
          abandonedAt: "2026-07-14T01:02:00.000Z",
        }),
      ],
      accountCompleted: 1,
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/last try: dnf/i)).toBeVisible();
    expect(screen.queryByText(/two articles\. links only\. beat the clock\./i)).toBeNull();
  });

  it("opens the teaching gate's how-to-play popup with today's real pair, links-only definition, and tie-break, and dismisses it", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      start: "Apple",
      target: "Fruit",
    });
    const fetchImpl = createFetchMock({ challenges: [todayChallenge], accountCompleted: 0 });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    // Scoped to the first-visit strip specifically - QF-05 added a second,
    // permanent "how to play" trigger in the footer that opens the exact
    // same popup, so an unscoped query now matches both.
    const strip = await screen.findByRole("note");
    await user.click(within(strip).getByRole("button", { name: /how to play/i }));
    const dialog = await screen.findByRole("dialog", { name: /how to play/i });
    expect(within(dialog).getByText(/get from/i)).toHaveTextContent(/apple/i);
    expect(within(dialog).getByText(/fruit/i)).toBeVisible();
    expect(within(dialog).getByText(/no search, no back button cheese/i)).toBeVisible();
    expect(within(dialog).getByText(/fastest time wins; fewest clicks breaks ties/i)).toBeVisible();
    // QF-05: the flavor-badge legend - wording matches `dailyFlavorLabel`'s
    // actual on-screen output ("Recognizable"/"Weird"/"Hard"), not a
    // synonym.
    expect(
      within(dialog).getByText(/recognizable picks early week, weird thu.{1,3}fri, hard weekends/i),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: /close how to play/i }));
    expect(screen.queryByRole("dialog", { name: /how to play/i })).toBeNull();
  });

  it("QF-05: keeps 'How to play' re-accessible forever via a permanent footer link, even after the first-visit strip is gone", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges(), accountCompleted: 1 });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    // The first-visit strip is gone (account already has a completed race).
    expect(screen.queryByText(/two articles\. links only\. beat the clock\./i)).toBeNull();

    const footer = document.querySelector(".site-footer") as HTMLElement;
    await user.click(within(footer).getByRole("button", { name: /how to play/i }));
    const dialog = await screen.findByRole("dialog", { name: /how to play/i });
    expect(within(dialog).getByText(/no search, no back button cheese/i)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: /close how to play/i }));
    expect(screen.queryByRole("dialog", { name: /how to play/i })).toBeNull();
  });

  it("opens Challenge Detail when a Browse card is clicked (plan-drift fix: no more select-and-land-on-Home)", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /challenge #2/i }));

    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByRole("button", { name: /^▶ race$/i })).toBeVisible();
    expect(within(detail).getByText(/water/i)).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0002");
  });
});

describe("Home board dedup + pre-drop hero (desktop pass, FIX 3/FIX 4)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders the yesterday card from the deduped board endpoint - one row per account - and never calls the raw leaderboard", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      start: "Apple",
      target: "Fruit",
    });
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      start: "Mars",
      target: "Water",
      label: "Yesterday's Daily",
    });
    const fetchImpl = createFetchMock({
      challenges: [todayChallenge, yesterdayChallenge],
      // The raw per-attempt leaderboard deliberately lists the same account
      // twice (bug e: production showed #1 AND #2 both theonenonlyvj). If
      // Home still read this endpoint, the card would render both rows.
      leaderboardRowsByChallenge: {
        "challenge-0002": [
          leaderboardRow({ rank: 1, runId: "run-y1", challengeId: "challenge-0002", accountId: "acc-other", displayName: "Ari", elapsedMs: 20_000, clickCount: 3 }),
          leaderboardRow({ rank: 2, runId: "run-y2", challengeId: "challenge-0002", accountId: "acc-other", displayName: "Ari", elapsedMs: 25_000, clickCount: 4, isRepeatRun: true }),
        ],
      },
      // The deduped board endpoint: one row per canonical account.
      boardByChallenge: {
        "challenge-0002": {
          placements: [
            { accountId: "acc-other", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
            { accountId: "acc-1", displayName: "Vijay", placement: 2, elapsedMs: 25_000, clickCount: 4 },
          ],
        },
      },
    });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    const yesterdayCard = await screen.findByRole("region", { name: /yesterday's results/i });
    await within(yesterdayCard).findByText(/ari/i);
    expect(within(yesterdayCard).queryAllByText(/ari/i)).toHaveLength(1);
    expect(within(yesterdayCard).getByText("#1")).toBeVisible();
    expect(within(yesterdayCard).getByText("#2")).toBeVisible();
    expect(within(yesterdayCard).getByText(/\(you\)/i)).toBeVisible();
    expect(boardCalls(fetchImpl, "challenge-0002")).toBeGreaterThan(0);
    expect(leaderboardCalls(fetchImpl, "challenge-0002")).toBe(0);
  });

  it("derives the DNF sub-state from the board's dnfs section (completed placements always win)", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      start: "Apple",
      target: "Fruit",
    });
    const fetchImpl = createFetchMock({
      challenges: [todayChallenge],
      boardByChallenge: {
        "challenge-0001": {
          placements: [],
          dnfs: [{ accountId: "acc-1", displayName: "Vijay", clickCount: 3, elapsedMs: 12_000 }],
        },
      },
    });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    expect(await screen.findByText(/last try: dnf/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
    // Home's state came from the board endpoint (App.tsx's own
    // selected-challenge leaderboard read for Detail/paths is out of scope
    // here and may still fire once).
    expect(boardCalls(fetchImpl, "challenge-0001")).toBeGreaterThan(0);
  });

  it("pre-drop (FIX 4): heroes YESTERDAY's daily with an explicit badge, a live countdown, and a live Race button", async () => {
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      flavor: "weird",
      start: "Mars",
      target: "Water",
      label: "Yesterday's Daily",
    });
    // The first active challenge would have been the old silent fallback
    // (bug f: production heroed "Moon -> Gravity" with no badge) - its
    // presence proves yesterday's daily now wins pre-drop.
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0], yesterdayChallenge],
    });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    expect(await screen.findByText(fullTextMatch(/Mars → Water/), { selector: "strong" })).toBeVisible();
    expect(screen.getByText(/yesterday's daily · weird/i)).toBeVisible();
    // PKG-07 (owner-proxy ruling (d)): the old static "New daily drops 5:00
    // AM Central." sentence is gone, replaced by a live "time left today"
    // readout.
    expect(screen.queryByText(/new daily drops 5:00 am central\./i)).toBeNull();
    expect(screen.getByText(/\d+(:\d{2}){1,2} left today/)).toBeVisible();
    expect(screen.getByRole("button", { name: /▶ race/i })).toBeEnabled();
    // PKG-06: the hero IS yesterday's daily, so the "Yesterday's results"
    // recap now reuses the hero's own (already-fetched) board - one card,
    // not a silent hollow gap where a second, separately-fetched card used
    // to be suppressed. No board data was seeded for this challenge, so it
    // reads the shared BoardSnippet empty state, not a duplicate/second
    // board.
    const yesterdayCard = screen.getByRole("region", { name: /yesterday's results/i });
    expect(within(yesterdayCard).getByText(/no completed runs yet\./i)).toBeVisible();
    // And the silent fallback pair must NOT be the hero.
    expect(screen.queryByText(fullTextMatch(/Apple → Fruit/), { selector: "strong" })).toBeNull();
  });

  it("PKG-06: pre-drop, a populated hero board renders as the 'Yesterday's results' recap with a single board fetch (reuse, not a duplicate request)", async () => {
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      start: "Mars",
      target: "Water",
    });
    const fetchImpl = createFetchMock({
      challenges: [yesterdayChallenge],
      boardByChallenge: {
        "challenge-0002": {
          placements: [
            { accountId: "acc-other", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
          ],
        },
      },
    });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    // The region itself (an empty-board `BoardSnippet`) renders on first
    // paint, independent of the board fetch - `findByRole` can resolve
    // before "Ari" lands, so its own content needs an awaited `findByText`
    // too, not a synchronous `getByText` right after.
    const yesterdayCard = await screen.findByRole("region", { name: /yesterday's results/i });
    expect(await within(yesterdayCard).findByText(/ari/i)).toBeVisible();
    expect(within(yesterdayCard).getByText("#1")).toBeVisible();
    await waitFor(() => expect(boardCalls(fetchImpl, "challenge-0002")).toBe(1));
  });

  it("PKG-06: no yesterday's daily in the catalog - still never a bare hero, falls back to a compact link to Stats with no false 'never happened' claim", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    // Deliberately NOT a "Yesterday's results"/board region - there is no
    // prior daily to recap, and showing today's own (hero's) live board here
    // would be scouting (spec: "the player has no stake in today's board
    // yet, and it discourages scouting").
    expect(screen.queryByRole("region", { name: /yesterday's results/i })).toBeNull();
    // PKG-06 remainder fix: this same `!yesterdaysDaily` fallback also fires
    // in the ordinary post-drop case (yesterday's daily aged out of the
    // active catalog) - not only "no daily ever ran," the only case this
    // fixture actually models. The old "No prior daily board yet." copy
    // read "yet" as a claim that none ever existed, which is false in that
    // far more common case - the fix drops the claim entirely rather than
    // asserting something the client can't actually verify either way.
    expect(screen.queryByText(/no prior daily board yet/i)).toBeNull();
    const seeBoards = screen.getByRole("button", { name: /see stats/i });
    expect(seeBoards).toBeVisible();

    await user.click(seeBoards);
    expect(await screen.findByRole("heading", { name: "Stats" })).toBeVisible();
  });

  it("post-drop: today's daily heroes with its plain flavor badge, unchanged, but now also carries a live countdown to tomorrow's drop (PKG-07)", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      start: "Apple",
      target: "Fruit",
    });
    const fetchImpl = createFetchMock({ challenges: [todayChallenge] });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.getByText("Recognizable")).toBeVisible();
    expect(screen.queryByText(/yesterday's daily/i)).toBeNull();
    // PKG-07: the mockup's own Step-1-Home shows a countdown for a real
    // TODAY's daily too (counting down to TOMORROW's drop), not just the
    // pre-drop yesterday-framed case the old static sentence was limited to.
    expect(screen.queryByText(/new daily drops 5:00 am central\./i)).toBeNull();
    expect(screen.getByText(/\d+(:\d{2}){1,2} left today/)).toBeVisible();
  });

  it("no dailies at all: keeps the default-challenge hero with no badge and no drop-time line or countdown", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.getByText(fullTextMatch(/Apple → Fruit/), { selector: "strong" })).toBeVisible();
    expect(screen.queryByText(/yesterday's daily/i)).toBeNull();
    expect(screen.queryByText(/new daily drops/i)).toBeNull();
    expect(screen.queryByText(/left today/i)).toBeNull();
  });
});

describe("Home v2: guarded streak/trend chip (Increment 4)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("pre-play: shows the streak plus a below-guard progress chip (F4) when the account hasn't cleared the 30d ranking guard", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      accountDailyStreak: 5,
      accountTrend30: { avgPlacement: null, playedCount: 4, ranked: false, guard: 10 },
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/🔥 5-day streak/)).toBeVisible();
    expect(screen.queryByText(/30-day avg/i)).toBeNull();
    // F4: below-guard no longer goes silent - it reads as progress, same
    // framing Boards' own unranked section uses.
    expect(screen.getByText(/4\/10 dailies/)).toBeVisible();
  });

  it("F4: shows the below-guard progress chip alone when there's no streak either", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      accountDailyStreak: 0,
      accountTrend30: { avgPlacement: null, playedCount: 4, ranked: false, guard: 10 },
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByText(/4\/10 dailies/)).toBeVisible();
    expect(screen.queryByText(/day streak/i)).toBeNull();
    expect(screen.queryByText(/30-day avg/i)).toBeNull();
  });

  it("post-play: shows both the streak and the 30d avg chip once ranked", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 2, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      accountDailyStreak: 12,
      accountTrend30: { avgPlacement: 2.4, playedCount: 26, ranked: true, guard: 10 },
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    // Settle into the post-play (finished) state first - Home re-renders the
    // chip inside the finished branch once its board fetch lands, so an
    // element grabbed during the transient pre-play frame can detach.
    expect(await screen.findByText(/done · you finished #2/i)).toBeVisible();
    expect(screen.getByText(/🔥 12-day streak/)).toBeVisible();
    expect(screen.getByText(/30-day avg #2\.4 \(26 dailies\)/)).toBeVisible();
  });

  it("omits the streak text at 0 but still shows the trend chip once ranked", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      accountDailyStreak: 0,
      accountTrend30: { avgPlacement: 3.1, playedCount: 15, ranked: true, guard: 10 },
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    expect(screen.queryByText(/day streak/i)).toBeNull();
    expect(screen.getByText(/30-day avg #3\.1 \(15 dailies\)/)).toBeVisible();
  });

  it("renders no chip at all when the streak is 0 and the trend is unranked (guard inheritance)", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      accountDailyStreak: 0,
      accountTrend30: { avgPlacement: null, playedCount: 0, ranked: false, guard: 10 },
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    expect(screen.queryByText(/day streak/i)).toBeNull();
    expect(screen.queryByText(/30-day avg/i)).toBeNull();
  });

  it("PKG-06: a true guest (no identified session yet - invariant 4, identity only at Start/Create) sees a stats-independent 'Start your streak today' line instead of no row at all", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    expect(screen.getByText(/start your streak today/i)).toBeVisible();
  });

  it("PKG-06: does NOT show the guest streak line for an identified account whose stats simply haven't loaded yet (the same loaded/pending ambiguity teachingGate.ts already had to disambiguate)", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      delayedAccountStats: new Promise(() => {}),
    });
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByRole("button", { name: /▶ race/i });
    expect(screen.queryByText(/start your streak today/i)).toBeNull();
    expect(screen.queryByText(/day streak/i)).toBeNull();
    expect(screen.queryByText(/30-day avg/i)).toBeNull();
  });
});

describe("PKG-07 (council 2026-07-19, owner-proxy ruling): daily ritual identity", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("'Daily #N' appears identically on Home's hero, Boards' Today segment, and the pre-race preview for the same daily", async () => {
    const user = userEvent.setup();
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      flavor: "weird",
      dailyNumber: 7,
    });
    const fetchImpl = createFetchMock({ challenges: [todayChallenge] });
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    // Home's hero.
    expect(await screen.findByText(/weird · daily #7/i)).toBeVisible();

    // Boards' Today segment.
    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Stats" }));
    expect(await screen.findByText(/weird · daily #7/i)).toBeVisible();

    // The pre-race preview, reached from Home's Race button.
    await user.click(within(nav).getByRole("button", { name: "Home" }));
    await user.click(await screen.findByRole("button", { name: /▶ race/i }));
    expect(await screen.findByRole("button", { name: /start race/i })).toBeVisible();
    expect(screen.getByText(/weird · daily #7/i)).toBeVisible();
  });

  it("Home pre-play shows a live 'time left today' countdown that visibly decreases across a reload, replacing the static drop-time sentence (acceptance criterion 2)", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" });

    // 4:59:58 AM Central - `todayUtc` pins the DAILY selection deterministically;
    // the countdown itself reads the real (here, mocked) system clock
    // independently, exactly as it does in production.
    vi.setSystemTime(new Date("2026-07-17T09:59:58.000Z"));
    const first = render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ challenges: [todayChallenge] })}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );
    expect(await first.findByText("0:02 left today")).toBeVisible();
    expect(first.queryByText(/new daily drops 5:00 am central\./i)).toBeNull();
    first.unmount();
    // `first` mounting itself synced `?challenge=challenge-0001` onto the
    // real, file-shared `window.location` (App's own syncChallengeUrl) -
    // reset it, the same way `beforeEach` does before every test, so
    // `second` below boots fresh on Home rather than reading that leftover
    // query param as "the user navigated straight to Detail."
    window.history.pushState({}, "", "/");

    // A later "reload" (a fresh mount, standing in for App.tsx's own
    // remount-on-refresh) two seconds later reads a smaller remainder -
    // the acceptance bar's literal "visibly decreases across a reload".
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z")); // exactly the drop
    const second = render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ challenges: [todayChallenge] })}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );
    expect(await second.findByText("24:00:00 left today")).toBeVisible();
  });

  it("You shows a streak tile reusing accountStats.dailyStreak", async () => {
    const fetchImpl = createFetchMock({ accountDailyStreak: 9 });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "You" }));

    expect(screen.getByRole("heading", { name: "Your stats" })).toBeVisible();
    expect(await screen.findByText("Streak")).toBeVisible();
    expect(screen.getByText("9 days")).toBeVisible();
  });

  it("You's stat tiles show real zeros for confirmed-zero totals and 'No data yet.' (never a bare '-') for a never-completed account (PKG-11)", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "You" }));
    await screen.findByText("Streak");

    const grid = document.querySelector(".stat-grid") as HTMLElement;
    const valueFor = (label: string) =>
      within(grid).getByText(label).nextElementSibling?.textContent;

    // Confirmed zeros (the fixture's default: an identified account that has
    // never played) render as real numbers, not a placeholder.
    await waitFor(() => expect(valueFor("Attempts")).toBe("0"));
    expect(valueFor("Streak")).toBe("0 days");
    expect(valueFor("Completed")).toBe("0");
    expect(valueFor("DNFs")).toBe("0");
    expect(valueFor("Completed clicks")).toBe("0");
    // `bestElapsedMs`/`bestClicks` are legitimately `null` (no completion to
    // measure yet, not a missing-data bug) - "No data yet." matches
    // StatsList's own established convention rather than a bare "-".
    expect(valueFor("Best speed")).toBe("No data yet.");
    expect(valueFor("Best clicks")).toBe("No data yet.");
    expect(within(grid).queryByText("-")).toBeNull();
  });

  it("How-to-play establishes the daily cadence, not just the rules (acceptance criterion 3)", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    // Scoped to the first-visit strip specifically - QF-05 added a second,
    // permanent "how to play" trigger in the footer that opens the exact
    // same popup, so an unscoped query now matches both.
    const strip = await screen.findByRole("note");
    await user.click(within(strip).getByRole("button", { name: /how to play/i }));
    const dialog = await screen.findByRole("dialog", { name: /how to play/i });
    expect(
      within(dialog).getByText(/a new pair drops every day at 5:00 am central.*keep your streak alive/i),
    ).toBeVisible();
  });
});

describe("Increment 5: Play-another suggestion + create-random (Browse full card spec)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the specific Play-another suggestion with player count on Home's post-play card, opening Detail (Browse-card-consistent route) on click", async () => {
    const [daily, other] = twoChallenges();
    const fetchImpl = createFetchMock({
      challenges: [daily, other],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      playAnotherSuggestion: other,
      challengesSummary: [{ challengeId: "challenge-0002", playerCount: 4, best: null }],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const card = await screen.findByRole("region", { name: /play another challenge/i });
    const suggestionButton = await within(card).findByRole(
      "button",
      { name: /🏁 mars → water · 4 players/i },
    );
    // PKG-05: demoted to the existing `.secondary-button` treatment (mockup-
    // race-flow-v3 panel 3's smaller bordered card) rather than the default
    // solid-cyan weight - PlayAnotherCard is shared with Results, so this
    // fix lands on Home's card too (a deliberate twofer, not a side effect).
    expect(suggestionButton).toHaveClass("secondary-button");
    await user.click(suggestionButton);

    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText(/water/i)).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0002");
  });

  it("swaps in 'Create a random new one' once the account has started everything, and lands on the new challenge's Detail on success", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      playAnotherSuggestion: null,
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const card = await screen.findByRole("region", { name: /play another challenge/i });
    const randomButton = await within(card).findByRole("button", { name: /create a random new one/i });
    // PKG-05: the "empty" slot's fallback CTA gets the same demotion as the
    // "ready" suggestion button above - one consistent look for whichever
    // alternative fills this slot.
    expect(randomButton).toHaveClass("secondary-button");
    await user.click(randomButton);

    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText(/ice/i)).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-random-1");
    expect(randomChallengeCalls(fetchImpl)).toBe(1);
  });

  it("shows a friendly 429 error respecting Retry-After from the create-random action", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      playAnotherSuggestion: null,
      randomChallengeError: {
        status: 429,
        code: "random_challenge_quota_exceeded",
        message: "You've reached the hourly limit for random challenges. Try again later.",
        retryAfterSeconds: 3600,
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const card = await screen.findByRole("region", { name: /play another challenge/i });
    await user.click(await within(card).findByRole("button", { name: /create a random new one/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You've reached the hourly limit for random challenges. Try again later. (retry in 60 minutes)",
    );
    expect(screen.queryByRole("region", { name: /challenge detail/i })).toBeNull();
  });

  it("shows the mandated 503 copy from the create-random action", async () => {
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      playAnotherSuggestion: null,
      randomChallengeError: {
        status: 503,
        code: "random_challenge_unavailable",
        message: "Could not find a random challenge right now. Try again.",
        retryAfterSeconds: 5,
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const card = await screen.findByRole("region", { name: /play another challenge/i });
    await user.click(await within(card).findByRole("button", { name: /create a random new one/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wikipedia wasn't cooperating — try again.",
    );
  });

  it("disables the button and fires only one request while a random-challenge creation is in flight (no double-fire)", async () => {
    const deferredResponse = createDeferredResponse({
      challenge: {
        id: "challenge-random-1",
        label: "Random Find",
        mode: "solo",
        origin: "manual",
        start: { title: "Comet" },
        target: { title: "Ice" },
        ruleset: "ranked_classic",
        source: "wikipedia_random",
      },
      disposition: "created",
      nomination: "not_requested",
    });
    const fetchImpl = createFetchMock({
      challenges: [twoChallenges()[0]],
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-1", accountId: "acc-1", displayName: "Vijay", elapsedMs: 42_000, clickCount: 6 }),
      ],
      playAnotherSuggestion: null,
      delayedRandomChallenge: deferredResponse.promise,
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const card = await screen.findByRole("region", { name: /play another challenge/i });
    const button = await within(card).findByRole("button", { name: /create a random new one/i });
    await user.click(button);

    expect(await screen.findByRole("button", { name: /rolling the dice on wikipedia/i })).toBeDisabled();
    // A second click while disabled/in-flight must not fire a second request
    // - the shared App-level lock (spec: "a per-account concurrency cap of 1
    // in-flight request").
    await user.click(screen.getByRole("button", { name: /rolling the dice on wikipedia/i }));
    expect(randomChallengeCalls(fetchImpl)).toBe(1);

    deferredResponse.resolve();
    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText(/ice/i)).toBeVisible();
    expect(randomChallengeCalls(fetchImpl)).toBe(1);
  });

  it("prompts for identity before creating a random challenge from Browse for an anonymous visitor, then resumes after guest signup", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    const nav = await screen.findByRole("navigation", { name: /vwiki race views/i });
    await user.click(within(nav).getByRole("button", { name: "Challenges" }));
    await user.click(await screen.findByRole("button", { name: /create a random new one/i }));

    const identityDialog = await screen.findByRole("dialog", { name: /save your stats/i });
    await user.click(within(identityDialog).getByRole("button", { name: /^guest$/i }));
    await user.type(screen.getByLabelText(/display name/i), "Vijay");
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

    const detail = await screen.findByRole("region", { name: /challenge detail/i });
    expect(within(detail).getByText(/ice/i)).toBeVisible();
    expect(randomChallengeCalls(fetchImpl)).toBe(1);
  });
});

describe("Boards v1: Today/Yesterday daily views (Increment 3)", () => {
  it("renders the Today/Yesterday/7d/30d/Lifetime segments, defaulting to Today", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    const segments = within(board).getAllByRole("tab");
    expect(segments.map((tab) => tab.textContent)).toEqual(["Today", "Yesterday", "7d", "30d", "Lifetime"]);
    expect(within(board).getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls the newly active segment into view on selection (Bug B: keeps Lifetime tap-reachable once the control scrolls horizontally on narrow widths)", async () => {
    const scrollIntoViewSpy = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    try {
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: "Stats" }));
      const board = screen.getByRole("region", { name: "Stats" });
      scrollIntoViewSpy.mockClear(); // drop the mount-time call for the default "Today" segment

      await user.click(within(board).getByRole("tab", { name: "Lifetime" }));

      expect(scrollIntoViewSpy).toHaveBeenCalledWith(
        expect.objectContaining({ block: "nearest", inline: "nearest" }),
      );
      // Called on the Lifetime button itself, not some other tab.
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        within(board).getByRole("tab", { name: "Lifetime" }),
      );
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("moves roving tabindex focus with ArrowLeft/ArrowRight and selects the newly-focused segment, wrapping at both ends (PKG-10)", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    const [today, yesterday, sevenDay, thirtyDay, lifetime] = within(board).getAllByRole("tab");

    // Roving tabindex: only the selected tab is in the Tab order.
    expect(today).toHaveAttribute("tabindex", "0");
    for (const tab of [yesterday, sevenDay, thirtyDay, lifetime]) {
      expect(tab).toHaveAttribute("tabindex", "-1");
    }

    today.focus();
    await user.keyboard("{ArrowRight}");
    expect(yesterday).toHaveFocus();
    expect(yesterday).toHaveAttribute("aria-selected", "true");
    expect(yesterday).toHaveAttribute("tabindex", "0");
    expect(today).toHaveAttribute("aria-selected", "false");
    expect(today).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowLeft}");
    expect(today).toHaveFocus();
    expect(today).toHaveAttribute("aria-selected", "true");

    // Wraps backward past the first segment to the last ("Lifetime").
    await user.keyboard("{ArrowLeft}");
    expect(lifetime).toHaveFocus();
    expect(lifetime).toHaveAttribute("aria-selected", "true");

    // Wraps forward past the last segment back to the first ("Today").
    await user.keyboard("{ArrowRight}");
    expect(today).toHaveFocus();
    expect(today).toHaveAttribute("aria-selected", "true");
  });

  it("completes the ARIA tabs pattern: each tab's aria-controls points at a real role=tabpanel labelled by the active tab (PKG-10 remainder fix)", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    const [today, yesterday] = within(board).getAllByRole("tab");
    const panel = within(board).getByRole("tabpanel");

    // Every tab controls the one (swapped) panel - it exists and has an id.
    const panelId = panel.getAttribute("id");
    expect(panelId).toBeTruthy();
    for (const tab of within(board).getAllByRole("tab")) {
      expect(tab.getAttribute("aria-controls")).toBe(panelId);
    }
    // The panel is labelled by whichever tab is currently active.
    expect(panel.getAttribute("aria-labelledby")).toBe(today.getAttribute("id"));

    await user.click(yesterday);
    expect(within(board).getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      yesterday.getAttribute("id"),
    );
  });

  it("shows today's deduped board - rank, name, time·clicks - and highlights the viewer's own row", async () => {
    // PKG-01: a genuine today's daily, not `twoChallenges()`'s plain fixture
    // (no dailyFeature/origin) - Boards' Today segment now shows its own
    // honest empty state for a non-daily "default" selection instead of
    // silently falling back to an arbitrary challenge.
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" })],
      boardByChallenge: {
        "challenge-0001": {
          placements: [
            { accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
            { accountId: "acc-1", displayName: "Vijay", placement: 2, elapsedMs: 25_000, clickCount: 4 },
          ],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    expect(await within(board).findByText("Ari")).toBeVisible();
    expect(within(board).getByText("#1")).toBeVisible();
    expect(within(board).getByText("0:20 · 3 clk")).toBeVisible();
    expect(within(board).getByText("Vijay")).toBeVisible();
    expect(within(board).getByText("0:25 · 4 clk")).toBeVisible();
    expect(within(board).getByText(/\(you\)/i)).toBeVisible();
  });

  it("shows a muted DNF section below finishers, with no path disclosure anywhere in Boards", async () => {
    // PKG-01: see the "shows today's deduped board" test above for why this
    // is a real daily fixture now, not `twoChallenges()`.
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" })],
      boardByChallenge: {
        "challenge-0001": {
          placements: [
            { accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
          ],
          dnfs: [
            { accountId: "acc-1", displayName: "Vijay", clickCount: 2, elapsedMs: 8_000 },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    const dnfSection = await within(board).findByRole("region", { name: "DNF" });
    expect(within(dnfSection).getByText("Vijay")).toBeVisible();
    expect(within(dnfSection).getByText("0:08 · 2 clk")).toBeVisible();
    expect(within(dnfSection).getByText(/\(you\)/i)).toBeVisible();
    // Invariant 5 / task scope: Boards drops per-run path disclosure
    // entirely this increment - that's Detail-only content now (see the
    // "labels leaderboard provenance"/"View winning path" tests above).
    expect(within(board).queryByText(/view path/i)).toBeNull();
    expect(within(board).queryByText(/view winning path/i)).toBeNull();
  });

  it("shows a Race CTA on Today when the viewer hasn't finished, wired to the pre-race preview", async () => {
    // PKG-01: see the "shows today's deduped board" test above for why this
    // is a real daily fixture now, not `twoChallenges()`.
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" })],
      boardByChallenge: { "challenge-0001": { placements: [], dnfs: [] } },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = await screen.findByRole("region", { name: "Stats" });
    const raceCta = await within(board).findByRole("button", { name: /race today's daily/i });
    // PKG-04 (owner-proxy ruling): non-committal preview CTA - teal
    // `.race-preview-button`, not the coral `.start-race-button`.
    expect(raceCta).toHaveClass("race-preview-button");
    expect(raceCta).not.toHaveClass("start-race-button");
    await user.click(raceCta);
    expect(await screen.findByRole("button", { name: /start race/i })).toBeVisible();
  });

  it("renders the Race CTA after the DNF section and the 'Paths hidden' footnote, not before the board (PKG-10, mockup-boards-trends order)", async () => {
    const fetchImpl = createFetchMock({
      challenges: [dailyChallenge("challenge-0001", { dailyDate: "2026-07-17" })],
      boardByChallenge: {
        "challenge-0001": {
          placements: [{ accountId: "acc-ari", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 }],
          dnfs: [{ accountId: "acc-mike", displayName: "MikeD", clickCount: 3, elapsedMs: 9_000 }],
        },
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    const dnfSection = await within(board).findByRole("region", { name: "DNF" });
    const footnote = within(board).getByText(/paths hidden until you.ve played/i);
    const raceCta = within(board).getByRole("button", { name: /race today's daily/i });

    // DOCUMENT_POSITION_FOLLOWING (4): raceCta comes after both.
    expect(dnfSection.compareDocumentPosition(raceCta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footnote.compareDocumentPosition(raceCta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the Race CTA once the viewer has a completed placement, and never shows it on Yesterday", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      start: "Apple",
      target: "Fruit",
    });
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      start: "Mars",
      target: "Water",
      label: "Yesterday's Daily",
    });
    const fetchImpl = createFetchMock({
      challenges: [todayChallenge, yesterdayChallenge],
      boardByChallenge: {
        "challenge-0001": {
          placements: [{ accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 20_000, clickCount: 3 }],
          dnfs: [],
        },
        "challenge-0002": { placements: [], dnfs: [] },
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await within(board).findByText("Vijay");
    expect(within(board).queryByRole("button", { name: /race today's daily/i })).toBeNull();

    await user.click(within(board).getByRole("tab", { name: "Yesterday" }));
    await waitFor(() => expect(within(board).queryByText("Vijay")).toBeNull());
    expect(within(board).queryByRole("button", { name: /race today's daily/i })).toBeNull();
  });

  it("switches to Yesterday and shows that daily's own board, never mixing the two", async () => {
    const todayChallenge = dailyChallenge("challenge-0001", {
      dailyDate: "2026-07-17",
      start: "Apple",
      target: "Fruit",
    });
    const yesterdayChallenge = dailyChallenge("challenge-0002", {
      dailyDate: "2026-07-16",
      start: "Mars",
      target: "Water",
      label: "Yesterday's Daily",
    });
    const fetchImpl = createFetchMock({
      challenges: [todayChallenge, yesterdayChallenge],
      boardByChallenge: {
        "challenge-0001": {
          placements: [{ accountId: "acc-today", displayName: "Today Runner", placement: 1, elapsedMs: 10_000, clickCount: 2 }],
          dnfs: [],
        },
        "challenge-0002": {
          placements: [{ accountId: "acc-yesterday", displayName: "Yesterday Runner", placement: 1, elapsedMs: 15_000, clickCount: 3 }],
          dnfs: [],
        },
      },
    });
    const user = userEvent.setup();
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={fetchImpl}
        storage={claimedStorage()}
        todayUtc={() => "2026-07-17"}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    expect(await within(board).findByText("Today Runner")).toBeVisible();
    expect(within(board).queryByText("Yesterday Runner")).toBeNull();

    await user.click(within(board).getByRole("tab", { name: "Yesterday" }));
    expect(within(board).queryByText("Today Runner")).toBeNull();
    expect(await within(board).findByText("Yesterday Runner")).toBeVisible();
  });

  it("shows a graceful empty state when yesterday's daily is missing from the catalog", async () => {
    const fetchImpl = createFetchMock({ challenges: [twoChallenges()[0]] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "Yesterday" }));
    expect(within(board).getByText(/yesterday's daily isn't available/i)).toBeVisible();
  });
});

describe("Boards v2: 7d/30d/lifetime trends (Increment 4)", () => {
  it("shows the guard sub-header, ranked rows, and the progress-framed unranked section for 7d", async () => {
    const fetchImpl = createFetchMock({
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 3,
          ranked: [
            { accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 3 },
          ],
          unranked: [
            { accountId: "acc-2", displayName: "Ari", playedCount: 1 },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "7d" }));

    expect(await within(board).findByText(/rolling 7 days · ranked by average placement · play ≥3 dailies to rank/i)).toBeVisible();
    expect(within(board).getByText("1.")).toBeVisible();
    expect(within(board).getByText(/vijay/i)).toBeVisible();
    expect(within(board).getByText(/avg #1\.3 \(3 dailies\)/)).toBeVisible();
    expect(within(board).getByText(/\(you\)/i)).toBeVisible();

    const unrankedSection = within(board).getByRole("region", { name: "Not yet ranked" });
    expect(within(unrankedSection).getByText(/ari/i)).toBeVisible();
    expect(within(unrankedSection).getByText(/1\/3 dailies/)).toBeVisible();
  });

  it("switches windows on segment change - 30d's guard is 10, framed as progress toward it", async () => {
    const fetchImpl = createFetchMock({
      boardsTrendsByWindow: {
        "30": {
          window: "30",
          guard: 10,
          ranked: [],
          unranked: [{ accountId: "acc-1", displayName: "Vijay", playedCount: 4 }],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "30d" }));

    expect(await within(board).findByText(/rolling 30 days · ranked by average placement · play ≥10 dailies to rank/i)).toBeVisible();
    expect(within(board).getByText(/4\/10 dailies/)).toBeVisible();
  });

  it("expands the viewer's own ranked row into their last 3 dailies as placement/DNF + time·clicks (invariant 1)", async () => {
    const recentDaily1 = dailyChallenge("challenge-0011", { dailyDate: "2026-07-18", start: "A", target: "B" });
    const recentDaily2 = dailyChallenge("challenge-0012", { dailyDate: "2026-07-17", start: "C", target: "D" });
    const recentDaily3 = dailyChallenge("challenge-0013", { dailyDate: "2026-07-16", start: "E", target: "F" });
    const fetchImpl = createFetchMock({
      challenges: [recentDaily1, recentDaily2, recentDaily3],
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 3,
          ranked: [{ accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 3 }],
          unranked: [],
        },
      },
      boardByChallenge: {
        "challenge-0011": {
          placements: [{ accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 5_000, clickCount: 2 }],
          dnfs: [],
        },
        "challenge-0012": {
          placements: [],
          dnfs: [{ accountId: "acc-1", displayName: "Vijay", clickCount: 3, elapsedMs: 8_000 }],
        },
        "challenge-0013": { placements: [], dnfs: [] },
      },
    });
    const user = userEvent.setup();
    render(
      <App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} todayUtc={() => "2026-07-18"} />,
    );

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "7d" }));
    await user.click(await within(board).findByRole("button", { name: /vijay.*avg #1\.3/i }));

    expect(await within(board).findByText("2026-07-18")).toBeVisible();
    expect(within(board).getByText(/#1 · 0:05 · 2 clk/)).toBeVisible();
    expect(within(board).getByText("2026-07-17")).toBeVisible();
    expect(within(board).getByText(/dnf · 0:08 · 3 clk/i)).toBeVisible();
    expect(within(board).getByText("2026-07-16")).toBeVisible();
    expect(within(board).getByText(/not played/i)).toBeVisible();
  });

  it("shows a muted ▲/▼/– trend arrow per ranked row, comparing avgPlacement to the previous window (F3)", async () => {
    const fetchImpl = createFetchMock({
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 3,
          ranked: [
            // Lower avgPlacement than prevAvgPlacement -> improved -> ▲.
            { accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 3, prevAvgPlacement: 2.1 },
            // Higher avgPlacement than prevAvgPlacement -> declined -> ▼.
            { accountId: "acc-2", displayName: "Ari", avgPlacement: 3.0, playedCount: 4, prevAvgPlacement: 1.5 },
            // No previous window standing at all -> –.
            { accountId: "acc-3", displayName: "Sam", avgPlacement: 2.0, playedCount: 3, prevAvgPlacement: null },
          ],
          unranked: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "7d" }));

    await within(board).findByText(/vijay/i);
    expect(within(board).getByLabelText(/improved vs\. previous window/i)).toHaveTextContent("▲");
    expect(within(board).getByLabelText(/declined vs\. previous window/i)).toHaveTextContent("▼");
    expect(within(board).getByLabelText(/no previous window to compare/i)).toHaveTextContent("–");
  });

  it("renders every trend copy off the server-echoed guard, never a client re-derivation (F5)", async () => {
    // A deliberately "wrong" guard (5, not the formula's 3 for a 7d window)
    // proves the client renders whatever the server echoed rather than
    // recomputing it locally - if it were re-deriving, this would read 3.
    const fetchImpl = createFetchMock({
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 5,
          ranked: [],
          unranked: [{ accountId: "acc-1", displayName: "Vijay", playedCount: 2 }],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "7d" }));

    expect(await within(board).findByText(/play ≥5 dailies to rank/i)).toBeVisible();
    expect(within(board).getByText(/2\/5 dailies/)).toBeVisible();
  });

  it("renders an error banner + Retry on a failed trends fetch, never the 'no one has cleared the guard' empty state (F6)", async () => {
    const fetchImpl = createFetchMock({
      boardsTrendsFailOnce: true,
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 3,
          ranked: [{ accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 3 }],
          unranked: [],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });
    await user.click(within(board).getByRole("tab", { name: "7d" }));

    expect(await within(board).findByRole("alert")).toHaveTextContent(/couldn.t load this trend/i);
    expect(within(board).queryByText(/nobody.s played enough dailies to rank yet/i)).toBeNull();

    await user.click(within(board).getByRole("button", { name: /retry/i }));

    expect(await within(board).findByText(/vijay/i)).toBeVisible();
    expect(within(board).queryByRole("alert")).toBeNull();
  });

  it("PKG-14 (direct owner feedback): Lifetime shows an 'Everyone who's played' roster covering custom-only racers - absent from 7d", async () => {
    const fetchImpl = createFetchMock({
      boardsTrendsByWindow: {
        "7": {
          window: "7",
          guard: 1,
          ranked: [],
          unranked: [],
        },
        lifetime: {
          window: "lifetime",
          guard: 2,
          ranked: [{ accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 4 }],
          unranked: [],
          roster: [
            { accountId: "acc-1", displayName: "Vijay", racesStarted: 4, finishes: 4, wins: 3 },
            // Custom-only racers `listDailyTrends` can never surface -
            // exactly the owner's reported gap ("fran, lollerskates").
            { accountId: "acc-fran", displayName: "FranTheGreat", racesStarted: 1, finishes: 0, wins: 0 },
            { accountId: "acc-loller", displayName: "lollerskates", racesStarted: 2, finishes: 2, wins: 1 },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: "Stats" }));
    const board = screen.getByRole("region", { name: "Stats" });

    await user.click(within(board).getByRole("tab", { name: "7d" }));
    await within(board).findByText(/rolling 7 days/i);
    expect(within(board).queryByText(/everyone who.s played/i)).toBeNull();

    await user.click(within(board).getByRole("tab", { name: "Lifetime" }));
    const roster = await within(board).findByRole("region", { name: "Everyone who's played" });

    expect(within(roster).getByText(/franthegreat/i)).toBeVisible();
    expect(within(roster).getByText(/1 race · 0 finishes · 0 wins/i)).toBeVisible();
    expect(within(roster).getByText(/lollerskates/i)).toBeVisible();
    expect(within(roster).getByText(/2 races · 2 finishes · 1 win/i)).toBeVisible();
    expect(within(roster).getByText(/daily rankings need 2 played dailies/i)).toBeVisible();
  });
});

function dailyChallenge(
  id: string,
  overrides: {
    dailyDate: string;
    flavor?: "recognizable" | "weird" | "hard";
    label?: string;
    start?: string;
    target?: string;
    selectionSource?: "automatic" | "community" | "admin";
    // PKG-07: server-computed sequential daily number - optional (see
    // DailyFeature's own doc comment), so fixtures that don't care about
    // numbering can keep omitting it without any behavior change.
    dailyNumber?: number;
  },
): Challenge {
  const selectionSource = overrides.selectionSource ?? "admin";
  return {
    id,
    label: overrides.label ?? `Daily ${overrides.dailyDate}`,
    isActive: true,
    mode: "daily",
    start: { title: overrides.start ?? "Apple" },
    target: { title: overrides.target ?? "Fruit" },
    ruleset: "ranked_classic",
    origin: "daily",
    dailyDate: overrides.dailyDate,
    dailyFeature: {
      dailyDate: overrides.dailyDate,
      flavor: overrides.flavor ?? "recognizable",
      selectionSource,
      dailyNumber: overrides.dailyNumber,
    },
    source: selectionSource === "automatic" ? "wikipedia_random" : "curated",
  };
}

function createFetchMock(options?: {
  challenges?: Challenge[];
  delayedFruitArticle?: Promise<Response>;
  delayedClickResponse?: Promise<Response>;
  delayedChallenges?: Promise<Response>;
  startUnauthorizedOnce?: boolean;
  clickUnauthorizedOnce?: boolean;
  clickSyncFailureOnce?: boolean;
  startConflictOnce?: boolean;
  activeRunAfterConflict?: boolean;
  createUnauthorizedOnce?: boolean;
  abandonFailsOnce?: boolean;
  abandonUnauthorizedOnce?: boolean;
  // PKG-03: models the server's own persisted elapsedMs on a genuine
  // abandon response, distinct from (and here deliberately different than)
  // whatever the client's own timer read at End-Run-click time.
  abandonElapsedMs?: number;
  activeRun?: ReturnType<typeof activeRunFixture> | null;
  delayedActiveRun?: Promise<Response>;
  targetPreviewFailure?: boolean;
  leaderboardRows?: ReturnType<typeof leaderboardRow>[];
  // Per-challenge leaderboard rows, keyed by challenge id - needed once a
  // single render needs two *different* boards at once (Home's daily hero
  // fetches today's AND yesterday's daily leaderboards independently).
  // Takes precedence over the single flat `leaderboardRows` above for any
  // challenge id it covers.
  leaderboardRowsByChallenge?: Record<string, ReturnType<typeof leaderboardRow>[]>;
  // Boards' daily-view board (GET .../board), keyed by challenge id. Falls
  // back to deriving placements/DNFs from leaderboardRowsByChallenge /
  // leaderboardRows above (splitting completed vs. abandoned rows) so tests
  // that already set those up don't need parallel board-only fixtures too.
  boardByChallenge?: Record<string, { placements?: unknown[]; dnfs?: unknown[] }>;
  runOldPath?: ServerPathStep[];
  accountAttempts?: number;
  accountCompleted?: number;
  // QF-09: totals.averageClicks/averageElapsedMs, for the You tab's "Avg
  // clicks"/"Avg speed" tiles - defaults to {0, 0} like the rest of
  // totals' zeroed fixture fields.
  accountAverages?: { averageClicks: number; averageElapsedMs: number };
  // Models totals.completed changing across successive /accounts/me/stats
  // reads (e.g. pre-race fetch vs. post-race refresh) - index N-1 for the
  // Nth call, holding the last entry once exhausted. Takes precedence over
  // the static accountCompleted above when provided (M2: RaceResults'
  // showFirstFinishRitual regression coverage).
  accountCompletedSequence?: number[];
  // Every call to /accounts/me/stats after the first returns this
  // never-resolving promise instead - models a post-race stats refetch that
  // never comes back, to prove the ritual hook no longer depends on it.
  delayedStatsAfterFirst?: Promise<Response>;
  // PKG-06: unlike delayedStatsAfterFirst above, this delays the FIRST
  // (and every) /accounts/me/stats read - models an identified account whose
  // stats simply haven't landed yet, to prove Home's guest-only streak-row
  // empty state doesn't fire for this case (the loaded/pending ambiguity
  // teachingGate.ts already solves the same way for the teaching gate).
  delayedAccountStats?: Promise<Response>;
  // Increment 4: Home's guarded streak/trend chip and Boards' trend
  // segments.
  accountDailyStreak?: number;
  accountTrend30?: { avgPlacement: number | null; playedCount: number; ranked: boolean; guard: number };
  boardsTrendsByWindow?: Record<string, {
    window: string;
    guard: number;
    ranked: Array<{
      accountId: string;
      displayName: string | null;
      avgPlacement: number;
      playedCount: number;
      prevAvgPlacement?: number | null;
    }>;
    unranked: Array<{ accountId: string; displayName: string | null; playedCount: number }>;
    // PKG-14: Lifetime-only "Everyone who's played" roster - absent on
    // 7d/30d fixtures, same as the real server response.
    roster?: Array<{ accountId: string; displayName: string | null; racesStarted: number; finishes: number; wins: number }>;
  }>;
  // F6: fails the very next `/api/v2/boards/trends` fetch once, then
  // succeeds normally (including on a manual Retry).
  boardsTrendsFailOnce?: boolean;
  leaderboardContext?: { isPersonalBest: boolean; rank: number | null };
  statsUnauthorizedAfterFirst?: boolean;
  creationOutcome?: CreateChallengeOutcome;
  canManageDailies?: boolean;
  // Every fixture challenge's only known non-start link resolves straight
  // to the target ("Fruit"), so every click mock always completes the run.
  // Setting this makes the recorded click come back "active" instead, so a
  // test can click a non-target link (any of Apple's other links, e.g.
  // "Apple tree") and then still End Run on a genuinely mid-flight run -
  // exercising the DNF Results variant/DNF-aware confirm copy.
  clickStaysActive?: boolean;
  dailyAdminState?: { nominations: DailyNomination[]; queueEntries: DailyQueueEntry[] };
  // Increment 5 (Browse full card spec + Play-another/create-random).
  challengesSummary?: Array<{ challengeId: string; playerCount: number; best: { elapsedMs: number; clickCount: number } | null }>;
  challengeOutcomes?: Array<{ challengeId: string; outcome: "completed" | "dnf"; best: { elapsedMs: number; clickCount: number } | null }>;
  playAnotherSuggestion?: Challenge | null;
  // `error` short-circuits a successful random-challenge creation with the
  // given status/code/message/Retry-After - models the server's documented
  // 429 in-progress/quota and 503 candidate-unavailable responses.
  randomChallengeError?: { status: number; code: string; message: string; retryAfterSeconds?: number };
  randomChallengeChallenge?: Challenge;
  // Delays the random-challenge response indefinitely (a caller resolves it
  // manually) - for no-double-fire assertions.
  delayedRandomChallenge?: Promise<Response>;
}) {
  let completed = false;
  let unauthorizedStartRemaining = options?.startUnauthorizedOnce ? 1 : 0;
  let unauthorizedClickRemaining = options?.clickUnauthorizedOnce ? 1 : 0;
  let clickSyncFailuresRemaining = options?.clickSyncFailureOnce ? 2 : 0;
  let conflictingStartRemaining = options?.startConflictOnce ? 1 : 0;
  let unauthorizedCreateRemaining = options?.createUnauthorizedOnce ? 1 : 0;
  let abandonFailuresRemaining = options?.abandonFailsOnce ? 2 : 0;
  let unauthorizedAbandonRemaining = options?.abandonUnauthorizedOnce ? 1 : 0;
  let boardsTrendsFailRemaining = options?.boardsTrendsFailOnce ? 1 : 0;
  let statsReads = 0;
  let challenges: Challenge[] = options?.challenges ?? [
    {
      id: "challenge-0001",
      label: "Challenge #1",
      sortOrder: 1,
      isActive: true,
      mode: "daily",
      start: { title: "Apple" },
      target: { title: "Fruit" },
      ruleset: "ranked_classic",
      source: "curated",
    },
  ];

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(input);
    const url = requestUrl.startsWith(apiOrigin)
      ? requestUrl.slice(apiOrigin.length)
      : requestUrl;
    const method = init?.method ?? "GET";

    if (url === "/api/v2/challenges" && method === "POST") {
      expect(readJsonBody(init)).toMatchObject({
        startTitle: "Mars",
        targetTitle: "Water",
      });
      if (unauthorizedCreateRemaining > 0) {
        unauthorizedCreateRemaining -= 1;
        return jsonError("unauthorized", "Session expired.", 401);
      }
      const challenge: Challenge = options?.creationOutcome?.challenge ?? {
        id: "challenge-0002",
        label: "Challenge #2",
        sortOrder: 2,
        isActive: true,
        mode: "daily",
        start: { title: "Mars" },
        target: { title: "Water" },
        ruleset: "ranked_classic",
        source: "curated",
        createdBy: {
          accountId: "acc-1",
          displayName: "Vijay",
          identityStatus: "claimed",
        },
      };
      challenges = [...challenges, challenge];
      return jsonResponse({
        challenge,
        disposition: options?.creationOutcome?.disposition ?? "created",
        nomination: options?.creationOutcome?.nomination ?? "not_requested",
      });
    }

    if (url === "/api/v2/challenges" && options?.delayedChallenges) {
      return options.delayedChallenges;
    }

    if (url === "/api/v2/challenges") {
      return jsonResponse({
        challenges,
      });
    }

    if (url === "/api/v2/identity/guest") {
      const body = readJsonBody(init) as { displayName: string };
      return jsonResponse({
        accountId: "acc-guest",
        displayName: body.displayName,
        token: "jwt-guest",
        status: "ghost",
      });
    }

    if (url === "/api/v2/identity/secure") {
      expect(readJsonBody(init)).toMatchObject({
        username: "vijay",
        password: "secret-pass",
      });
      return jsonResponse({
        accountId: "acc-claimed",
        displayName: "vijay",
        token: "jwt-claimed",
        status: "claimed",
      });
    }

    if (url === "/api/v2/identity/login") {
      expect(readJsonBody(init)).toMatchObject({
        username: "vijay",
        password: "secret-pass",
      });
      return jsonResponse({
        accountId: "acc-claimed",
        displayName: "vijay",
        token: "jwt-claimed",
        status: "claimed",
      });
    }

    if (url === "/api/v2/runs/start") {
      const startBody = readJsonBody(init) as { challengeId: string };
      expect(startBody).toEqual({ challengeId: expect.any(String) });
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer jwt-/),
      });
      if (unauthorizedStartRemaining > 0) {
        unauthorizedStartRemaining -= 1;
        return jsonError("unauthorized", "Session expired.", 401);
      }
      if (conflictingStartRemaining > 0) {
        conflictingStartRemaining -= 1;
        return jsonError("active_run_exists", "End the old run first.", 409);
      }
      const challenge = challenges.find((item) => item.id === startBody.challengeId) ?? challenges[0];
      return jsonResponse({
        run: {
          id: "run-1",
          challengeId: challenge.id,
          accountId: "acc-guest",
          status: "active",
          startTitle: challenge.start.title,
          targetTitle: challenge.target.title,
          clickCount: 0,
          startedAt: "2026-07-14T01:00:00.000Z",
          canonicalAccountId: "acc-guest",
          protocolVersion: 2,
        },
      });
    }

    if (url === "/api/v2/runs/active") {
      if (options?.delayedActiveRun) return options.delayedActiveRun;
      return jsonResponse({
        run: options?.activeRunAfterConflict && conflictingStartRemaining > 0
          ? null
          : options?.activeRun ?? null,
      });
    }

    if (url === "/api/v2/accounts/me/stats") {
      statsReads += 1;
      if (options?.delayedAccountStats) return options.delayedAccountStats;
      if (options?.statsUnauthorizedAfterFirst && statsReads > 1) {
        return jsonError("unauthorized", "Session expired.", 401);
      }
      if (options?.delayedStatsAfterFirst && statsReads > 1) {
        return options.delayedStatsAfterFirst;
      }
      const sequence = options?.accountCompletedSequence;
      const completed = sequence
        ? sequence[Math.min(statsReads, sequence.length) - 1]
        : options?.accountCompleted ?? 0;
      return jsonResponse({
        stats: {
          totals: {
            attempts: options?.accountAttempts ?? 0,
            completed,
            abandoned: 0,
            timedCompleted: 0,
            totalClicks: 0,
            bestClicks: null,
            bestElapsedMs: null,
            averageClicks: options?.accountAverages?.averageClicks ?? 0,
            averageElapsedMs: options?.accountAverages?.averageElapsedMs ?? 0,
          },
          topStarts: [], topTargets: [], mostVisited: [],
          dailyStreak: options?.accountDailyStreak ?? 0,
          trend30: options?.accountTrend30 ?? { avgPlacement: null, playedCount: 0, ranked: false, guard: 10 },
        },
      });
    }

    if (url.startsWith("/api/v2/boards/trends")) {
      if (boardsTrendsFailRemaining > 0) {
        boardsTrendsFailRemaining -= 1;
        return jsonError("boards_trends_failed", "Could not load trends.", 500);
      }
      const window = new URL(requestUrl).searchParams.get("window") ?? "7";
      const fixture = options?.boardsTrendsByWindow?.[window];
      return jsonResponse(fixture ?? {
        window,
        guard: window === "7" ? 3 : 10,
        ranked: [],
        unranked: [],
      });
    }

    if (url === "/api/v2/accounts/me/capabilities") {
      return jsonResponse({ canManageDailies: options?.canManageDailies ?? false });
    }

    if (url === "/api/v2/challenges/summary") {
      return jsonResponse({ challenges: options?.challengesSummary ?? [] });
    }

    if (url === "/api/v2/account/challenge-outcomes") {
      return jsonResponse({ outcomes: options?.challengeOutcomes ?? [] });
    }

    if (url === "/api/v2/challenges/suggestion") {
      return jsonResponse({ challenge: options?.playAnotherSuggestion ?? null });
    }

    if (url === "/api/v2/challenges/random" && method === "POST") {
      expect(readJsonBody(init)).toEqual({});
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer jwt-/),
        "Idempotency-Key": expect.any(String),
      });
      if (options?.delayedRandomChallenge) {
        return options.delayedRandomChallenge;
      }
      if (options?.randomChallengeError) {
        const { status, code, message, retryAfterSeconds } = options.randomChallengeError;
        return new Response(
          JSON.stringify({ error: { code, message } }),
          {
            status,
            headers: {
              "Content-Type": "application/json",
              ...(retryAfterSeconds !== undefined ? { "Retry-After": String(retryAfterSeconds) } : {}),
            },
          },
        );
      }
      const challenge: Challenge = options?.randomChallengeChallenge ?? {
        id: "challenge-random-1",
        label: "Random Find",
        sortOrder: 3,
        isActive: true,
        mode: "solo",
        origin: "manual",
        start: { title: "Comet" },
        target: { title: "Ice" },
        ruleset: "ranked_classic",
        source: "wikipedia_random",
      };
      challenges = [...challenges, challenge];
      return jsonResponse({ challenge, disposition: "created", nomination: "not_requested" });
    }

    if (url === "/api/v2/admin/dailies") {
      return jsonResponse(options?.dailyAdminState ?? { nominations: [], queueEntries: [] });
    }

    if (url === "/api/v2/runs/run-1/click") {
      expect(readJsonBody(init)).toMatchObject({
        clientEventId: expect.any(String),
        expectedStepNumber: 1,
        sourceTitle: "Apple",
        sourcePageId: 18978754,
        // Every non-"Fruit" link the fixture Apple article offers (e.g.
        // "Apple tree") resolves through the same generic catch-all below,
        // so most tests click "fruit" specifically but clickStaysActive
        // tests click some other link on purpose - assert shape, not the
        // exact destination.
        clickedAnchorText: expect.any(String),
        requestedTitle: expect.any(String),
        destinationTitle: expect.any(String),
        destinationPageId: expect.any(Number),
        decisionElapsedMs: expect.any(Number),
      });
      if (unauthorizedClickRemaining > 0) {
        unauthorizedClickRemaining -= 1;
        return jsonError("unauthorized", "Session expired.", 401);
      }
      if (clickSyncFailuresRemaining > 0) {
        clickSyncFailuresRemaining -= 1;
        return jsonError("network_error", "Offline while syncing click.", 503);
      }
      if (options?.delayedClickResponse) {
        return options.delayedClickResponse.then((response) => {
          completed = true;
          return response;
        });
      }
      if (options?.clickStaysActive) {
        const clickBody = readJsonBody(init) as { expectedStepNumber: number };
        return jsonResponse({
          transition: {
            runId: "run-1",
            clickCount: clickBody.expectedStepNumber,
            runStatus: "active",
          },
        });
      }
      completed = true;
      return jsonResponse(completedClickResponse(options?.leaderboardContext));
    }

    if (url === "/api/v2/runs/run-old/abandon") {
      if (abandonFailuresRemaining > 0) {
        abandonFailuresRemaining -= 1;
        return jsonError("network_error", "Offline while ending run.", 503);
      }
      return jsonResponse({ runId: "run-old", runStatus: "abandoned", outcome: "legacy_recovery_abandoned" });
    }

    if (url === "/api/v2/runs/run-1/abandon") {
      if (unauthorizedAbandonRemaining > 0) {
        unauthorizedAbandonRemaining -= 1;
        return jsonError("unauthorized", "Session expired.", 401);
      }
      if (abandonFailuresRemaining > 0) {
        abandonFailuresRemaining -= 1;
        return jsonError("network_error", "Offline while ending run.", 503);
      }
      return jsonResponse({
        runId: "run-1",
        runStatus: "abandoned",
        outcome: "abandoned",
        // PKG-03: the real server always echoes its own persisted
        // elapsedMs on an abandon now (see d1TrackingRepository.ts's
        // abandonRunV2) - `undefined` by default here just omits the key
        // entirely (JSON.stringify drops it), matching a response that
        // never carried one.
        ...(options?.abandonElapsedMs !== undefined ? { elapsedMs: options.abandonElapsedMs } : {}),
      });
    }

    if (url === "/api/v2/runs/run-old/recovery-path") {
      return jsonResponse({ path: options?.runOldPath ?? [] });
    }

    if (url === "/api/v2/runs/run-ranked/path") {
      return jsonResponse({ path: [{ stepNumber: 1, sourceTitle: "Apple", clickedAnchorText: "fruit", destinationTitle: "Fruit", destinationPageId: 10843, elapsedSinceStartMs: 1500, createdAt: "2026-07-14T01:00:01.500Z" }] });
    }

    if (url.startsWith("/api/v2/challenges/") && url.endsWith("/board")) {
      const challengeIdMatch = url.match(/\/api\/v2\/challenges\/([^/]+)\/board$/);
      const challengeId = challengeIdMatch?.[1] ?? "challenge-0001";
      const explicit = options?.boardByChallenge?.[challengeId];
      if (explicit) {
        return jsonResponse({
          challengeId,
          placements: explicit.placements ?? [],
          dnfs: explicit.dnfs ?? [],
        });
      }
      const sourceRows = options?.leaderboardRowsByChallenge?.[challengeId] ??
        options?.leaderboardRows ??
        (completed && challengeId === "challenge-0001" ? [leaderboardRow({ accountId: "acc-guest" })] : []);
      const placements = sourceRows
        .filter((row) => row.status !== "abandoned")
        .map((row, index) => ({
          accountId: row.accountId,
          displayName: row.displayName ?? null,
          // Preserve the fixture row's rank as the board placement so tests
          // modeling "you finished #3" don't silently collapse to #1 when
          // derived from a single-row leaderboard fixture.
          placement: typeof row.rank === "number" ? row.rank : index + 1,
          elapsedMs: row.elapsedMs,
          clickCount: row.clickCount,
          // PKG-03 remainder fix: the real server always carries the
          // surviving best attempt's runId on a placement row - propagate
          // the fixture leaderboard row's own runId here too, so tests
          // relying on this default (rather than an explicit
          // `boardByChallenge`) can still exercise path disclosure off the
          // main Leaderboard panel.
          runId: row.runId,
        }));
      const dnfs = sourceRows
        .filter((row) => row.status === "abandoned")
        .map((row) => ({
          accountId: row.accountId,
          displayName: row.displayName ?? null,
          clickCount: row.clickCount,
          elapsedMs: row.elapsedMs,
        }));
      return jsonResponse({ challengeId, placements, dnfs });
    }

    if (url.startsWith("/api/v2/challenges/") && url.endsWith("/leaderboard")) {
      const perChallengeMatch = Object.entries(options?.leaderboardRowsByChallenge ?? {})
        .find(([challengeId]) => url.includes(challengeId));
      if (perChallengeMatch) {
        return jsonResponse({ leaderboard: perChallengeMatch[1] });
      }
      return jsonResponse({
        leaderboard: options?.leaderboardRows ?? (completed && url.includes("challenge-0001")
          ? [
              {
                rank: 1,
                runId: "run-1",
                challengeId: "challenge-0001",
                accountId: "acc-guest",
                displayName: "Vijay",
                status: "completed",
                isRepeatRun: false,
                startedAt: "2026-07-14T01:00:00.000Z",
                elapsedMs: 1500,
                clickCount: 1,
                completedAt: "2026-07-14T01:00:01.500Z",
                protocolVersion: 2,
              },
            ]
          : []),
      });
    }

    if (url.includes("page=Fruit") && options?.delayedFruitArticle) {
      return options.delayedFruitArticle;
    }
    if (url.includes("page=Fruit") && options?.targetPreviewFailure) {
      return jsonError("wikipedia_unavailable", "Preview unavailable.", 503);
    }

    const requestedPage = new URL(requestUrl).searchParams.get("page");
    const body = requestedPage === "Fruit"
      ? fruitParseResponse
      : requestedPage && requestedPage !== "Apple"
        ? {
            parse: {
              ...appleParseResponse.parse,
              title: requestedPage,
              pageid: 900_000,
            },
          }
        : appleParseResponse;
    return jsonResponse(body);
  });
}

/**
 * A text-query matcher for content split across element boundaries (e.g.
 * Home's daily hero, which wraps its route arrow in its own `<span>` for
 * the "teal arrow" styling the spec calls for). RTL's default string/regex
 * matcher only concatenates a candidate node's direct text-node children -
 * it does not walk into child elements - so a plain regex silently fails to
 * find text like "Mars → Water" once any part of it is wrapped in markup.
 * This checks the full `element.textContent` (which does walk descendants)
 * instead.
 */
function fullTextMatch(expected: RegExp) {
  return (_content: string, element: Element | null): boolean =>
    Boolean(element?.textContent && expected.test(element.textContent));
}

/**
 * PKG-11 (council 2026-07-19): the identity dialog's create-form submit
 * button and its own mode-switcher tab are both named "Create account" while
 * that tab is active (a deliberate app-wide account-verb-pair unification -
 * see App.tsx's doc comment on `.auth-mode-switch`), so an unscoped
 * `getByRole` query is ambiguous the instant both are on screen at once.
 * Scopes to the create form itself (identified by its unique "VGames
 * username" field) the same way the file's existing `loginForm` local
 * disambiguates the login tab from the login form's own submit button.
 */
function createAccountSubmitButton(): HTMLElement {
  const form = screen.getByLabelText(/vgames username/i).closest("form") as HTMLFormElement;
  return within(form).getByRole("button", { name: /^create account$/i });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readJsonBody(init?: RequestInit): unknown {
  return JSON.parse(String(init?.body ?? "{}"));
}

function challengeCatalogCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(
    ([input, init]) =>
      String(input) === apiUrl("/api/v2/challenges") &&
      (init?.method === undefined || init.method === "GET"),
  ).length;
}

function leaderboardCalls(fetchImpl: ReturnType<typeof createFetchMock>, challengeId: string): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl(`/api/v2/challenges/${challengeId}/leaderboard`)).length;
}

function boardCalls(fetchImpl: ReturnType<typeof createFetchMock>, challengeId: string): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl(`/api/v2/challenges/${challengeId}/board`)).length;
}

function startRunCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl("/api/v2/runs/start")).length;
}

function activeRunCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl("/api/v2/runs/active")).length;
}

function completeRunCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input]) => /\/api\/v2\/runs\/[^/]+\/complete$/.test(String(input))).length;
}

function abandonRunCalls(
  fetchImpl: ReturnType<typeof createFetchMock>,
  runId: string,
): number {
  return fetchImpl.mock.calls.filter(
    ([input]) => String(input) === apiUrl(`/api/v2/runs/${runId}/abandon`),
  ).length;
}

function clickRequestBodies(fetchImpl: ReturnType<typeof createFetchMock>): Array<Record<string, unknown>> {
  return fetchImpl.mock.calls
    .filter(([input]) => String(input) === apiUrl("/api/v2/runs/run-1/click"))
    .map(([, init]) => readJsonBody(init) as Record<string, unknown>);
}

function randomChallengeCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input, init]) =>
    String(input) === apiUrl("/api/v2/challenges/random") && init?.method === "POST"
  ).length;
}

function createChallengeCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input, init]) =>
    String(input) === apiUrl("/api/v2/challenges") && init?.method === "POST"
  ).length;
}

function createChallengeBodies(fetchImpl: ReturnType<typeof createFetchMock>): Array<Record<string, unknown>> {
  return fetchImpl.mock.calls
    .filter(([input, init]) =>
      String(input) === apiUrl("/api/v2/challenges") && init?.method === "POST"
    )
    .map(([, init]) => readJsonBody(init) as Record<string, unknown>);
}

function accountStatsCalls(fetchImpl: ReturnType<typeof createFetchMock>): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl("/api/v2/accounts/me/stats")).length;
}

function runPathCalls(fetchImpl: ReturnType<typeof createFetchMock>, runId: string): number {
  return fetchImpl.mock.calls.filter(([input]) => String(input) === apiUrl(`/api/v2/runs/${runId}/path`)).length;
}

function claimedStorage(): Storage {
  const storage = memoryStorage();
  storage.setItem("vwiki-race:vgames-session", JSON.stringify({ accountId: "acc-1", displayName: "Vijay", token: "jwt-claimed", status: "claimed" }));
  return storage;
}

function identity(displayName: string, token: string): VGamesIdentitySession {
  return { accountId: `account-${token}`, displayName, token, status: "claimed" };
}

function identityRepository(session: VGamesIdentitySession): VGamesIdentityRepository {
  let current: VGamesIdentitySession | null = session;
  return {
    clearSession: () => { current = null; },
    getDeviceCredential: () => "device-credential",
    getSession: () => current,
    saveSession: (next) => { current = next; },
  };
}

function accountStatsFixture(attempts: number) {
  return {
    totals: {
      attempts,
      completed: 0,
      abandoned: 0,
      timedCompleted: 0,
      totalClicks: 0,
      bestClicks: null,
      bestElapsedMs: null,
      averageClicks: 0,
      averageElapsedMs: 0,
    },
    topStarts: [],
    topTargets: [],
    mostVisited: [],
    dailyStreak: 0,
    trend30: { avgPlacement: null, playedCount: 0, ranked: false, guard: 10 },
  };
}

function completedClickResponse(
  leaderboardContext = { isPersonalBest: true, rank: 1 as number | null },
) {
  return {
    transition: {
      runId: "run-1",
      clickCount: 1,
      runStatus: "completed",
      completedAt: "2026-07-14T01:00:01.500Z",
      elapsedMs: 1500,
    },
    leaderboardContext,
  };
}

function activeRunFixture(override: Record<string, unknown> = {}) {
  return { id: "run-old", challengeId: "challenge-0001", accountId: "acc-1", canonicalAccountId: "acc-1", status: "active", startTitle: "Apple", targetTitle: "Fruit", clickCount: 0, startedAt: "2026-07-14T01:00:00.000Z", protocolVersion: 2, lastTitle: "Apple", lastPageId: 18978754, ...override };
}

function leaderboardRow(override: Record<string, unknown> = {}) {
  return { rank: 1, runId: "run-ranked", challengeId: "challenge-0001", accountId: "acc-1", displayName: "Vijay", status: "completed", isRepeatRun: false, startedAt: "2026-07-14T01:00:00.000Z", elapsedMs: 1500, clickCount: 1, completedAt: "2026-07-14T01:00:01.500Z", protocolVersion: 2, ...override };
}

function twoChallenges(): Challenge[] {
  return [
    { id: "challenge-0001", label: "Challenge #1", sortOrder: 1, isActive: true, mode: "daily", start: { title: "Apple" }, target: { title: "Fruit" }, ruleset: "ranked_classic", source: "curated" },
    { id: "challenge-0002", label: "Challenge #2", sortOrder: 2, isActive: true, mode: "daily", start: { title: "Mars" }, target: { title: "Water" }, ruleset: "ranked_classic", source: "curated" },
  ];
}

function wikipediaArticleCalls(
  fetchImpl: ReturnType<typeof createFetchMock>,
  title: string,
): number {
  return fetchImpl.mock.calls.filter(([input]) => {
    const url = new URL(String(input));
    return url.hostname === "en.wikipedia.org" && url.searchParams.get("page") === title;
  }).length;
}

function createDeferredResponse(body: unknown): {
  promise: Promise<Response>;
  resolve: () => void;
} {
  let resolvePromise!: (response: Response) => void;
  return {
    promise: new Promise<Response>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => resolvePromise(jsonResponse(body)),
  };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
