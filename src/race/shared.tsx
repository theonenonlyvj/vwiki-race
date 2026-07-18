import { useEffect, useRef, useState } from "react";
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

export function ChallengeShareButton({ challengeId }: { challengeId: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const activeChallengeId = useRef(challengeId);
  const copyGeneration = useRef(0);
  const shareUrl = challengeShareUrl(challengeId);
  activeChallengeId.current = challengeId;

  useEffect(() => {
    copyGeneration.current += 1;
    setStatus("idle");
  }, [challengeId]);

  async function copyChallengeLink() {
    const generation = ++copyGeneration.current;
    const requestIsCurrent = () =>
      generation === copyGeneration.current && activeChallengeId.current === challengeId;
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable.");
      }
      await writeTextWithTimeout(
        (text) => navigator.clipboard.writeText(text),
        shareUrl,
        1_200,
      );
      if (!requestIsCurrent()) return;
      setStatus("copied");
    } catch {
      if (!requestIsCurrent()) return;
      const fallbackCopied = copyTextFallback(shareUrl);
      if (!requestIsCurrent()) return;
      setStatus(fallbackCopied ? "copied" : "failed");
    }
  }

  return (
    <div className="challenge-share">
      <button
        className="secondary-button"
        disabled={status === "copying"}
        onClick={() => void copyChallengeLink()}
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
