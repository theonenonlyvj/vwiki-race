import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { dailyNumberLabel } from "../domain/dailyEditorial";
import { formatTimeAndClicks } from "../domain/formatting";
import type { GameSession } from "../domain/gameSession";
import { compressPathForStrip } from "../domain/pathCompression";
import type { Article } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";

/**
 * Beat 2 of the race flow: the active-race takeover. Slim HUD (timer +
 * clicks always visible, End Run prominent) above a muted path breadcrumb
 * above the existing (unmodified) article surface. Rendered whenever
 * race.phase is preparing/active/syncing/abandoning and there is no
 * recoveryRun in play (RaceFlow routes recovery to its own notice).
 */
export default function RaceMode({
  article,
  session,
  elapsedMs,
  redirectedFrom,
  pendingNavigationTitle,
  pendingRetry,
  onRetryPending,
  targetPreview,
  endRunDisabled,
  onRequestEndRun,
  checkingActiveRun,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  article: Article | null;
  session: GameSession | null;
  elapsedMs: number;
  // LK-1: the anchor's pre-redirect title when the current article was
  // reached via a Wikipedia redirect (server followed redirects=1 and
  // returned a different canonical title than the one the player clicked) -
  // null otherwise. Display-only, current article only; see
  // useRaceController's own doc comment on the field.
  redirectedFrom: string | null;
  pendingNavigationTitle: string | null;
  pendingRetry: { title: string; anchorText: string } | null;
  onRetryPending: () => void;
  targetPreview: TargetPreviewState;
  endRunDisabled: boolean;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
  // True only for recoverActiveRun's own "preparing, no session yet" tick
  // (boot recovery checking whether there's anything to resume) - not for a
  // fresh challenge start's equivalent preparing window, where an article
  // really is loading. See RaceFlow's checkingActiveRun computation.
  checkingActiveRun: boolean;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  handleArticlePrewarm: (target: EventTarget | null) => void;
}) {
  const articleClickRef = useRef(handleArticleClick);
  articleClickRef.current = handleArticleClick;
  const stableArticleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    articleClickRef.current(event);
  }, []);
  const articlePrewarmRef = useRef(handleArticlePrewarm);
  articlePrewarmRef.current = handleArticlePrewarm;
  const stableArticlePrewarm = useCallback((target: EventTarget | null) => {
    articlePrewarmRef.current(target);
  }, []);
  const stableArticleFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    stableArticlePrewarm(event.target);
  }, [stableArticlePrewarm]);
  const stableArticlePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    stableArticlePrewarm(event.target);
  }, [stableArticlePrewarm]);

  const currentPathTitles = session
    ? [
        session.challenge.start.title,
        ...session.path.map(
          (entry) => entry.resolvedDestination.canonicalTitle,
        ),
      ]
    : [];
  const visiblePath = session
    ? compressPathForStrip(currentPathTitles, session.challenge.target.title)
    : [];

  return (
    <section className="race-mode">
      <header className="race-hud">
        <div className="race-hud-status">
          {pendingNavigationTitle ? (
            <strong className="header-navigation-status" role="status">
              Opening {pendingNavigationTitle}...
            </strong>
          ) : null}
        </div>
        {session ? (
          // PKG-02: was three chips (Clicks/Timer/Target), one per `dl`
          // entry - collapsed to a single always-visible "0:14 · 3 clk"
          // chip using the same time+clicks formatter every other
          // run-summary in the app uses (invariant 1). Target dropped here
          // since PathStrip's own "Target ▾" disclosure just below already
          // shows it - this was a literal on-screen duplicate.
          <dl className="run-metrics" aria-label="Current run">
            <div>
              <dt>Run</dt>
              <dd>{formatTimeAndClicks(elapsedMs, session.clicks)}</dd>
            </div>
          </dl>
        ) : null}
        <button
          className="end-run-button"
          disabled={endRunDisabled}
          type="button"
          onClick={onRequestEndRun}
        >
          End Run
        </button>
      </header>

      {session ? <PathStrip targetPreview={targetPreview} titles={visiblePath} /> : null}

      {pendingRetry ? (
        <aside className="sync-retry-panel" role="status">
          <p>{pendingRetry.anchorText || pendingRetry.title} is ready to retry.</p>
          <button type="button" onClick={onRetryPending}>Retry click</button>
        </aside>
      ) : null}

      {article ? (
        <WikipediaArticlePanel
          article={article}
          challengeLabel={
            dailyNumberLabel(session?.challenge.dailyFeature?.dailyNumber) ??
            session?.challenge.label ??
            session?.challenge.mode ??
            ""
          }
          acceptedPageId={session?.currentPage.pageId}
          redirectedFrom={redirectedFrom}
          onClick={stableArticleClick}
          onFocus={stableArticleFocus}
          onPointerDown={stableArticlePointerDown}
          pendingNavigationTitle={pendingNavigationTitle}
        />
      ) : (
        <p className="loading-text">
          {checkingActiveRun ? "Checking for an active run..." : "Loading article..."}
        </p>
      )}
    </section>
  );
}

