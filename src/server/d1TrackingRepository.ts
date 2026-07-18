import { normalizeTitle } from "../domain/rules";
import type {
  CreateChallengeOutcome,
  DailyClassification,
  DailyFlavor,
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";
import { dailyFlavorForCentralDate } from "../domain/dailyEditorial";
import { centralDateKey, previousCentralDate } from "../domain/challengeSelection";
import { dailyTrendGuard, dailyTrendWindowStart } from "../domain/dailyTrends";
import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AuthorizedAccount,
  Challenge,
  DailyTrendRankedEntry,
  DailyTrendUnrankedEntry,
  LeaderboardContext,
  RankedLeaderboardRow,
  RunTransition,
  ServerPathStep,
} from "../domain/types";
import { ApiError } from "./http";
import {
  clickOperationKey,
  DECISION_TIME_GRACE_MS,
  fingerprintAbandonRun,
  fingerprintCreateChallenge,
  fingerprintRunClick,
  fingerprintStartRun,
  MAX_RUN_CLICKS,
  MIN_RESUMABLE_CLICKS,
  RUN_EXPIRY_MS,
  type AbandonRunV2Input,
  type RecordClickV2Input,
  type StartRunV2Input,
} from "./runProtocol";
import type {
  ActiveRunRecord,
  AccountProfileRecord,
  ApproveDailyNominationInput,
  CreateChallengeV2Input,
  DailyAdminState,
  DailyChallengeInput,
  DailyChallengeJob,
  DailyFeatureSelection,
  DailyQueuedCandidate,
  DeclineDailyNominationInput,
  LegacyClickInput,
  LegacyCompleteInput,
  QueueDailyChallengeInput,
  RecordClickV2Result,
  RemoveDailyQueueEntryInput,
  RunProtocolRepository,
  RunRecordResponse,
} from "./trackingRepository";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1ResultLike {
  meta?: {
    changes?: number;
  };
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export function createD1TrackingRepository(options: {
  db: D1DatabaseLike;
  now?: () => Date;
  randomId?: () => string;
}): RunProtocolRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const timestamp = () => now().toISOString();

  const repository: RunProtocolRepository = {
    async ensureDailyChallengeJob(dailyDate) {
      const at = timestamp();
      await db.prepare(
        `INSERT OR IGNORE INTO daily_challenge_jobs
           (daily_date, status, attempt_count, next_attempt_at, created_at, updated_at)
         VALUES (?, 'pending', 0, ?, ?, ?)`,
      ).bind(requireDailyDate(dailyDate), at, at, at).run();
    },

    async claimDueDailyChallengeJob() {
      const at = timestamp();
      const leaseToken = randomId();
      const leaseExpiresAt = new Date(Date.parse(at) + 10 * 60 * 1000).toISOString();
      const result = await db.prepare(
        `UPDATE daily_challenge_jobs
         SET status = 'claimed', attempt_count = attempt_count + 1,
             lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE daily_date = (
           SELECT daily_date FROM daily_challenge_jobs
           WHERE (status = 'pending' AND next_attempt_at <= ?)
              OR (status = 'claimed' AND lease_expires_at <= ?)
           ORDER BY daily_date LIMIT 1
         ) AND ((status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'claimed' AND lease_expires_at <= ?))`,
      ).bind(leaseToken, leaseExpiresAt, at, at, at, at, at).run();
      if (mutationChanges(result) !== 1) return null;
      const row = await db.prepare(
        `SELECT daily_date, attempt_count, lease_token, lease_expires_at
         FROM daily_challenge_jobs WHERE lease_token = ? AND status = 'claimed'`,
      ).bind(leaseToken).first<DailyChallengeJobRow>();
      return row ? mapDailyChallengeJob(row) : null;
    },

    async failDailyChallengeJob(job, failureCode) {
      const normalized = normalizeDailyJob(job);
      const at = timestamp();
      const nextAttemptAt = new Date(
        Date.parse(at) + dailyRetryHours(normalized.attemptCount) * 60 * 60 * 1000,
      ).toISOString();
      await db.prepare(
        `UPDATE daily_challenge_jobs
         SET status = 'pending', next_attempt_at = ?, lease_token = NULL,
             lease_expires_at = NULL, failure_code = ?, updated_at = ?
         WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?`,
      ).bind(nextAttemptAt, redactDailyFailureCode(failureCode), at, normalized.dailyDate, normalized.leaseToken).run();
    },

    async acceptDailyChallenge(job, input) {
      return repository.acceptDailyFeature(job, {
        kind: "automatic",
        candidate: input,
        classifierVersion: "legacy-v1",
      });
    },

    async listDailyAdminState() {
      const [nominations, queueEntries] = await Promise.all([
        db.prepare(
          `SELECT id, challenge_id, nominated_by_account_id, nominated_by_display_name,
                  status, recognizable_score, weird_score, hard_score, suggested_flavor,
                  confidence, classifier_version, reviewed_by_account_id, reviewed_at,
                  created_at, updated_at
           FROM daily_nominations
           ORDER BY created_at, id`,
        ).all<DailyNominationRow>(),
        db.prepare(
          `SELECT id, challenge_id, nomination_id, flavor, source, status,
                  queued_by_account_id, queued_at, consumed_daily_date, consumed_at, updated_at
           FROM daily_queue_entries
           ORDER BY queued_at, id`,
        ).all<DailyQueueEntryRow>(),
      ]);
      return {
        nominations: nominations.results.map(mapDailyNominationRow),
        queueEntries: queueEntries.results.map(mapDailyQueueEntryRow),
      } satisfies DailyAdminState;
    },

    async approveDailyNomination(input) {
      const normalized = normalizeApproveDailyNominationInput(input);
      const at = timestamp();
      const fingerprint = await fingerprintDailyEditorialOperation("approve", normalized);
      const existing = await loadOperation(db, "approve_daily_nomination", normalized.idempotencyKey);
      if (existing) {
        return replayDailyEditorialOperation<DailyQueueEntry>(
          existing,
          normalized.actorAccountId,
          fingerprint,
        );
      }
      const queueEntryId = randomId();
      await requireBatch(db)([
        insertDailyEditorialOperation(
          db,
          "approve_daily_nomination",
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          at,
        ),
        db.prepare(
          `UPDATE daily_nominations
           SET status = 'approved', reviewed_by_account_id = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM daily_features f
               WHERE f.challenge_id = daily_nominations.challenge_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM daily_queue_entries q
               WHERE q.challenge_id = daily_nominations.challenge_id
                 AND q.status = 'queued'
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'approve_daily_nomination' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND outcome_status = 'pending'
             )`,
        ).bind(
          normalized.actorAccountId,
          at,
          at,
          normalized.nominationId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO daily_queue_entries
             (id, challenge_id, nomination_id, flavor, source, status,
              queued_by_account_id, queued_at, updated_at)
           SELECT ?, n.challenge_id, n.id, ?, 'community', 'queued', ?, ?, ?
           FROM daily_nominations n
           WHERE n.id = ? AND n.status = 'approved'
             AND NOT EXISTS (
               SELECT 1 FROM daily_features f WHERE f.challenge_id = n.challenge_id
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'approve_daily_nomination' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND outcome_status = 'pending'
             )`,
        ).bind(
          queueEntryId,
          normalized.flavor,
          normalized.actorAccountId,
          at,
          at,
          normalized.nominationId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = ?
           WHERE operation = 'approve_daily_nomination' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM daily_queue_entries
               WHERE id = ? AND nomination_id = ? AND flavor = ?
                 AND source = 'community' AND status = 'queued'
                 AND queued_by_account_id = ?
             )`,
        ).bind(
          queueEntryId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          queueEntryId,
          normalized.nominationId,
          normalized.flavor,
          normalized.actorAccountId,
        ),
        finalizeDailyQueueOperation(db, {
          operation: "approve_daily_nomination",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
        }),
        rejectApproveNominationOperation(db, {
          operation: "approve_daily_nomination",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
          nominationId: normalized.nominationId,
        }),
      ]);
      return replayDailyEditorialOperation<DailyQueueEntry>(
        await requireFinalizedOperation(db, "approve_daily_nomination", normalized.idempotencyKey),
        normalized.actorAccountId,
        fingerprint,
      );
    },

    async declineDailyNomination(input) {
      const normalized = normalizeDeclineDailyNominationInput(input);
      const at = timestamp();
      const fingerprint = await fingerprintDailyEditorialOperation("decline", normalized);
      const existing = await loadOperation(db, "decline_daily_nomination", normalized.idempotencyKey);
      if (existing) {
        return replayDailyEditorialOperation<DailyNomination>(
          existing,
          normalized.actorAccountId,
          fingerprint,
        );
      }
      await requireBatch(db)([
        insertDailyEditorialOperation(
          db,
          "decline_daily_nomination",
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          at,
        ),
        db.prepare(
          `UPDATE daily_nominations
           SET status = 'declined', reviewed_by_account_id = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM daily_queue_entries q
               WHERE q.nomination_id = daily_nominations.id AND q.source = 'community'
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'decline_daily_nomination' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND outcome_status = 'pending'
             )`,
        ).bind(
          normalized.actorAccountId,
          at,
          at,
          normalized.nominationId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = ?
           WHERE operation = 'decline_daily_nomination' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM daily_nominations WHERE id = ? AND status = 'declined'
             )`,
        ).bind(
          normalized.nominationId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          normalized.nominationId,
        ),
        finalizeDailyNominationOperation(db, {
          operation: "decline_daily_nomination",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
        }),
        rejectDailyEditorialOperation(db, {
          operation: "decline_daily_nomination",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
          missingCode: "daily_nomination_not_found",
          unavailableCode: "daily_nomination_not_pending",
          resourceSql: "SELECT challenge_id FROM daily_nominations WHERE id = ?",
          resourceBindings: [normalized.nominationId],
          stateSql: "SELECT status FROM daily_nominations WHERE id = ?",
          stateBindings: [normalized.nominationId],
        }),
      ]);
      return replayDailyEditorialOperation<DailyNomination>(
        await requireFinalizedOperation(db, "decline_daily_nomination", normalized.idempotencyKey),
        normalized.actorAccountId,
        fingerprint,
      );
    },

    async queueDailyChallenge(input) {
      const normalized = normalizeQueueDailyChallengeInput(input);
      const at = timestamp();
      const fingerprint = await fingerprintDailyEditorialOperation("queue", normalized);
      const existing = await loadOperation(db, "queue_daily_challenge", normalized.idempotencyKey);
      if (existing) {
        return replayDailyEditorialOperation<DailyQueueEntry>(
          existing,
          normalized.actorAccountId,
          fingerprint,
        );
      }
      const queueEntryId = randomId();
      await requireBatch(db)([
        insertDailyEditorialOperation(
          db,
          "queue_daily_challenge",
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          at,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO daily_queue_entries
             (id, challenge_id, nomination_id, flavor, source, status,
              queued_by_account_id, queued_at, updated_at)
           SELECT ?, c.id, NULL, ?, 'admin', 'queued', ?, ?, ?
           FROM challenges c
           WHERE c.id = ? AND c.is_active = 1 AND c.validation_status = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM daily_features f WHERE f.challenge_id = c.id
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'queue_daily_challenge' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND outcome_status = 'pending'
             )`,
        ).bind(
          queueEntryId,
          normalized.flavor,
          normalized.actorAccountId,
          at,
          at,
          normalized.challengeId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = ?
           WHERE operation = 'queue_daily_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM daily_queue_entries
               WHERE id = ? AND challenge_id = ? AND nomination_id IS NULL
                 AND flavor = ? AND source = 'admin' AND status = 'queued'
                 AND queued_by_account_id = ?
             )`,
        ).bind(
          queueEntryId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          queueEntryId,
          normalized.challengeId,
          normalized.flavor,
          normalized.actorAccountId,
        ),
        finalizeDailyQueueOperation(db, {
          operation: "queue_daily_challenge",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
        }),
        rejectDirectQueueOperation(db, {
          operation: "queue_daily_challenge",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
          challengeId: normalized.challengeId,
        }),
      ]);
      return replayDailyEditorialOperation<DailyQueueEntry>(
        await requireFinalizedOperation(db, "queue_daily_challenge", normalized.idempotencyKey),
        normalized.actorAccountId,
        fingerprint,
      );
    },

    async removeDailyQueueEntry(input) {
      const normalized = normalizeRemoveDailyQueueEntryInput(input);
      const at = timestamp();
      const fingerprint = await fingerprintDailyEditorialOperation("remove", normalized);
      const existing = await loadOperation(db, "remove_daily_queue_entry", normalized.idempotencyKey);
      if (existing) {
        return replayDailyEditorialOperation<DailyQueueEntry>(
          existing,
          normalized.actorAccountId,
          fingerprint,
        );
      }
      await requireBatch(db)([
        insertDailyEditorialOperation(
          db,
          "remove_daily_queue_entry",
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          at,
        ),
        db.prepare(
          `UPDATE daily_queue_entries
           SET status = 'removed', updated_at = ?
           WHERE id = ? AND status = 'queued'
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'remove_daily_queue_entry' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND outcome_status = 'pending'
             )`,
        ).bind(
          at,
          normalized.queueEntryId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = ?
           WHERE operation = 'remove_daily_queue_entry' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM daily_queue_entries WHERE id = ? AND status = 'removed'
             )`,
        ).bind(
          normalized.queueEntryId,
          normalized.idempotencyKey,
          normalized.actorAccountId,
          fingerprint,
          normalized.queueEntryId,
        ),
        finalizeDailyQueueOperation(db, {
          operation: "remove_daily_queue_entry",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
        }),
        rejectRemoveQueueOperation(db, {
          operation: "remove_daily_queue_entry",
          idempotencyKey: normalized.idempotencyKey,
          actorAccountId: normalized.actorAccountId,
          fingerprint,
          queueEntryId: normalized.queueEntryId,
        }),
      ]);
      return replayDailyEditorialOperation<DailyQueueEntry>(
        await requireFinalizedOperation(db, "remove_daily_queue_entry", normalized.idempotencyKey),
        normalized.actorAccountId,
        fingerprint,
      );
    },

    async findQueuedDailyCandidate(flavorInput) {
      const flavor = requireDailyFlavor(flavorInput);
      const at = timestamp();
      await db.prepare(
        `UPDATE daily_queue_entries
         SET status = 'invalid', updated_at = ?
         WHERE status = 'queued' AND flavor = ?
           AND (
             NOT EXISTS (
               SELECT 1 FROM challenges c
               WHERE c.id = daily_queue_entries.challenge_id
                 AND c.is_active = 1 AND c.validation_status = 'ready'
             )
             OR EXISTS (
               SELECT 1 FROM daily_features f
               WHERE f.challenge_id = daily_queue_entries.challenge_id
             )
             OR (
               source = 'community' AND NOT EXISTS (
                 SELECT 1 FROM daily_nominations n
                 WHERE n.id = daily_queue_entries.nomination_id
                   AND n.challenge_id = daily_queue_entries.challenge_id
                   AND n.status = 'approved'
               )
             )
           )`,
      ).bind(at, flavor).run();
      const row = await db.prepare(
        `SELECT q.id, q.challenge_id, q.nomination_id, q.flavor, q.source, q.status,
                q.queued_by_account_id, q.queued_at, q.consumed_daily_date,
                q.consumed_at, q.updated_at,
                c.label AS challenge_label, c.start_title AS challenge_start_title,
                c.target_title AS challenge_target_title, c.ruleset AS challenge_ruleset,
                c.sort_order AS challenge_sort_order, c.is_active AS challenge_is_active,
                c.start_page_id AS challenge_start_page_id,
                c.target_page_id AS challenge_target_page_id,
                c.created_by_account_id AS challenge_created_by_account_id,
                c.created_by_display_name AS challenge_created_by_display_name,
                c.created_by_identity_status AS challenge_created_by_identity_status,
                c.origin AS challenge_origin, c.daily_date AS challenge_daily_date,
                c.source AS challenge_source
         FROM daily_queue_entries q
         JOIN challenges c ON c.id = q.challenge_id
         WHERE q.status = 'queued' AND q.flavor = ?
           AND c.is_active = 1 AND c.validation_status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM daily_features f WHERE f.challenge_id = q.challenge_id
           )
           AND (q.source = 'admin' OR EXISTS (
             SELECT 1 FROM daily_nominations n
             WHERE n.id = q.nomination_id AND n.challenge_id = q.challenge_id
               AND n.status = 'approved'
           ))
         ORDER BY q.queued_at, q.id
         LIMIT 1`,
      ).bind(flavor).first<DailyQueuedCandidateRow>();
      return row ? mapDailyQueuedCandidateRow(row) : null;
    },

    async acceptDailyFeature(job, selection) {
      const normalizedJob = normalizeDailyJob(job);
      const normalizedSelection = normalizeDailyFeatureSelection(selection);
      const flavor = dailyFlavorForCentralDate(normalizedJob.dailyDate);
      const at = timestamp();
      const batch = requireBatch(db);
      const provenance = dailyFeatureAcceptanceProvenance(normalizedSelection);

      if (normalizedSelection.kind === "queued") {
        await batch([
          invalidateQueueEntry(db, normalizedSelection.queueEntryId, at),
          db.prepare(
            `INSERT OR IGNORE INTO daily_features
               (daily_date, challenge_id, flavor, selection_source, queue_entry_id,
                selected_by_account_id, classifier_version, selected_score, created_at)
             SELECT j.daily_date, q.challenge_id, q.flavor, q.source, q.id,
                    q.queued_by_account_id, ?, NULL, ?
             FROM daily_challenge_jobs j
             JOIN daily_queue_entries q ON q.id = ?
             JOIN challenges c ON c.id = q.challenge_id
             WHERE j.daily_date = ? AND j.status = 'claimed' AND j.lease_token = ?
               AND q.status = 'queued' AND q.flavor = ?
               AND c.is_active = 1 AND c.validation_status = 'ready'
               AND NOT EXISTS (
                 SELECT 1 FROM daily_features f WHERE f.daily_date = j.daily_date
               )
               AND NOT EXISTS (
                 SELECT 1 FROM daily_features f WHERE f.challenge_id = q.challenge_id
               )
               AND (q.source = 'admin' OR EXISTS (
                 SELECT 1 FROM daily_nominations n
                 WHERE n.id = q.nomination_id AND n.challenge_id = q.challenge_id
                   AND n.status = 'approved'
               ))
               AND NOT EXISTS (
                 SELECT 1
                 FROM daily_queue_entries older
                 JOIN challenges older_challenge ON older_challenge.id = older.challenge_id
                 WHERE older.status = 'queued' AND older.flavor = q.flavor
                   AND (
                     older.queued_at < q.queued_at
                     OR (older.queued_at = q.queued_at AND older.id < q.id)
                   )
                   AND older_challenge.is_active = 1
                   AND older_challenge.validation_status = 'ready'
                   AND NOT EXISTS (
                     SELECT 1 FROM daily_features older_feature
                     WHERE older_feature.challenge_id = older.challenge_id
                   )
                   AND (older.source = 'admin' OR EXISTS (
                     SELECT 1 FROM daily_nominations older_nomination
                     WHERE older_nomination.id = older.nomination_id
                       AND older_nomination.challenge_id = older.challenge_id
                       AND older_nomination.status = 'approved'
                   ))
               )`,
          ).bind(
            normalizedSelection.classifierVersion,
            at,
            normalizedSelection.queueEntryId,
            normalizedJob.dailyDate,
            normalizedJob.leaseToken,
            flavor,
          ),
          db.prepare(
            `UPDATE daily_queue_entries
             SET status = 'consumed', consumed_daily_date = ?, consumed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'
               AND EXISTS (
                 SELECT 1 FROM daily_features
                 WHERE daily_date = ? AND queue_entry_id = daily_queue_entries.id
               )`,
          ).bind(
            normalizedJob.dailyDate,
            at,
            at,
            normalizedSelection.queueEntryId,
            normalizedJob.dailyDate,
          ),
          acceptDailyFeatureJob(db, normalizedJob, at, provenance),
        ]);
      } else {
        const candidate = normalizedSelection.candidate;
        await batch([
          db.prepare(
            `UPDATE daily_challenge_jobs
             SET failure_code = 'daily_feature_allocating'
             WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?
               AND NOT EXISTS (
                 SELECT 1 FROM daily_features WHERE daily_date = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM challenges
                 WHERE start_page_id = ? AND target_page_id = ?
                   AND ruleset = 'ranked_classic'
               )`,
          ).bind(
            normalizedJob.dailyDate,
            normalizedJob.leaseToken,
            normalizedJob.dailyDate,
            candidate.startPageId,
            candidate.targetPageId,
          ),
          db.prepare(
            `UPDATE challenge_number_sequence
             SET next_sort_order = next_sort_order + 1
             WHERE sequence_name = 'global'
               AND EXISTS (
                 SELECT 1 FROM daily_challenge_jobs
                 WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?
                   AND failure_code = 'daily_feature_allocating'
               )`,
          ).bind(normalizedJob.dailyDate, normalizedJob.leaseToken),
          db.prepare(
            `INSERT OR IGNORE INTO challenges
               (id, label, start_title, target_title, start_page_id, target_page_id,
                validation_status, ruleset, sort_order, is_active, created_at,
                created_by_account_id, created_by_display_name, created_by_identity_status,
                origin, daily_date, source)
             SELECT printf('challenge-%04d', s.next_sort_order - 1),
                    'Challenge #' || (s.next_sort_order - 1), ?, ?, ?, ?,
                    'ready', 'ranked_classic', s.next_sort_order - 1, 1, ?,
                    'vwiki-race:daily', 'VWiki Race', 'claimed',
                    'daily', ?, 'wikipedia_random'
             FROM challenge_number_sequence s
             WHERE s.sequence_name = 'global'
               AND EXISTS (
                 SELECT 1 FROM daily_challenge_jobs
                 WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?
                   AND failure_code = 'daily_feature_allocating'
               )`,
          ).bind(
            candidate.startTitle,
            candidate.targetTitle,
            candidate.startPageId,
            candidate.targetPageId,
            at,
            normalizedJob.dailyDate,
            normalizedJob.dailyDate,
            normalizedJob.leaseToken,
          ),
          db.prepare(
            `UPDATE challenge_number_sequence
             SET next_sort_order = next_sort_order - 1
             WHERE sequence_name = 'global'
               AND NOT EXISTS (
                 SELECT 1 FROM challenges
                 WHERE sort_order = challenge_number_sequence.next_sort_order - 1
               )
               AND EXISTS (
                 SELECT 1 FROM daily_challenge_jobs
                 WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?
                   AND failure_code = 'daily_feature_allocating'
               )
               AND EXISTS (
                 SELECT 1 FROM challenges
                 WHERE start_page_id = ? AND target_page_id = ?
                   AND ruleset = 'ranked_classic'
               )`,
          ).bind(
            normalizedJob.dailyDate,
            normalizedJob.leaseToken,
            candidate.startPageId,
            candidate.targetPageId,
          ),
          db.prepare(
            `INSERT OR IGNORE INTO daily_features
               (daily_date, challenge_id, flavor, selection_source, queue_entry_id,
                selected_by_account_id, classifier_version, selected_score, created_at)
             SELECT j.daily_date, c.id, ?, 'automatic', NULL, NULL, ?, ?, ?
             FROM daily_challenge_jobs j
             JOIN challenges c
               ON c.start_page_id = ? AND c.target_page_id = ?
              AND c.ruleset = 'ranked_classic'
             WHERE j.daily_date = ? AND j.status = 'claimed' AND j.lease_token = ?
               AND c.is_active = 1 AND c.validation_status = 'ready'
               AND NOT EXISTS (
                 SELECT 1 FROM daily_features f WHERE f.daily_date = j.daily_date
               )
               AND NOT EXISTS (
                 SELECT 1 FROM daily_features f WHERE f.challenge_id = c.id
               )
             ORDER BY c.sort_order, c.id
             LIMIT 1`,
          ).bind(
            flavor,
            normalizedSelection.classifierVersion,
            normalizedSelection.selectedScore,
            at,
            candidate.startPageId,
            candidate.targetPageId,
            normalizedJob.dailyDate,
            normalizedJob.leaseToken,
          ),
          acceptDailyFeatureJob(db, normalizedJob, at, provenance),
        ]);
      }

      const row = await selectChallengeForDailyFeature(
        db,
        normalizedJob.dailyDate,
        provenance,
      );
      if (!row) {
        const failureCode = await dailyFeatureAcceptanceFailureCode(
          db,
          normalizedJob,
          normalizedSelection,
          flavor,
        );
        throw new ApiError(
          failureCode,
          "Daily feature acceptance did not complete.",
          500,
        );
      }
      return mapChallengeRow(row);
    },

    async listChallenges() {
      const { results } = await db
        .prepare(
          `SELECT c.id, c.label, c.start_title, c.target_title, c.ruleset,
                  c.sort_order, c.is_active, c.start_page_id, c.target_page_id,
                  c.created_by_account_id, c.created_by_display_name,
                  c.created_by_identity_status, c.origin, c.daily_date, c.source,
                  f.daily_date AS feature_daily_date, f.flavor AS feature_flavor,
                  f.selection_source AS feature_selection_source
           FROM challenges c
           LEFT JOIN daily_features f ON f.challenge_id = c.id
           WHERE c.is_active = 1
           ORDER BY c.sort_order`,
        )
        .all<ChallengeRow>();
      return results.map(mapChallengeRow);
    },

    async createChallenge(input) {
      const createdAt = timestamp();
      await requireBatch(db)([
        db.prepare(
          `UPDATE challenge_number_sequence
           SET next_sort_order = next_sort_order + 1 WHERE sequence_name = 'global'`,
        ),
        db.prepare(
          `INSERT INTO challenges
             (id, label, start_title, target_title, ruleset, sort_order, is_active,
              created_at, created_by_account_id, created_by_display_name,
              created_by_identity_status, origin, source)
           SELECT printf('challenge-%04d', next_sort_order - 1),
                  'Challenge #' || (next_sort_order - 1), ?, ?, 'ranked_classic',
                  next_sort_order - 1, 1, ?, ?, ?, ?, 'manual', 'curated'
           FROM challenge_number_sequence WHERE sequence_name = 'global'`,
        ).bind(
          input.startTitle, input.targetTitle, createdAt, input.creatorAccountId,
          input.creatorDisplayName, input.creatorIdentityStatus,
        ),
      ]);
      const row = await db.prepare(
        `SELECT id, label, start_title, target_title, ruleset, sort_order, is_active,
                start_page_id, target_page_id, created_by_account_id,
                created_by_display_name, created_by_identity_status, origin, daily_date, source
         FROM challenges WHERE created_at = ? AND created_by_account_id = ?
         ORDER BY sort_order DESC LIMIT 1`,
      ).bind(createdAt, input.creatorAccountId).first<ChallengeRow>();
      if (!row) throw new ApiError("challenge_create_failed", "Challenge creation did not complete.", 500);
      return mapChallengeRow(row);
    },

    async findChallengeCreationReplay(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const idempotencyKey = requireValue(
        input.idempotencyKey,
        "invalid_idempotency_key",
      );
      const fingerprint = requireValue(
        input.requestFingerprint,
        "invalid_request_fingerprint",
      );
      const existing = await loadOperation(db, "create_challenge", idempotencyKey);
      if (!existing) {
        return null;
      }
      await assertOperationIdentity(db, account, existing, fingerprint);
      if (await isExpiredCreateQuotaRejection(db, existing, account, timestamp())) {
        return null;
      }
      return replayCreateChallengeOperation(db, account, existing, fingerprint, timestamp());
    },

    async createChallengeV2(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const create = normalizeCreateChallengeInput(input);
      const createdAt = timestamp();
      const nominationId = randomId();
      const classification = create.dailyClassification!;
      await ingestAuthorizedAccount(db, account, createdAt);

      const fingerprint = create.requestFingerprint ?? await fingerprintCreateChallenge(create);
      const existing = await loadOperation(db, "create_challenge", create.idempotencyKey);
      let expiredRejection: OperationRow | null = null;
      if (existing) {
        await assertOperationIdentity(db, account, existing, fingerprint);
        if (await isExpiredCreateQuotaRejection(db, existing, account, createdAt)) {
          expiredRejection = existing;
        } else {
          return replayCreateChallengeOperation(db, account, existing, fingerprint, createdAt);
        }
      }

      const batch = requireBatch(db);
      const statements: D1PreparedStatementLike[] = [];
      if (expiredRejection) {
        statements.push(db.prepare(
          `UPDATE operation_idempotency
           SET idempotency_key = ?
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'rejected' AND error_code = ?
             AND created_at = ?`,
        ).bind(
          archivedQuotaOperationKey(expiredRejection),
          create.idempotencyKey,
          expiredRejection.canonical_account_id,
          fingerprint,
          expiredRejection.error_code,
          expiredRejection.created_at,
        ));
      }
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO operation_idempotency
             (operation, idempotency_key, canonical_account_id,
              request_fingerprint, outcome_status, created_at)
           VALUES ('create_challenge', ?, ?, ?, 'pending', ?)`,
        ).bind(create.idempotencyKey, account.accountId, fingerprint, createdAt),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = (
                 SELECT id FROM challenges
                 WHERE start_page_id = ? AND target_page_id = ?
                   AND ruleset = 'ranked_classic'
                 LIMIT 1
               ),
               error_code = 'existing_pair'
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending' AND resource_id IS NULL
             AND EXISTS (
               SELECT 1 FROM challenges
               WHERE start_page_id = ? AND target_page_id = ?
                 AND ruleset = 'ranked_classic'
             )
             AND (SELECT count(*) FROM operation_idempotency attempted
                  WHERE attempted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = attempted.canonical_account_id),
                                 attempted.canonical_account_id) = ?
                    AND attempted.outcome_status <> 'pending'
                    AND attempted.created_at > ?) < 20
             AND (SELECT count(*) FROM operation_idempotency accepted
                  WHERE accepted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = accepted.canonical_account_id),
                                 accepted.canonical_account_id) = ?
                    AND accepted.outcome_status = 'accepted'
                    AND accepted.created_at >= substr(?, 1, 10) || 'T00:00:00.000Z') < 10`,
        ).bind(
          create.startPageId, create.targetPageId,
          create.idempotencyKey, account.accountId, fingerprint,
          create.startPageId, create.targetPageId,
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
        ),
        db.prepare(
          `UPDATE challenge_number_sequence
           SET next_sort_order = next_sort_order + 1
           WHERE sequence_name = 'global'
             AND EXISTS (
               SELECT 1 FROM operation_idempotency o
               WHERE o.operation = 'create_challenge' AND o.idempotency_key = ?
                 AND o.canonical_account_id = ? AND o.request_fingerprint = ?
                 AND o.outcome_status = 'pending' AND o.resource_id IS NULL
             )
             AND (SELECT count(*) FROM operation_idempotency attempted
                  WHERE attempted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = attempted.canonical_account_id),
                                 attempted.canonical_account_id) = ?
                    AND attempted.outcome_status <> 'pending'
                    AND attempted.created_at > ?) < 20
             AND (SELECT count(*) FROM operation_idempotency accepted
                  WHERE accepted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = accepted.canonical_account_id),
                                 accepted.canonical_account_id) = ?
                    AND accepted.outcome_status = 'accepted'
                    AND accepted.created_at >= substr(?, 1, 10) || 'T00:00:00.000Z') < 10`,
        ).bind(
          create.idempotencyKey, account.accountId, fingerprint,
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = printf('challenge-%04d', (
             SELECT next_sort_order - 1 FROM challenge_number_sequence
             WHERE sequence_name = 'global'
           ))
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending' AND resource_id IS NULL
             AND (SELECT count(*) FROM operation_idempotency attempted
                  WHERE attempted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = attempted.canonical_account_id),
                                 attempted.canonical_account_id) = ?
                    AND attempted.outcome_status <> 'pending'
                    AND attempted.created_at > ?) < 20
             AND (SELECT count(*) FROM operation_idempotency accepted
                  WHERE accepted.operation = 'create_challenge'
                    AND coalesce((SELECT canonical_account_id FROM account_aliases
                                  WHERE alias_account_id = accepted.canonical_account_id),
                                 accepted.canonical_account_id) = ?
                    AND accepted.outcome_status = 'accepted'
                    AND accepted.created_at >= substr(?, 1, 10) || 'T00:00:00.000Z') < 10`,
        ).bind(
          create.idempotencyKey, account.accountId, fingerprint,
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
        ),
        // Invariant: `account_aliases` (the merge-graph joined below) holds
        // opaque internal account UUIDs — server-to-server only, NEVER
        // serialize aliases into any client-facing response.
        db.prepare(
          `INSERT OR IGNORE INTO challenges
             (id, label, start_title, target_title, start_page_id, target_page_id,
              validation_status, ruleset, sort_order, is_active, created_at,
              created_by_account_id, created_by_display_name, created_by_identity_status,
              source)
           SELECT o.resource_id,
                  'Challenge #' || (SELECT next_sort_order - 1 FROM challenge_number_sequence WHERE sequence_name = 'global'),
                  ?, ?, ?, ?, 'ready', 'ranked_classic',
                  (SELECT next_sort_order - 1 FROM challenge_number_sequence WHERE sequence_name = 'global'),
                  1, ?, ?, ?, ?, ?
           FROM operation_idempotency o
           WHERE o.operation = 'create_challenge' AND o.idempotency_key = ?
             AND o.canonical_account_id = ? AND o.request_fingerprint = ?
             AND o.outcome_status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM challenges c WHERE c.id = o.resource_id)
             AND (SELECT count(*) FROM operation_idempotency attempted
                  WHERE attempted.operation = 'create_challenge'
                    AND coalesce(
                      (SELECT canonical_account_id FROM account_aliases
                       WHERE alias_account_id = attempted.canonical_account_id),
                      attempted.canonical_account_id
                    ) = ?
                    AND attempted.outcome_status <> 'pending'
                    AND attempted.created_at > ?) < 20
             AND (SELECT count(*) FROM operation_idempotency accepted
                  WHERE accepted.operation = 'create_challenge'
                    AND coalesce(
                      (SELECT canonical_account_id FROM account_aliases
                       WHERE alias_account_id = accepted.canonical_account_id),
                      accepted.canonical_account_id
                    ) = ?
                    AND accepted.outcome_status = 'accepted'
                    AND accepted.created_at >= substr(?, 1, 10) || 'T00:00:00.000Z') < 10`,
        ).bind(
          create.startTitle, create.targetTitle, create.startPageId, create.targetPageId,
          createdAt, account.accountId, account.displayName, account.status, create.source,
          create.idempotencyKey, account.accountId, fingerprint,
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
        ),
        db.prepare(
          `UPDATE challenge_number_sequence
           SET next_sort_order = next_sort_order - 1
           WHERE sequence_name = 'global'
             AND NOT EXISTS (
               SELECT 1 FROM challenges c
               WHERE c.sort_order = challenge_number_sequence.next_sort_order - 1
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency o
               WHERE o.operation = 'create_challenge' AND o.idempotency_key = ?
                 AND o.canonical_account_id = ? AND o.request_fingerprint = ?
                 AND o.outcome_status = 'pending'
                 AND o.resource_id = printf(
                   'challenge-%04d', challenge_number_sequence.next_sort_order - 1
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM challenges allocated WHERE allocated.id = o.resource_id
                 )
                 AND EXISTS (
                   SELECT 1 FROM challenges winner
                   WHERE winner.start_page_id = ? AND winner.target_page_id = ?
                     AND winner.ruleset = 'ranked_classic'
                 )
             )`,
        ).bind(
          create.idempotencyKey,
          account.accountId,
          fingerprint,
          create.startPageId,
          create.targetPageId,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET resource_id = (
                 SELECT id FROM challenges
                 WHERE start_page_id = ? AND target_page_id = ?
                   AND ruleset = 'ranked_classic'
                 ORDER BY sort_order, id
                 LIMIT 1
               ),
               error_code = 'existing_pair'
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND resource_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM challenges allocated
               WHERE allocated.id = operation_idempotency.resource_id
             )
             AND EXISTS (
               SELECT 1 FROM challenges winner
               WHERE winner.start_page_id = ? AND winner.target_page_id = ?
                 AND winner.ruleset = 'ranked_classic'
             )`,
        ).bind(
          create.startPageId,
          create.targetPageId,
          create.idempotencyKey,
          account.accountId,
          fingerprint,
          create.startPageId,
          create.targetPageId,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO daily_nominations
             (id, challenge_id, nominated_by_account_id, nominated_by_display_name,
              status, recognizable_score, weird_score, hard_score,
              suggested_flavor, confidence, classifier_version,
              created_at, updated_at)
           SELECT ?, o.resource_id, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?
           FROM operation_idempotency o
           WHERE o.operation = 'create_challenge' AND o.idempotency_key = ?
             AND o.canonical_account_id = ? AND o.request_fingerprint = ?
             AND o.outcome_status = 'pending' AND o.resource_id IS NOT NULL
             AND ? = 1 AND ? = 'claimed'
             AND EXISTS (SELECT 1 FROM challenges c WHERE c.id = o.resource_id)
             AND NOT EXISTS (
               SELECT 1 FROM daily_features f WHERE f.challenge_id = o.resource_id
             )`,
        ).bind(
          nominationId,
          account.accountId,
          account.displayName,
          classification.recognizableScore,
          classification.weirdScore,
          classification.hardScore,
          classification.suggestedFlavor,
          classification.confidence,
          classification.classifierVersion,
          createdAt,
          createdAt,
          create.idempotencyKey,
          account.accountId,
          fingerprint,
          create.nominateForDaily ? 1 : 0,
          account.status,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'accepted',
               response_json = (
                 SELECT json_object(
                   'challenge', json_object(
                     'id', c.id, 'label', c.label, 'sortOrder', c.sort_order,
                     'isActive', c.is_active,
                     'mode', CASE
                       WHEN f.challenge_id IS NOT NULL OR c.origin = 'daily'
                         THEN 'daily'
                       ELSE 'solo'
                     END,
                     'start', json_object('title', c.start_title, 'pageId', c.start_page_id),
                     'target', json_object('title', c.target_title, 'pageId', c.target_page_id),
                     'ruleset', c.ruleset,
                     'origin', CASE
                       WHEN f.challenge_id IS NOT NULL OR c.origin = 'daily'
                         THEN 'daily'
                       ELSE 'manual'
                     END,
                     'dailyDate', coalesce(f.daily_date, c.daily_date),
                     'dailyFeature', CASE
                       WHEN f.challenge_id IS NOT NULL THEN json_object(
                         'dailyDate', f.daily_date,
                         'flavor', f.flavor,
                         'selectionSource', f.selection_source
                       )
                       ELSE NULL
                     END,
                     'source', CASE
                       WHEN f.selection_source = 'automatic' THEN 'wikipedia_random'
                       WHEN f.challenge_id IS NOT NULL THEN 'curated'
                       WHEN c.source = 'wikipedia_random' THEN 'wikipedia_random'
                       ELSE 'curated'
                     END,
                     'createdBy', json_object('accountId', c.created_by_account_id,
                       'displayName', c.created_by_display_name,
                       'identityStatus', c.created_by_identity_status)
                   ),
                   'disposition', CASE
                     WHEN operation_idempotency.error_code = 'existing_pair'
                       THEN 'existing'
                     ELSE 'created'
                   END,
                   'nomination', CASE
                     WHEN ? = 0 THEN 'not_requested'
                     WHEN ? <> 'claimed' THEN 'account_required'
                     WHEN EXISTS (
                       SELECT 1 FROM daily_features f WHERE f.challenge_id = c.id
                     ) THEN 'previously_featured'
                     WHEN EXISTS (
                       SELECT 1 FROM daily_nominations n WHERE n.id = ?
                     ) THEN 'pending'
                     ELSE 'already_exists'
                   END
                 )
                 FROM challenges c
                 LEFT JOIN daily_features f ON f.challenge_id = c.id
                 WHERE c.id = operation_idempotency.resource_id
               )
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (SELECT 1 FROM challenges WHERE id = resource_id)`,
        ).bind(
          create.nominateForDaily ? 1 : 0,
          account.status,
          nominationId,
          create.idempotencyKey,
          account.accountId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'rejected', error_code = CASE
             WHEN (SELECT count(*) FROM operation_idempotency attempted
                   WHERE attempted.operation = 'create_challenge'
                     AND coalesce(
                       (SELECT canonical_account_id FROM account_aliases
                        WHERE alias_account_id = attempted.canonical_account_id),
                       attempted.canonical_account_id
                     ) = ?
                     AND attempted.outcome_status <> 'pending'
                     AND attempted.created_at > ?) >= 20 THEN 'challenge_create_rate_limited'
             WHEN (SELECT count(*) FROM operation_idempotency accepted
                   WHERE accepted.operation = 'create_challenge'
                     AND coalesce(
                       (SELECT canonical_account_id FROM account_aliases
                        WHERE alias_account_id = accepted.canonical_account_id),
                       accepted.canonical_account_id
                     ) = ?
                     AND accepted.outcome_status = 'accepted'
                     AND accepted.created_at >= substr(?, 1, 10) || 'T00:00:00.000Z') >= 10 THEN 'challenge_create_daily_limit'
             ELSE 'challenge_create_conflict'
           END
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'`,
        ).bind(
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
          create.idempotencyKey, account.accountId, fingerprint,
        ),
      );
      const results = await batch(statements);
      inspectBatchResult(results[0]);
      return replayCreateChallengeOperation(
        db,
        account,
        await requireFinalizedOperation(db, "create_challenge", create.idempotencyKey),
        fingerprint,
        createdAt,
      );
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

    async startRunV2(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const challengeId = requireValue(input.challengeId, "invalid_challenge_id");
      const idempotencyKey = requireValue(input.idempotencyKey, "invalid_idempotency_key");
      const createdAt = timestamp();
      await ingestAuthorizedAccount(db, account, createdAt);

      const fingerprint = await fingerprintStartRun({ challengeId, idempotencyKey });
      const existing = await loadOperation(db, "start", idempotencyKey);
      if (existing) {
        return replayStartOperation(db, account, existing, fingerprint, createdAt);
      }

      const runId = randomId();
      const eventId = randomId();
      const expiresAt = new Date(Date.parse(createdAt) + RUN_EXPIRY_MS).toISOString();
      const batch = requireBatch(db);
      const results = await batch([
        db.prepare(
          `INSERT OR IGNORE INTO operation_idempotency
             (operation, idempotency_key, canonical_account_id,
              request_fingerprint, resource_id, outcome_status, created_at)
           VALUES ('start', ?, ?, ?, ?, 'pending', ?)`,
        ).bind(idempotencyKey, account.accountId, fingerprint, runId, createdAt),
        db.prepare(
          `UPDATE runs
           SET status = 'abandoned', abandoned_at = ?, updated_at = ?,
               ranked_eligible = 0
           WHERE coalesce(canonical_account_id, account_id) = ?
             AND status = 'active'
             AND protocol_version = 2
             AND click_count < ?
             AND EXISTS (
               SELECT 1 FROM operation_idempotency o
               WHERE o.operation = 'start' AND o.idempotency_key = ?
                 AND o.canonical_account_id = ? AND o.request_fingerprint = ?
                 AND o.resource_id = ? AND o.outcome_status = 'pending'
             )`,
        ).bind(
          createdAt,
          createdAt,
          account.accountId,
          MIN_RESUMABLE_CLICKS,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
        ),
        db.prepare(
          `INSERT INTO runs
             (id, challenge_id, account_id, canonical_account_id, status,
              started_at, click_count, start_title, target_title,
              start_page_id, target_page_id, last_page_id, last_title,
              expires_at, wall_elapsed_ms, ranked_eligible, protocol_version,
              created_at, updated_at)
           SELECT ?, c.id, ?, ?, 'active', ?, 0, c.start_title, c.target_title,
                  c.start_page_id, c.target_page_id, c.start_page_id,
                  c.start_title, ?, 0, 1, 2, ?, ?
           FROM challenges c
           JOIN operation_idempotency o
             ON o.operation = 'start' AND o.idempotency_key = ?
            AND o.canonical_account_id = ? AND o.request_fingerprint = ?
            AND o.resource_id = ? AND o.outcome_status = 'pending'
           WHERE c.id = ? AND c.is_active = 1
             AND c.validation_status = 'ready'
             AND c.start_page_id IS NOT NULL AND c.target_page_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM runs active
               WHERE coalesce(active.canonical_account_id, active.account_id) = ?
                 AND active.status = 'active'
             )
             AND (SELECT count(*) FROM operation_idempotency attempted
                  WHERE attempted.operation = 'start'
                    AND coalesce(
                      (SELECT canonical_account_id FROM account_aliases
                       WHERE alias_account_id = attempted.canonical_account_id),
                      attempted.canonical_account_id
                    ) = ?
                    AND attempted.outcome_status <> 'pending'
                    AND attempted.created_at > ?) < 120`,
        ).bind(
          runId,
          account.accountId,
          account.accountId,
          createdAt,
          expiresAt,
          createdAt,
          createdAt,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
          challengeId,
          account.accountId,
          account.accountId,
          new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
        ),
        db.prepare(
          `INSERT INTO run_events
             (id, run_id, event_type, step_number, created_at)
           SELECT ?, r.id, 'run_started', 0, ?
           FROM runs r
           JOIN operation_idempotency o
             ON o.operation = 'start' AND o.idempotency_key = ?
            AND o.canonical_account_id = ? AND o.request_fingerprint = ?
            AND o.resource_id = r.id AND o.outcome_status = 'pending'
           WHERE r.id = ? AND r.protocol_version = 2`,
        ).bind(
          eventId,
          createdAt,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'accepted',
               response_json = (
                 SELECT json_object(
                   'id', r.id,
                   'challengeId', r.challenge_id,
                   'accountId', coalesce(r.canonical_account_id, r.account_id),
                   'canonicalAccountId', coalesce(r.canonical_account_id, r.account_id),
                   'status', r.status,
                   'startTitle', r.start_title,
                   'targetTitle', r.target_title,
                   'startPageId', r.start_page_id,
                   'targetPageId', r.target_page_id,
                   'lastPageId', r.last_page_id,
                   'lastTitle', r.last_title,
                   'clickCount', r.click_count,
                   'startedAt', r.started_at,
                   'expiresAt', r.expires_at,
                   'wallElapsedMs', r.wall_elapsed_ms,
                   'protocolVersion', r.protocol_version
                 ) FROM runs r WHERE r.id = ?
               )
           WHERE operation = 'start' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'
             AND EXISTS (SELECT 1 FROM runs WHERE id = ?)`,
        ).bind(
          runId,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
          runId,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'rejected',
               error_code = CASE
                 WHEN NOT EXISTS (SELECT 1 FROM challenges WHERE id = ?)
                   THEN 'challenge_not_found'
                 WHEN NOT EXISTS (
                   SELECT 1 FROM challenges
                   WHERE id = ? AND is_active = 1
                     AND validation_status = 'ready'
                     AND start_page_id IS NOT NULL AND target_page_id IS NOT NULL
                 ) THEN 'challenge_unavailable'
                 WHEN EXISTS (
                   SELECT 1 FROM runs
                   WHERE coalesce(canonical_account_id, account_id) = ?
                     AND status = 'active'
                 ) THEN 'active_run_exists'
                 WHEN (SELECT count(*) FROM operation_idempotency attempted
                       WHERE attempted.operation = 'start'
                         AND coalesce(
                           (SELECT canonical_account_id FROM account_aliases
                            WHERE alias_account_id = attempted.canonical_account_id),
                           attempted.canonical_account_id
                         ) = ?
                         AND attempted.outcome_status <> 'pending'
                         AND attempted.created_at > ?) >= 120 THEN 'start_rate_limited'
                 ELSE 'start_conflict'
               END
           WHERE operation = 'start' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'`,
        ).bind(
          challengeId,
          challengeId,
          account.accountId,
          account.accountId,
          new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
        ),
      ]);
      inspectBatchResult(results[0]);

      const operation = await requireFinalizedOperation(db, "start", idempotencyKey);
      return replayStartOperation(db, account, operation, fingerprint, createdAt);
    },

    async recordClickV2(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const click = normalizeClickInput(input);
      const sourceRevisionValid = click.sourceRevisionId === undefined || (
        Number.isSafeInteger(click.sourceRevisionId) && click.sourceRevisionId > 0
      );
      const sourceRevisionForSql = sourceRevisionValid
        ? click.sourceRevisionId ?? null
        : null;
      const receivedAt = timestamp();
      await ingestAuthorizedAccount(db, account, receivedAt);

      const fingerprint = await fingerprintRunClick(click);
      const operationKey = clickOperationKey(click.runId, click.clientEventId);
      const existing = await loadOperation(db, "click", operationKey);
      if (existing) {
        return replayClickOperation(db, account, existing, fingerprint, receivedAt);
      }

      const eventId = randomId();
      const batch = requireBatch(db);
      const results = await batch([
        db.prepare(
          `INSERT OR IGNORE INTO operation_idempotency
             (operation, idempotency_key, canonical_account_id,
              request_fingerprint, resource_id, outcome_status, created_at)
           VALUES ('click', ?, ?, ?, ?, 'pending', ?)`,
        ).bind(
          operationKey,
          account.accountId,
          fingerprint,
          click.runId,
          receivedAt,
        ),
        db.prepare(
          `INSERT INTO run_events
             (id, run_id, event_type, step_number, source_title,
              clicked_anchor_text, requested_title, destination_title,
              destination_page_id, client_timestamp_ms, created_at,
              client_event_id, request_fingerprint, source_page_id,
              source_revision_id, response_click_count, response_run_status,
              response_completed_at, response_elapsed_ms)
           SELECT ?, r.id, 'page_clicked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  r.click_count + 1,
                  CASE WHEN ? = r.target_page_id THEN 'completed' ELSE 'active' END,
                  CASE WHEN ? = r.target_page_id THEN ? ELSE NULL END,
                  CASE WHEN ? = r.target_page_id THEN ? ELSE NULL END
           FROM runs r
           JOIN operation_idempotency o
             ON o.operation = 'click' AND o.idempotency_key = ?
            AND o.canonical_account_id = ? AND o.request_fingerprint = ?
            AND o.resource_id = r.id AND o.outcome_status = 'pending'
           WHERE r.id = ?
             AND coalesce(r.canonical_account_id, r.account_id) = ?
             AND ? = 1
             AND r.protocol_version = 2 AND r.status = 'active'
             AND r.expires_at >= ? AND r.click_count < ?
             AND ? = r.click_count + 1 AND r.last_page_id = ?
             AND ? = cast(? as integer)
             AND ? >= coalesce(r.elapsed_ms, 0)
             AND ? <= max(
               0,
               cast(round((julianday(?) - julianday(r.started_at)) * 86400000) as integer)
             ) + ?`,
        ).bind(
          eventId,
          click.expectedStepNumber,
          click.sourceTitle,
          click.clickedAnchorText,
          click.requestedTitle,
          click.destinationTitle,
          click.destinationPageId,
          parseClientTimestamp(click.clientObservedAt),
          receivedAt,
          click.clientEventId,
          fingerprint,
          click.sourcePageId,
          sourceRevisionForSql,
          click.destinationPageId,
          click.destinationPageId,
          receivedAt,
          click.destinationPageId,
          click.decisionElapsedMs,
          operationKey,
          account.accountId,
          fingerprint,
          click.runId,
          account.accountId,
          sourceRevisionValid ? 1 : 0,
          receivedAt,
          MAX_RUN_CLICKS,
          click.expectedStepNumber,
          click.sourcePageId,
          click.decisionElapsedMs,
          click.decisionElapsedMs,
          click.decisionElapsedMs,
          click.decisionElapsedMs,
          receivedAt,
          DECISION_TIME_GRACE_MS,
        ),
        db.prepare(
          `INSERT INTO run_path_steps
             (run_id, step_number, source_title, clicked_anchor_text,
              destination_title, destination_page_id,
              elapsed_since_start_ms, created_at)
           SELECT e.run_id, e.step_number, e.source_title,
                  e.clicked_anchor_text, e.destination_title,
                  e.destination_page_id, ?, e.created_at
           FROM run_events e
           JOIN operation_idempotency o
             ON o.operation = 'click' AND o.idempotency_key = ?
            AND o.canonical_account_id = ? AND o.request_fingerprint = ?
            AND o.resource_id = e.run_id AND o.outcome_status = 'pending'
           WHERE e.id = ? AND e.run_id = ? AND e.client_event_id = ?
             AND e.request_fingerprint = ?`,
        ).bind(
          click.decisionElapsedMs,
          operationKey,
          account.accountId,
          fingerprint,
          eventId,
          click.runId,
          click.clientEventId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE runs
           SET click_count = (
                 SELECT e.response_click_count FROM run_events e WHERE e.id = ?
               ),
               last_page_id = ?,
               last_title = ?,
               elapsed_ms = ?,
               wall_elapsed_ms = max(0, cast(round(
                 (julianday(?) - julianday(started_at)) * 86400000
               ) as integer)),
               status = (
                 SELECT e.response_run_status FROM run_events e WHERE e.id = ?
               ),
               completed_at = (
                 SELECT e.response_completed_at FROM run_events e WHERE e.id = ?
               ),
               final_title = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM run_events e
                   WHERE e.id = ? AND e.response_run_status = 'completed'
                 ) THEN ? ELSE final_title END,
               updated_at = ?
           WHERE id = ? AND protocol_version = 2
             AND EXISTS (
               SELECT 1 FROM run_events e
               JOIN operation_idempotency o
                 ON o.operation = 'click' AND o.idempotency_key = ?
                AND o.canonical_account_id = ? AND o.request_fingerprint = ?
                AND o.resource_id = e.run_id AND o.outcome_status = 'pending'
               WHERE e.id = ? AND e.run_id = runs.id
                 AND e.client_event_id = ? AND e.request_fingerprint = ?
             )`,
        ).bind(
          eventId,
          click.destinationPageId,
          click.destinationTitle,
          click.decisionElapsedMs,
          receivedAt,
          eventId,
          eventId,
          eventId,
          click.destinationTitle,
          receivedAt,
          click.runId,
          operationKey,
          account.accountId,
          fingerprint,
          eventId,
          click.clientEventId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'accepted',
               response_json = (
                 SELECT CASE
                   WHEN e.response_run_status = 'completed' THEN json_object(
                     'runId', e.run_id,
                     'clickCount', e.response_click_count,
                     'runStatus', e.response_run_status,
                     'completedAt', e.response_completed_at,
                     'elapsedMs', e.response_elapsed_ms
                   )
                   ELSE json_object(
                     'runId', e.run_id,
                     'clickCount', e.response_click_count,
                     'runStatus', e.response_run_status
                   )
                 END
                 FROM run_events e WHERE e.id = ?
               )
           WHERE operation = 'click' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM run_events
               WHERE id = ? AND run_id = ? AND client_event_id = ?
                 AND request_fingerprint = ?
             )`,
        ).bind(
          eventId,
          operationKey,
          account.accountId,
          fingerprint,
          click.runId,
          eventId,
          click.runId,
          click.clientEventId,
          fingerprint,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'rejected',
               error_code = CASE
                 WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = ?)
                   THEN 'run_not_found'
                 WHEN NOT EXISTS (
                   SELECT 1 FROM runs
                   WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
                 ) THEN 'run_forbidden'
                 WHEN (SELECT protocol_version FROM runs WHERE id = ?) <> 2
                   THEN 'protocol_mismatch'
                 WHEN ? <> 1 THEN 'invalid_source_revision'
                 WHEN (SELECT expires_at FROM runs WHERE id = ?) < ?
                   THEN 'run_expired'
                 WHEN (SELECT status FROM runs WHERE id = ?) <> 'active'
                   THEN 'run_not_active'
                 WHEN (SELECT click_count FROM runs WHERE id = ?) >= ?
                   THEN 'click_limit_reached'
                 WHEN ? <> (SELECT click_count + 1 FROM runs WHERE id = ?)
                   THEN 'stale_step'
                 WHEN ? <> (SELECT last_page_id FROM runs WHERE id = ?)
                   THEN 'source_page_mismatch'
                 WHEN ? <> cast(? as integer)
                   OR ? < coalesce((SELECT elapsed_ms FROM runs WHERE id = ?), 0)
                   OR ? > max(
                     0,
                     cast(round((
                       julianday(?) -
                       julianday((SELECT started_at FROM runs WHERE id = ?))
                     ) * 86400000) as integer)
                   ) + ?
                   THEN 'invalid_decision_time'
                 ELSE 'click_conflict'
               END
           WHERE operation = 'click' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'`,
        ).bind(
          click.runId,
          click.runId,
          account.accountId,
          click.runId,
          sourceRevisionValid ? 1 : 0,
          click.runId,
          receivedAt,
          click.runId,
          click.runId,
          MAX_RUN_CLICKS,
          click.expectedStepNumber,
          click.runId,
          click.sourcePageId,
          click.runId,
          click.decisionElapsedMs,
          click.decisionElapsedMs,
          click.decisionElapsedMs,
          click.runId,
          click.decisionElapsedMs,
          receivedAt,
          click.runId,
          DECISION_TIME_GRACE_MS,
          operationKey,
          account.accountId,
          fingerprint,
          click.runId,
        ),
      ]);
      inspectBatchResult(results[0]);

      const operation = await requireFinalizedOperation(db, "click", operationKey);
      return replayClickOperation(db, account, operation, fingerprint, receivedAt);
    },

    async abandonRunV2(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const runId = requireValue(input.runId, "invalid_run_id");
      const idempotencyKey = requireValue(input.idempotencyKey, "invalid_idempotency_key");
      const request: AbandonRunV2Input = {
        runId,
        idempotencyKey,
        recoveryProtocolVersion: input.recoveryProtocolVersion,
      };
      const receivedAt = timestamp();
      await ingestAuthorizedAccount(db, account, receivedAt, runId);
      const mutationOwnerId = await resolveReceiptOwnedRunOwner(
        db,
        account,
        runId,
      ) ?? account.accountId;

      const fingerprint = await fingerprintAbandonRun(request);
      const existing = await loadOperation(db, "abandon", idempotencyKey);
      if (existing) {
        return replayAbandonOperation(db, account, existing, fingerprint, receivedAt);
      }

      const eventId = randomId();
      const recoveryVersion = request.recoveryProtocolVersion ?? null;
      const batch = requireBatch(db);
      const results = await batch([
        db.prepare(
          `INSERT OR IGNORE INTO operation_idempotency
             (operation, idempotency_key, canonical_account_id,
              request_fingerprint, resource_id, outcome_status, created_at)
           VALUES ('abandon', ?, ?, ?, ?, 'pending', ?)`,
        ).bind(idempotencyKey, account.accountId, fingerprint, runId, receivedAt),
        db.prepare(
          `UPDATE runs
           SET status = 'abandoned', abandoned_at = ?, updated_at = ?,
               ranked_eligible = 0,
               wall_elapsed_ms = max(0, cast(round(
                 (julianday(?) - julianday(started_at)) * 86400000
               ) as integer)),
               elapsed_ms = max(0, cast(round(
                 (julianday(?) - julianday(started_at)) * 86400000
               ) as integer))
           WHERE id = ?
             AND coalesce(canonical_account_id, account_id) = ?
             AND status = 'active'
             AND (
               protocol_version = 2 OR
               (protocol_version = 1 AND ? = 1)
             )
             AND EXISTS (
               SELECT 1 FROM operation_idempotency
               WHERE operation = 'abandon' AND idempotency_key = ?
                 AND canonical_account_id = ? AND request_fingerprint = ?
                 AND resource_id = ? AND outcome_status = 'pending'
             )`,
        ).bind(
          receivedAt,
          receivedAt,
          receivedAt,
          receivedAt,
          runId,
          mutationOwnerId,
          recoveryVersion,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
        ),
        db.prepare(
          `INSERT INTO run_events (id, run_id, event_type, created_at)
           SELECT ?, r.id, 'run_abandoned', ?
           FROM runs r
           JOIN operation_idempotency o
             ON o.operation = 'abandon' AND o.idempotency_key = ?
            AND o.canonical_account_id = ? AND o.request_fingerprint = ?
            AND o.resource_id = r.id AND o.outcome_status = 'pending'
           WHERE r.id = ?
             AND coalesce(r.canonical_account_id, r.account_id) = ?
             AND r.status = 'abandoned' AND r.abandoned_at = ?
             AND changes() = 1
             AND (r.protocol_version = 2 OR (r.protocol_version = 1 AND ? = 1))`,
        ).bind(
          eventId,
          receivedAt,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
          mutationOwnerId,
          receivedAt,
          recoveryVersion,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'accepted',
               response_json = (
                 SELECT CASE
                   WHEN r.status = 'completed' THEN json_object(
                     'runId', r.id, 'runStatus', 'completed',
                     'completedAt', r.completed_at, 'elapsedMs', r.elapsed_ms,
                     'outcome', 'already_completed'
                   )
                   ELSE json_object(
                     'runId', r.id, 'runStatus', 'abandoned',
                     'outcome', CASE WHEN r.protocol_version = 1
                       THEN 'legacy_recovery_abandoned' ELSE 'abandoned' END
                   )
                 END
                 FROM runs r WHERE r.id = ?
               )
           WHERE operation = 'abandon' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM runs r WHERE r.id = ?
                 AND coalesce(r.canonical_account_id, r.account_id) = ?
                 AND (
                   (r.status = 'completed' AND r.protocol_version = 2) OR
                   (r.status = 'abandoned' AND EXISTS (
                     SELECT 1 FROM run_events e
                     WHERE e.id = ? AND e.run_id = r.id
                       AND e.event_type = 'run_abandoned'
                   ))
                 )
             )`,
        ).bind(
          runId,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
          runId,
          mutationOwnerId,
          eventId,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'rejected',
               error_code = CASE
                 WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = ?)
                   THEN 'run_not_found'
                 WHEN NOT EXISTS (
                   SELECT 1 FROM runs
                   WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
                 ) THEN 'run_forbidden'
                 WHEN (SELECT protocol_version FROM runs WHERE id = ?) = 1
                   AND ? IS NOT 1 THEN 'protocol_mismatch'
                 WHEN (SELECT protocol_version FROM runs WHERE id = ?) NOT IN (1, 2)
                   THEN 'protocol_mismatch'
                 ELSE 'run_not_active'
               END
           WHERE operation = 'abandon' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND resource_id = ? AND outcome_status = 'pending'`,
        ).bind(
          runId,
          runId,
          mutationOwnerId,
          runId,
          recoveryVersion,
          runId,
          idempotencyKey,
          account.accountId,
          fingerprint,
          runId,
        ),
      ]);
      inspectBatchResult(results[0]);

      const operation = await requireFinalizedOperation(db, "abandon", idempotencyKey);
      return replayAbandonOperation(db, account, operation, fingerprint, receivedAt);
    },

    async findActiveRun(accountInput) {
      const account = normalizeAuthorizedAccount(accountInput);
      const receipt = receiptIdsCte(account);
      const at = timestamp();
      const row = await db.prepare(
        `WITH ${receipt.sql}
         ${ACTIVE_RUN_SELECT}
         LEFT JOIN account_aliases owner_alias
           ON owner_alias.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
         WHERE (
           coalesce(r.canonical_account_id, r.account_id) IN (SELECT account_id FROM receipt_ids)
           OR owner_alias.canonical_account_id IN (SELECT account_id FROM receipt_ids)
         )
           AND r.status = 'active'
           AND (r.expires_at IS NULL OR r.expires_at >= ?)
           AND (r.protocol_version <> 2 OR r.click_count >= ?)
         ORDER BY r.started_at DESC LIMIT 1`,
      ).bind(...receipt.bindings, at, MIN_RESUMABLE_CLICKS).first<RunRow>();
      return row ? mapActiveRunRow(row) : null;
    },

    async startRunLegacy(accountInput, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      return startLegacyRun(
        db,
        {
          challengeId: input.challengeId,
          accountId: account.accountId,
          publicName: account.displayName,
          identityStatus: account.status,
          aliases: account.aliases,
        },
        timestamp(),
        randomId,
      );
    },

    async recordClickLegacy(accountInput, runId, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const at = timestamp();
      await ingestAuthorizedAccount(db, account, at);
      return recordLegacyClick(db, runId, account.accountId, input, at, randomId);
    },

    async completeRunLegacy(accountInput, runId, input) {
      const account = normalizeAuthorizedAccount(accountInput);
      const at = timestamp();
      await ingestAuthorizedAccount(db, account, at);
      return completeLegacyRun(db, runId, account.accountId, input, at, randomId);
    },

    async abandonRunLegacy(accountInput, runId) {
      const account = normalizeAuthorizedAccount(accountInput);
      const at = timestamp();
      await ingestAuthorizedAccount(db, account, at);
      return abandonLegacyRun(db, runId, account.accountId, at, randomId);
    },

    async startRun(input) {
      if (db.batch) {
        return startLegacyRun(db, input, timestamp(), randomId);
      }
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
      if (db.batch) {
        return recordLegacyClick(
          db,
          runId,
          accountId,
          input,
          timestamp(),
          randomId,
        );
      }
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
      if (db.batch) {
        return completeLegacyRun(
          db,
          runId,
          accountId,
          input,
          timestamp(),
          randomId,
        );
      }
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
      if (db.batch) {
        return abandonLegacyRun(db, runId, accountId, timestamp(), randomId);
      }
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
          `WITH resolved AS (
             SELECT r.id, r.challenge_id,
                    coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.status, r.started_at,
                    CASE WHEN r.status = 'abandoned' THEN coalesce(
                      r.elapsed_ms,
                      r.wall_elapsed_ms,
                      max(0, cast(round(
                        (julianday(r.abandoned_at) - julianday(r.started_at)) * 86400000
                      ) AS integer))
                    ) ELSE r.elapsed_ms END elapsed_ms,
                    r.click_count,
                    r.completed_at, r.abandoned_at, r.protocol_version,
                    r.ranked_eligible
             FROM runs r
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.challenge_id = ? AND r.board_excluded = 0
           ), attempted AS (
             SELECT *, row_number() over (
               PARTITION BY challenge_id, account_id
               ORDER BY started_at, id
             ) attempt_number
             FROM resolved
           ), eligible AS (
             SELECT *, CASE WHEN status = 'completed' THEN 0 ELSE 1 END result_group
             FROM attempted
             WHERE (
               status = 'completed' AND elapsed_ms IS NOT NULL
               AND completed_at IS NOT NULL AND (
                 (protocol_version = 2 AND ranked_eligible = 1)
                 OR protocol_version = 1
               )
             ) OR (
               status = 'abandoned' AND click_count > 0
               AND elapsed_ms IS NOT NULL AND abandoned_at IS NOT NULL
             )
           ), ranked AS (
             SELECT *, row_number() over (
               ORDER BY result_group,
                 CASE WHEN result_group = 0 THEN elapsed_ms END ASC,
                 CASE WHEN result_group = 0 THEN click_count END ASC,
                 CASE WHEN result_group = 0 THEN completed_at END ASC,
                 CASE WHEN result_group = 1 THEN elapsed_ms END DESC,
                 CASE WHEN result_group = 1 THEN click_count END DESC,
                 CASE WHEN result_group = 1 THEN abandoned_at END ASC,
                 id
             ) rank
             FROM eligible
           )
           SELECT ranked.id, ranked.challenge_id, ranked.account_id,
                  ranked.status, ranked.started_at, ranked.elapsed_ms,
                  ranked.click_count, ranked.completed_at, ranked.abandoned_at,
                  ranked.protocol_version, ranked.rank, ranked.attempt_number,
                  p.public_name AS display_name
           FROM ranked
           LEFT JOIN account_profiles p ON p.account_id = ranked.account_id
           ORDER BY ranked.rank
           LIMIT 100`,
        )
        .bind(challengeId)
        .all<LeaderboardRunRow>();
      return results.map((row, index) => ({
        rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
        runId: row.id,
        challengeId: row.challenge_id,
        accountId: row.account_id,
        displayName: row.display_name ?? "Unknown",
        status: row.status,
        isRepeatRun: Number(row.attempt_number) > 1,
        startedAt: row.started_at,
        elapsedMs: Number(row.elapsed_ms),
        clickCount: Number(row.click_count),
        completedAt: row.completed_at ?? undefined,
        abandonedAt: row.abandoned_at ?? undefined,
        protocolVersion: Number(row.protocol_version) as 1 | 2,
      }));
    },

    async listChallengePlacements(challengeId) {
      const { results } = await db
        .prepare(
          `WITH resolved AS (
             SELECT r.id,
                    coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.elapsed_ms, r.click_count, r.completed_at
             FROM runs r
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.challenge_id = ?
               AND r.board_excluded = 0
               AND r.status = 'completed'
               AND r.elapsed_ms IS NOT NULL
               AND r.completed_at IS NOT NULL
               AND ((r.protocol_version = 2 AND r.ranked_eligible = 1)
                    OR r.protocol_version = 1)
           ), best AS (
             SELECT *, row_number() OVER (
               PARTITION BY account_id
               ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
             ) attempt_rank
             FROM resolved
           )
           SELECT best.account_id, best.elapsed_ms, best.click_count,
                  best.completed_at,
                  row_number() OVER (
                    ORDER BY best.elapsed_ms ASC, best.click_count ASC,
                             best.completed_at ASC, best.id
                  ) placement,
                  p.public_name AS display_name
           FROM best
           LEFT JOIN account_profiles p ON p.account_id = best.account_id
           WHERE best.attempt_rank = 1
           ORDER BY placement
           LIMIT 100`,
        )
        .bind(challengeId)
        .all<ChallengePlacementQueryRow>();
      return results.map((row) => ({
        accountId: row.account_id,
        displayName: row.display_name ?? null,
        placement: Number(row.placement),
        elapsedMs: Number(row.elapsed_ms),
        clickCount: Number(row.click_count),
        completedAt: row.completed_at,
      }));
    },

    async listChallengeDnfs(challengeId) {
      const { results } = await db
        .prepare(
          `WITH resolved AS (
             SELECT r.id,
                    coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.status, r.elapsed_ms, r.click_count, r.completed_at,
                    r.abandoned_at, r.protocol_version, r.ranked_eligible
             FROM runs r
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.challenge_id = ?
               AND r.board_excluded = 0
           ), completed_eligible_accounts AS (
             SELECT DISTINCT account_id
             FROM resolved
             WHERE status = 'completed'
               AND elapsed_ms IS NOT NULL
               AND completed_at IS NOT NULL
               AND ((protocol_version = 2 AND ranked_eligible = 1)
                    OR protocol_version = 1)
           ), dnf_eligible AS (
             SELECT *
             FROM resolved
             WHERE status = 'abandoned'
               AND click_count > 0
               AND elapsed_ms IS NOT NULL
               AND abandoned_at IS NOT NULL
               AND account_id NOT IN (SELECT account_id FROM completed_eligible_accounts)
           ), best AS (
             SELECT *, row_number() OVER (
               PARTITION BY account_id
               ORDER BY click_count DESC, elapsed_ms DESC, abandoned_at ASC, id
             ) attempt_rank
             FROM dnf_eligible
           )
           SELECT best.account_id, best.elapsed_ms, best.click_count,
                  best.abandoned_at,
                  p.public_name AS display_name
           FROM best
           LEFT JOIN account_profiles p ON p.account_id = best.account_id
           WHERE best.attempt_rank = 1
           ORDER BY best.click_count DESC, best.elapsed_ms DESC,
                    best.abandoned_at ASC, best.id
           LIMIT 100`,
        )
        .bind(challengeId)
        .all<ChallengeDnfQueryRow>();
      return results.map((row) => ({
        accountId: row.account_id,
        displayName: row.display_name ?? null,
        elapsedMs: Number(row.elapsed_ms),
        clickCount: Number(row.click_count),
        abandonedAt: row.abandoned_at,
      }));
    },

    async listDailyTrends(windowDays, todayCentral) {
      const dateFilter = windowDays === null
        ? ""
        : "WHERE daily_date BETWEEN ? AND ?";
      const dateBindings = windowDays === null
        ? []
        : [dailyTrendWindowStart(todayCentral, windowDays), todayCentral];

      // Deliberately no LIMIT anywhere in this query (Task 3.1's flagged
      // "revisit at Increment 4"): a rolling trend must weigh every
      // eligible finisher of each daily, not just the first 100 - a
      // truncated per-daily field would silently distort every account's
      // average once aggregated across many dailies.
      //
      // F2 (spec §Boards "≥1 eligible/leaderboard-visible run"): a
      // board-visible DNF (≥1 click abandon, same eligibility shape as
      // `listChallengeDnfs`) counts toward `played_count` alongside
      // completed dailies, but `avg_placement` stays over `placements`
      // only (finished dailies) - `played_days` is a distinct UNION of
      // finished-challenge and DNF-challenge per account so a day that's
      // both (unusual, but harmless) doesn't double-count.
      const { results } = await db
        .prepare(
          `WITH windowed_dailies AS (
             SELECT daily_date, challenge_id FROM daily_features ${dateFilter}
           ), resolved AS (
             SELECT wd.challenge_id,
                    coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.id, r.status, r.elapsed_ms, r.click_count, r.completed_at,
                    r.abandoned_at, r.protocol_version, r.ranked_eligible
             FROM windowed_dailies wd
             JOIN runs r ON r.challenge_id = wd.challenge_id
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.board_excluded = 0
           ), finished AS (
             SELECT * FROM resolved
             WHERE status = 'completed'
               AND elapsed_ms IS NOT NULL
               AND completed_at IS NOT NULL
               AND ((protocol_version = 2 AND ranked_eligible = 1)
                    OR protocol_version = 1)
           ), best AS (
             SELECT *, row_number() OVER (
               PARTITION BY challenge_id, account_id
               ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
             ) attempt_rank
             FROM finished
           ), placements AS (
             SELECT challenge_id, account_id,
                    row_number() OVER (
                      PARTITION BY challenge_id
                      ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
                    ) placement
             FROM best
             WHERE attempt_rank = 1
           ), dnf_days AS (
             SELECT DISTINCT challenge_id, account_id
             FROM resolved
             WHERE status = 'abandoned'
               AND click_count > 0
               AND elapsed_ms IS NOT NULL
               AND abandoned_at IS NOT NULL
           ), played_days AS (
             SELECT account_id, challenge_id FROM placements
             UNION
             SELECT account_id, challenge_id FROM dnf_days
           ), played AS (
             SELECT account_id, count(*) played_count
             FROM played_days
             GROUP BY account_id
           ), avgs AS (
             SELECT account_id, avg(placement) avg_placement
             FROM placements
             GROUP BY account_id
           )
           SELECT played.account_id, avgs.avg_placement,
                  played.played_count, p.public_name AS display_name
           FROM played
           LEFT JOIN avgs ON avgs.account_id = played.account_id
           LEFT JOIN account_profiles p ON p.account_id = played.account_id`,
        )
        .bind(...dateBindings)
        .all<DailyTrendQueryRow>();

      const guard = dailyTrendGuard(windowDays);
      const ranked: DailyTrendRankedEntry[] = [];
      const unranked: DailyTrendUnrankedEntry[] = [];
      for (const row of results) {
        const playedCount = Number(row.played_count);
        const displayName = row.display_name ?? null;
        // An account can clear the participation guard on DNF days alone
        // (no finishes at all) - `avg_placement` is then `null` (nothing to
        // average), and there's no meaningful placement to rank by, so it
        // reads as unranked-with-progress rather than a ranked row with a
        // fabricated average.
        if (playedCount >= guard && row.avg_placement !== null) {
          ranked.push({
            accountId: row.account_id,
            displayName,
            avgPlacement: Math.round(Number(row.avg_placement) * 10) / 10,
            playedCount,
          });
        } else {
          unranked.push({ accountId: row.account_id, displayName, playedCount });
        }
      }
      ranked.sort((left, right) =>
        left.avgPlacement - right.avgPlacement ||
        right.playedCount - left.playedCount ||
        (left.displayName ?? "").localeCompare(right.displayName ?? ""));
      unranked.sort((left, right) =>
        right.playedCount - left.playedCount ||
        (left.displayName ?? "").localeCompare(right.displayName ?? ""));

      return { ranked, unranked };
    },

    async getAccountDailyStreak(accountId, todayCentral) {
      // F1 (hard fuse): the previous implementation bound one parameter per
      // `daily_features` row fetched (an `IN (...)` list built from up to
      // 500 challenge ids) - D1 caps bound parameters at ~100 per
      // statement, so once the catalog passed ~100 dailies ever played,
      // this query would 500 on every stats read in real D1 (Miniflare
      // doesn't enforce the cap, so that never surfaced locally). This is
      // now a single join with exactly 2 fixed binds (`todayCentral`,
      // `accountId`) no matter how many dailies exist - see the
      // "150 daily_features rows" regression test.
      //
      // F2: "played" here matches the trends participation guard - a
      // board-visible DNF (≥1 click abandon, same eligibility shape as
      // `listChallengeDnfs`/`listDailyTrends`) counts the same as a
      // completed run. A date only ever lands in the result if
      // `daily_features` has a row for it AND this account played that
      // row's challenge - a genuine catalog gap (no `daily_features` row)
      // can never appear here, so it still breaks the streak exactly like
      // a missed day.
      const { results } = await db
        .prepare(
          `SELECT DISTINCT df.daily_date
           FROM daily_features df
           JOIN runs r ON r.challenge_id = df.challenge_id
           LEFT JOIN account_aliases a
             ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
           WHERE df.daily_date <= ?
             AND coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) = ?
             AND r.board_excluded = 0
             AND (
               (r.status = 'completed' AND r.elapsed_ms IS NOT NULL
                 AND r.completed_at IS NOT NULL
                 AND ((r.protocol_version = 2 AND r.ranked_eligible = 1)
                      OR r.protocol_version = 1))
               OR (r.status = 'abandoned' AND r.click_count > 0
                 AND r.elapsed_ms IS NOT NULL AND r.abandoned_at IS NOT NULL)
             )`,
        )
        .bind(todayCentral, accountId)
        .all<{ daily_date: string }>();

      const playedDates = new Set(results.map((row) => row.daily_date));

      // "Today not yet played doesn't break the streak until the day
      // passes" (spec): only start counting today itself if it was already
      // played; otherwise the walk starts at yesterday, silently skipping
      // over an in-progress/unplayed today rather than treating it as a
      // miss. Since F2 makes a DNF "played" too, a DNF recorded today
      // starts the walk at today and extends the streak by one, same as a
      // finish would.
      let cursor = playedDates.has(todayCentral) ? todayCentral : previousCentralDate(todayCentral);
      let streak = 0;
      while (playedDates.has(cursor)) {
        streak += 1;
        cursor = previousCentralDate(cursor);
      }
      return streak;
    },

    async setRunBoardExclusion(runId, excluded) {
      const row = await db
        .prepare(
          `UPDATE runs SET board_excluded = ?
           WHERE id = ?
           RETURNING id`,
        )
        .bind(excluded ? 1 : 0, runId)
        .first<{ id: string }>();
      if (!row) return null;
      return { runId: row.id, boardExcluded: excluded };
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

    async getPublicRunPath(runId) {
      const { results } = await db.prepare(
        `SELECT p.step_number, p.source_title, p.clicked_anchor_text,
                p.destination_title, p.destination_page_id,
                p.elapsed_since_start_ms, p.created_at
         FROM run_path_steps p
         JOIN runs r ON r.id = p.run_id
         WHERE r.id = ? AND r.board_excluded = 0 AND (
           (r.status = 'completed' AND r.elapsed_ms IS NOT NULL
             AND r.completed_at IS NOT NULL AND (
               (r.protocol_version = 2 AND r.ranked_eligible = 1)
               OR r.protocol_version = 1
             ))
           OR (r.status = 'abandoned' AND r.click_count > 0
             AND r.abandoned_at IS NOT NULL)
         )
         ORDER BY p.step_number`,
      ).bind(runId).all<PathStepRow>();
      if (!results.length) {
        throw new ApiError("run_path_not_found", "That completed ranked run was not found.", 404);
      }
      return results.map(mapPathStepRow);
    },

    async getRecoveryRunPath(accountInput, runIdInput) {
      const account = normalizeAuthorizedAccount(accountInput);
      const runId = requireValue(runIdInput, "invalid_run_id");
      const receipt = receiptIdsCte(account);
      const activeOwnedRun = await db.prepare(
        `WITH ${receipt.sql}
         SELECT 1
         FROM runs r
         LEFT JOIN account_aliases owner_alias
           ON owner_alias.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
         WHERE r.id = ?
           AND r.status = 'active'
           AND r.protocol_version = 2
           AND (r.expires_at IS NULL OR r.expires_at >= ?)
           AND (
             coalesce(r.canonical_account_id, r.account_id) IN (SELECT account_id FROM receipt_ids)
             OR owner_alias.canonical_account_id IN (SELECT account_id FROM receipt_ids)
           )`,
      ).bind(...receipt.bindings, runId, timestamp()).first<{ present: number }>();
      if (!activeOwnedRun) {
        throw new ApiError(
          "recovery_path_not_found",
          "That active run was not found.",
          404,
        );
      }
      return loadPath(db, runId);
    },

    async getAccountStats(accountInput) {
      const account = normalizeAuthorizedAccount(accountInput);
      const receipt = receiptIdsCte(account);
      const ownerCte = `WITH ${receipt.sql}, owner_runs AS (
        SELECT r.id, r.start_title, r.target_title, r.status, r.click_count,
               r.protocol_version, r.elapsed_ms
        FROM runs r
        LEFT JOIN account_aliases a ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
        WHERE coalesce(r.canonical_account_id, r.account_id) IN (SELECT account_id FROM receipt_ids)
           OR a.canonical_account_id IN (SELECT account_id FROM receipt_ids)
      )`;
      const totals = await db.prepare(
        `${ownerCte}
         SELECT count(*) attempts,
                sum(status = 'completed') completed,
                sum(status = 'abandoned') abandoned,
                sum(status = 'completed' AND protocol_version = 2 AND elapsed_ms IS NOT NULL) timed_completed,
                coalesce(sum(CASE WHEN status = 'completed' THEN click_count ELSE 0 END), 0) total_clicks,
                min(CASE WHEN status = 'completed' THEN click_count END) best_clicks,
                min(CASE WHEN status = 'completed' AND protocol_version = 2 THEN elapsed_ms END) best_elapsed_ms,
                coalesce(avg(CASE WHEN status = 'completed' THEN click_count END), 0) average_clicks,
                coalesce(avg(CASE WHEN status = 'completed' AND protocol_version = 2 THEN elapsed_ms END), 0) average_elapsed_ms
         FROM owner_runs`,
      ).bind(...receipt.bindings).first<AccountStatsTotalsRow>();
      const countRows = async (sql: string): Promise<Array<{ title: string; count: number }>> => {
        const { results } = await db.prepare(`${ownerCte} ${sql}`).bind(...receipt.bindings).all<CountRow>();
        return results.map((row) => ({ title: row.title, count: Number(row.count) }));
      };
      const [topStarts, topTargets, mostVisited] = await Promise.all([
        countRows(`SELECT start_title title, count(*) count FROM owner_runs
                   GROUP BY start_title ORDER BY count DESC, title ASC LIMIT 5`),
        countRows(`SELECT target_title title, count(*) count FROM owner_runs
                   GROUP BY target_title ORDER BY count DESC, title ASC LIMIT 5`),
        countRows(`, visits AS (
                     SELECT start_title title FROM owner_runs
                     UNION ALL
                     SELECT p.destination_title title
                     FROM run_path_steps p JOIN owner_runs r ON r.id = p.run_id
                   )
                   SELECT title, count(*) count FROM visits
                   GROUP BY title ORDER BY count DESC, title ASC LIMIT 5`),
      ]);
      // Increment 4: streak + 30-day trend, both alias-resolved against the
      // same canonical `account.accountId` the rest of this method already
      // resolved to. `trend30` reuses `listDailyTrends` wholesale (rather
      // than a bespoke single-account query) so Boards' 30d segment and this
      // "my stats" number can never disagree - it's the exact same
      // computation, just read for one account instead of rendered for all.
      const todayCentral = centralDateKey(now());
      const [dailyStreak, trend] = await Promise.all([
        repository.getAccountDailyStreak(account.accountId, todayCentral),
        repository.listDailyTrends(30, todayCentral),
      ]);
      const selfRanked = trend.ranked.find((entry) => entry.accountId === account.accountId);
      const selfUnranked = trend.unranked.find((entry) => entry.accountId === account.accountId);
      const trend30 = selfRanked
        ? { avgPlacement: selfRanked.avgPlacement, playedCount: selfRanked.playedCount, ranked: true }
        : { avgPlacement: null, playedCount: selfUnranked?.playedCount ?? 0, ranked: false };

      return {
        totals: {
          attempts: Number(totals?.attempts ?? 0),
          completed: Number(totals?.completed ?? 0),
          abandoned: Number(totals?.abandoned ?? 0),
          timedCompleted: Number(totals?.timed_completed ?? 0),
          totalClicks: Number(totals?.total_clicks ?? 0),
          bestClicks: totals?.best_clicks == null ? null : Number(totals.best_clicks),
          bestElapsedMs: totals?.best_elapsed_ms == null ? null : Number(totals.best_elapsed_ms),
          averageClicks: Number(totals?.average_clicks ?? 0),
          averageElapsedMs: Number(totals?.average_elapsed_ms ?? 0),
        },
        topStarts,
        topTargets,
        mostVisited,
        dailyStreak,
        trend30,
      } satisfies AccountStats;
    },

    async listChallengesSummary() {
      // One query across every active challenge (council: "no N+1 per
      // challenge"), reusing the exact eligibility shape `listLeaderboard`/
      // `listChallengePlacements` already established, just GROUP BY'd
      // instead of scoped to a single challenge_id.
      const { results } = await db
        .prepare(
          `WITH resolved AS (
             SELECT r.id, r.challenge_id,
                    coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.status, r.elapsed_ms, r.click_count, r.completed_at, r.abandoned_at,
                    r.protocol_version, r.ranked_eligible
             FROM runs r
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.board_excluded = 0
           ), eligible AS (
             SELECT *, CASE WHEN status = 'completed' THEN 0 ELSE 1 END result_group
             FROM resolved
             WHERE (
               status = 'completed' AND elapsed_ms IS NOT NULL AND completed_at IS NOT NULL
               AND ((protocol_version = 2 AND ranked_eligible = 1) OR protocol_version = 1)
             ) OR (
               status = 'abandoned' AND click_count > 0
               AND elapsed_ms IS NOT NULL AND abandoned_at IS NOT NULL
             )
           ), players AS (
             SELECT challenge_id, COUNT(DISTINCT account_id) player_count
             FROM eligible
             GROUP BY challenge_id
           ), completed_best AS (
             SELECT challenge_id, account_id, elapsed_ms, click_count, completed_at, id,
                    row_number() OVER (
                      PARTITION BY challenge_id, account_id
                      ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
                    ) account_rank
             FROM eligible
             WHERE result_group = 0
           ), overall_best AS (
             SELECT challenge_id, elapsed_ms, click_count,
                    row_number() OVER (
                      PARTITION BY challenge_id
                      ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
                    ) overall_rank
             FROM completed_best
             WHERE account_rank = 1
           )
           SELECT c.id challenge_id,
                  coalesce(p.player_count, 0) player_count,
                  ob.elapsed_ms best_elapsed_ms,
                  ob.click_count best_click_count
           FROM challenges c
           LEFT JOIN players p ON p.challenge_id = c.id
           LEFT JOIN overall_best ob ON ob.challenge_id = c.id AND ob.overall_rank = 1
           WHERE c.is_active = 1
           ORDER BY c.sort_order`,
        )
        .all<ChallengeSummaryQueryRow>();
      return results.map((row) => ({
        challengeId: row.challenge_id,
        playerCount: Number(row.player_count),
        best: row.best_elapsed_ms == null
          ? null
          : { elapsedMs: Number(row.best_elapsed_ms), clickCount: Number(row.best_click_count) },
      }));
    },

    async getAccountChallengeOutcomes(accountInput) {
      const account = normalizeAuthorizedAccount(accountInput);
      const receipt = receiptIdsCte(account);
      const { results } = await db
        .prepare(
          `WITH ${receipt.sql}, owner_runs AS (
             SELECT r.challenge_id, r.id, r.status, r.elapsed_ms, r.click_count,
                    r.completed_at, r.abandoned_at, r.protocol_version, r.ranked_eligible
             FROM runs r
             LEFT JOIN account_aliases a ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.board_excluded = 0
               AND (
                 coalesce(r.canonical_account_id, r.account_id) IN (SELECT account_id FROM receipt_ids)
                 OR a.canonical_account_id IN (SELECT account_id FROM receipt_ids)
               )
           ), eligible AS (
             SELECT *, CASE WHEN status = 'completed' THEN 0 ELSE 1 END result_group
             FROM owner_runs
             WHERE (
               status = 'completed' AND elapsed_ms IS NOT NULL AND completed_at IS NOT NULL
               AND ((protocol_version = 2 AND ranked_eligible = 1) OR protocol_version = 1)
             ) OR (
               status = 'abandoned' AND click_count > 0
               AND elapsed_ms IS NOT NULL AND abandoned_at IS NOT NULL
             )
           ), best_completed AS (
             SELECT challenge_id, elapsed_ms, click_count,
                    row_number() OVER (
                      PARTITION BY challenge_id
                      ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
                    ) rn
             FROM eligible
             WHERE result_group = 0
           )
           SELECT e.challenge_id challenge_id,
                  min(e.result_group) best_group,
                  bc.elapsed_ms best_elapsed_ms,
                  bc.click_count best_click_count
           FROM eligible e
           LEFT JOIN best_completed bc ON bc.challenge_id = e.challenge_id AND bc.rn = 1
           GROUP BY e.challenge_id`,
        )
        .bind(...receipt.bindings)
        .all<ChallengeOutcomeQueryRow>();
      return results.map((row) => {
        const completed = Number(row.best_group) === 0;
        return {
          challengeId: row.challenge_id,
          outcome: completed ? "completed" as const : "dnf" as const,
          best: completed
            ? { elapsedMs: Number(row.best_elapsed_ms), clickCount: Number(row.best_click_count) }
            : null,
        };
      });
    },

    async getPlayAnotherSuggestion(accountInput, todayCentral) {
      const account = normalizeAuthorizedAccount(accountInput);
      const receipt = receiptIdsCte(account);
      const row = await db
        .prepare(
          `WITH ${receipt.sql}, touched AS (
             SELECT DISTINCT r.challenge_id
             FROM runs r
             LEFT JOIN account_aliases a ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE coalesce(r.canonical_account_id, r.account_id) IN (SELECT account_id FROM receipt_ids)
                OR a.canonical_account_id IN (SELECT account_id FROM receipt_ids)
           ), resolved AS (
             SELECT r.challenge_id,
                    coalesce(a2.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                    r.status, r.elapsed_ms, r.click_count, r.completed_at, r.abandoned_at,
                    r.protocol_version, r.ranked_eligible
             FROM runs r
             LEFT JOIN account_aliases a2 ON a2.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.board_excluded = 0
           ), eligible AS (
             SELECT * FROM resolved
             WHERE (
               status = 'completed' AND elapsed_ms IS NOT NULL AND completed_at IS NOT NULL
               AND ((protocol_version = 2 AND ranked_eligible = 1) OR protocol_version = 1)
             ) OR (
               status = 'abandoned' AND click_count > 0
               AND elapsed_ms IS NOT NULL AND abandoned_at IS NOT NULL
             )
           ), players AS (
             SELECT challenge_id, COUNT(DISTINCT account_id) player_count
             FROM eligible
             GROUP BY challenge_id
           )
           SELECT c.id, c.label, c.start_title, c.target_title, c.ruleset, c.sort_order,
                  c.is_active, c.start_page_id, c.target_page_id, c.created_by_account_id,
                  c.created_by_display_name, c.created_by_identity_status, c.origin,
                  c.daily_date, c.source,
                  f.daily_date AS feature_daily_date, f.flavor AS feature_flavor,
                  f.selection_source AS feature_selection_source
           FROM challenges c
           LEFT JOIN daily_features f ON f.challenge_id = c.id
           LEFT JOIN players p ON p.challenge_id = c.id
           WHERE c.is_active = 1
             AND c.id NOT IN (SELECT challenge_id FROM touched)
             AND NOT EXISTS (
               SELECT 1 FROM daily_features today
               WHERE today.daily_date = ? AND today.challenge_id = c.id
             )
           ORDER BY coalesce(p.player_count, 0) DESC, c.sort_order ASC
           LIMIT 1`,
        )
        .bind(...receipt.bindings, todayCentral)
        .first<ChallengeRow>();
      return row ? mapChallengeRow(row) : null;
    },

    async beginRandomChallengeAttempt(accountInput, idempotencyKey) {
      const account = normalizeAuthorizedAccount(accountInput);
      const cleanIdempotencyKey = requireValue(idempotencyKey, "invalid_idempotency_key");
      const at = timestamp();
      const staleBefore = new Date(
        Date.parse(at) - RANDOM_CHALLENGE_LOCK_STALE_MS,
      ).toISOString();
      const lockResult = await db
        .prepare(
          `INSERT INTO operation_idempotency
             (operation, idempotency_key, canonical_account_id, request_fingerprint,
              outcome_status, created_at)
           VALUES ('random_challenge_lock', ?, ?, ?, 'pending', ?)
           ON CONFLICT(operation, idempotency_key) DO UPDATE SET
             request_fingerprint = excluded.request_fingerprint,
             outcome_status = 'pending',
             created_at = excluded.created_at
           WHERE operation_idempotency.outcome_status <> 'pending'
              OR operation_idempotency.created_at < ?`,
        )
        .bind(account.accountId, account.accountId, cleanIdempotencyKey, at, staleBefore)
        .run();
      if (mutationChanges(lockResult) !== 1) {
        return "in_progress";
      }

      const receipt = receiptIdsCte(account);
      const hourAgo = new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
      const quotaRow = await db
        .prepare(
          `WITH ${receipt.sql}
           SELECT count(*) recent
           FROM challenges c
           LEFT JOIN account_aliases a ON a.alias_account_id = c.created_by_account_id
           WHERE c.origin = 'manual' AND c.source = 'wikipedia_random'
             AND c.created_at > ?
             AND (
               c.created_by_account_id IN (SELECT account_id FROM receipt_ids)
               OR a.canonical_account_id IN (SELECT account_id FROM receipt_ids)
             )`,
        )
        .bind(...receipt.bindings, hourAgo)
        .first<{ recent: number }>();
      if (Number(quotaRow?.recent ?? 0) >= RANDOM_CHALLENGE_HOURLY_QUOTA) {
        await releaseRandomChallengeLock(db, account.accountId, "rejected", null);
        return "quota_exceeded";
      }
      return "ok";
    },

    async finishRandomChallengeAttempt(accountInput, outcome, resourceId) {
      const account = normalizeAuthorizedAccount(accountInput);
      await releaseRandomChallengeLock(db, account.accountId, outcome, resourceId);
    },
  };

  return repository;
}

