import { useCallback, useEffect, useRef, useState } from "react";
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
 * One-line, real-data share text (no fabricated "daily #N" - the catalog has
 * no such field yet). Always carries time+clicks (invariant 1) when ranked;
 * falls back gracefully when the server didn't return a rank. Takes plain
 * result primitives rather than a full `RaceResultOutcome` so both Results
 * (a live `GameSession`) and Home's post-play card (a persisted leaderboard
 * row, reachable across reloads) can compose the identical string from
 * whatever shape of data they each already have on hand.
 */
export function composeShareText(
  challenge: Challenge,
  result: { elapsedMs: number; clicks: number; rank: number | null },
): string {
  const label = challenge.label ?? challenge.id;
  const scoreLine = result.rank !== null
    ? `#${result.rank} · ${formatTimeAndClicks(result.elapsedMs, result.clicks)}`
    : formatTimeAndClicks(result.elapsedMs, result.clicks);
  return `VWiki Race — ${label} — ${scoreLine} — ${challengeShareUrl(challenge.id)}`;
}

/**
 * Shared "Share result" affordance - Results' completed outcome and Home's
 * post-play card (UX redesign spec: "reuse useClipboardShare + the Results
 * composition") both render this exact button from whatever result
 * primitives they have.
 */
export function ShareResultButton({
  challenge,
  elapsedMs,
  clicks,
  rank,
}: {
  challenge: Challenge;
  elapsedMs: number;
  clicks: number;
  rank: number | null;
}) {
  const shareText = composeShareText(challenge, { elapsedMs, clicks, rank });
  const { status, copy } = useClipboardShare(shareText);

  return (
    <div className="share-result">
      <button
        disabled={status === "copying"}
        type="button"
        onClick={() => void copy()}
      >
        Share result
      </button>
      {status !== "idle" ? (
        <span aria-live="polite" role="status">
          {status === "copying"
            ? "Copying result..."
            : status === "copied"
              ? "Result copied. Paste it anywhere."
              : "Automatic copy was blocked. Select the text below."}
        </span>
      ) : null}
      {status === "failed" ? (
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
        onClick={() => void copy()}
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
