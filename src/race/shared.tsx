import { useCallback, useEffect, useRef, useState } from "react";
import { dailyNumberLabel } from "../domain/dailyEditorial";
import { formatTimeAndClicks } from "../domain/formatting";
import type { Challenge } from "../domain/types";
import { writeTextWithTimeout } from "../services/challengeShare";

/**
 * Small pieces shared across the race-flow beats (PreRacePreview, RaceMode,
 * RaceResults) and the still-App.tsx-owned idle/home views. Kept dependency-
 * free of App.tsx to avoid a circular import (App renders RaceFlow, which
 * renders these).
 */

export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function challengeShareUrl(challengeId: string): string {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("challenge", challengeId);
  return url.toString();
}

export function copyTextFallback(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export type ClipboardShareStatus = "idle" | "copying" | "copied" | "failed";

/**
 * Clipboard-write machinery shared by every "copy/share" affordance in the
 * race flow (challenge-link copy today, Results' composed share line). One
 * place owns the timeout + legacy-execCommand fallback + stale-request
 * guarding so beats don't reimplement it.
 */
export function useClipboardShare(text: string): {
  status: ClipboardShareStatus;
  copy: () => Promise<void>;
} {
  const [status, setStatus] = useState<ClipboardShareStatus>("idle");
  const activeText = useRef(text);
  const copyGeneration = useRef(0);
  activeText.current = text;

  useEffect(() => {
    copyGeneration.current += 1;
    setStatus("idle");
  }, [text]);

  const copy = useCallback(async () => {
    const generation = ++copyGeneration.current;
    const requestIsCurrent = () =>
      generation === copyGeneration.current && activeText.current === text;
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable.");
      }
      await writeTextWithTimeout(
        (value) => navigator.clipboard.writeText(value),
        text,
        1_200,
      );
      if (!requestIsCurrent()) return;
      setStatus("copied");
    } catch {
      if (!requestIsCurrent()) return;
      const fallbackCopied = copyTextFallback(text);
      if (!requestIsCurrent()) return;
      setStatus(fallbackCopied ? "copied" : "failed");
    }
  }, [text]);

  return { status, copy };
}

/**
 * One-line, real-data share text. Always carries time+clicks (invariant 1)
 * when ranked; falls back gracefully when the server didn't return a rank.
 * Takes plain result primitives rather than a full `RaceResultOutcome` so
 * both Results (a live `GameSession`) and Home's post-play card (a
 * persisted leaderboard row, reachable across reloads) can compose the
 * identical string from whatever shape of data they each already have on
 * hand.
 *
 * PKG-05 (council 2026-07-19, owner-proxy ruling): `status` is required, not
 * inferred from `rank`. A DNF has no rank, and a bare "time · clicks" line
 * with no rank is otherwise indistinguishable from a real (if unranked)
 * completed run - it would read exactly like a blazing-fast win, not a
 * failed 1-click abandon. DNF gets its own explicit "DNF · ..." line (with a
 * self-deprecating "beat that" nudge, not a brag) so sharing a loss never
 * misrepresents it as a win.
 *
 * PKG-07 (council 2026-07-19, owner-proxy ruling): a daily challenge leads
 * with "Daily #N" (Wordle's own "Wordle 942" convention) instead of its
 * generic `label` ("Challenge #47", a global creation counter across every
 * challenge type - misleading for a daily, and not the number a player saw
 * on Home/Boards/Preview). `dailyNumber` postdates this field on older
 * fixtures/responses (see `DailyFeature`'s own doc comment), so a daily
 * challenge missing it falls back to the pre-PKG-07 `label`/`id` line
 * rather than shipping a "Daily #undefined" share.
 */
export function composeShareText(
  challenge: Challenge,
  result: { elapsedMs: number; clicks: number; rank: number | null; status: "completed" | "dnf" },
): string {
  const label = dailyNumberLabel(challenge.dailyFeature?.dailyNumber) ?? challenge.label ?? challenge.id;
  const timeAndClicks = formatTimeAndClicks(result.elapsedMs, result.clicks);
  const scoreLine = result.status === "dnf"
    ? `DNF · ${timeAndClicks} — beat that`
    : result.rank !== null
      ? `#${result.rank} · ${timeAndClicks}`
      : timeAndClicks;
  return `VWiki Race — ${label} — ${scoreLine} — ${challengeShareUrl(challenge.id)}`;
}