const ACTIVE_RUN_SELECT = `SELECT
  r.id, r.challenge_id, r.account_id, r.canonical_account_id, r.status,
  r.started_at, r.completed_at, r.abandoned_at, r.elapsed_ms,
  r.wall_elapsed_ms, r.click_count, r.start_title, r.target_title,
  r.start_page_id, r.target_page_id, r.last_page_id, r.last_title,
  r.expires_at, r.ranked_eligible, r.protocol_version
FROM runs r`;

function requireBatch(
  db: D1DatabaseLike,
): (statements: D1PreparedStatementLike[]) => Promise<D1ResultLike[]> {
  if (!db.batch) {
    throw new ApiError(
      "d1_batch_required",
      "The atomic run protocol requires D1 batch support.",
      500,
    );
  }
  return db.batch.bind(db);
}

function inspectBatchResult(result: D1ResultLike | undefined): number {
  const changes = result?.meta?.changes;
  if (changes === undefined) {
    throw new ApiError(
      "d1_batch_metadata_missing",
      "D1 did not return mutation metadata.",
      500,
    );
  }
  return Number(changes);
}

function insertDailyEditorialOperation(
  db: D1DatabaseLike,
  operation: string,
  idempotencyKey: string,
  actorAccountId: string,
  fingerprint: string,
  createdAt: string,
): D1PreparedStatementLike {
  return db.prepare(
    `INSERT OR IGNORE INTO operation_idempotency
       (operation, idempotency_key, canonical_account_id,
        request_fingerprint, outcome_status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(operation, idempotencyKey, actorAccountId, fingerprint, createdAt);
}

function finalizeDailyQueueOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationIdentity,
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'accepted', response_json = (
       SELECT json_object(
         'id', q.id,
         'challengeId', q.challenge_id,
         'nominationId', q.nomination_id,
         'flavor', q.flavor,
         'source', q.source,
         'status', q.status,
         'queuedByAccountId', q.queued_by_account_id,
         'queuedAt', q.queued_at,
         'consumedDailyDate', q.consumed_daily_date,
         'consumedAt', q.consumed_at,
         'updatedAt', q.updated_at
       )
       FROM daily_queue_entries q WHERE q.id = operation_idempotency.resource_id
     )
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'
       AND EXISTS (
         SELECT 1 FROM daily_queue_entries WHERE id = resource_id
       )`,
  ).bind(
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function finalizeDailyNominationOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationIdentity,
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'accepted', response_json = (
       SELECT json_object(
         'id', n.id,
         'challengeId', n.challenge_id,
         'nominatedByAccountId', n.nominated_by_account_id,
         'nominatedByDisplayName', n.nominated_by_display_name,
         'status', n.status,
         'recognizableScore', n.recognizable_score,
         'weirdScore', n.weird_score,
         'hardScore', n.hard_score,
         'suggestedFlavor', n.suggested_flavor,
         'confidence', n.confidence,
         'classifierVersion', n.classifier_version,
         'reviewedByAccountId', n.reviewed_by_account_id,
         'reviewedAt', n.reviewed_at,
         'createdAt', n.created_at,
         'updatedAt', n.updated_at
       )
       FROM daily_nominations n WHERE n.id = operation_idempotency.resource_id
     )
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'
       AND EXISTS (SELECT 1 FROM daily_nominations WHERE id = resource_id)`,
  ).bind(
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function rejectDailyEditorialOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationRejection,
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'rejected', error_code = CASE
       WHEN NOT EXISTS (${input.stateSql}) THEN ?
       WHEN EXISTS (
         SELECT 1 FROM daily_features
         WHERE challenge_id = (${input.resourceSql})
       ) THEN ?
       ELSE ?
     END
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'`,
  ).bind(
    ...input.stateBindings,
    input.missingCode,
    ...input.resourceBindings,
    input.unavailableCode,
    input.unavailableCode,
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function rejectApproveNominationOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationIdentity & { nominationId: string },
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'rejected', error_code = CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM daily_nominations WHERE id = ?
       ) THEN 'daily_nomination_not_found'
       WHEN EXISTS (
         SELECT 1 FROM daily_features f
         JOIN daily_nominations n ON n.challenge_id = f.challenge_id
         WHERE n.id = ?
       ) THEN 'daily_challenge_already_featured'
       WHEN EXISTS (
         SELECT 1 FROM daily_queue_entries q
         JOIN daily_nominations n ON n.challenge_id = q.challenge_id
         WHERE n.id = ? AND q.status = 'queued'
       ) THEN 'daily_queue_conflict'
       ELSE 'daily_nomination_not_pending'
     END
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'`,
  ).bind(
    input.nominationId,
    input.nominationId,
    input.nominationId,
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function rejectDirectQueueOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationIdentity & { challengeId: string },
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'rejected', error_code = CASE
       WHEN NOT EXISTS (SELECT 1 FROM challenges WHERE id = ?) THEN 'daily_challenge_not_found'
       WHEN EXISTS (SELECT 1 FROM daily_features WHERE challenge_id = ?) THEN 'daily_challenge_already_featured'
       WHEN NOT EXISTS (
         SELECT 1 FROM challenges
         WHERE id = ? AND is_active = 1 AND validation_status = 'ready'
       ) THEN 'daily_challenge_unavailable'
       ELSE 'daily_queue_conflict'
     END
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'`,
  ).bind(
    input.challengeId,
    input.challengeId,
    input.challengeId,
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function rejectRemoveQueueOperation(
  db: D1DatabaseLike,
  input: DailyEditorialOperationIdentity & { queueEntryId: string },
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE operation_idempotency
     SET outcome_status = 'rejected', error_code = CASE
       WHEN NOT EXISTS (SELECT 1 FROM daily_queue_entries WHERE id = ?) THEN 'daily_queue_not_found'
       ELSE 'daily_queue_not_queued'
     END
     WHERE operation = ? AND idempotency_key = ?
       AND canonical_account_id = ? AND request_fingerprint = ?
       AND outcome_status = 'pending'`,
  ).bind(
    input.queueEntryId,
    input.operation,
    input.idempotencyKey,
    input.actorAccountId,
    input.fingerprint,
  );
}

function invalidateQueueEntry(
  db: D1DatabaseLike,
  queueEntryId: string,
  at: string,
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE daily_queue_entries
     SET status = 'invalid', updated_at = ?
     WHERE id = ? AND status = 'queued'
       AND (
         NOT EXISTS (
           SELECT 1 FROM challenges c
           WHERE c.id = daily_queue_entries.challenge_id
             AND c.is_active = 1 AND c.validation_status = 'ready'
         )
         OR EXISTS (
           SELECT 1 FROM daily_features f
           WHERE f.challenge_id = daily_queue_entries.challenge_id
         )
         OR (
           source = 'community' AND NOT EXISTS (
             SELECT 1 FROM daily_nominations n
             WHERE n.id = daily_queue_entries.nomination_id
               AND n.challenge_id = daily_queue_entries.challenge_id
               AND n.status = 'approved'
           )
         )
       )`,
  ).bind(at, queueEntryId);
}

