/// <reference types="@cloudflare/workers-types" />

import type { AccountStatus } from "../domain/types";
import { createApiHandlers } from "./apiHandlers";
import { createD1TrackingRepository } from "./d1TrackingRepository";
import { ApiError } from "./http";
import { createVGamesIdentityClient } from "./vgamesIdentityClient";
import { createWikipediaChallengeValidator } from "./wikipediaChallengeValidator";

export interface Env {
  VWIKI_RACE_DB: D1Database;
  VGAMES_URL: string;
}

interface AuthorizedVGamesAccount {
  accountId: string;
  status: AccountStatus;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const tracking = createTracking(env);

    try {
      if (request.method === "GET" && url.pathname === "/api/challenges") {
        return json(await tracking.handlers.listChallenges());
      }

      if (request.method === "POST" && url.pathname === "/api/challenges") {
        const account = await tracking.authorize(request);
        const input = (await readJson(request)) as {
          startTitle: string;
          targetTitle: string;
          creatorDisplayName: string;
        };
        return json(
          await tracking.handlers.createChallenge({
            ...input,
            creatorAccountId: account.accountId,
            creatorIdentityStatus: account.status,
          }),
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/identity/guest"
      ) {
        return json(await tracking.identity.quick(await readJson(request) as {
          deviceCredential: string;
          displayName: string;
        }));
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/identity/secure"
      ) {
        return json(await tracking.identity.secure(await readJson(request) as {
          deviceCredential: string;
          token: string;
          username: string;
          password: string;
        }));
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/identity/login"
      ) {
        return json(await tracking.identity.login(await readJson(request) as {
          deviceCredential: string;
          username: string;
          password: string;
        }));
      }

      if (request.method === "POST" && url.pathname === "/api/runs/start") {
        const account = await tracking.authorize(request);
        const input = (await readJson(request)) as {
          challengeId: string;
          publicName: string;
        };
        return json(
          await tracking.handlers.startRun({
            challengeId: input.challengeId,
            accountId: account.accountId,
            publicName: input.publicName,
            identityStatus: account.status,
          }),
        );
      }

      const leaderboardMatch = url.pathname.match(
        /^\/api\/challenges\/([^/]+)\/leaderboard$/,
      );
      if (request.method === "GET" && leaderboardMatch?.[1]) {
        return json(
          await tracking.handlers.listLeaderboard(
            decodeURIComponent(leaderboardMatch[1]),
          ),
        );
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)$/);
      if (runMatch?.[1] && runMatch[2]) {
        const runId = decodeURIComponent(runMatch[1]);
        const action = runMatch[2];

        if (request.method === "GET" && action === "path") {
          return json(await tracking.handlers.getRunPath(runId));
        }

        if (request.method === "POST" && action === "click") {
          const account = await tracking.authorize(request);
          return json(
            await tracking.handlers.recordClick(
              runId,
              account.accountId,
              (await readJson(request)) as {
                sourceTitle: string;
                clickedAnchorText: string;
                requestedTitle: string;
                destinationTitle: string;
                destinationPageId?: number;
                clientTimestampMs?: number;
              },
            ),
          );
        }

        if (request.method === "POST" && action === "complete") {
          const account = await tracking.authorize(request);
          return json(
            await tracking.handlers.completeRun(
              runId,
              account.accountId,
              (await readJson(request)) as {
                finalTitle: string;
                clientTimestampMs?: number;
              },
            ),
          );
        }

        if (request.method === "POST" && action === "abandon") {
          const account = await tracking.authorize(request);
          return json(
            await tracking.handlers.abandonRun(runId, account.accountId),
          );
        }
      }

      return json(
        { error: { code: "not_found", message: "Not found." } },
        { status: 404 },
      );
    } catch (caught) {
      return error(caught);
    }
  },
};

function createTracking(env: Env) {
  const repository = createD1TrackingRepository({
    db: env.VWIKI_RACE_DB,
  });
  const wikipedia = createWikipediaChallengeValidator({
    fetchImpl: fetch,
  });
  const handlers = createApiHandlers(repository, {
    validateChallengeArticles: wikipedia.validateChallengeArticles,
  });
  const identity = createVGamesIdentityClient({
    baseUrl: env.VGAMES_URL,
  });

  return {
    handlers,
    identity,
    authorize: (request: Request) => authorizeVGamesRequest(request, identity),
  };
}

async function authorizeVGamesRequest(
  request: Request,
  identity: Pick<ReturnType<typeof createVGamesIdentityClient>, "introspect">,
): Promise<AuthorizedVGamesAccount> {
  const result = await identity.introspect(readBearerToken(request));
  if (!result.valid) {
    throw new ApiError(
      "unauthorized",
      "Sign in before changing VWiki Race.",
      401,
    );
  }

  return {
    accountId: result.accountId,
    status: result.status,
  };
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new ApiError(
      "unauthorized",
      "Sign in before changing VWiki Race.",
      401,
    );
  }
  return match[1].trim();
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("invalid_json", "Request body must be valid JSON.");
  }
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function error(caught: unknown): Response {
  if (caught instanceof ApiError) {
    return json(
      { error: { code: caught.code, message: caught.message } },
      { status: caught.status },
    );
  }

  return json(
    {
      error: {
        code: "internal_error",
        message: "Something went wrong.",
      },
    },
    { status: 500 },
  );
}
