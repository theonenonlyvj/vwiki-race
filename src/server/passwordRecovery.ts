import { ApiError } from "./http";

const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PasswordRecoveryBinding {
  fetch(request: Request): Promise<Response>;
}

export interface PasswordResetIssueResult {
  username: string;
  resetToken: string;
  maxAgeSeconds: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function internalPost(
  binding: PasswordRecoveryBinding | undefined,
  path: string,
  body: unknown,
): Promise<Response> {
  if (!binding) {
    throw new ApiError(
      "password_recovery_unavailable",
      "Password recovery is temporarily unavailable.",
      503,
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await binding.fetch(new Request(`https://identity.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }));
  } catch {
    throw new ApiError(
      "password_recovery_unavailable",
      "Password recovery is temporarily unavailable.",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function responseObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export async function issuePasswordReset(
  binding: PasswordRecoveryBinding | undefined,
  input: { username: string; actorAccountId: string },
): Promise<PasswordResetIssueResult> {
  const response = await internalPost(binding, "/auth/password-reset/issue", {
    username: input.username,
    actor: `vwiki:${input.actorAccountId}`,
  });
  const value = await responseObject(response);
  if (response.status === 404) {
    throw new ApiError(
      "account_not_found",
      "No claimed VGames account uses that username.",
      404,
    );
  }
  if (!response.ok || !value) {
    throw new ApiError(
      "password_recovery_unavailable",
      "Password recovery is temporarily unavailable.",
      503,
    );
  }
  if (
    typeof value.username !== "string" ||
    typeof value.resetToken !== "string" ||
    !RESET_TOKEN_PATTERN.test(value.resetToken) ||
    value.maxAgeSeconds !== 604_800
  ) {
    throw new ApiError(
      "invalid_identity_response",
      "Password recovery is temporarily unavailable.",
      502,
    );
  }
  return {
    username: value.username,
    resetToken: value.resetToken,
    maxAgeSeconds: value.maxAgeSeconds,
  };
}

export async function consumePasswordReset(
  binding: PasswordRecoveryBinding | undefined,
  input: { token: string; password: string },
): Promise<{ ok: true }> {
  const response = await internalPost(binding, "/auth/password-reset/consume", input);
  const value = await responseObject(response);
  if (response.status === 400) {
    throw new ApiError(
      "invalid_or_expired_reset",
      "That reset link is invalid or has expired.",
      400,
    );
  }
  if (!response.ok || value?.ok !== true) {
    throw new ApiError(
      "password_recovery_unavailable",
      "Password recovery is temporarily unavailable.",
      503,
    );
  }
  return { ok: true };
}