function acceptDailyFeatureJob(
  db: D1DatabaseLike,
  job: DailyChallengeJob,
  at: string,
  provenance: DailyFeatureAcceptanceProvenance,
): D1PreparedStatementLike {
  return db.prepare(
    `UPDATE daily_challenge_jobs
     SET status = 'accepted', lease_token = NULL, lease_expires_at = NULL,
         accepted_challenge_id = (
           SELECT challenge_id FROM daily_features WHERE daily_date = ?
         ),
         failure_code = NULL, updated_at = ?
     WHERE daily_date = ? AND status = 'claimed' AND lease_token = ?
       AND EXISTS (
         SELECT 1 FROM daily_features f
         WHERE f.daily_date = ? AND (${provenance.sql})
       )`,
  ).bind(
    job.dailyDate,
    at,
    job.dailyDate,
    job.leaseToken,
    job.dailyDate,
    ...provenance.bindings,
  );
}

async function selectChallengeForDailyFeature(
  db: D1DatabaseLike,
  dailyDate: string,
  provenance: DailyFeatureAcceptanceProvenance,
): Promise<ChallengeRow | null> {
  return db.prepare(
    `SELECT c.id, c.label, c.start_title, c.target_title, c.ruleset,
            c.sort_order, c.is_active, c.start_page_id, c.target_page_id,
            c.created_by_account_id, c.created_by_display_name,
            c.created_by_identity_status, c.origin, c.daily_date, c.source,
            f.daily_date AS feature_daily_date, f.flavor AS feature_flavor,
            f.selection_source AS feature_selection_source
     FROM daily_features f
     JOIN challenges c ON c.id = f.challenge_id
     WHERE f.daily_date = ? AND (${provenance.sql})`,
  ).bind(dailyDate, ...provenance.bindings).first<ChallengeRow>();
}