/**
 * QF-10 (round-2 quickfix, owner-proxy ruling): tries the OS's native share
 * sheet first (iOS Safari, Android Chrome, any other navigator.share-
 * capable browser) before falling back to the existing clipboard flow.
 * Deliberately NOT folded into `useClipboardShare` above (binding scope) -
 * both share buttons call this locally from their own onClick, so the
 * shared hook's clipboard-only contract - and every test already written
 * against it - stays untouched. A user-cancelled share (AbortError) is a
 * no-op, not an error; any other failure (including no navigator.share at
 * all) falls through to the same clipboard-write `copy` the hook already
 * exposes. Passes `text` only, never a separate `url` field - `text` here
 * already carries the URL baked in (`composeShareText`/`challengeShareUrl`
 * both compose it that way), and some share targets (notably iOS Messages)
 * render the link twice if it's also passed as `url`.
 */
async function shareOrCopy(text: string, copy: () => Promise<void>): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (error) {
      // A cancelled share rejects with an `AbortError` DOMException, which
      // (per spec) does NOT extend `Error` - checked by duck-typed `.name`,
      // not `instanceof Error`, so this actually catches the real rejection
      // shape browsers use.
      const name = error && typeof error === "object" && "name" in error
        ? (error as { name?: unknown }).name
        : undefined;
      if (name === "AbortError") return;
      // Any other failure falls through to the clipboard fallback below - a
      // real share failure shouldn't leave the tap with no outcome at all.
    }
  }
  await copy();
}

/**
 * Shared "Share result" affordance - Results' completed AND (PKG-05) dnf
 * outcomes, plus Home's post-play card (UX redesign spec: "reuse
 * useClipboardShare + the Results composition"), all render this exact
 * button from whatever result primitives they have.
 */
export function ShareResultButton({
  challenge,
  elapsedMs,
  clicks,
  rank,
  status,
}: {
  challenge: Challenge;
  elapsedMs: number;
  clicks: number;
  rank: number | null;
  status: "completed" | "dnf";
}) {
  const shareText = composeShareText(challenge, { elapsedMs, clicks, rank, status });
  const { status: copyStatus, copy } = useClipboardShare(shareText);

  return (
    <div className="share-result">
      <button
        disabled={copyStatus === "copying"}
        type="button"
        onClick={() => void shareOrCopy(shareText, copy)}
      >
        Share result
      </button>
      {copyStatus !== "idle" ? (
        <span aria-live="polite" role="status">
          {copyStatus === "copying"
            ? "Copying result..."
            : copyStatus === "copied"
              ? "Result copied. Paste it anywhere."
              : "Automatic copy was blocked. Select the text below."}
        </span>
      ) : null}
      {copyStatus === "failed" ? (
        <input
          aria-label="Share text"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={shareText}
        />
      ) : null}
    </div>
  );
}

export function ChallengeShareButton({ challengeId }: { challengeId: string }) {
  const shareUrl = challengeShareUrl(challengeId);
  const { status, copy } = useClipboardShare(shareUrl);

  return (
    <div className="challenge-share">
      <button
        className="secondary-button"
        disabled={status === "copying"}
        onClick={() => void shareOrCopy(shareUrl, copy)}
        type="button"
      >
        Copy challenge link
      </button>
      {status !== "idle" ? (
        <span aria-live="polite" role="status">
          {status === "copying"
            ? "Copying challenge link..."
            : status === "copied"
              ? "Challenge link copied."
              : "Automatic copy was blocked. Select the link below."}
        </span>
      ) : null}
      {status === "failed" ? (
        <input
          aria-label="Challenge link"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={shareUrl}
        />
      ) : null}
    </div>
  );
}
