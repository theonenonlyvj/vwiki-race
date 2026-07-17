import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminDailies from "./AdminDailies";
import type {
  DailyFlavor,
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";
import type { VWikiRaceDailyAdminApiClient } from "../services/vwikiRaceApiClient";
import type { Challenge } from "../domain/types";

describe("AdminDailies", () => {
  it("shows a loading state before the moderation state arrives", () => {
    render(
      <AdminDailies
        apiClient={adminClient({
          getDailyAdminState: () => new Promise(() => undefined),
        })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    expect(screen.getByText("Loading daily moderation...")).toBeVisible();
  });

  it("shows a recoverable error when the moderation state cannot load", async () => {
    render(
      <AdminDailies
        apiClient={adminClient({
          getDailyAdminState: vi.fn().mockRejectedValue(new Error("Moderation service is unavailable.")),
        })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Moderation service is unavailable.");
    expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();
  });

  it("shows operational empty states for pending nominations and each queue flavor", async () => {
    render(
      <AdminDailies
        apiClient={adminClient({
          getDailyAdminState: vi.fn().mockResolvedValue({ nominations: [], queueEntries: [] }),
        })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    expect(await screen.findByText("No pending nominations.")).toBeVisible();
    for (const flavor of ["Recognizable", "Weird", "Hard"]) {
      const group = screen.getByRole("region", { name: `${flavor} queue` });
      expect(within(group).getByText("No queued challenges.")).toBeVisible();
    }
  });

  it("shows classifier guidance, lets an admin override flavor, and approves the nomination", async () => {
    const approveDailyNomination = vi.fn().mockResolvedValue(queueEntry({ flavor: "hard" }));
    render(
      <AdminDailies
        apiClient={adminClient({ approveDailyNomination })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    const nomination = await screen.findByRole("article", { name: "Nomination nomination-1" });
    expect(within(nomination).getByText("80")).toBeVisible();
    expect(within(nomination).getByText("12")).toBeVisible();
    expect(within(nomination).getByText("53")).toBeVisible();
    expect(within(nomination).getByText("Suggested: recognizable")).toBeVisible();
    expect(within(nomination).getByText("Confidence: high")).toBeVisible();
    expect(within(nomination).getByText("Challenge #101")).toBeVisible();
    expect(within(nomination).getByText("Mercury -> Solar System")).toBeVisible();

    const flavorOverride = within(nomination).getByRole("group", { name: "Flavor for nomination-1" });
    await userEvent.click(within(flavorOverride).getByRole("button", { name: "Hard" }));
    expect(within(flavorOverride).getByRole("button", { name: "Hard" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(nomination).getByRole("button", { name: "Approve" }));
    expect(approveDailyNomination).toHaveBeenCalledWith(
      "nomination-1",
      { flavor: "hard" },
      "admin-token",
    );
    await waitFor(() => expect(screen.queryByRole("article", { name: "Nomination nomination-1" })).toBeNull());
    expect(screen.getByText("Challenge #101")).toBeVisible();
  });

  it("declines nominations, removes queued entries, and directly promotes a challenge", async () => {
    const declineDailyNomination = vi.fn().mockResolvedValue({ ...nomination(), status: "declined" });
    const removeDailyQueueEntry = vi.fn().mockResolvedValue({ ...queueEntry(), status: "removed" });
    const queueDailyChallenge = vi.fn().mockResolvedValue(queueEntry({
      id: "queue-direct",
      challengeId: "challenge-direct",
      flavor: "weird",
      source: "admin",
    }));
    render(
      <AdminDailies
        apiClient={adminClient({
          declineDailyNomination,
          getDailyAdminState: vi.fn().mockResolvedValue({
            nominations: [nomination()],
            queueEntries: [queueEntry()],
          }),
          queueDailyChallenge,
          removeDailyQueueEntry,
        })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    const pending = await screen.findByRole("article", { name: "Nomination nomination-1" });
    await userEvent.click(within(pending).getByRole("button", { name: "Decline" }));
    expect(declineDailyNomination).toHaveBeenCalledWith("nomination-1", "admin-token");

    const queued = await screen.findByRole("article", { name: "Queued challenge queue-1" });
    await userEvent.click(within(queued).getByRole("button", { name: "Remove" }));
    expect(removeDailyQueueEntry).toHaveBeenCalledWith("queue-1", "admin-token");

    await userEvent.selectOptions(screen.getByLabelText("Challenge"), "challenge-direct");
    const directFlavor = screen.getByRole("group", { name: "Direct promotion flavor" });
    await userEvent.click(within(directFlavor).getByRole("button", { name: "Weird" }));
    await userEvent.click(screen.getByRole("button", { name: "Queue challenge" }));

    expect(queueDailyChallenge).toHaveBeenCalledWith(
      { challengeId: "challenge-direct", flavor: "weird" },
      "admin-token",
    );
    expect(await screen.findByText("Challenge #102")).toBeVisible();
  });

  it("keeps moderation groups available in a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });

    render(
      <AdminDailies
        apiClient={adminClient({
          getDailyAdminState: vi.fn().mockResolvedValue({ nominations: [], queueEntries: [] }),
        })}
        challenges={challengeCatalog()}
        token="admin-token"
      />,
    );

    expect(await screen.findByTestId("daily-admin-layout")).toHaveClass("daily-admin-layout");
    expect(screen.getByRole("region", { name: "Recognizable queue" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Direct promotion" })).toBeVisible();
  });
});

function adminClient(overrides: Partial<VWikiRaceDailyAdminApiClient> = {}): VWikiRaceDailyAdminApiClient {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ canManageDailies: true }),
    getDailyAdminState: vi.fn().mockResolvedValue({
      nominations: [nomination()],
      queueEntries: [],
    }),
    approveDailyNomination: vi.fn().mockResolvedValue(queueEntry()),
    declineDailyNomination: vi.fn().mockResolvedValue({ ...nomination(), status: "declined" }),
    queueDailyChallenge: vi.fn().mockResolvedValue(queueEntry()),
    removeDailyQueueEntry: vi.fn().mockResolvedValue({ ...queueEntry(), status: "removed" }),
    ...overrides,
  };
}

function nomination(overrides: Partial<DailyNomination> = {}): DailyNomination {
  return {
    id: "nomination-1",
    challengeId: "challenge-0101",
    nominatedByAccountId: "account-1",
    nominatedByDisplayName: "Vijay",
    status: "pending",
    recognizableScore: 80,
    weirdScore: 12,
    hardScore: 53,
    suggestedFlavor: "recognizable",
    confidence: "high",
    classifierVersion: "v1",
    reviewedByAccountId: null,
    reviewedAt: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function queueEntry(overrides: Partial<DailyQueueEntry> = {}): DailyQueueEntry {
  return {
    id: "queue-1",
    challengeId: "challenge-0101",
    nominationId: "nomination-1",
    flavor: "recognizable" as DailyFlavor,
    source: "community",
    status: "queued",
    queuedByAccountId: "account-admin",
    queuedAt: "2026-07-17T00:00:00.000Z",
    consumedDailyDate: null,
    consumedAt: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function challengeCatalog(): Challenge[] {
  return [
    challenge("challenge-0101", "Challenge #101", "Mercury", "Solar System"),
    challenge("challenge-direct", "Challenge #102", "Coffee", "Moon"),
  ];
}

function challenge(id: string, label: string, start: string, target: string): Challenge {
  return {
    id,
    label,
    sortOrder: Number(id.replace(/\D/g, "")),
    isActive: true,
    mode: "solo",
    start: { title: start },
    target: { title: target },
    ruleset: "ranked_classic",
    origin: "manual",
    dailyDate: null,
    source: "curated",
  };
}
