import { getSortedChallenges } from "../domain/challenges";
import { optionalNumber, requiredString } from "./http";
import { ApiError } from "./http";
import type {
  AbandonRunResponse,
  ChallengesResponse,
  ClickRequest,
  ClickResponse,
  CreateChallengeRequest,
  CreateChallengeV2Request,
  CreateChallengeResponse,
  CompleteRunRequest,
  CompleteRunResponse,
  LeaderboardResponse,
  RunPathResponse,
  StartRunRequest,
  StartRunResponse,
} from "./contracts";
import type {
  CreateChallengeRepositoryResult,
  RunProtocolRepository,
  TrackingRepository,
} from "./trackingRepository";
import type { ValidateChallengeArticles } from "./wikipediaChallengeValidator";
import type { AccountStatus, AuthorizedAccount } from "../domain/types";
import type { CreateChallengeOutcome, DailyClassification } from "../domain/dailyEditorial";
import { fingerprintCreateChallengeRequest } from "./runProtocol";

export interface ApiHandlers {
  listChallenges(): Promise<ChallengesResponse>;
  createChallenge(
    input: CreateChallengeHandlerRequest,
  ): Promise<CreateChallengeResponse>;
  createChallengeV2(
    account: AuthorizedAccount,
    input: CreateChallengeV2Request,
    idempotencyKey: string,
  ): Promise<CreateChallengeOutcome>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordClick(
    runId: string,
    accountId: string,
    input: ClickRequest,
  ): Promise<ClickResponse>;
  completeRun(
    runId: string,
    accountId: string,
    input: CompleteRunRequest,
  ): Promise<CompleteRunResponse>;
  abandonRun(
    runId: string,
    accountId: string,
  ): Promise<AbandonRunResponse>;
  listLeaderboard(challengeId: string): Promise<LeaderboardResponse>;
  getRunPath(runId: string): Promise<RunPathResponse>;
}

export interface ApiHandlerOptions {
  validateChallengeArticles?: ValidateChallengeArticles;
  classifyDaily?: ClassifyDailyChallenge;
}

export interface DailyClassificationInput {
  startTitle: string;
  startPageId: number;
  startAllowedLinkCount: number;
  targetTitle: string;
  targetPageId: number;
}

export type ClassifyDailyChallenge = (
  input: DailyClassificationInput,
) => Promise<DailyClassification>;

export interface CreateChallengeHandlerRequest extends CreateChallengeRequest {
  creatorAccountId: string;
  creatorDisplayName: string;
  creatorIdentityStatus: AccountStatus;
}