async function dailyFeatureAcceptanceFailureCode(
  db: D1DatabaseLike,
  job: DailyChallengeJob,
  selection: DailyFeatureSelection,
  flavor: DailyFlavor,
): Promise<
  | "daily_feature_date_conflict"
  | "daily_feature_lease_lost"
  | "daily_feature_selection_conflict"
  | "daily_queue_selection_changed"
  | "daily_feature_accept_failed"
> {
  const dateFeature = await db.prepare(
    "SELECT challenge_id FROM daily_features WHERE daily_date = ?",
  ).bind(job.dailyDate).first<{ challenge_id: string }>();
  if (dateFeature) return "daily_feature_date_conflict";

  const jobState = await db.prepare(
    "SELECT status, lease_token FROM daily_challenge_jobs WHERE daily_date = ?",
  ).bind(job.dailyDate).first<{ status: string; lease_token: string | null }>();
  if (jobState?.status !== "claimed" || jobState.lease_token !== job.leaseToken) {
    return "daily_feature_lease_lost";
  }

  if (selection.kind === "queued") {
    const queueHead = await db.prepare(
      `SELECT q.id
       FROM daily_queue_entries q
       JOIN challenges c ON c.id = q.challenge_id
       WHERE q.status = 'queued' AND q.flavor = ?
         AND c.is_active = 1 AND c.validation_status = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM daily_features f WHERE f.challenge_id = q.challenge_id
         )
         AND (q.source = 'admin' OR EXISTS (
           SELECT 1 FROM daily_nominations n
           WHERE n.id = q.nomination_id AND n.challenge_id = q.challenge_id
             AND n.status = 'approved'
         ))
       ORDER BY q.queued_at, q.id
       LIMIT 1`,
    ).bind(flavor).first<{ id: string }>();
    return queueHead?.id === selection.queueEntryId
      ? "daily_feature_accept_failed"
      : "daily_queue_selection_changed";
  }

  const existingSelection = await db.prepare(
    `SELECT f.daily_date
     FROM daily_features f
     JOIN challenges c ON c.id = f.challenge_id
     WHERE c.start_page_id = ? AND c.target_page_id = ?
       AND c.ruleset = 'ranked_classic'
     LIMIT 1`,
  ).bind(
    selection.candidate.startPageId,
    selection.candidate.targetPageId,
  ).first<{ daily_date: string }>();
  return existingSelection
    ? "daily_feature_selection_conflict"
    : "daily_feature_accept_failed";
}

