import { useEffect, useRef, useState, type FormEvent } from "react";
import "./PasswordRecovery.css";

const RESET_FRAGMENT = /^#reset-password=([A-Za-z0-9_-]{43})$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

function readResetToken(): string | null {
  return window.location.hash.match(RESET_FRAGMENT)?.[1] ?? null;
}

function resetEndpoint(apiOrigin: string): string {
  return new URL("/api/v2/identity/password-reset", apiOrigin || window.location.origin).toString();
}

async function responseErrorCode(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function resetErrorMessage(code: string | null): string {
  switch (code) {
    case "invalid_or_expired_reset":
      return "This reset link is invalid, expired, or already used. Ask Vijay for a new one.";
    case "invalid_password":
      return "Use a password between 6 and 128 characters.";
    case "forbidden":
      return "This reset request was blocked. Reopen the link on the VWiki Race site and try again.";
    case "password_reset_rate_limited":
      return "Too many reset attempts. Wait a little and try again.";
    case "rate_limiter_unavailable":
    case "password_recovery_unavailable":
    default:
      return "Password reset is temporarily unavailable. Try again.";
  }
}

export default function ResetPassword({ apiOrigin, onDone }: {
  apiOrigin: string;
  onDone: () => void;
}) {
  // Capture the fragment exactly once. AppEntry keeps gameplay unmounted
  // while this screen is active, and the effect below removes the bearer
  // secret from the address bar without making render mutate navigation.
  const [resetToken] = useState(readResetToken);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [linkRejected, setLinkRejected] = useState(false);
  const submitLock = useRef(false);

  useEffect(() => {
    if (!window.location.hash.startsWith("#reset-password")) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current || !resetToken) return;
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      setError("Use a password between 6 and 128 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    submitLock.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(resetEndpoint(apiOrigin), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, password }),
      });
      if (!response.ok) {
        const code = await responseErrorCode(response);
        setLinkRejected(code === "invalid_or_expired_reset");
        setError(resetErrorMessage(code));
        return;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
        setError(resetErrorMessage("password_recovery_unavailable"));
        return;
      }
      setPassword("");
      setConfirmation("");
      setSucceeded(true);
    } catch {
      setError(resetErrorMessage("password_recovery_unavailable"));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  const invalidLink = resetToken === null;

  return (
    <main className="password-recovery-screen">
      <section aria-labelledby="reset-password-title" className="password-recovery-card">
        <span className="vwiki-mark">VWiki</span>
        <h1 id="reset-password-title">Choose a new password</h1>

        {succeeded ? (
          <>
            <p className="password-recovery-success" role="status">
              Password reset. Log in with your new password.
            </p>
            <button onClick={onDone} type="button">Back to game</button>
          </>
        ) : invalidLink || linkRejected ? (
          <>
            <p className="error-banner" role="alert">
              {error ?? "This reset link is invalid or incomplete. Ask Vijay for a new one."}
            </p>
            <button onClick={onDone} type="button">Back to game</button>
          </>
        ) : (
          <form className="password-recovery-form" onSubmit={submit}>
            <p>Enter a new password for your VGames account.</p>
            <label className="name-control">
              <span>New password</span>
              <input
                aria-label="New password"
                autoComplete="new-password"
                disabled={busy}
                maxLength={MAX_PASSWORD_LENGTH}
                minLength={MIN_PASSWORD_LENGTH}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </label>
            <label className="name-control">
              <span>Confirm new password</span>
              <input
                aria-label="Confirm new password"
                autoComplete="new-password"
                disabled={busy}
                maxLength={MAX_PASSWORD_LENGTH}
                minLength={MIN_PASSWORD_LENGTH}
                onChange={(event) => setConfirmation(event.target.value)}
                type="password"
                value={confirmation}
              />
            </label>
            {error ? <p className="error-banner" role="alert">{error}</p> : null}
            <button disabled={busy} type="submit">
              {busy ? "Resetting password…" : "Reset password"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
