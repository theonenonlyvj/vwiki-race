import { useRef, useState, type FormEvent } from "react";
import { useClipboardShare } from "../race/shared";
import "./PasswordRecovery.css";

type IssuedReset = {
  link: string;
  maxAgeSeconds: number;
  username: string;
};

type IssuedResetResponse = {
  maxAgeSeconds: number;
  resetToken: string;
  username: string;
};

function issueEndpoint(apiOrigin: string): string {
  return new URL("/api/v2/admin/password-resets", apiOrigin || window.location.origin).toString();
}

async function responseErrorCode(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function issueErrorMessage(code: string | null): string {
  switch (code) {
    case "invalid_username":
      return "Enter a valid VGames username.";
    case "account_not_found":
      return "No claimed VGames account uses that username.";
    case "forbidden":
      return "This admin session is not authorized to create reset links.";
    case "daily_admin_rate_limited":
      return "Too many reset links were requested. Wait a little and try again.";
    case "invalid_identity_response":
    case "password_recovery_unavailable":
    default:
      return "Password recovery is temporarily unavailable. Try again.";
  }
}

function parseIssuedReset(value: unknown): IssuedResetResponse | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.username !== "string" ||
    typeof body.resetToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.resetToken) ||
    typeof body.maxAgeSeconds !== "number" ||
    !Number.isFinite(body.maxAgeSeconds) ||
    body.maxAgeSeconds <= 0
  ) {
    return null;
  }
  return {
    username: body.username,
    maxAgeSeconds: body.maxAgeSeconds,
    resetToken: body.resetToken,
  };
}

function expiryLabel(maxAgeSeconds: number): string {
  const secondsPerDay = 24 * 60 * 60;
  if (maxAgeSeconds % secondsPerDay === 0) {
    const days = maxAgeSeconds / secondsPerDay;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.max(1, Math.floor(maxAgeSeconds / (60 * 60)));
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export default function AdminPasswordReset({ token, apiOrigin }: {
  token: string;
  apiOrigin: string;
}) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedReset | null>(null);
  const submitLock = useRef(false);
  const { status: copyStatus, copy } = useClipboardShare(issued?.link ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) {
      setError("Enter a VGames username.");
      return;
    }

    submitLock.current = true;
    setBusy(true);
    setError(null);
    // Remove an older bearer link before requesting its replacement. The
    // server invalidates that older link on successful reissue.
    setIssued(null);
    try {
      const response = await fetch(issueEndpoint(apiOrigin), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: normalizedUsername }),
      });
      if (!response.ok) {
        setError(issueErrorMessage(await responseErrorCode(response)));
        return;
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        value = null;
      }
      const parsed = parseIssuedReset(value);
      if (!parsed) {
        setError(issueErrorMessage("invalid_identity_response"));
        return;
      }
      const link = new URL("/", window.location.origin);
      link.hash = `reset-password=${parsed.resetToken}`;
      setIssued({
        link: link.toString(),
        maxAgeSeconds: parsed.maxAgeSeconds,
        username: parsed.username,
      });
    } catch {
      setError(issueErrorMessage("password_recovery_unavailable"));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="admin-password-reset-title" className="admin-password-reset password-recovery-card">
      <header>
        <h2 id="admin-password-reset-title">Password reset links</h2>
        <p>Create a one-use link after confirming the player&apos;s VGames username.</p>
      </header>
      <form className="password-recovery-form" onSubmit={submit}>
        <label className="name-control">
          <span>VGames username</span>
          <input
            aria-label="VGames username"
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            spellCheck={false}
            value={username}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "Creating reset link…" : "Create reset link"}
        </button>
      </form>

      {error ? <p className="error-banner" role="alert">{error}</p> : null}

      {issued ? (
        <section aria-label={`Reset link for ${issued.username}`} className="password-reset-issued">
          <h3>One-use link for {issued.username}</h3>
          <p>
            Expires in {expiryLabel(issued.maxAgeSeconds)}. Creating another link for this username invalidates this one.
          </p>
          <label className="name-control">
            <span>Password reset link</span>
            <input
              aria-label="Password reset link"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={issued.link}
            />
          </label>
          <button
            disabled={copyStatus === "copying"}
            onClick={() => void copy()}
            type="button"
          >
            {copyStatus === "copying" ? "Copying reset link…" : "Copy reset link"}
          </button>
          {copyStatus !== "idle" ? (
            <p aria-live="polite" role="status">
              {copyStatus === "copying"
                ? "Copying reset link…"
                : copyStatus === "copied"
                  ? "Reset link copied."
                  : "Automatic copy was blocked. Select the link above and copy it manually."}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