function dailyFeatureAcceptanceProvenance(
  selection: DailyFeatureSelection,
): DailyFeatureAcceptanceProvenance {
  if (selection.kind === "queued") {
    return {
      sql: "f.queue_entry_id = ? AND f.selection_source IN ('community', 'admin')",
      bindings: [selection.queueEntryId],
    };
  }
  return {
    sql: `f.selection_source = 'automatic'
      AND EXISTS (
        SELECT 1 FROM challenges selected_challenge
        WHERE selected_challenge.id = f.challenge_id
          AND selected_challenge.start_page_id = ?
          AND selected_challenge.target_page_id = ?
          AND selected_challenge.ruleset = 'ranked_classic'
      )`,
    bindings: [selection.candidate.startPageId, selection.candidate.targetPageId],
  };
}

async function replayDailyEditorialOperation<T>(
  row: OperationRow,
  actorAccountId: string,
  fingerprint: string,
): Promise<T> {
  if (row.canonical_account_id !== actorAccountId) {
    throw new ApiError("operation_forbidden", "That operation belongs to another account.", 403);
  }
  if (row.request_fingerprint !== fingerprint) {
    throw new ApiError(
      "idempotency_conflict",
      "That idempotency key was used for a different request.",
      409,
    );
  }
  if (row.outcome_status === "pending") {
    throw new ApiError("operation_pending", "That operation is still pending.", 503);
  }
  if (row.outcome_status === "rejected") {
    throw new ApiError(
      row.error_code ?? "daily_moderation_rejected",
      "The Daily moderation operation was rejected.",
      row.error_code?.endsWith("_not_found") ? 404 : 409,
    );
  }
  return parseOperationJson<T>(row);
}

