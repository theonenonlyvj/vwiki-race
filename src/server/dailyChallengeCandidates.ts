import type { WikipediaGateway } from "../services/wikipediaGateway";
import {
  createDailyCandidateEvaluator,
  type DailyCandidateEvaluator,
  type DailyCandidateRequest,
  type DailyChallengeDiagnosticEvent,
  type DailyChallengeCandidate,
} from "./dailyCandidateEvaluator";

export {
  DailyChallengeCandidateError,
  type DailyCandidateRequest,
  type DailyChallengeCandidate,
  type DailyChallengeDiagnosticEvent,
} from "./dailyCandidateEvaluator";

export function createDailyChallengeCandidateSource(options: {
  fetchImpl: typeof fetch;
  gateway: WikipediaGateway;
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
  const evaluator = options.evaluator ?? createDailyCandidateEvaluator({
    fetchImpl: options.fetchImpl,
    gateway: options.gateway,
    endpoint: options.endpoint,
    pageviewsEndpoint: options.pageviewsEndpoint,
    now: options.now,
    phaseTimeoutMs: options.phaseTimeoutMs,
    maxRequests: options.maxRequests,
    onDiagnostic: options.onDiagnostic,
  });

  return {
    async findCandidate(request: DailyCandidateRequest): Promise<DailyChallengeCandidate> {
      if (!request) {
        throw new TypeError("Daily candidate requests require a daily date and flavor.");
      }
      return evaluator.findCandidate(request);
    },
  };
}
