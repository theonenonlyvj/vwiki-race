import { createApiHandlers } from "../../src/server/apiHandlers";
import { ApiError } from "../../src/server/http";
import { createSupabaseTrackingRepository } from "../../src/server/supabaseTrackingRepository";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export function createTrackingContext(env: Env) {
  const repository = createSupabaseTrackingRepository({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const handlers = createApiHandlers(repository);

  return {
    handlers,
    readJson,
    json,
    error,
  };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("invalid_json", "Request body must be valid JSON.");
  }
}

export function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export function error(caught: unknown): Response {
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

export function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