export function createApiHandlers(
  repository: TrackingRepository,
  options: ApiHandlerOptions = {},
): ApiHandlers {
  const validateChallengeArticles =
    options.validateChallengeArticles ?? defaultChallengeArticleValidation;

  return {
    async listChallenges() {
      return {
        challenges: getSortedChallenges(await repository.listChallenges()),
      };
    },

    async createChallenge(input) {
      const startTitle = requiredString(
        input.startTitle,
        "invalid_start_title",
        "Enter a start article title.",
      );
      const targetTitle = requiredString(
        input.targetTitle,
        "invalid_target_title",
        "Enter a target article title.",
      );
      const creatorAccountId = requiredString(
        input.creatorAccountId,
        "invalid_creator_account",
        "A VGames account is required.",
      );
      const creatorDisplayName = requiredString(
        input.creatorDisplayName,
        "invalid_creator_name",
        "Enter a display name before creating a challenge.",
      ).slice(0, 24);
      const creatorIdentityStatus = readIdentityStatus(
        input.creatorIdentityStatus,
      );
      const validatedArticles = await validateChallengeArticles({
        startTitle,
        targetTitle,
      });

      return {
        challenge: await repository.createChallenge({
          startTitle: validatedArticles.start.title,
          targetTitle: validatedArticles.target.title,
          creatorAccountId,
          creatorDisplayName,
          creatorIdentityStatus,
        }),
      };
    },

    async createChallengeV2(account, input, idempotencyKey) {
      const startTitle = boundedRequiredString(
        input.startTitle,
        "invalid_start_title",
        "Enter a start article title.",
        2048,
      );
      const targetTitle = boundedRequiredString(
        input.targetTitle,
        "invalid_target_title",
        "Enter a target article title.",
        2048,
      );
      const nominateForDaily = readNominationIntent(input.nominateForDaily);
      const cleanIdempotencyKey = boundedRequiredString(
        idempotencyKey,
        "invalid_idempotency_key",
        "An idempotency key is required.",
        200,
      );
      const requestFingerprint = await fingerprintCreateChallengeRequest({
        startTitle,
        targetTitle,
        nominateForDaily,
      });
      const protocol = repository as RunProtocolRepository;
      const replay = await protocol.findChallengeCreationReplay(account, {
        idempotencyKey: cleanIdempotencyKey,
        requestFingerprint,
      });
      if (replay) {
        return normalizeCreateChallengeOutcome(replay);
      }
      const validatedArticles = await validateChallengeArticles({ startTitle, targetTitle });
      if (validatedArticles.start.pageId === validatedArticles.target.pageId) {
        throw new ApiError("same_challenge_article", "Start and target must be different Wikipedia articles.", 409);
      }
      if (validatedArticles.start.allowedLinkCount < 1) {
        throw new ApiError("start_has_no_allowed_links", "The start article has no allowed links.", 409);
      }
      const dailyClassification = nominateForDaily && account.status === "claimed"
        ? await classifyDailyChallenge(options.classifyDaily, {
            startTitle: validatedArticles.start.title,
            startPageId: validatedArticles.start.pageId,
            startAllowedLinkCount: validatedArticles.start.allowedLinkCount,
            targetTitle: validatedArticles.target.title,
            targetPageId: validatedArticles.target.pageId,
          })
        : unclassifiedDailyClassification();
      return normalizeCreateChallengeOutcome(await protocol.createChallengeV2(account, {
          startTitle: boundedRequiredString(
            validatedArticles.start.title,
            "invalid_start_title",
            "The canonical start article title is invalid.",
            512,
          ),
          startPageId: validatedArticles.start.pageId,
          startAllowedLinkCount: validatedArticles.start.allowedLinkCount,
          targetTitle: boundedRequiredString(
            validatedArticles.target.title,
            "invalid_target_title",
            "The canonical target article title is invalid.",
            512,
          ),
          targetPageId: validatedArticles.target.pageId,
          idempotencyKey: cleanIdempotencyKey,
          requestFingerprint,
          nominateForDaily,
          dailyClassification,
        }));
    },

    async startRun(input) {
      const challengeId = requiredString(
        input.challengeId,
        "invalid_challenge_id",
        "Choose a challenge before starting.",
      );
      const accountId = requiredString(
        input.accountId,
        "invalid_account_id",
        "A VGames account is required.",
      );
      const publicName = requiredString(
        input.publicName,
        "invalid_public_name",
        "Enter a display name before starting.",
      );
      const identityStatus = readIdentityStatus(input.identityStatus);

      return {
        run: await repository.startRun({
          challengeId,
          accountId,
          publicName: publicName.slice(0, 24),
          identityStatus,
        }),
      };
    },

    async recordClick(runId, accountId, input) {
      const cleanRunId = requiredString(
        runId,
        "invalid_run_id",
        "A run id is required.",
      );
      const cleanAccountId = requiredString(
        accountId,
        "invalid_account_id",
        "A VGames account is required.",
      );

      return repository.recordClick(cleanRunId, cleanAccountId, {
        sourceTitle: requiredString(
          input.sourceTitle,
          "invalid_source_title",
          "A source article title is required.",
        ),
        clickedAnchorText: requiredString(
          input.clickedAnchorText,
          "invalid_anchor_text",
          "Clicked link text is required.",
        ),
        requestedTitle: requiredString(
          input.requestedTitle,
          "invalid_requested_title",
          "A requested article title is required.",
        ),
        destinationTitle: requiredString(
          input.destinationTitle,
          "invalid_destination_title",
          "A destination article title is required.",
        ),
        destinationPageId: optionalNumber(input.destinationPageId),
        clientTimestampMs: optionalNumber(input.clientTimestampMs),
      });
    },

    async completeRun(runId, accountId, input) {
      const cleanRunId = requiredString(
        runId,
        "invalid_run_id",
        "A run id is required.",
      );
      const cleanAccountId = requiredString(
        accountId,
        "invalid_account_id",
        "A VGames account is required.",
      );
      const finalTitle = requiredString(
        input.finalTitle,
        "invalid_final_title",
        "A final article title is required.",
      );

      return {
        leaderboardRow: await repository.completeRun(
          cleanRunId,
          cleanAccountId,
          {
            finalTitle,
            clientTimestampMs: optionalNumber(input.clientTimestampMs),
          },
        ),
      };
    },

    async abandonRun(runId, accountId) {
      return repository.abandonRun(
        requiredString(runId, "invalid_run_id", "A run id is required."),
        requiredString(
          accountId,
          "invalid_account_id",
          "A VGames account is required.",
        ),
      );
    },

    async listLeaderboard(challengeId) {
      return {
        leaderboard: await repository.listLeaderboard(
          requiredString(
            challengeId,
            "invalid_challenge_id",
            "A challenge id is required.",
          ),
        ),
      };
    },

    async getRunPath(runId) {
      return {
        path: await repository.getRunPath(
          requiredString(runId, "invalid_run_id", "A run id is required."),
        ),
      };
    },
  };
}

const defaultChallengeArticleValidation: ValidateChallengeArticles = async ({
  startTitle,
  targetTitle,
}) => ({
  start: { title: startTitle, pageId: 1, allowedLinkCount: 1 },
  target: { title: targetTitle, pageId: 2, allowedLinkCount: 1 },
});

function normalizeCreateChallengeOutcome(
  result: CreateChallengeRepositoryResult,
): CreateChallengeOutcome {
  if ("disposition" in result && "nomination" in result) {
    return result;
  }

  return {
    challenge: result,
    disposition: "created",
    nomination: "not_requested",
  };
}

async function classifyDailyChallenge(
  classifier: ClassifyDailyChallenge | undefined,
  input: DailyClassificationInput,
): Promise<DailyClassification> {
  if (classifier) {
    try {
      return await classifier(input);
    } catch {
      // Classification is editorial metadata; it must not block a valid challenge.
    }
  }

  return unclassifiedDailyClassification();
}

function unclassifiedDailyClassification(): DailyClassification {
  return {
    recognizableScore: null,
    weirdScore: null,
    hardScore: null,
    suggestedFlavor: null,
    confidence: "unclassified",
    classifierVersion: "editorial-v1",
  };
}

function readNominationIntent(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ApiError(
      "invalid_nomination_intent",
      "Daily nomination intent must be a boolean.",
      400,
    );
  }
  return value;
}

function boundedRequiredString(
  value: unknown,
  code: string,
  message: string,
  maxLength: number,
): string {
  const result = requiredString(value, code, message);
  if (result.length > maxLength) {
    throw new ApiError(code, message, 400);
  }
  return result;
}

function readIdentityStatus(value: unknown): "ghost" | "claimed" | "merged" {
  if (value === "ghost" || value === "claimed" || value === "merged") {
    return value;
  }

  return "ghost";
}