async function fingerprintDailyEditorialOperation(
  action: string,
  input: object,
): Promise<string> {
  const value = JSON.stringify({ action, input });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeAuthorizedAccount(input: AuthorizedAccount): AuthorizedAccount {
  const accountId = requireValue(input.accountId, "invalid_account_id");
  const displayName = requireValue(input.displayName, "invalid_public_name").slice(0, 24);
  if (input.status !== "ghost" && input.status !== "claimed") {
    throw new ApiError("invalid_account_status", "VGames account status is invalid.");
  }
  const aliases = [...new Set(
    (input.aliases ?? [])
      .map((alias) => alias.trim())
      .filter((alias) => alias && alias !== accountId),
  )].sort();
  return { accountId, displayName, status: input.status, aliases };
}

function receiptIdsCte(account: AuthorizedAccount): {
  sql: string;
  bindings: string[];
} {
  const bindings = [account.accountId, ...account.aliases];
  return {
    sql: `receipt_ids(account_id) AS (VALUES ${bindings.map(() => "(?)").join(", ")})`,
    bindings,
  };
}

async function ingestAuthorizedAccount(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  at: string,
  preserveActiveRunId?: string,
): Promise<void> {
  const preservedRunId = preserveActiveRunId ?? null;
  const statements: D1PreparedStatementLike[] = [
    db.prepare(
      `INSERT INTO account_profiles
         (account_id, public_name, identity_status, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         public_name = excluded.public_name,
         identity_status = excluded.identity_status,
         updated_at = excluded.updated_at`,
    ).bind(account.accountId, account.displayName, account.status, at),
    db.prepare(
      `UPDATE runs
       SET status = 'abandoned', abandoned_at = ?, updated_at = ?,
           ranked_eligible = 0
       WHERE status = 'active' AND expires_at < ?
         AND coalesce(canonical_account_id, account_id) = ?
         AND (? IS NULL OR id <> ?)`,
    ).bind(at, at, at, account.accountId, preservedRunId, preservedRunId),
  ];

  for (const alias of account.aliases) {
    statements.push(
      db.prepare(
        `UPDATE account_aliases
         SET canonical_account_id = ?, updated_at = ?
         WHERE canonical_account_id = ? AND alias_account_id <> ?`,
      ).bind(account.accountId, at, alias, account.accountId),
      db.prepare(
        `INSERT INTO account_aliases
           (alias_account_id, canonical_account_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(alias_account_id) DO UPDATE SET
           canonical_account_id = excluded.canonical_account_id,
           updated_at = excluded.updated_at`,
      ).bind(alias, account.accountId, at),
      db.prepare(
        `UPDATE runs
         SET status = 'abandoned', abandoned_at = ?, updated_at = ?,
             ranked_eligible = 0
         WHERE status = 'active'
           AND coalesce(canonical_account_id, account_id) = ?
           AND (? IS NULL OR id <> ?)`,
      ).bind(at, at, alias, preservedRunId, preservedRunId),
    );
  }

  await requireBatch(db)(statements);
}

async function resolveReceiptOwnedRunOwner(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  runId: string,
): Promise<string | null> {
  const receipt = receiptIdsCte(account);
  const row = await db.prepare(
    `WITH ${receipt.sql}
     SELECT coalesce(r.canonical_account_id, r.account_id) owner_id
     FROM runs r
     LEFT JOIN account_aliases owner_alias
       ON owner_alias.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
     WHERE r.id = ? AND (
       coalesce(r.canonical_account_id, r.account_id) IN (
         SELECT account_id FROM receipt_ids
       ) OR owner_alias.canonical_account_id IN (
         SELECT account_id FROM receipt_ids
       )
     )`,
  ).bind(...receipt.bindings, runId).first<{ owner_id: string }>();
  return row?.owner_id ?? null;
}

function requireValue(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(code, "A required protocol value is missing.");
  }
  return value.trim();
}

function normalizeClickInput(input: RecordClickV2Input): RecordClickV2Input {
  const clientEventId = requireValue(input.clientEventId, "invalid_client_event_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientEventId)) {
    throw new ApiError("invalid_client_event_id", "Client event id must be a UUID.");
  }
  if (!Number.isInteger(input.expectedStepNumber) || input.expectedStepNumber < 1) {
    throw new ApiError("invalid_step_number", "Expected step number is invalid.");
  }
  if (!Number.isInteger(input.sourcePageId) || input.sourcePageId < 1) {
    throw new ApiError("invalid_source_page_id", "Source page id is invalid.");
  }
  if (!Number.isInteger(input.destinationPageId) || input.destinationPageId < 1) {
    throw new ApiError("invalid_destination_page_id", "Destination page id is invalid.");
  }
  if (!Number.isFinite(input.decisionElapsedMs)) {
    throw new ApiError("invalid_decision_time", "Decision time is invalid.");
  }
  return {
    runId: requireValue(input.runId, "invalid_run_id"),
    clientEventId,
    expectedStepNumber: input.expectedStepNumber,
    sourceTitle: requireValue(input.sourceTitle, "invalid_source_title"),
    sourcePageId: input.sourcePageId,
    sourceRevisionId: input.sourceRevisionId,
    clickedAnchorText: requireValue(input.clickedAnchorText, "invalid_anchor_text"),
    requestedTitle: requireValue(input.requestedTitle, "invalid_requested_title"),
    destinationTitle: requireValue(input.destinationTitle, "invalid_destination_title"),
    destinationPageId: input.destinationPageId,
    decisionElapsedMs: input.decisionElapsedMs,
    clientObservedAt: input.clientObservedAt,
  };
}

function normalizeCreateChallengeInput(input: CreateChallengeV2Input): CreateChallengeV2Input {
  const startTitle = requireValue(input.startTitle, "invalid_start_title");
  const targetTitle = requireValue(input.targetTitle, "invalid_target_title");
  if (!Number.isSafeInteger(input.startPageId) || input.startPageId < 1) {
    throw new ApiError("invalid_start_page_id", "Start page id is invalid.");
  }
  if (!Number.isSafeInteger(input.targetPageId) || input.targetPageId < 1) {
    throw new ApiError("invalid_target_page_id", "Target page id is invalid.");
  }
  if (!Number.isSafeInteger(input.startAllowedLinkCount) || input.startAllowedLinkCount < 1) {
    throw new ApiError("start_has_no_allowed_links", "The start article has no allowed links.", 409);
  }
  if (input.startPageId === input.targetPageId) {
    throw new ApiError("same_challenge_article", "Start and target must be different Wikipedia articles.", 409);
  }
  return {
    startTitle,
    startPageId: input.startPageId,
    startAllowedLinkCount: input.startAllowedLinkCount,
    targetTitle,
    targetPageId: input.targetPageId,
    idempotencyKey: requireValue(input.idempotencyKey, "invalid_idempotency_key"),
    nominateForDaily: input.nominateForDaily === true,
    dailyClassification: normalizeDailyClassification(input.dailyClassification),
    requestFingerprint: input.requestFingerprint === undefined
      ? undefined
      : requireValue(input.requestFingerprint, "invalid_request_fingerprint"),
    source: input.source === "wikipedia_random" ? "wikipedia_random" : "curated",
  };
}

function normalizeDailyClassification(
  input: DailyClassification | undefined,
): DailyClassification {
  return input ?? {
    recognizableScore: null,
    weirdScore: null,
    hardScore: null,
    suggestedFlavor: null,
    confidence: "unclassified",
    classifierVersion: "editorial-v1",
  };
}

function parseClientTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadOperation(
  db: D1DatabaseLike,
  operation: OperationRow["operation"],
  key: string,
): Promise<OperationRow | null> {
  return db.prepare(
    `SELECT operation, idempotency_key, canonical_account_id,
            request_fingerprint, resource_id, outcome_status,
            response_json, error_code, created_at
     FROM operation_idempotency
     WHERE operation = ? AND idempotency_key = ?`,
  ).bind(operation, key).first<OperationRow>();
}

async function requireFinalizedOperation(
  db: D1DatabaseLike,
  operation: OperationRow["operation"],
  key: string,
): Promise<OperationRow> {
  const row = await loadOperation(db, operation, key);
  if (!row || row.outcome_status === "pending") {
    throw new ApiError(
      "operation_not_finalized",
      "The atomic operation did not produce a final outcome.",
      500,
    );
  }
  return row;
}

async function assertOperationReplay(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
  at: string,
): Promise<void> {
  await assertOperationIdentity(db, account, row, fingerprint);
  if (row.outcome_status === "pending") {
    throw new ApiError("operation_pending", "That operation is still pending.", 503);
  }
  if (row.outcome_status === "rejected") {
    throw await operationError(db, row, account, at);
  }
}

async function assertOperationIdentity(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
): Promise<void> {
  if (row.canonical_account_id !== account.accountId) {
    const receiptAuthorizesAlias = account.aliases.includes(row.canonical_account_id);
    const alias = receiptAuthorizesAlias ? { authorized: 1 } : await db.prepare(
      `SELECT 1 AS authorized FROM account_aliases
       WHERE alias_account_id = ? AND canonical_account_id = ?`,
    ).bind(row.canonical_account_id, account.accountId).first();
    if (!alias) {
      throw new ApiError(
        "operation_forbidden",
        "That operation belongs to another account.",
        403,
      );
    }
  }
  if (row.request_fingerprint !== fingerprint) {
    throw new ApiError(
      "idempotency_conflict",
      "That idempotency key was used for a different request.",
      409,
    );
  }
}

function archivedQuotaOperationKey(row: OperationRow): string {
  return [
    "archived-create-rejection",
    row.canonical_account_id,
    row.idempotency_key,
    row.created_at,
  ].join(":");
}

