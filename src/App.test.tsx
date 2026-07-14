import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { appleParseResponse, fruitParseResponse } from "./test/fixtures";

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
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows the challenge catalog without requiring identity at page entry", async () => {
    render(<App fetchImpl={createFetchMock()} storage={memoryStorage()} />);

    expect(await screen.findByRole("heading", { name: "VWiki Race" })).toBeVisible();
    expect(await screen.findByRole("button", { name: /start challenge #1/i })).toBeVisible();
    expect(screen.queryByText(/enter vwiki race/i)).toBeNull();
  });

  it("prompts for identity before starting when no session exists", async () => {
    const storage = memoryStorage();
    const fetchImpl = createFetchMock();
    const user = userEvent.setup();

    render(<App fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));

    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
    await user.type(screen.getByLabelText(/display name/i), "Vijay");
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(JSON.parse(storage.getItem("vwiki-race:vgames-session") ?? "{}")).toEqual({
      accountId: "acc-guest",
      displayName: "Vijay",
      token: "jwt-guest",
      status: "ghost",
    });
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

    render(<App fetchImpl={createFetchMock()} storage={storage} />);

    await userEvent.click(await screen.findByRole("button", { name: /start challenge #1/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /save your stats/i })).toBeNull();
    expect(screen.getByRole("status", { name: /current player/i })).toHaveTextContent(
      "Vijay",
    );
  });

  it("prompts ghost sessions to claim or continue before each challenge start", async () => {
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

    render(<App fetchImpl={fetchImpl} storage={storage} />);

    await user.click(await screen.findByRole("button", { name: /start challenge #1/i }));

    expect(await screen.findByRole("dialog", { name: /save your stats/i })).toBeVisible();
    expect(screen.getByText(/claim this name/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /continue as guest/i }));

    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();
    expect(fetchImpl).not.toHaveBeenCalledWith(
      "/api/identity/guest",
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
        fetchImpl={fetchImpl}
        now={() => now}
        storage={storage}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /start challenge #1/i }),
    );
    await user.click(await screen.findByRole("button", { name: /continue as guest/i }));
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();

    now = 2500;
    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/target reached/i)).toBeVisible();
    expect(await screen.findByText("Vijay")).toBeVisible();
    expect(screen.getAllByText(/1 click/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1\.5s/i).length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/runs/run-1/complete",
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

    render(<App fetchImpl={fetchImpl} storage={storage} />);

    await user.click(
      await screen.findByRole("button", { name: /start challenge #1/i }),
    );
    expect(await screen.findByRole("heading", { name: "Apple" })).toBeVisible();

    await user.click(await screen.findByRole("link", { name: /fruit/i }));

    expect(await screen.findByText(/opening fruit/i)).toBeVisible();
    fruitArticle.resolve();
    expect(await screen.findByRole("heading", { name: "Fruit" })).toBeVisible();
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

    render(<App fetchImpl={fetchImpl} storage={storage} />);

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
        "/api/challenges",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer jwt-claimed",
          }),
          body: JSON.stringify({
            startTitle: "Mars",
            targetTitle: "Water",
            creatorDisplayName: "Vijay",
          }),
        }),
      );
    });
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

    render(<App fetchImpl={fetchImpl} storage={storage} />);

    expect((await screen.findAllByText(/mars -> water/i)).length).toBeGreaterThan(
      0,
    );
    await user.click(await screen.findByRole("button", { name: /start challenge #2/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/runs/start",
        expect.objectContaining({
          body: JSON.stringify({
            challengeId: "challenge-0002",
            publicName: "Vijay",
          }),
        }),
      );
    });
    expect(window.location.search).toBe("?challenge=challenge-0002");
  });
});

function createFetchMock(options?: {
  challenges?: Array<{
    id: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
    mode: string;
    start: { title: string };
    target: { title: string };
    ruleset: string;
    source: string;
  }>;
  delayedFruitArticle?: Promise<Response>;
}) {
  let completed = false;
  let challenges = options?.challenges ?? [
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
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/challenges" && method === "POST") {
      expect(readJsonBody(init)).toEqual({
        startTitle: "Mars",
        targetTitle: "Water",
        creatorDisplayName: "Vijay",
      });
      const challenge = {
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
      return jsonResponse({ challenge });
    }

    if (url === "/api/challenges") {
      return jsonResponse({
        challenges,
      });
    }

    if (url === "/api/identity/guest") {
      const body = readJsonBody(init) as { displayName: string };
      return jsonResponse({
        accountId: "acc-guest",
        displayName: body.displayName,
        token: "jwt-guest",
        status: "ghost",
      });
    }

    if (url === "/api/identity/secure") {
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

    if (url === "/api/identity/login") {
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

    if (url === "/api/runs/start") {
      const startBody = readJsonBody(init) as { challengeId: string; publicName: string };
      expect(startBody.publicName).toBe("Vijay");
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer jwt-/),
      });
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
        },
      });
    }

    if (url === "/api/runs/run-1/click") {
      expect(readJsonBody(init)).toMatchObject({
        sourceTitle: "Apple",
        clickedAnchorText: "fruit",
        requestedTitle: "Fruit",
        destinationTitle: "Fruit",
        destinationPageId: 10843,
        clientTimestampMs: 2500,
      });
      return jsonResponse({ clickCount: 1 });
    }

    if (url === "/api/runs/run-1/complete") {
      completed = true;
      expect(readJsonBody(init)).toEqual({
        finalTitle: "Fruit",
        clientTimestampMs: 2500,
      });
      return jsonResponse({
        leaderboardRow: {
          rank: 1,
          runId: "run-1",
          challengeId: "challenge-0001",
          accountId: "acc-guest",
          displayName: "Vijay",
          elapsedMs: 1500,
          clickCount: 1,
          completedAt: "2026-07-14T01:00:01.500Z",
          pathPreview: [],
        },
      });
    }

    if (url.startsWith("/api/challenges/") && url.endsWith("/leaderboard")) {
      return jsonResponse({
        leaderboard: completed && url.includes("challenge-0001")
          ? [
              {
                rank: 1,
                runId: "run-1",
                challengeId: "challenge-0001",
                accountId: "acc-guest",
                displayName: "Vijay",
                elapsedMs: 1500,
                clickCount: 1,
                completedAt: "2026-07-14T01:00:01.500Z",
                pathPreview: [
                  {
                    stepNumber: 1,
                    sourceTitle: "Apple",
                    clickedAnchorText: "fruit",
                    destinationTitle: "Fruit",
                    destinationPageId: 10843,
                    elapsedSinceStartMs: 1500,
                    createdAt: "2026-07-14T01:00:01.500Z",
                  },
                ],
              },
            ]
          : [],
      });
    }

    if (url.includes("page=Fruit") && options?.delayedFruitArticle) {
      return options.delayedFruitArticle;
    }

    const body = url.includes("page=Fruit")
      ? fruitParseResponse
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

function readJsonBody(init?: RequestInit): unknown {
  return JSON.parse(String(init?.body ?? "{}"));
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