export const WikipediaArticlePanel = memo(function WikipediaArticlePanel({
  article,
  acceptedPageId,
  challengeLabel,
  // LK-1: optional (defaults to no line) - RaceResults' own frozen-article
  // render of this same component is out of scope (retrospective summary,
  // not an active navigation decision), so it never passes this prop.
  redirectedFrom = null,
  onClick,
  onFocus,
  onPointerDown,
  pendingNavigationTitle,
}: {
  article: Article;
  acceptedPageId: number | undefined;
  challengeLabel: string;
  redirectedFrom?: string | null;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  pendingNavigationTitle: string | null;
}) {
  const articleHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const heading = articleHeadingRef.current;
    heading?.scrollIntoView?.({ behavior: "auto", block: "start" });
    heading?.focus({ preventScroll: true });
  }, [acceptedPageId]);

  return (
    <article
      aria-busy={Boolean(pendingNavigationTitle)}
      className="article-panel"
      onClick={onClick}
      onFocus={onFocus}
      onPointerDown={onPointerDown}
    >
      {pendingNavigationTitle ? (
        <div className="article-navigation-pending" role="status">
          Loading next article...
        </div>
      ) : null}
      <div aria-live="polite" className="article-heading">
        <span>{challengeLabel}</span>
        <h2 ref={articleHeadingRef} tabIndex={-1}>{article.canonicalTitle}</h2>
        {redirectedFrom ? (
          // LK-1: mirrors Wikipedia's own "(Redirected from X)" convention
          // (same register, lowercase "redirected") so a player who clicked
          // one title and landed on another sees why, instead of concluding
          // links are cross-wired. Lives here (under the heading), not the
          // path strip - the strip stays canonical/compact - and not a
          // toast, per the brief.
          <p className="article-redirect-note">(redirected from {redirectedFrom})</p>
        ) : null}
      </div>
      <div
        aria-label="Wikipedia article"
        className="article-content"
        dangerouslySetInnerHTML={{ __html: article.sanitizedHtml }}
        inert={Boolean(pendingNavigationTitle)}
        role="region"
        tabIndex={0}
      />
      <p className="attribution">
        <a
          href={article.attributionUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          Source revision
        </a>{" "}
        ·{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          rel="noreferrer noopener"
          target="_blank"
        >
          CC BY-SA 4.0
        </a>
      </p>
    </article>
  );
});

export function PathStrip({
  targetPreview,
  titles,
}: {
  targetPreview: TargetPreviewState;
  titles: string[];
}) {
  const targetTitle = titles.at(-1) ?? "Target";
  const visitedTitles = titles.slice(0, -1);
  const readyPreview = targetPreview.status === "ready" ? targetPreview : null;
  return (
    <nav className="path-strip" aria-label="Run path">
      <div className="path-history">
        {visitedTitles.map((title, index) => (
          <span
            className={title === "..." ? "path-ellipsis" : undefined}
            key={`${title}-${index}`}
          >
            {title}
          </span>
        ))}
      </div>
      <details aria-label="Target reference" className="target-reference">
        <summary>
          <small>Target</small>
          <strong>{targetTitle}</strong>
        </summary>
        <p>
          {readyPreview?.preview.blurb ??
            "The target preview was not ready when this run began."}
        </p>
      </details>
    </nav>
  );
}
