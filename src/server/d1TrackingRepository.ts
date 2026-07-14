import { normalizeTitle } from "../domain/rules";
import { rankLeaderboardRows } from "../domain/serverLeaderboard";
import type {
  AccountStatus,
  Challenge,
  RankedLeaderboardRow,
  ServerLeaderboardRow,
  ServerPathStep,
} from "../domain/types";
import { ApiError } from "./http";
import type {
  AccountProfileRecord,
  RunRecordResponse,
  TrackingRepository,
} from "./trackingRepository";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export function createD1TrackingRepository(options: {
  db: D1DatabaseLike;
  now?: () => Date;
  randomId?: () => string;
}): TrackingRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const timestamp = () => now().toISOString();

  const repository: TrackingRepository = {
    async listChallenges() {
      const { results } = await db
        .prepare(
          `SELECT
             id,
             label,
             start_title,
             target_title,
             ruleset,
             sort_order,
             is_active,
             created_by_account_id,
             created_by_display_name,
             created_by_identity_status
           FROM challenges
           WHERE is_active = 1
           ORDER BY sort_order`,
        )
        .all<ChallengeRow>();
      return results.map(mapChallengeRow);
    },

    async createChallenge(input) {
      const latest = await db
        .prepare(
          `SELECT sort_order
           FROM challenges
           ORDER BY sort_order DESC
           LIMIT 1`,
        )
        .first<Pick<ChallengeRow, "sort_order">>();
      const sortOrder = Number(latest?.sort_order ?? 0) + 1;
      const id = `challenge-${String(sortOrder).padStart(4, "0")}`;
      const label = `Challenge #${sortOrder}`;
      const createdAt = timestamp();

      await db
        .prepare(
          `INSERT INTO challenges
             (
               id,
               label,
               start_title,
               target_title,
               ruleset,
               sort_order,
               is_active,
               created_at,
               created_by_account_id,
               created_by_display_name,
               created_by_identity_status
             )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          label,
          input.startTitle,
          input.targetTitle,
          "ranked_classic",
          sortOrder,
          1,
          createdAt,
          input.creatorAccountId,
          input.creatorDisplayName,
          input.creatorIdentityStatus,
        )
        .run();

      return {
        id,
        label,
        sortOrder,
        isActive: true,
        mode: "daily",
        start: { title: input.startTitle },
        target: { title: input.targetTitle },
        ruleset: "ranked_classic",
        source: "curated",
        createdBy: {
          accountId: input.creatorAccountId,
          displayName: input.creatorDisplayName,
          identityStatus: input.creatorIdentityStatus,
        },
      };
    },

    async upsertAccountProfile(input) {
      const profile = normalizeProfileInput(input);
      await db
        .prepare(
          `INSERT INTO account_profiles
             (account_id, public_name, identity_status, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             public_name = excluded.public_name,
             identity_status = excluded.identity_status,
             updated_at = excluded.updated_at`,
        )
        .bind(
          profile.accountId,
          profile.publicName,
          profile.identityStatus,
          timestamp(),
        )
        .run();
      return profile;
    },

    async startRun(input) {
      await repository.upsertAccountProfile({
        accountId: input.accountId,
        publicName: input.publicName,
        identityStatus: input.identityStatus,
      });

      const challenge = await db
        .prepare(
          `SELECT id, start_title, target_title
           FROM challenges
           WHERE id = ?`,
        )
        .bind(input.challengeId)
        .first<Pick<ChallengeRow, "id" | "start_title" | "target_title">>();
      if (!challenge) {
        throw new ApiError(
          "challenge_not_found",
          "That challenge does not exist.",
          404,
        );
      }

      const runId = randomId();
      const startedAt = timestamp();
      await db
        .prepare(
          `INSERT INTO runs
             (id, challenge_id, account_id, status, started_at, click_count, start_title, target_title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          challenge.id,
          input.accountId,
          "active",
          startedAt,
          0,
          challenge.start_title,
          challenge.target_title,
          startedAt,
          startedAt,
        )
        .run();

      await insertRunEvent(db, randomId(), runId, "run_started", {
        createdAt: startedAt,
      });

      return {
        id: runId,
        challengeId: challenge.id,
        accountId: input.accountId,
        status: "active",
        startTitle: challenge.start_title,
        targetTitle: challenge.target_title,
        clickCount: 0,
        startedAt,
      };
    },

    async recordClick(runId, accountId, input) {
      const run = await loadOwnedRun(db, runId, accountId);
      assertActiveRun(run);

      const stepNumber = Number(run.click_count) + 1;
      const createdAt = timestamp();
      const elapsedSinceStartMs = Math.max(
        0,
        Date.parse(createdAt) - Date.parse(run.started_at),
      );

      await insertRunEvent(db, randomId(), runId, "page_clicked", {
        stepNumber,
        sourceTitle: input.sourceTitle,
        clickedAnchorText: input.clickedAnchorText,
        requestedTitle: input.requestedTitle,
        destinationTitle: input.destinationTitle,
        destinationPageId: input.destinationPageId,
        clientTimestampMs: input.clientTimestampMs,
        createdAt,
      });

      await db
        .prepare(
          `INSERT INTO run_path_steps
             (run_id, step_number, source_title, clicked_anchor_text, destination_title, destination_page_id, elapsed_since_start_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          stepNumber,
          input.sourceTitle,
          input.clickedAnchorText,
          input.destinationTitle,
          input.destinationPageId ?? null,
          elapsedSinceStartMs,
          createdAt,
        )
        .run();

      await db
        .prepare(
          `UPDATE runs SET click_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(stepNumber, createdAt, runId)
        .run();

      return { clickCount: stepNumber };
    },

    async completeRun(runId, accountId, input) {
      const run = await loadOwnedRun(db, runId, accountId);
      assertActiveRun(run);
      if (normalizeTitle(input.finalTitle) !== normalizeTitle(run.target_title)) {
        throw new ApiError(
          "target_mismatch",
          "The final article does not match the challenge target.",
          409,
        );
      }

      const completedAt = timestamp();
      const elapsedMs = Math.max(
        0,
        Date.parse(completedAt) - Date.parse(run.started_at),
      );

      await db
        .prepare(
          `UPDATE runs SET status = 'completed',
             completed_at = ?,
             elapsed_ms = ?,
             final_title = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(completedAt, elapsedMs, input.finalTitle, completedAt, runId)
        .run();

      await insertRunEvent(db, randomId(), runId, "run_completed", {
        destinationTitle: input.finalTitle,
        clientTimestampMs: input.clientTimestampMs,
        createdAt: completedAt,
      });

      const leaderboard = await repository.listLeaderboard(run.challenge_id);
      const row = leaderboard.find((entry) => entry.runId === runId);
      if (!row) {
        throw new ApiError(
          "leaderboard_row_missing",
          "Completed run was not found on the leaderboard.",
          500,
        );
      }
      return row;
    },

    async abandonRun(runId, accountId) {
      const run = await loadOwnedRun(db, runId, accountId);
      assertActiveRun(run);
      const abandonedAt = timestamp();

      await db
        .prepare(
          `UPDATE runs SET status = 'abandoned',
             abandoned_at = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(abandonedAt, abandonedAt, runId)
        .run();

      await insertRunEvent(db, randomId(), runId, "run_abandoned", {
        createdAt: abandonedAt,
      });

      return { status: "abandoned" };
    },

    async listLeaderboard(challengeId) {
      const { results } = await db
        .prepare(
          `SELECT
             r.id,
             r.challenge_id,
             r.account_id,
             r.elapsed_ms,
             r.click_count,
             r.completed_at,
             p.public_name AS display_name
           FROM runs r
           LEFT JOIN account_profiles p ON p.account_id = r.account_id
           WHERE r.challenge_id = ? AND r.status = 'completed'`,
        )
        .bind(challengeId)
        .all<LeaderboardRunRow>();

      const rows = await Promise.all(
        results.map(async (row) => ({
          runId: row.id,
          challengeId: row.challenge_id,
          accountId: row.account_id,
          displayName: row.display_name ?? "Unknown",
          elapsedMs: Number(row.elapsed_ms),
          clickCount: Number(row.click_count),
          completedAt: row.completed_at,
          pathPreview: await repository.getRunPath(row.id),
        })),
      );

      return rankLeaderboardRows(rows satisfies ServerLeaderboardRow[]);
    },

    async getRunPath(runId) {
      const { results } = await db
        .prepare(
          `SELECT
             step_number,
             source_title,
             clicked_anchor_text,
             destination_title,
             destination_page_id,
             elapsed_since_start_ms,
             created_at
           FROM run_path_steps
           WHERE run_id = ?
           ORDER BY step_number`,
        )
        .bind(runId)
        .all<PathStepRow>();

      return results.map(mapPathStepRow);
    },
  };

  return repository;
}

function normalizeProfileInput(input: {
  accountId: string;
  publicName: string;
  identityStatus: AccountStatus;
}): AccountProfileRecord {
  const accountId = input.accountId.trim();
  const publicName = input.publicName.trim().slice(0, 24);
  if (!accountId) {
    throw new ApiError("invalid_account_id", "A VGames account is required.");
  }
  if (!publicName) {
    throw new ApiError(
      "invalid_public_name",
      "Enter a display name before starting.",
    );
  }

  return {
    accountId,
    publicName,
    identityStatus: input.identityStatus,
  };
}

async function loadOwnedRun(
  db: D1DatabaseLike,
  runId: string,
  accountId: string,
): Promise<RunRow> {
  const run = await db
    .prepare(
      `SELECT
         id,
         challenge_id,
         account_id,
         status,
         started_at,
         completed_at,
         elapsed_ms,
         click_count,
         start_title,
         target_title
       FROM runs
       WHERE id = ?`,
    )
    .bind(runId)
    .first<RunRow>();

  if (!run) {
    throw new ApiError("run_not_found", "That run does not exist.", 404);
  }
  if (run.account_id !== accountId) {
    throw new ApiError(
      "run_forbidden",
      "That run belongs to another account.",
      403,
    );
  }

  return run;
}

function assertActiveRun(run: RunRow): void {
  if (run.status !== "active") {
    throw new ApiError("run_not_active", "This run is not active.", 409);
  }
}

async function insertRunEvent(
  db: D1DatabaseLike,
  eventId: string,
  runId: string,
  eventType: "run_started" | "page_clicked" | "run_completed" | "run_abandoned",
  input: {
    stepNumber?: number;
    sourceTitle?: string;
    clickedAnchorText?: string;
    requestedTitle?: string;
    destinationTitle?: string;
    destinationPageId?: number;
    clientTimestampMs?: number;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO run_events
         (id, run_id, event_type, step_number, source_title, clicked_anchor_text, requested_title, destination_title, destination_page_id, client_timestamp_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId,
      runId,
      eventType,
      input.stepNumber ?? null,
      input.sourceTitle ?? null,
      input.clickedAnchorText ?? null,
      input.requestedTitle ?? null,
      input.destinationTitle ?? null,
      input.destinationPageId ?? null,
      input.clientTimestampMs ?? null,
      input.createdAt,
    )
    .run();
}

function mapChallengeRow(row: ChallengeRow): Challenge {
  const createdBy =
    row.created_by_account_id &&
    row.created_by_display_name &&
    row.created_by_identity_status
      ? {
          accountId: row.created_by_account_id,
          displayName: row.created_by_display_name,
          identityStatus: row.created_by_identity_status,
        }
      : undefined;

  return {
    id: row.id,
    label: row.label,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    mode: "daily",
    start: { title: row.start_title },
    target: { title: row.target_title },
    ruleset: "ranked_classic",
    source: "curated",
    createdBy,
  };
}

function mapPathStepRow(row: PathStepRow): ServerPathStep {
  return {
    stepNumber: Number(row.step_number),
    sourceTitle: row.source_title,
    clickedAnchorText: row.clicked_anchor_text,
    destinationTitle: row.destination_title,
    destinationPageId:
      row.destination_page_id === null || row.destination_page_id === undefined
        ? undefined
        : Number(row.destination_page_id),
    elapsedSinceStartMs:
      row.elapsed_since_start_ms === null ||
      row.elapsed_since_start_ms === undefined
        ? undefined
        : Number(row.elapsed_since_start_ms),
    createdAt: row.created_at,
  };
}

export function mapRunRow(row: RunRow): RunRecordResponse {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    accountId: row.account_id,
    status: row.status,
    startTitle: row.start_title,
    targetTitle: row.target_title,
    clickCount: Number(row.click_count),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    elapsedMs:
      row.elapsed_ms === null || row.elapsed_ms === undefined
        ? undefined
        : Number(row.elapsed_ms),
  };
}

interface ChallengeRow {
  id: string;
  label: string;
  start_title: string;
  target_title: string;
  ruleset: string;
  sort_order: number;
  is_active: number | boolean;
  created_by_account_id?: string | null;
  created_by_display_name?: string | null;
  created_by_identity_status?: AccountStatus | null;
}

interface RunRow {
  id: string;
  challenge_id: string;
  account_id: string;
  status: "active" | "completed" | "abandoned";
  started_at: string;
  completed_at?: string | null;
  elapsed_ms?: number | null;
  click_count: number;
  start_title: string;
  target_title: string;
}

interface LeaderboardRunRow {
  id: string;
  challenge_id: string;
  account_id: string;
  elapsed_ms: number;
  click_count: number;
  completed_at: string;
  display_name?: string | null;
}

interface PathStepRow {
  step_number: number;
  source_title: string;
  clicked_anchor_text: string;
  destination_title: string;
  destination_page_id?: number | null;
  elapsed_since_start_ms?: number | null;
  created_at: string;
}
