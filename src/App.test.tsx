import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
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
    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
    expect(screen.queryByText(/enter vwiki race/i)).toBeNull();
  });

  it("keeps an unauthenticated direct admin visit in the ordinary game without loading moderation data", async () => {
    window.history.pushState({}, "", "/admin/dailies");
    const fetchImpl = createFetchMock();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
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

  it("exposes the Admin command and protected route only to daily managers", async () => {
    window.history.pushState({}, "", "/admin/dailies");
    const fetchImpl = createFetchMock({ canManageDailies: true });

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    expect(await screen.findByRole("heading", { name: "Daily moderation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-pressed", "true");
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
    expect(screen.getByRole("button", { name: /start challenge #1/i })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Daily moderation" })).toBeNull();
    expect(
      fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/v2/admin/dailies")),
    ).toBe(false);
  });

  it("preserves the selected challenge while entering and leaving Daily moderation", async () => {
    window.history.pushState({}, "", "/?challenge=challenge-0001");
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ canManageDailies: true })}
        storage={claimedStorage()}
      />,
    );

    const admin = await screen.findByRole("button", { name: "Admin" });
    await userEvent.click(admin);
    expect(window.location.pathname).toBe("/admin/dailies");
    expect(window.location.search).toBe("?challenge=challenge-0001");

    await userEvent.click(screen.getByRole("button", { name: "play" }));
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

    const feedback = await screen.findByRole("link", { name: "Feedback" });
    expect(feedback).toHaveAttribute(
      "href",
      "https://theonenonlyvj.github.io/personal-site/contact",
    );
    expect(feedback).toHaveAttribute("target", "_blank");
    expect(feedback.getAttribute("rel")).toContain("noopener");
    const portfolio = screen.getByRole("link", { name: "Click here" });
    expect(portfolio).toHaveAttribute(
      "href",
      "https://theonenonlyvj.github.io/personal-site",
    );
    expect(portfolio).toHaveAttribute("target", "_blank");
    expect(portfolio.getAttribute("rel")).toContain("noopener");

    const tabbar = screen.getByRole("navigation", { name: /vwiki race views/i });
    for (const tab of ["leaderboard", "challenges", "stats"]) {
      await userEvent.click(within(tabbar).getByRole("button", { name: tab }));
      expect(screen.getByRole("link", { name: "Feedback" })).toBeVisible();
      expect(screen.getByRole("link", { name: "Click here" })).toBeVisible();
    }

    await userEvent.click(within(tabbar).getByRole("button", { name: "play" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /start challenge #1/i }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Feedback" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Click here" })).toBeNull();
  });

  it("explains the race in one line on the Play panel before start", async () => {
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
    expect(
      screen.getByText(/race from the start article to the target using only links inside the page/i),
    ).toBeVisible();
  });

  it("shows a target preview before start and retains a compact in-game reference", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    const preview = await screen.findByRole("region", { name: /target preview/i });
    await within(preview).findByText(/seed-bearing structure/i);
    expect(within(preview).getByRole("heading", { name: "Fruit" })).toBeVisible();
    expect(within(preview).getByText(/seed-bearing structure/i)).toBeVisible();
    expect(within(preview).queryByRole("img")).toBeNull();
    expect(within(preview).getByRole("link", { name: /source revision/i })).toHaveAttribute(
      "href",
      expect.stringContaining("oldid=78910"),
    );
    expect(within(preview).queryByRole("link", { name: /^fruit$/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /target preview/i })).toBeNull();
    const targetReference = screen.getByRole("group", { name: /target reference/i });
    expect(within(targetReference).getByText("Fruit")).toBeVisible();
    expect(within(targetReference).getByText(/seed-bearing structure/i)).toBeInTheDocument();
  });

  it("keeps Start enabled when the target preview is unavailable", async () => {
    render(
      <App
        apiOrigin={apiOrigin}
        fetchImpl={createFetchMock({ targetPreviewFailure: true })}
        storage={claimedStorage()}
      />,
    );

    const preview = await screen.findByRole("region", { name: /target preview/i });
    await within(preview).findByText(/preview unavailable/i);
    expect(within(preview).getByText(/preview unavailable/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /start challenge #1/i })).toBeEnabled();
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

    expect(await screen.findByRole("button", { name: /start challenge #16/i })).toBeVisible();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: /target preview/i })).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0016");
  });

  it("does not reload the challenge catalog on every render with the default fetch", async () => {
    const fetchImpl = createFetchMock();
    vi.stubGlobal("fetch", fetchImpl);

    const storage = memoryStorage();
    const { rerender } = render(<App apiOrigin={apiOrigin} storage={storage} />);

    expect(
      await screen.findByRole("button", { name: /start challenge #1/i }),
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
    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(1));

    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => expect(challengeCatalogCalls(fetchImpl)).toBe(2));
  });

  it("prompts for identity before starting when no session exists", async () => {
    const storage = memoryStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
      await screen.findByRole("button", { name: /start challenge #1/i }),
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
  });

  it("defaults the start gate to a VGames Create New account flow", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    const options = within(dialog).getByRole("group", { name: /identity options/i });
    expect(within(options).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Guest",
      "Create New",
      "Log In / Existing",
    ]);
    expect(within(options).getByRole("button", { name: /create new/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByText(/one account works across all v games/i)).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(screen.getByRole("button", { name: /create vgames account/i }));

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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "different-pass");
    await user.click(screen.getByRole("button", { name: /create vgames account/i }));

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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "Mike Smith");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(screen.getByRole("button", { name: /create vgames account/i }));

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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "abc");
    await user.type(screen.getByLabelText(/confirm password/i), "abc");
    await user.click(screen.getByRole("button", { name: /create vgames account/i }));

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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.type(screen.getByLabelText(/vgames username/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.type(screen.getByLabelText(/confirm password/i), "secret-pass");
    await user.click(screen.getByRole("button", { name: /create vgames account/i }));

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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /log in \/ existing/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /log in \/ existing/i }));
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
    expect(screen.getByRole("button", { name: /^create new$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /log in \/ existing/i })).toBeDisabled();

    pendingLogin.resolve();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /log in \/ existing/i }));
    await user.type(screen.getByLabelText(/^username$/i), "vijay");
    await user.type(screen.getByLabelText(/^password$/i), "secret-pass");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

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

    await userEvent.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /play again/i }));

    await waitFor(() => {
      expect(wikipediaArticleCalls(fetchImpl, "Apple")).toBe(2);
    });
  });

  it("prompts ghost sessions to create an account or continue before each challenge start", async () => {
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /create vgames account/i })).toBeVisible();
    expect(screen.getByLabelText(/vgames username/i)).toHaveValue("vijay");
    expect(screen.queryByRole("button", { name: /continue as guest/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^guest$/i }));
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

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
      await screen.findByRole("button", { name: /start challenge #1/i }),
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
      await screen.findByRole("button", { name: /start challenge #1/i }),
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

  it("scrolls to the accepted article top, not an unaccepted optimistic page", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const clickResponse = createDeferredResponse(completedClickResponse());
    try {
      const fetchImpl = createFetchMock({ delayedClickResponse: clickResponse.promise });
      const user = userEvent.setup();
      render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

      await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    await waitFor(() => expect(clickRequestBodies(fetchImpl)).toHaveLength(1));

    expect(screen.getByRole("button", { name: /^end run$/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /start challenge #1/i })).toBeNull();
    expect(screen.getByRole("region", { name: /wikipedia article/i })).toHaveAttribute("inert");
    expect(screen.getByText(/loading next article/i)).toBeVisible();
    clickResponse.resolve();
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
  });

  it("keeps End Run disabled while an exact click retry remains pending", async () => {
    const fetchImpl = createFetchMock({ clickSyncFailureOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByRole("button", { name: /retry click/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^end run$/i })).toBeDisabled();
  });

  it("keeps End Run as a prominent, styled control that opens the confirmation during an active run", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    expect(screen.getByRole("dialog", { name: /end this run/i })).toBeVisible();
  });

  it("shows Timer in active run metrics and freezes it throughout syncing and completion", async () => {
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const metrics = screen.getByLabelText(/current run/i);
    const timer = within(metrics).getByText("Timer").nextElementSibling;
    expect(timer).toHaveTextContent("0.0s");

    now = 2_500;
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/opening fruit/i)).toBeVisible();
    await waitFor(() => expect(timer).toHaveTextContent("1.5s"));
    now = 9_000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(timer).toHaveTextContent("1.5s");

    fruitArticle.resolve();
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    expect(timer).toHaveTextContent("1.5s");
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    const link = await screen.findByRole("link", { name: /fruit/i });
    now = 2_000;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(link.isConnected).toBe(true);
    expect(screen.getByRole("link", { name: /fruit/i })).toBe(link);
  });

  it("refreshes the completed challenge leaderboard exactly once after acceptance", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    // Invariant 1 ("Time AND clicks, always") + placement from the
    // server-returned leaderboardContext.rank (spec: Race flow beat 3).
    expect(screen.getByText(/#1 today · 0:01 · 1 clk/)).toBeVisible();
    const result = screen.getByText(/you reached it/i).closest("aside");
    const article = screen.getByRole("article");
    expect(result?.compareDocumentPosition(article)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole("button", { name: /play again/i })).toBeVisible();

    // "View leaderboard" exits the full-screen results takeover back to the
    // normal shell's Leaderboard tab (Results itself stays unchanged this
    // increment - see the race-flow spec's Results beat).
    await user.click(screen.getByRole("button", { name: /view leaderboard/i }));
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
    await waitFor(() => expect(leaderboardCalls(fetchImpl, "challenge-0001")).toBe(2));
    expect(completeRunCalls(fetchImpl)).toBe(0);
  });

  it("exits the results takeover to Challenges when Browse all challenges is clicked", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));

    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
    expect(screen.queryByText(/you reached it/i)).toBeNull();
  });

  it("locks solution-bearing views throughout an active run", async () => {
    const fetchImpl = createFetchMock({ leaderboardRows: [leaderboardRow()] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /leaderboard/i }));
    expect(await screen.findByText(/view winning path/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    // Zero chrome, not "disabled" chrome: the full-screen race takeover
    // deletes the "why are Leaderboard/Stats visible-but-disabled mid-race?"
    // problem at the root by not rendering the tabbar/header at all.
    await screen.findByRole("heading", { name: "Apple" });
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^leaderboard$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^challenges$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^stats$/i })).toBeNull();
    expect(screen.queryByText(/view winning path/i)).toBeNull();
  });

  it("always shows this run's server-provided placement, personal best or not", async () => {
    // Race flow spec beat 3 + task brief: placement comes straight from
    // leaderboardContext.rank (the server's rank for *this* run), shown
    // unconditionally - not gated on isPersonalBest.
    const fetchImpl = createFetchMock({
      leaderboardContext: { isPersonalBest: false, rank: 4 },
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/#4 today · 0:01 · 1 clk/)).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    await screen.findByText(/you reached it/i);
    expect(document.querySelector(".result-score")).toHaveTextContent("0:01 · 1 clk");
  });

  it("unlocks challenge selection after a completed run", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    expect(screen.getByRole("button", { name: /start challenge #2/i })).toBeEnabled();
  });

  it("clears the completed result and path when another challenge is selected", async () => {
    const fetchImpl = createFetchMock({ challenges: twoChallenges() });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));
    expect(await screen.findByText(/you reached it/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));
    await user.click(screen.getByRole("button", { name: /challenge #2/i }));

    expect(screen.queryByText(/you reached it/i)).toBeNull();
    expect(screen.queryByRole("navigation", { name: /run path/i })).toBeNull();
    expect(screen.getByRole("heading", { name: "Water" })).toBeVisible();
  });

  it("clears a stale 401 identity, retains Start intent, and resumes after login", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ startUnauthorizedOnce: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    const startButton = await screen.findByRole("button", { name: /start challenge #1/i });
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    const trigger = await screen.findByRole("button", { name: /start race/i });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /save your stats/i });
    expect(document.body.style.overflow).toBe("hidden");
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
    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeEnabled();
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
    expect(screen.queryByRole("button", { name: /start challenge #1/i })).toBeNull();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();

    await act(async () => {
      activeDiscovery.resolve();
      await activeDiscovery.promise;
    });

    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeEnabled();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    expect(screen.queryByRole("button", { name: /start challenge #1/i })).toBeNull();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    expect((await screen.findAllByText(/mars -> water/i)).length).toBeGreaterThan(0);
    await waitFor(() => expect(leaderboardCalls(fetchImpl, "challenge-0002")).toBeGreaterThan(0));
  });

  it("loads a winning path only when disclosed and memoizes repeat disclosure", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ leaderboardRows: [leaderboardRow()] });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /leaderboard/i }));
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(0);
    const disclosure = await screen.findByText(/view winning path/i);
    await user.click(disclosure);
    expect((await screen.findAllByText(/apple -> fruit/i)).length).toBeGreaterThan(1);
    await user.click(disclosure);
    await user.click(disclosure);
    expect(runPathCalls(fetchImpl, "run-ranked")).toBe(1);
  });

  it("labels leaderboard provenance without hiding either result", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({ protocolVersion: 1, displayName: "franelpana" }),
        leaderboardRow({
          rank: 2,
          runId: "run-verified",
          protocolVersion: 2,
          displayName: "theonenonlyvj",
        }),
      ],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /leaderboard/i }));

    expect(await screen.findByText("franelpana")).toBeVisible();
    expect(screen.getByText("Historical")).toBeVisible();
    expect(screen.getByText("Server tracked")).toBeVisible();
    expect(screen.getAllByText("1 click")).toHaveLength(2);
  });

  it("shows repeat attempts and keeps a meaningful DNF below completed runs", async () => {
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
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /leaderboard/i }));

    expect(await screen.findByText("#1")).toBeVisible();
    expect(screen.getByText("DNF")).toBeVisible();
    expect(screen.getAllByText("Repeat run")).toHaveLength(2);
    expect(screen.getByText("View winning path")).toBeVisible();
    expect(screen.getByText("View path")).toBeVisible();
  });

  it("loads account stats only from the authenticated account-stats projection", async () => {
    const storage = claimedStorage();
    const fetchImpl = createFetchMock({ accountAttempts: 7 });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /^stats$/i }));

    expect(await screen.findByText("7")).toBeVisible();
    expect(accountStatsCalls(fetchImpl)).toBe(1);
  });

  it("keeps Stats unreachable while a timed run is active", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));

    await screen.findByRole("heading", { name: "Apple" });
    expect(screen.queryByRole("button", { name: /^stats$/i })).toBeNull();
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

    await user.click(await screen.findByRole("button", { name: /^stats$/i }));
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

    await user.click(await screen.findByRole("button", { name: /^stats$/i }));
    expect(await screen.findByText("7")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^play$/i }));
    await user.click(screen.getByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("button", { name: /^end run$/i }));
    await user.click(screen.getByRole("button", { name: /confirm end run/i }));
    await user.click(screen.getByRole("button", { name: /^stats$/i }));

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

    expect(await screen.findByRole("button", { name: /start challenge #2/i })).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeEnabled();
    expect(abandonRunCalls(fetchImpl, "run-1")).toBe(2);
  });

  it("ignores stale catalog and leaderboard responses", async () => {
    const staleCatalog = createDeferredResponse({ challenges: [twoChallenges()[0]] });
    const staleFetch = createFetchMock({ delayedChallenges: staleCatalog.promise });
    const currentFetch = createFetchMock({ challenges: [twoChallenges()[1]] });
    const catalogStorage = memoryStorage();
    const catalogView = render(<App apiOrigin={apiOrigin} fetchImpl={staleFetch} storage={catalogStorage} />);
    catalogView.rerender(<App apiOrigin={apiOrigin} fetchImpl={currentFetch} storage={catalogStorage} />);
    expect((await screen.findAllByText(/mars -> water/i)).length).toBeGreaterThan(0);
    await act(async () => {
      staleCatalog.resolve();
      await staleCatalog.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByText(/apple -> fruit/i)).toBeNull());
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
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    const view = render(<App apiOrigin={apiOrigin} fetchImpl={racingFetch} storage={memoryStorage()} />);
    await user.click(await screen.findByRole("button", { name: /challenge #2/i }));
    await user.click(screen.getByRole("button", { name: /leaderboard/i }));
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
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0001/leaderboard")) {
        return Promise.resolve(jsonResponse({
          leaderboard: [leaderboardRow({ displayName: "Apple Runner", runId: "run-apple" })],
        }));
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await screen.findByLabelText(/start article/i);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(challengeRequestCount).toBeGreaterThanOrEqual(2));

    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByRole("button", { name: /start challenge #2/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^play$/i })).toHaveAttribute(
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
      expect(screen.getByRole("button", { name: /start challenge #2/i })).toBeVisible();
      expect(window.location.search).toBe("?challenge=challenge-0002");
    });
    expect(screen.getByRole("button", { name: /^play$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /leaderboard/i }));
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
      if (requestUrl === apiUrl("/api/v2/challenges/challenge-0002/leaderboard")) {
        return challengeTwoLeaderboard.promise;
      }
      return baseFetch(input, init);
    }) as typeof baseFetch;
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={memoryStorage()} />);

    await user.click(await screen.findByRole("button", { name: /leaderboard/i }));
    expect(await screen.findByText("Apple Runner")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^play$/i }));
    await user.click(screen.getByRole("button", { name: /challenge #2/i }));
    await user.click(screen.getByRole("button", { name: /leaderboard/i }));
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

    expect(
      await screen.findByRole("button", { name: /start challenge #2/i }),
    ).toBeVisible();
    expect((await screen.findAllByText(/mars -> water/i)).length).toBeGreaterThan(
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

    expect(await screen.findByRole("checkbox", { name: /nominate for a future daily/i })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /^challenges$/i }));
    expect(screen.getByRole("checkbox", { name: /nominate for a future daily/i })).toBeVisible();
    claimedView.unmount();

    const ghostStorage = memoryStorage();
    ghostStorage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({ accountId: "acc-guest", displayName: "Guest", token: "jwt-guest", status: "ghost" }),
    );
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={ghostStorage} />);

    await screen.findByRole("button", { name: /start challenge #1/i });
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

    await user.type(await screen.findByLabelText(/start article/i), "Mars");
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

    await user.type(await screen.findByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    if (nomination !== "not_requested") {
      await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    }
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByText(notice)).toBeVisible();
    expect(screen.getByRole("button", { name: /start challenge #12/i })).toBeVisible();
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

    await user.type(await screen.findByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByText(/already been featured as a daily/i)).toBeVisible();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /start challenge #12/i })).toBeVisible();
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
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));
    await waitFor(() => expect(leaderboardCalls(fetchImpl, existingChallenge.id)).toBe(2));

    await user.click(screen.getByRole("button", { name: /leaderboard/i }));
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
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    await user.click(screen.getByRole("checkbox", { name: /nominate for a future daily/i }));
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/leaderboard unavailable/i);
    expect(screen.getByText(/already exists as challenge #12/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /start challenge #12/i })).toBeVisible();
    expect(window.location.search).toBe("?challenge=challenge-0012");
  });

  it("keeps the selected challenge in the URL and honors challenge deep links", async () => {
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

    expect((await screen.findAllByText(/mars -> water/i)).length).toBeGreaterThan(
      0,
    );
    await user.click(await screen.findByRole("button", { name: /start challenge #2/i }));
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

  it("copies a permanent link for the selected challenge", async () => {
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

      const preview = await screen.findByRole("region", { name: /target preview/i });
      await user.click(
        within(preview).getByRole("button", { name: /copy challenge link/i }),
      );

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/?challenge=challenge-0002`,
        );
      });
      expect(await within(preview).findByRole("status")).toHaveTextContent(
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

      await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      const preview = await screen.findByRole("region", { name: /target preview/i });
      await user.click(
        within(preview).getByRole("button", { name: /copy challenge link/i }),
      );

      expect(await within(preview).findByRole("status")).toHaveTextContent(
        /challenge link copied/i,
      );
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(within(preview).queryByRole("textbox", { name: /challenge link/i })).toBeNull();
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
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock()}
          storage={claimedStorage()}
        />,
      );

      const preview = await screen.findByRole("region", { name: /target preview/i });
      await user.click(
        within(preview).getByRole("button", { name: /copy challenge link/i }),
      );

      const fallbackLink = await within(preview).findByRole("textbox", {
        name: /challenge link/i,
      });
      expect(fallbackLink).toHaveValue(
        `${window.location.origin}/?challenge=challenge-0001`,
      );
      expect(within(preview).getByRole("status")).toHaveTextContent(
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
      render(
        <App
          apiOrigin={apiOrigin}
          fetchImpl={createFetchMock({ challenges: twoChallenges() })}
          storage={claimedStorage()}
        />,
      );

      const preview = await screen.findByRole("region", { name: /target preview/i });
      const copyButton = within(preview).getByRole("button", {
        name: /copy challenge link/i,
      });
      await user.click(copyButton);
      expect(within(preview).getByRole("status")).toHaveTextContent(
        /copying challenge link/i,
      );
      expect(copyButton).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /challenge #2/i }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));

      const nextPreview = screen.getByRole("region", { name: /target preview/i });
      expect(within(nextPreview).getByRole("heading", { name: "Water" })).toBeVisible();
      expect(within(nextPreview).queryByRole("status")).toBeNull();
      expect(within(nextPreview).queryByRole("textbox", { name: /challenge link/i })).toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });
});

describe("Race flow: full-screen takeover", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the pre-race preview beat with target, attribution, and start-article label before Start", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));

    const preview = await screen.findByRole("region", { name: /pre-race preview/i });
    expect(within(preview).getByText(/your target/i)).toBeVisible();
    expect(within(preview).getByRole("heading", { name: "Fruit" })).toBeVisible();
    await within(preview).findByText(/seed-bearing structure/i);
    expect(within(preview).getByRole("link", { name: /source revision/i })).toHaveAttribute(
      "href",
      expect.stringContaining("oldid=78910"),
    );
    expect(within(preview).getByText(/start: apple/i)).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));

    const preview = await screen.findByRole("region", { name: /pre-race preview/i });
    await within(preview).findByText(/preview unavailable/i);
    expect(within(preview).getByRole("button", { name: /start race/i })).toBeEnabled();
  });

  it("(b) creates no run when backing out of the preview", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /^back$/i }));

    expect(startRunCalls(fetchImpl)).toBe(0);
    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
    expect(screen.queryByRole("region", { name: /pre-race preview/i })).toBeNull();
  });

  it("(c) lands on the Challenges view via 'See other challenges' without creating a run", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /see other challenges/i }));

    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /pre-race preview/i })).toBeNull();
    expect(startRunCalls(fetchImpl)).toBe(0);
  });

  it("(d) calls the same run-start API from the preview's Start race button", async () => {
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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
    expect(screen.queryByRole("button", { name: /start challenge #1/i })).toBeNull();

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

    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
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

    await user.click(within(claimCta).getByRole("button", { name: /make a name/i }));
    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
  });

  it("does not show the claim CTA for an already-claimed session", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    await screen.findByText(/you reached it/i);
    expect(screen.queryByRole("region", { name: /keep your spot/i })).toBeNull();
  });

  it("shows a top-3 board snippet with the player's own row highlighted", async () => {
    const fetchImpl = createFetchMock({
      leaderboardRows: [
        leaderboardRow({ rank: 1, runId: "run-a", displayName: "Ari" }),
        leaderboardRow({ rank: 2, runId: "run-b", displayName: "Bo" }),
        leaderboardRow({ rank: 3, runId: "run-c", displayName: "Cy" }),
        leaderboardRow({ rank: 4, runId: "run-1", displayName: "Vijay" }),
      ],
    });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    const board = await screen.findByRole("region", { name: /today's board/i });
    const rows = within(board).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[3]).getByText(/vijay/i)).toBeVisible();
    expect(rows[3]).toHaveClass("is-you");
  });

  it("keeps the original End Run confirm copy when no clicks have been made yet", async () => {
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={createFetchMock()} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await user.click(screen.getByRole("button", { name: /^end run$/i }));

    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    expect(
      within(dialog).getByText(/this cannot be resumed after the server accepts it\./i),
    ).toBeVisible();
  });

  it("shows the DNF Results variant and DNF-aware End Run confirm copy after abandoning a run with clicks", async () => {
    const fetchImpl = createFetchMock({ clickStaysActive: true });
    const user = userEvent.setup();
    render(<App apiOrigin={apiOrigin} fetchImpl={fetchImpl} storage={claimedStorage()} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));
    await user.click(await screen.findByRole("button", { name: /start race/i }));
    await screen.findByRole("heading", { name: "Apple" });
    await user.click(await screen.findByRole("link", { name: /apple tree/i }));
    await screen.findByRole("heading", { name: "Apple tree" });

    await user.click(screen.getByRole("button", { name: /^end run$/i }));
    const dialog = await screen.findByRole("dialog", { name: /end this run/i });
    expect(within(dialog).getByText(/it'll count as a dnf with 1 click\./i)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: /confirm end run/i }));

    expect(await screen.findByText(/that one got away/i)).toBeVisible();
    expect(screen.getByText(/dnf · 1 clk/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /browse all challenges/i })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: /vwiki race views/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /browse all challenges/i }));
    expect(screen.getByRole("heading", { name: "Challenges" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: /vwiki race views/i })).toBeVisible();
  });

});

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
  activeRun?: ReturnType<typeof activeRunFixture> | null;
  delayedActiveRun?: Promise<Response>;
  targetPreviewFailure?: boolean;
  leaderboardRows?: ReturnType<typeof leaderboardRow>[];
  runOldPath?: ServerPathStep[];
  accountAttempts?: number;
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
}) {
  let completed = false;
  let unauthorizedStartRemaining = options?.startUnauthorizedOnce ? 1 : 0;
  let unauthorizedClickRemaining = options?.clickUnauthorizedOnce ? 1 : 0;
  let clickSyncFailuresRemaining = options?.clickSyncFailureOnce ? 2 : 0;
  let conflictingStartRemaining = options?.startConflictOnce ? 1 : 0;
  let unauthorizedCreateRemaining = options?.createUnauthorizedOnce ? 1 : 0;
  let abandonFailuresRemaining = options?.abandonFailsOnce ? 2 : 0;
  let unauthorizedAbandonRemaining = options?.abandonUnauthorizedOnce ? 1 : 0;
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
      if (options?.statsUnauthorizedAfterFirst && statsReads > 1) {
        return jsonError("unauthorized", "Session expired.", 401);
      }
      return jsonResponse({
        stats: {
          totals: { attempts: options?.accountAttempts ?? 0, completed: 0, abandoned: 0, timedCompleted: 0, totalClicks: 0, bestClicks: null, bestElapsedMs: null, averageClicks: 0, averageElapsedMs: 0 },
          topStarts: [], topTargets: [], mostVisited: [],
        },
      });
    }

    if (url === "/api/v2/accounts/me/capabilities") {
      return jsonResponse({ canManageDailies: options?.canManageDailies ?? false });
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
      return jsonResponse({ runId: "run-1", runStatus: "abandoned", outcome: "abandoned" });
    }

    if (url === "/api/v2/runs/run-old/recovery-path") {
      return jsonResponse({ path: options?.runOldPath ?? [] });
    }

    if (url === "/api/v2/runs/run-ranked/path") {
      return jsonResponse({ path: [{ stepNumber: 1, sourceTitle: "Apple", clickedAnchorText: "fruit", destinationTitle: "Fruit", destinationPageId: 10843, elapsedSinceStartMs: 1500, createdAt: "2026-07-14T01:00:01.500Z" }] });
    }

    if (url.startsWith("/api/v2/challenges/") && url.endsWith("/leaderboard")) {
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
