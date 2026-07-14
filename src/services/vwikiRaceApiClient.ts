import type {
  AbandonRunResponse,
  ClickRequest,
  ClickResponse,
  CreateChallengeRequest,
  CompleteRunRequest,
  LeaderboardResponse,
  RunPathResponse,
} from "../server/contracts";
import type {
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";
import type {
  RunRecordResponse,
} from "../server/trackingRepository";

const API_BASE_URL = (import.meta.env.VITE_VWIKI_RACE_API_URL ?? "").replace(
  /\/+$/,
  "",
);

export interface StartTrackedRunRequest {
  challengeId: string;
  publicName: string;
}

export interface VWikiRaceApiClient {
  listChallenges(): Promise<Challenge[]>;
  createChallenge(
    input: CreateChallengeRequest,
    token: string,
  ): Promise<Challenge>;
  startRun(
    input: StartTrackedRunRequest,
    token: string,
  ): Promise<RunRecordResponse>;
  recordClick(
    runId: string,
    input: ClickRequest,
    token: string,
  ): Promise<ClickResponse>;
  completeRun(
    runId: string,
    input: CompleteRunRequest,
    token: string,
  ): Promise<RankedLeaderboardRow>;
  abandonRun(runId: string, token: string): Promise<AbandonRunResponse>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getRunPath(runId: string): Promise<ServerPathStep[]>;
}

export function createVWikiRaceApiClient(
  fetchImpl: typeof fetch,
): VWikiRaceApiClient {
  return {
    async listChallenges() {
      const response = await apiRequest<{ challenges: Challenge[] }>(
        fetchImpl,
        "/api/challenges",
      );
      return response.challenges;
    },
    async createChallenge(input, token) {
      const response = await apiRequest<{ challenge: Challenge }>(
        fetchImpl,
        "/api/challenges",
        {
          method: "POST",
          body: input,
          token,
        },
      );
      return response.challenge;
    },
    async startRun(input, token) {
      const response = await apiRequest<{ run: RunRecordResponse }>(
        fetchImpl,
        "/api/runs/start",
        {
          method: "POST",
          body: input,
          token,
        },
      );
      return response.run;
    },
    async recordClick(runId, input, token) {
      return apiRequest<ClickResponse>(
        fetchImpl,
        `/api/runs/${encodeURIComponent(runId)}/click`,
        {
          method: "POST",
          body: input,
          token,
        },
      );
    },
    async completeRun(runId, input, token) {
      const response = await apiRequest<{ leaderboardRow: RankedLeaderboardRow }>(
        fetchImpl,
        `/api/runs/${encodeURIComponent(runId)}/complete`,
        {
          method: "POST",
          body: input,
          token,
        },
      );
      return response.leaderboardRow;
    },
    async abandonRun(runId, token) {
      return apiRequest<AbandonRunResponse>(
        fetchImpl,
        `/api/runs/${encodeURIComponent(runId)}/abandon`,
        {
          method: "POST",
          token,
        },
      );
    },
    async listLeaderboard(challengeId) {
      const response = await apiRequest<LeaderboardResponse>(
        fetchImpl,
        `/api/challenges/${encodeURIComponent(challengeId)}/leaderboard`,
      );
      return response.leaderboard;
    },
    async getRunPath(runId) {
      const response = await apiRequest<RunPathResponse>(
        fetchImpl,
        `/api/runs/${encodeURIComponent(runId)}/path`,
      );
      return response.path;
    },
  };
}

async function apiRequest<T>(
  fetchImpl: typeof fetch,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const response = await fetchImpl(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: createHeaders(options),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(readApiError(payload, response.status));
  }

  return payload as T;
}

function createHeaders(options: {
  body?: unknown;
  token?: string;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  return Object.keys(headers).length ? headers : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function readApiError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return `VWiki Race API request failed with status ${status}`;
}