async function isExpiredCreateQuotaRejection(
  db: D1DatabaseLike,
  row: OperationRow,
  account: AuthorizedAccount,
  at: string,
): Promise<boolean> {
  if (
    row.outcome_status !== "rejected" ||
    (row.error_code !== "challenge_create_rate_limited" &&
      row.error_code !== "challenge_create_daily_limit")
  ) {
    return false;
  }
  return Date.parse(await quotaRetryAt(db, row, account, at)) <= Date.parse(at);
}

async function replayStartOperation(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
  at: string,
): Promise<ActiveRunRecord> {
  await assertOperationReplay(db, account, row, fingerprint, at);
  return parseOperationJson<ActiveRunRecord>(row);
}

async function replayCreateChallengeOperation(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
  at: string,
): Promise<CreateChallengeOutcome> {
  await assertOperationReplay(db, account, row, fingerprint, at);
  const stored = parseOperationJson<
    | (Omit<CreateChallengeOutcome, "challenge"> & {
        challenge: Omit<Challenge, "isActive"> & { isActive?: unknown };
      })
    | (Omit<Challenge, "isActive"> & { isActive?: unknown })
  >(row);
  if ("disposition" in stored && "nomination" in stored && "challenge" in stored) {
    return {
      ...stored,
      challenge: {
        ...stored.challenge,
        isActive: Boolean(stored.challenge.isActive),
      },
    };
  }
  return {
    challenge: {
      ...stored,
      isActive: Boolean(stored.isActive),
    },
    disposition: "created",
    nomination: "not_requested",
  };
}

async function replayClickOperation(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
  at: string,
): Promise<RecordClickV2Result> {
  await assertOperationReplay(db, account, row, fingerprint, at);
  const transition = parseOperationJson<RunTransition>(row);
  const leaderboardContext = transition.runStatus === "completed"
    ? await loadLeaderboardContext(db, transition.runId)
    : undefined;
  return leaderboardContext ? { transition, leaderboardContext } : { transition };
}

async function replayAbandonOperation(
  db: D1DatabaseLike,
  account: AuthorizedAccount,
  row: OperationRow,
  fingerprint: string,
  at: string,
): Promise<AbandonRunTransition> {
  await assertOperationReplay(db, account, row, fingerprint, at);
  return parseOperationJson<AbandonRunTransition>(row);
}

function parseOperationJson<T>(row: OperationRow): T {
  if (!row.response_json) {
    throw new ApiError("operation_response_missing", "Operation response is missing.", 500);
  }
  try {
    return JSON.parse(row.response_json) as T;
  } catch {
    throw new ApiError("operation_response_invalid", "Operation response is invalid.", 500);
  }
}

async function operationError(
  db: D1DatabaseLike,
  row: OperationRow,
  account: AuthorizedAccount,
  at: string,
): Promise<ApiError> {
  const code = row.error_code;
  const errorCode = code ?? "operation_rejected";
  const status = errorCode === "challenge_create_rate_limited" || errorCode === "challenge_create_daily_limit" || errorCode === "start_rate_limited"
    ? 429
    : errorCode === "run_not_found" || errorCode === "challenge_not_found"
    ? 404
    : errorCode === "run_forbidden" || errorCode === "operation_forbidden"
      ? 403
      : 409;
  let retryAfterSeconds: number | null = null;
  if (
    errorCode === "challenge_create_daily_limit" ||
    errorCode === "challenge_create_rate_limited" ||
    errorCode === "start_rate_limited"
  ) {
    const retryAt = await quotaRetryAt(db, row, account, at);
    retryAfterSeconds = Math.max(
      1,
      Math.ceil((Date.parse(retryAt) - Date.parse(at)) / 1000),
    );
  }
  return new ApiError(
    errorCode,
    `The run operation was rejected: ${errorCode}.`,
    status,
    retryAfterSeconds,
  );
}

async function quotaRetryAt(
  db: D1DatabaseLike,
  row: OperationRow,
  account: AuthorizedAccount,
  at: string,
): Promise<string> {
  if (row.error_code === "challenge_create_daily_limit") {
    const rejectedAt = new Date(row.created_at);
    return new Date(Date.UTC(
      rejectedAt.getUTCFullYear(),
      rejectedAt.getUTCMonth(),
      rejectedAt.getUTCDate() + 1,
    )).toISOString();
  }

  const operation = row.error_code === "start_rate_limited"
    ? "start"
    : "create_challenge";
  const limit = operation === "start" ? 120 : 20;
  const cutoff = new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
  const receipt = receiptIdsCte(account);
  const boundary = await db.prepare(
    `WITH ${receipt.sql},
     windowed AS (
       SELECT attempted.created_at, attempted.idempotency_key
       FROM operation_idempotency attempted
       LEFT JOIN account_aliases owner_alias
         ON owner_alias.alias_account_id = attempted.canonical_account_id
       WHERE attempted.operation = ? AND attempted.outcome_status <> 'pending'
         AND (
           attempted.canonical_account_id IN (SELECT account_id FROM receipt_ids)
           OR coalesce(owner_alias.canonical_account_id,
                       attempted.canonical_account_id) IN (
             SELECT account_id FROM receipt_ids
           )
         )
         AND attempted.created_at > ?
     ), ranked AS (
       SELECT created_at,
              row_number() over (ORDER BY created_at, idempotency_key) attempt_position,
              count(*) over () attempt_count
       FROM windowed
     )
     SELECT created_at
     FROM ranked
     WHERE attempt_position = attempt_count - ? + 1
     LIMIT 1`,
  ).bind(
    ...receipt.bindings,
    operation,
    cutoff,
    limit,
  ).first<{ created_at: string }>();
  return boundary
    ? new Date(Date.parse(boundary.created_at) + 60 * 60 * 1000).toISOString()
    : at;
}

async function loadLeaderboardContext(
  db: D1DatabaseLike,
  runId: string,
): Promise<LeaderboardContext> {
  const row = await db.prepare(
    `WITH resolved AS (
       SELECT r.id, r.challenge_id,
              coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) owner_id,
              r.elapsed_ms, r.click_count, r.completed_at
       FROM runs r
       LEFT JOIN account_aliases a
         ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
       WHERE r.status = 'completed' AND r.elapsed_ms IS NOT NULL
         AND r.completed_at IS NOT NULL AND (
           (r.protocol_version = 2 AND r.ranked_eligible = 1)
           OR r.protocol_version = 1
         )
         AND r.board_excluded = 0
         AND r.challenge_id = (SELECT challenge_id FROM runs WHERE id = ?)
     ), ranked AS (
       SELECT *,
         row_number() over (
         PARTITION BY challenge_id, owner_id
         ORDER BY elapsed_ms, click_count, completed_at, id
         ) owner_position,
         row_number() over (
         PARTITION BY challenge_id
         ORDER BY elapsed_ms, click_count, completed_at, id
         ) challenge_rank
       FROM resolved
     )
     SELECT challenge_rank AS rank, owner_position
     FROM ranked WHERE id = ?`,
  ).bind(runId, runId).first<{ rank: number; owner_position: number }>();
  return {
    isPersonalBest: Number(row?.owner_position) === 1,
    rank: row ? Number(row.rank) : null,
  };
}

function mapActiveRunRow(row: RunRow): ActiveRunRecord {
  return {
    ...mapRunRow(row),
    canonicalAccountId: row.canonical_account_id ?? row.account_id,
    protocolVersion: Number(row.protocol_version) as 1 | 2,
    startPageId: optionalInteger(row.start_page_id),
    targetPageId: optionalInteger(row.target_page_id),
    lastPageId: optionalInteger(row.last_page_id),
    lastTitle: row.last_title ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    wallElapsedMs: optionalInteger(row.wall_elapsed_ms),
  };
}

