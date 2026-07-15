import { normalizeTitle } from "../domain/rules";
import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AuthorizedAccount,
  Challenge,
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
  RUN_EXPIRY_MS,
  type AbandonRunV2Input,
  type RecordClickV2Input,
  type StartRunV2Input,
} from "./runProtocol";
import type {
  ActiveRunRecord,
  AccountProfileRecord,
  CreateChallengeV2Input,
  LegacyClickInput,
  LegacyCompleteInput,
  RecordClickV2Result,
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
             start_page_id,
             target_page_id,
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
           SET resource_id = printf('challenge-%04d', (
             SELECT coalesce(max(sort_order), 0) + 1 FROM challenges
           ))
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending' AND resource_id IS NULL`,
        ).bind(create.idempotencyKey, account.accountId, fingerprint),
        // Invariant: `account_aliases` (the merge-graph joined below) holds
        // opaque internal account UUIDs — server-to-server only, NEVER
        // serialize aliases into any client-facing response.
        db.prepare(
          `INSERT INTO challenges
             (id, label, start_title, target_title, start_page_id, target_page_id,
              validation_status, ruleset, sort_order, is_active, created_at,
              created_by_account_id, created_by_display_name, created_by_identity_status)
           SELECT o.resource_id,
                  'Challenge #' || (SELECT coalesce(max(sort_order), 0) + 1 FROM challenges),
                  ?, ?, ?, ?, 'ready', 'ranked_classic',
                  (SELECT coalesce(max(sort_order), 0) + 1 FROM challenges),
                  1, ?, ?, ?, ?
           FROM operation_idempotency o
           WHERE o.operation = 'create_challenge' AND o.idempotency_key = ?
             AND o.canonical_account_id = ? AND o.request_fingerprint = ?
             AND o.outcome_status = 'pending'
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
          createdAt, account.accountId, account.displayName, account.status,
          create.idempotencyKey, account.accountId, fingerprint,
          account.accountId, new Date(Date.parse(createdAt) - 60 * 60 * 1000).toISOString(),
          account.accountId, createdAt,
        ),
        db.prepare(
          `UPDATE operation_idempotency
           SET outcome_status = 'accepted',
               response_json = (
                 SELECT json_object(
                   'id', c.id, 'label', c.label, 'sortOrder', c.sort_order,
                   'isActive', c.is_active, 'mode', 'daily',
                   'start', json_object('title', c.start_title, 'pageId', c.start_page_id),
                   'target', json_object('title', c.target_title, 'pageId', c.target_page_id),
                   'ruleset', c.ruleset, 'source', 'curated',
                   'createdBy', json_object('accountId', c.created_by_account_id,
                     'displayName', c.created_by_display_name,
                     'identityStatus', c.created_by_identity_status)
                 ) FROM challenges c WHERE c.id = resource_id
               )
           WHERE operation = 'create_challenge' AND idempotency_key = ?
             AND canonical_account_id = ? AND request_fingerprint = ?
             AND outcome_status = 'pending'
             AND EXISTS (SELECT 1 FROM challenges WHERE id = resource_id)`,
        ).bind(create.idempotencyKey, account.accountId, fingerprint),
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
               ranked_eligible = 0
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
         ORDER BY r.started_at DESC LIMIT 1`,
      ).bind(...receipt.bindings, at).first<RunRow>();
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
                    r.elapsed_ms, r.click_count, r.completed_at
             FROM runs r
             LEFT JOIN account_aliases a
               ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
             WHERE r.challenge_id = ? AND r.status = 'completed'
               AND r.ranked_eligible = 1 AND r.protocol_version = 2
           ), best_per_account AS (
             SELECT *, row_number() over (
               PARTITION BY account_id
               ORDER BY elapsed_ms, click_count, completed_at, id
             ) account_position
             FROM resolved
           ), ranked AS (
             SELECT *, row_number() over (
               ORDER BY elapsed_ms, click_count, completed_at, id
             ) rank
             FROM best_per_account WHERE account_position = 1
           )
           SELECT ranked.id, ranked.challenge_id, ranked.account_id,
                  ranked.elapsed_ms, ranked.click_count, ranked.completed_at,
                  ranked.rank, p.public_name AS display_name
           FROM ranked
           LEFT JOIN account_profiles p ON p.account_id = ranked.account_id
           ORDER BY ranked.elapsed_ms, ranked.click_count, ranked.completed_at, ranked.id
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
        elapsedMs: Number(row.elapsed_ms),
        clickCount: Number(row.click_count),
        completedAt: row.completed_at,
      }));
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
         WHERE r.id = ? AND r.status = 'completed'
           AND r.ranked_eligible = 1 AND r.protocol_version = 2
         ORDER BY p.step_number`,
      ).bind(runId).all<PathStepRow>();
      if (!results.length) {
        throw new ApiError("run_path_not_found", "That completed ranked run was not found.", 404);
      }
      return results.map(mapPathStepRow);
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
      } satisfies AccountStats;
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
    requestFingerprint: input.requestFingerprint === undefined
      ? undefined
      : requireValue(input.requestFingerprint, "invalid_request_fingerprint"),
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
): Promise<Challenge> {
  await assertOperationReplay(db, account, row, fingerprint, at);
  return parseOperationJson<Challenge>(row);
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
       WHERE r.status = 'completed' AND r.ranked_eligible = 1
         AND r.protocol_version = 2
         AND r.challenge_id = (SELECT challenge_id FROM runs WHERE id = ?)
     ), best AS (
       SELECT *, row_number() over (
         PARTITION BY challenge_id, owner_id
         ORDER BY elapsed_ms, click_count, completed_at, id
       ) owner_position
       FROM resolved
     ), ranked AS (
       SELECT *, row_number() over (
         PARTITION BY challenge_id
         ORDER BY elapsed_ms, click_count, completed_at, id
       ) challenge_rank
       FROM best WHERE owner_position = 1
     )
     SELECT challenge_rank AS rank FROM ranked WHERE id = ?`,
  ).bind(runId, runId).first<{ rank: number }>();
  return {
    isPersonalBest: Boolean(row),
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
    elapsedMs: Number(run.elapsed_ms ?? 0),
    clickCount: Number(run.click_count),
    completedAt: run.completed_at ?? "",
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

  return {
    id: row.id,
    label: row.label,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    mode: "daily",
    start: { title: row.start_title, pageId: optionalInteger(row.start_page_id) },
    target: { title: row.target_title, pageId: optionalInteger(row.target_page_id) },
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
  operation: "start" | "click" | "abandon" | "create_challenge";
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
  elapsed_ms: number;
  click_count: number;
  completed_at: string;
  rank: number;
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
