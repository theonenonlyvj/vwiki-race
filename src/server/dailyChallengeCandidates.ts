import type { DailyFlavor } from "../domain/dailyEditorial";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import {
  createDailyCandidateEvaluator,
  type DailyCandidateEvaluator,
  type DailyCandidateRequest,
  type DailyChallengeDiagnosticEvent,
  type DailyChallengeCandidate,
} from "./dailyCandidateEvaluator";
import type { EditorialTargetPools } from "./editorialTargetPools";

export {
  DailyChallengeCandidateError,
  type DailyCandidateRequest,
  type DailyChallengeCandidate,
  type DailyChallengeDiagnosticEvent,
} from "./dailyCandidateEvaluator";

export function createDailyChallengeCandidateSource(options: {
  fetchImpl: typeof fetch;
  gateway: WikipediaGateway;
  targetPools?: EditorialTargetPools;
  evaluator?: DailyCandidateEvaluator;
  endpoint?: string;
  pageviewsEndpoint?: string;
  now?: () => number;
  phaseTimeoutMs?: number;
  maxRequests?: number;
  onDiagnostic?: (
    event: DailyChallengeDiagnosticEvent,
    fields: Record<string, string | number | boolean>,
  ) => void;
}) {
  const now = options.now ?? Date.now;
  const evaluator = options.evaluator ?? createDailyCandidateEvaluator({
    fetchImpl: options.fetchImpl,
    gateway: options.gateway,
    targetPools: options.targetPools,
    endpoint: options.endpoint,
    pageviewsEndpoint: options.pageviewsEndpoint,
    now,
    phaseTimeoutMs: options.phaseTimeoutMs,
    maxRequests: options.maxRequests,
    onDiagnostic: options.onDiagnostic,
  });

  return {
    async findCandidate(request?: DailyCandidateRequest): Promise<DailyChallengeCandidate> {
      return evaluator.findCandidate(request ?? legacyRequest(now));
    },
  };
}

function legacyRequest(now: () => number): { dailyDate: string; flavor: DailyFlavor } {
  return {
    dailyDate: new Date(now()).toISOString().slice(0, 10),
    flavor: "recognizable",
  };
}