function optionalInteger(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

async function startLegacyRun(
  db: D1DatabaseLike,
  input: {
    challengeId: string;
    accountId: string;
    publicName: string;
    identityStatus: AccountStatus;
    aliases?: string[];
  },
  startedAt: string,
  randomId: () => string,
): Promise<RunRecordResponse> {
  const account: AuthorizedAccount = normalizeAuthorizedAccount({
    accountId: input.accountId,
    displayName: input.publicName,
    status: input.identityStatus === "claimed" ? "claimed" : "ghost",
    aliases: input.aliases ?? [],
  });
  const challengeId = requireValue(input.challengeId, "invalid_challenge_id");
  await ingestAuthorizedAccount(db, account, startedAt);
  const runId = randomId();
  const operationKey = `legacy-start:${runId}`;
  const fingerprint = await fingerprintStartRun({ challengeId, idempotencyKey: operationKey });
  const eventId = randomId();
  const expiresAt = new Date(Date.parse(startedAt) + RUN_EXPIRY_MS).toISOString();
  const cutoff = new Date(Date.parse(startedAt) - 60 * 60 * 1000).toISOString();
  const results = await requireBatch(db)([
    db.prepare(
      `INSERT OR IGNORE INTO operation_idempotency
         (operation, idempotency_key, canonical_account_id,
          request_fingerprint, resource_id, outcome_status, created_at)
       VALUES ('start', ?, ?, ?, ?, 'pending', ?)`,
    ).bind(operationKey, account.accountId, fingerprint, runId, startedAt),
    db.prepare(
      `INSERT OR IGNORE INTO runs
         (id, challenge_id, account_id, canonical_account_id, status,
          started_at, click_count, start_title, target_title, start_page_id,
          target_page_id, last_page_id, last_title, expires_at,
          wall_elapsed_ms, ranked_eligible, protocol_version, created_at, updated_at)
       SELECT ?, c.id, ?, ?, 'active', ?, 0, c.start_title, c.target_title,
              c.start_page_id, c.target_page_id, c.start_page_id, c.start_title,
              ?, 0, 0, 1, ?, ?
       FROM challenges c
       JOIN operation_idempotency o
         ON o.operation = 'start' AND o.idempotency_key = ?
        AND o.canonical_account_id = ? AND o.request_fingerprint = ?
        AND o.resource_id = ? AND o.outcome_status = 'pending'
       WHERE c.id = ? AND c.is_active = 1 AND c.validation_status = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM runs
           WHERE coalesce(canonical_account_id, account_id) = ?
             AND status = 'active'
         )
         AND (SELECT count(*) FROM operation_idempotency attempted
              WHERE attempted.operation = 'start'
                AND coalesce(
                  (SELECT canonical_account_id FROM account_aliases
                   WHERE alias_account_id = attempted.canonical_account_id),
                  attempted.canonical_account_id
                ) = ?
                AND attempted.outcome_status <> 'pending'
                AND attempted.created_at > ?) < 120`,
    ).bind(
      runId,
      account.accountId,
      account.accountId,
      startedAt,
      expiresAt,
      startedAt,
      startedAt,
      operationKey,
      account.accountId,
      fingerprint,
      runId,
      challengeId,
      account.accountId,
      account.accountId,
      cutoff,
    ),
    db.prepare(
      `INSERT INTO run_events (id, run_id, event_type, step_number, created_at)
       SELECT ?, id, 'run_started', 0, ? FROM runs
       WHERE id = ? AND protocol_version = 1`,
    ).bind(eventId, startedAt, runId),
    db.prepare(
      `UPDATE operation_idempotency
       SET resource_id = (
         SELECT r.id FROM runs r
         WHERE coalesce(r.canonical_account_id, r.account_id) = ?
           AND r.status = 'active' AND r.protocol_version = 1
           AND r.challenge_id = ?
         ORDER BY r.started_at DESC, r.id DESC LIMIT 1
       )
       WHERE operation = 'start' AND idempotency_key = ?
         AND canonical_account_id = ? AND request_fingerprint = ?
         AND outcome_status = 'pending'
         AND (SELECT count(*) FROM operation_idempotency attempted
              WHERE attempted.operation = 'start'
                AND coalesce(
                  (SELECT canonical_account_id FROM account_aliases
                   WHERE alias_account_id = attempted.canonical_account_id),
                  attempted.canonical_account_id
                ) = ?
                AND attempted.outcome_status <> 'pending'
                AND attempted.created_at > ?) < 120
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE coalesce(r.canonical_account_id, r.account_id) = ?
             AND r.status = 'active' AND r.protocol_version = 1
             AND r.challenge_id = ?
         )`,
    ).bind(
      account.accountId,
      challengeId,
      operationKey,
      account.accountId,
      fingerprint,
      account.accountId,
      cutoff,
      account.accountId,
      challengeId,
    ),
    db.prepare(
      `UPDATE operation_idempotency
       SET outcome_status = 'accepted', response_json = (
         SELECT json_object(
           'id', r.id, 'challengeId', r.challenge_id,
           'accountId', r.account_id, 'status', r.status,
           'startTitle', r.start_title, 'targetTitle', r.target_title,
           'clickCount', r.click_count, 'startedAt', r.started_at,
           'protocolVersion', r.protocol_version
         )
         FROM runs r WHERE r.id = resource_id
       )
       WHERE operation = 'start' AND idempotency_key = ?
         AND canonical_account_id = ? AND request_fingerprint = ?
         AND outcome_status = 'pending'
         AND EXISTS (SELECT 1 FROM runs WHERE id = resource_id)`,
    ).bind(operationKey, account.accountId, fingerprint),
    db.prepare(
      `UPDATE operation_idempotency
       SET outcome_status = 'rejected', error_code = CASE
         WHEN (SELECT count(*) FROM operation_idempotency attempted
               WHERE attempted.operation = 'start'
                 AND coalesce(
                   (SELECT canonical_account_id FROM account_aliases
                    WHERE alias_account_id = attempted.canonical_account_id),
                   attempted.canonical_account_id
                 ) = ?
                 AND attempted.outcome_status <> 'pending'
                 AND attempted.created_at > ?) >= 120 THEN 'start_rate_limited'
         WHEN NOT EXISTS (SELECT 1 FROM challenges WHERE id = ?)
           THEN 'challenge_not_found'
         WHEN NOT EXISTS (
           SELECT 1 FROM challenges
           WHERE id = ? AND is_active = 1 AND validation_status = 'ready'
         ) THEN 'challenge_unavailable'
         WHEN EXISTS (
           SELECT 1 FROM runs
           WHERE coalesce(canonical_account_id, account_id) = ?
             AND status = 'active'
         ) THEN 'active_run_exists'
         ELSE 'start_conflict'
       END
       WHERE operation = 'start' AND idempotency_key = ?
         AND canonical_account_id = ? AND request_fingerprint = ?
         AND outcome_status = 'pending'`,
    ).bind(
      account.accountId,
      cutoff,
      challengeId,
      challengeId,
      account.accountId,
      operationKey,
      account.accountId,
      fingerprint,
    ),
  ]);
  inspectBatchResult(results[0]);
  const operation = await requireFinalizedOperation(db, "start", operationKey);
  await assertOperationReplay(db, account, operation, fingerprint, startedAt);
  return parseOperationJson<RunRecordResponse>(operation);
}

async function recordLegacyClick(
  db: D1DatabaseLike,
  runIdInput: string,
  accountIdInput: string,
  input: LegacyClickInput,
  createdAt: string,
  randomId: () => string,
): Promise<{ clickCount: number }> {
  const runId = requireValue(runIdInput, "invalid_run_id");
  const accountId = requireValue(accountIdInput, "invalid_account_id");
  const run = await loadHardenedOwnedRun(db, runId, accountId);
  assertProtocol(run, 1);
  assertActiveRun(run);
  const stepNumber = Number(run.click_count) + 1;
  const eventId = randomId();
  const wallElapsed = Math.max(0, Date.parse(createdAt) - Date.parse(run.started_at));

  await requireBatch(db)([
    db.prepare(
      `INSERT INTO run_events
         (id, run_id, event_type, step_number, source_title,
          clicked_anchor_text, requested_title, destination_title,
          destination_page_id, client_timestamp_ms, created_at)
       SELECT ?, r.id, 'page_clicked', ?, ?, ?, ?, ?, ?, ?, ?
       FROM runs r
       WHERE r.id = ? AND r.protocol_version = 1 AND r.status = 'active'
         AND r.click_count = ?
         AND coalesce(r.canonical_account_id, r.account_id) = ?`,
    ).bind(
      eventId,
      stepNumber,
      input.sourceTitle,
      input.clickedAnchorText,
      input.requestedTitle,
      input.destinationTitle,
      input.destinationPageId ?? null,
      input.clientTimestampMs ?? null,
      createdAt,
      runId,
      stepNumber - 1,
      accountId,
    ),
    db.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text,
          destination_title, destination_page_id, elapsed_since_start_ms,
          created_at)
       SELECT e.run_id, e.step_number, e.source_title, e.clicked_anchor_text,
              e.destination_title, e.destination_page_id, ?, e.created_at
       FROM run_events e
       WHERE e.id = ? AND e.run_id = ?`,
    ).bind(wallElapsed, eventId, runId),
    db.prepare(
      `UPDATE runs
       SET click_count = ?, last_page_id = ?, last_title = ?,
           wall_elapsed_ms = ?, ranked_eligible = 0, updated_at = ?
       WHERE id = ? AND protocol_version = 1 AND status = 'active'
         AND coalesce(canonical_account_id, account_id) = ?
         AND EXISTS (SELECT 1 FROM run_events WHERE id = ? AND run_id = ?)`,
    ).bind(
      stepNumber,
      input.destinationPageId ?? run.last_page_id ?? null,
      input.destinationTitle,
      wallElapsed,
      createdAt,
      runId,
      accountId,
      eventId,
      runId,
    ),
  ]);

  const updated = await loadHardenedOwnedRun(db, runId, accountId);
  return { clickCount: Number(updated.click_count) };
}

async function completeLegacyRun(
  db: D1DatabaseLike,
  runIdInput: string,
  accountIdInput: string,
  input: LegacyCompleteInput,
  completedAt: string,
  randomId: () => string,
): Promise<RankedLeaderboardRow> {
  const runId = requireValue(runIdInput, "invalid_run_id");
  const accountId = requireValue(accountIdInput, "invalid_account_id");
  const run = await loadHardenedOwnedRun(db, runId, accountId);
  if (Number(run.protocol_version) !== 1) {
    throw new ApiError(
      "completion_requires_target_click",
      "Protocol 2 completes only through an accepted target click.",
      409,
    );
  }
  if (run.status === "completed") {
    return legacyCompletionRow(db, run);
  }
  assertActiveRun(run);
  if (Number(run.click_count) < 1) {
    throw new ApiError(
      "completion_requires_click",
      "A legacy run requires at least one observed click.",
      409,
    );
  }
  if (
    normalizeTitle(input.finalTitle) !== normalizeTitle(run.target_title) ||
    normalizeTitle(run.last_title ?? "") !== normalizeTitle(run.target_title)
  ) {
    throw new ApiError(
      "target_mismatch",
      "The observed legacy destination does not match the challenge target.",
      409,
    );
  }

  const elapsedMs = Math.max(0, Date.parse(completedAt) - Date.parse(run.started_at));
  const eventId = randomId();
  const results = await requireBatch(db)([
    db.prepare(
      `UPDATE runs
       SET status = 'completed', completed_at = ?, elapsed_ms = ?,
           wall_elapsed_ms = ?, final_title = ?, ranked_eligible = 0,
           updated_at = ?
       WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
         AND protocol_version = 1
         AND status = 'active' AND click_count = ?
         AND last_title = ? AND target_title = ?`,
    ).bind(
      completedAt,
      elapsedMs,
      elapsedMs,
      input.finalTitle,
      completedAt,
      runId,
      accountId,
      Number(run.click_count),
      run.last_title,
      run.target_title,
    ),
    db.prepare(
      `INSERT INTO run_events
         (id, run_id, event_type, destination_title,
          client_timestamp_ms, created_at)
       SELECT ?, id, 'run_completed', ?, ?, ? FROM runs
       WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
         AND protocol_version = 1
         AND status = 'completed' AND completed_at = ?
         AND changes() = 1`,
    ).bind(
      eventId,
      input.finalTitle,
      input.clientTimestampMs ?? null,
      completedAt,
      runId,
      accountId,
      completedAt,
    ),
  ]);
  if (inspectBatchResult(results[0]) === 0) {
    const current = await loadHardenedOwnedRun(db, runId, accountId);
    if (Number(current.protocol_version) !== 1 || current.status !== "active") {
      if (current.status === "completed") {
        return legacyCompletionRow(db, current);
      }
      throw new ApiError("run_not_active", "This run is not active.", 409);
    }
    throw new ApiError(
      "target_mismatch",
      "The observed legacy destination changed before completion.",
      409,
    );
  }
  return legacyCompletionRow(
    db,
    await loadHardenedOwnedRun(db, runId, accountId),
  );
}

async function abandonLegacyRun(
  db: D1DatabaseLike,
  runIdInput: string,
  accountIdInput: string,
  abandonedAt: string,
  randomId: () => string,
): Promise<{ status: "abandoned" | "completed" }> {
  const runId = requireValue(runIdInput, "invalid_run_id");
  const accountId = requireValue(accountIdInput, "invalid_account_id");
  const run = await loadHardenedOwnedRun(db, runId, accountId);
  assertProtocol(run, 1);
  if (run.status !== "active") {
    return { status: run.status === "completed" ? "completed" : "abandoned" };
  }
  const eventId = randomId();
  const results = await requireBatch(db)([
    db.prepare(
      `UPDATE runs
       SET status = 'abandoned', abandoned_at = ?, ranked_eligible = 0,
           updated_at = ?
       WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
         AND protocol_version = 1 AND status = 'active'`,
    ).bind(abandonedAt, abandonedAt, runId, accountId),
    db.prepare(
      `INSERT INTO run_events (id, run_id, event_type, created_at)
       SELECT ?, id, 'run_abandoned', ? FROM runs
       WHERE id = ? AND coalesce(canonical_account_id, account_id) = ?
         AND protocol_version = 1
         AND status = 'abandoned' AND abandoned_at = ?
         AND changes() = 1`,
    ).bind(eventId, abandonedAt, runId, accountId, abandonedAt),
  ]);
  if (inspectBatchResult(results[0]) === 0) {
    const current = await loadHardenedOwnedRun(db, runId, accountId);
    assertProtocol(current, 1);
    if (current.status === "active") {
      throw new ApiError(
        "abandon_conflict",
        "The legacy run changed without reaching a terminal state.",
        409,
      );
    }
    return { status: current.status };
  }
  return { status: "abandoned" };
}

async function loadHardenedOwnedRun(
  db: D1DatabaseLike,
  runId: string,
  accountId: string,
): Promise<RunRow> {
  const row = await db.prepare(
    `${ACTIVE_RUN_SELECT} WHERE r.id = ?`,
  ).bind(runId).first<RunRow>();
  if (!row) {
    throw new ApiError("run_not_found", "That run does not exist.", 404);
  }
  if (row.canonical_account_id !== accountId && row.account_id !== accountId) {
    throw new ApiError("run_forbidden", "That run belongs to another account.", 403);
  }
  return row;
}

function assertProtocol(run: RunRow, version: 1 | 2): void {
  if (Number(run.protocol_version) !== version) {
    throw new ApiError("protocol_mismatch", "That run uses another protocol.", 409);
  }
}

async function legacyCompletionRow(
  db: D1DatabaseLike,
  run: RunRow,
): Promise<RankedLeaderboardRow> {
  const profile = await db.prepare(
    "SELECT public_name FROM account_profiles WHERE account_id = ?",
  ).bind(run.canonical_account_id ?? run.account_id).first<{ public_name: string }>();
  return {
    rank: 0,
    runId: run.id,
    challengeId: run.challenge_id,
    accountId: run.canonical_account_id ?? run.account_id,
    displayName: profile?.public_name ?? "Unknown",
    status: "completed",
    isRepeatRun: false,
    startedAt: run.started_at,
    elapsedMs: Number(run.elapsed_ms ?? 0),
    clickCount: Number(run.click_count),
    completedAt: run.completed_at ?? "",
    protocolVersion: 1,
  };
}

async function loadPath(
  db: D1DatabaseLike,
  runId: string,
): Promise<ServerPathStep[]> {
  const { results } = await db.prepare(
    `SELECT step_number, source_title, clicked_anchor_text,
            destination_title, destination_page_id,
            elapsed_since_start_ms, created_at
     FROM run_path_steps WHERE run_id = ? ORDER BY step_number`,
  ).bind(runId).all<PathStepRow>();
  return results.map(mapPathStepRow);
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

  const dailyFeature =
    row.feature_daily_date && row.feature_flavor && row.feature_selection_source
      ? {
          dailyDate: row.feature_daily_date,
          flavor: row.feature_flavor,
          selectionSource: row.feature_selection_source,
        }
      : null;
  const origin = dailyFeature || row.origin === "daily" ? "daily" : "manual";
  const dailyDate = dailyFeature?.dailyDate ?? row.daily_date ?? null;
  const source = dailyFeature
    ? dailyFeature.selectionSource === "automatic" ? "wikipedia_random" : "curated"
    : row.source === "wikipedia_random" ? "wikipedia_random" : "curated";

  return {
    id: row.id,
    label: row.label,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    mode: origin === "daily" ? "daily" : "solo",
    start: { title: row.start_title, pageId: optionalInteger(row.start_page_id) },
    target: { title: row.target_title, pageId: optionalInteger(row.target_page_id) },
    ruleset: "ranked_classic",
    origin,
    dailyDate,
    dailyFeature,
    source,
    createdBy,
  };
}

function mapDailyNominationRow(row: DailyNominationRow): DailyNomination {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    nominatedByAccountId: row.nominated_by_account_id,
    nominatedByDisplayName: row.nominated_by_display_name,
    status: row.status,
    recognizableScore: nullableInteger(row.recognizable_score),
    weirdScore: nullableInteger(row.weird_score),
    hardScore: nullableInteger(row.hard_score),
    suggestedFlavor: row.suggested_flavor,
    confidence: row.confidence,
    classifierVersion: row.classifier_version,
    reviewedByAccountId: row.reviewed_by_account_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDailyQueueEntryRow(row: DailyQueueEntryRow): DailyQueueEntry {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    nominationId: row.nomination_id,
    flavor: row.flavor,
    source: row.source,
    status: row.status,
    queuedByAccountId: row.queued_by_account_id,
    queuedAt: row.queued_at,
    consumedDailyDate: row.consumed_daily_date,
    consumedAt: row.consumed_at,
    updatedAt: row.updated_at,
  };
}

function mapDailyQueuedCandidateRow(row: DailyQueuedCandidateRow): DailyQueuedCandidate {
  return {
    ...mapDailyQueueEntryRow(row),
    challenge: mapChallengeRow({
      id: row.challenge_id,
      label: row.challenge_label,
      start_title: row.challenge_start_title,
      target_title: row.challenge_target_title,
      ruleset: row.challenge_ruleset,
      sort_order: row.challenge_sort_order,
      is_active: row.challenge_is_active,
      start_page_id: row.challenge_start_page_id,
      target_page_id: row.challenge_target_page_id,
      created_by_account_id: row.challenge_created_by_account_id,
      created_by_display_name: row.challenge_created_by_display_name,
      created_by_identity_status: row.challenge_created_by_identity_status,
      origin: row.challenge_origin,
      daily_date: row.challenge_daily_date,
      source: row.challenge_source,
    }),
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
  const result: RunRecordResponse = {
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
  if (row.protocol_version === 1 || row.protocol_version === 2) {
    result.protocolVersion = row.protocol_version;
  }
  return result;
}

interface ChallengeRow {
  id: string;
  label: string;
  start_title: string;
  target_title: string;
  ruleset: string;
  sort_order: number;
  is_active: number | boolean;
  start_page_id?: number | null;
  target_page_id?: number | null;
  created_by_account_id?: string | null;
  created_by_display_name?: string | null;
  created_by_identity_status?: AccountStatus | null;
  origin?: "manual" | "daily" | null;
  daily_date?: string | null;
  source?: "curated" | "wikipedia_random" | null;
  feature_daily_date?: string | null;
  feature_flavor?: DailyFlavor | null;
  feature_selection_source?: "automatic" | "community" | "admin" | null;
}

interface DailyNominationRow {
  id: string;
  challenge_id: string;
  nominated_by_account_id: string;
  nominated_by_display_name: string;
  status: "pending" | "approved" | "declined";
  recognizable_score: number | null;
  weird_score: number | null;
  hard_score: number | null;
  suggested_flavor: DailyFlavor | null;
  confidence: "high" | "medium" | "low" | "unclassified";
  classifier_version: string;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DailyQueueEntryRow {
  id: string;
  challenge_id: string;
  nomination_id: string | null;
  flavor: DailyFlavor;
  source: "community" | "admin";
  status: "queued" | "consumed" | "removed" | "invalid";
  queued_by_account_id: string;
  queued_at: string;
  consumed_daily_date: string | null;
  consumed_at: string | null;
  updated_at: string;
}

interface DailyQueuedCandidateRow extends DailyQueueEntryRow {
  challenge_label: string;
  challenge_start_title: string;
  challenge_target_title: string;
  challenge_ruleset: string;
  challenge_sort_order: number;
  challenge_is_active: number | boolean;
  challenge_start_page_id: number | null;
  challenge_target_page_id: number | null;
  challenge_created_by_account_id: string | null;
  challenge_created_by_display_name: string | null;
  challenge_created_by_identity_status: AccountStatus | null;
  challenge_origin: "manual" | "daily" | null;
  challenge_daily_date: string | null;
  challenge_source: "curated" | "wikipedia_random" | null;
}

interface DailyEditorialOperationIdentity {
  operation: string;
  idempotencyKey: string;
  actorAccountId: string;
  fingerprint: string;
}

interface DailyEditorialOperationRejection extends DailyEditorialOperationIdentity {
  missingCode: string;
  unavailableCode: string;
  resourceSql: string;
  resourceBindings: unknown[];
  stateSql: string;
  stateBindings: unknown[];
}

interface DailyFeatureAcceptanceProvenance {
  sql: string;
  bindings: unknown[];
}

interface DailyChallengeJobRow {
  daily_date: string;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
}

function requireDailyDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new ApiError("invalid_daily_date", "Daily challenge dates must be UTC calendar dates.", 400);
  }
  return value;
}

function normalizeDailyJob(job: DailyChallengeJob): DailyChallengeJob {
  const dailyDate = requireDailyDate(job.dailyDate);
  const leaseToken = requireValue(job.leaseToken, "invalid_daily_lease");
  const leaseExpiresAt = requireValue(job.leaseExpiresAt, "invalid_daily_lease");
  if (!Number.isSafeInteger(job.attemptCount) || job.attemptCount < 1) {
    throw new ApiError("invalid_daily_attempt", "Daily challenge job attempt is invalid.", 400);
  }
  return { dailyDate, attemptCount: job.attemptCount, leaseToken, leaseExpiresAt };
}

function normalizeDailyChallengeInput(input: DailyChallengeInput): DailyChallengeInput {
  const startTitle = requireValue(input.startTitle, "invalid_start_title");
  const targetTitle = requireValue(input.targetTitle, "invalid_target_title");
  if (!Number.isSafeInteger(input.startPageId) || input.startPageId < 1 ||
      !Number.isSafeInteger(input.targetPageId) || input.targetPageId < 1 ||
      input.startPageId === input.targetPageId) {
    throw new ApiError("invalid_daily_candidate", "Daily challenge candidates must be distinct main articles.", 400);
  }
  return { startTitle, startPageId: input.startPageId, targetTitle, targetPageId: input.targetPageId };
}

function normalizeApproveDailyNominationInput(
  input: ApproveDailyNominationInput,
): ApproveDailyNominationInput {
  return {
    nominationId: requireValue(input.nominationId, "invalid_daily_nomination_id"),
    flavor: requireDailyFlavor(input.flavor),
    ...normalizeDailyModerationInput(input),
  };
}

function normalizeDeclineDailyNominationInput(
  input: DeclineDailyNominationInput,
): DeclineDailyNominationInput {
  return {
    nominationId: requireValue(input.nominationId, "invalid_daily_nomination_id"),
    ...normalizeDailyModerationInput(input),
  };
}

function normalizeQueueDailyChallengeInput(
  input: QueueDailyChallengeInput,
): QueueDailyChallengeInput {
  return {
    challengeId: requireValue(input.challengeId, "invalid_challenge_id"),
    flavor: requireDailyFlavor(input.flavor),
    ...normalizeDailyModerationInput(input),
  };
}

function normalizeRemoveDailyQueueEntryInput(
  input: RemoveDailyQueueEntryInput,
): RemoveDailyQueueEntryInput {
  return {
    queueEntryId: requireValue(input.queueEntryId, "invalid_daily_queue_entry_id"),
    ...normalizeDailyModerationInput(input),
  };
}

function normalizeDailyModerationInput(input: {
  actorAccountId: string;
  idempotencyKey: string;
}): { actorAccountId: string; idempotencyKey: string } {
  return {
    actorAccountId: requireValue(input.actorAccountId, "invalid_account_id"),
    idempotencyKey: requireValue(input.idempotencyKey, "invalid_idempotency_key"),
  };
}

function normalizeDailyFeatureSelection(
  selection: DailyFeatureSelection,
): DailyFeatureSelection {
  const classifierVersion = requireValue(
    selection.classifierVersion,
    "invalid_daily_classifier_version",
  );
  if (selection.kind === "queued") {
    return {
      kind: "queued",
      queueEntryId: requireValue(selection.queueEntryId, "invalid_daily_queue_entry_id"),
      classifierVersion,
    };
  }
  if (selection.kind !== "automatic") {
    throw new ApiError("invalid_daily_selection", "Daily feature selection is invalid.", 400);
  }
  const selectedScore = selection.selectedScore ?? null;
  if (selectedScore !== null && !Number.isSafeInteger(selectedScore)) {
    throw new ApiError("invalid_daily_score", "Daily feature score is invalid.", 400);
  }
  return {
    kind: "automatic",
    candidate: normalizeDailyChallengeInput(selection.candidate),
    classifierVersion,
    selectedScore,
  };
}

function requireDailyFlavor(value: unknown): DailyFlavor {
  if (value === "recognizable" || value === "weird" || value === "hard") return value;
  throw new ApiError("invalid_daily_flavor", "Daily flavor is invalid.", 400);
}

function nullableInteger(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapDailyChallengeJob(row: DailyChallengeJobRow): DailyChallengeJob {
  if (!row.lease_token || !row.lease_expires_at) {
    throw new ApiError("daily_lease_missing", "Daily challenge lease was incomplete.", 500);
  }
  return {
    dailyDate: row.daily_date,
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function mutationChanges(result: unknown): number {
  return Number((result as D1ResultLike | undefined)?.meta?.changes ?? 0);
}

/**
 * On-demand random-challenge endpoint (Increment 5): a per-account
 * concurrency lock, "borrowing" the `operation_idempotency` table (no
 * migration needed - see the plan's "no migration this increment"
 * constraint) with `operation = 'random_challenge_lock'` and
 * `idempotency_key = <canonical accountId>`, so its primary key
 * `(operation, idempotency_key)` gives at most one row per account for
 * this operation - a true per-account mutex, not a per-request replay
 * record like every other `operation_idempotency` consumer. The real
 * client-supplied idempotency key rides along in `request_fingerprint`
 * purely for observability. `RANDOM_CHALLENGE_LOCK_STALE_MS` bounds how
 * long a lock can be held if a Worker invocation dies mid-flight without
 * reaching `finishRandomChallengeAttempt` (comfortably above the ~25s
 * worst-case candidate-selection wall time).
 */
const RANDOM_CHALLENGE_LOCK_STALE_MS = 60_000;

/** D1-side hourly creation quota (spec: "max 3 creations/hour/account"). */
const RANDOM_CHALLENGE_HOURLY_QUOTA = 3;

async function releaseRandomChallengeLock(
  db: D1DatabaseLike,
  canonicalAccountId: string,
  outcome: "accepted" | "rejected",
  resourceId: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE operation_idempotency
       SET outcome_status = ?, resource_id = ?
       WHERE operation = 'random_challenge_lock' AND idempotency_key = ?`,
    )
    .bind(outcome, resourceId, canonicalAccountId)
    .run();
}

function dailyRetryHours(attemptCount: number): number {
  return [1, 2, 4, 6][Math.min(Math.max(attemptCount - 1, 0), 3)] ?? 6;
}

function redactDailyFailureCode(value: string): string {
  return /^(daily_candidate_unavailable|daily_candidate_timeout|daily_persistence_failed)$/.test(value)
    ? value
    : "daily_persistence_failed";
}

interface RunRow {
  id: string;
  challenge_id: string;
  account_id: string;
  canonical_account_id?: string | null;
  status: "active" | "completed" | "abandoned";
  started_at: string;
  completed_at?: string | null;
  abandoned_at?: string | null;
  elapsed_ms?: number | null;
  wall_elapsed_ms?: number | null;
  click_count: number;
  start_title: string;
  target_title: string;
  start_page_id?: number | null;
  target_page_id?: number | null;
  last_page_id?: number | null;
  last_title?: string | null;
  expires_at?: string | null;
  ranked_eligible?: number | null;
  protocol_version?: number | null;
}

interface OperationRow {
  operation:
    | "start"
    | "click"
    | "abandon"
    | "create_challenge"
    | "approve_daily_nomination"
    | "decline_daily_nomination"
    | "queue_daily_challenge"
    | "remove_daily_queue_entry";
  idempotency_key: string;
  canonical_account_id: string;
  request_fingerprint: string;
  resource_id: string | null;
  outcome_status: "pending" | "accepted" | "rejected";
  response_json: string | null;
  error_code: string | null;
  created_at: string;
}

interface LeaderboardRunRow {
  id: string;
  challenge_id: string;
  account_id: string;
  status: "completed" | "abandoned";
  started_at: string;
  elapsed_ms: number;
  click_count: number;
  completed_at?: string | null;
  abandoned_at?: string | null;
  protocol_version: number;
  rank: number;
  attempt_number: number;
  display_name?: string | null;
}

interface ChallengePlacementQueryRow {
  account_id: string;
  elapsed_ms: number;
  click_count: number;
  completed_at: string;
  placement: number;
  display_name?: string | null;
}

interface ChallengeDnfQueryRow {
  account_id: string;
  elapsed_ms: number;
  click_count: number;
  abandoned_at: string;
  display_name?: string | null;
}

interface ChallengeSummaryQueryRow {
  challenge_id: string;
  player_count: number;
  best_elapsed_ms: number | null;
  best_click_count: number | null;
}

interface ChallengeOutcomeQueryRow {
  challenge_id: string;
  best_group: number;
  best_elapsed_ms: number | null;
  best_click_count: number | null;
}

interface DailyTrendQueryRow {
  account_id: string;
  // F2: `null` for an account whose played days are all DNFs (no
  // finishes at all) - `avgs` is a LEFT JOIN against `played`.
  avg_placement: number | null;
  played_count: number;
  display_name?: string | null;
}

interface AccountStatsTotalsRow {
  attempts: number | null;
  completed: number | null;
  abandoned: number | null;
  timed_completed: number | null;
  total_clicks: number | null;
  best_clicks: number | null;
  best_elapsed_ms: number | null;
  average_clicks: number | null;
  average_elapsed_ms: number | null;
}

interface CountRow {
  title: string;
  count: number;
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
