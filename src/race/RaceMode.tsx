import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { dailyNumberLabel } from "../domain/dailyEditorial";
import { formatTimeAndClicks, truncateTitle } from "../domain/formatting";
import type { GameSession } from "../domain/gameSession";
import { compressPathForStrip } from "../domain/pathCompression";
import type { Article } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";

/**
 * Beat 2 of the race flow: the active-race takeover. Slim HUD (timer +
 * clicks always visible, target one tap away) above a muted path breadcrumb
 * above the existing (unmodified) article surface. Rendered whenever
 * race.phase is preparing/active/syncing/abandoning and there is no
 * recoveryRun in play (RaceFlow routes recovery to its own notice).
 *
 * HD-1 (owner report, two phone screenshots): the sticky `.race-hud` used to
 * be two rows (a status/End-Run row above a Run+Target metrics row) - a tall
 * dead area above the actual timer on a phone. End Run's own prominence
 * never needed the HUD specifically; it just needed to always be reachable
 * during an active run. Moved onto the path-strip row instead (still always
 * rendered whenever `session` is set, i.e. whenever a run is genuinely
 * active - see PathStrip below), leaving `.race-hud` a single row: the Run
 * chip flush left, the Target chip flush right (`.race-hud-metrics`'s
 * `justify-content: space-between`, RaceMode.tsx's only structural change
 * here - the chips are still the same flex siblings RC-1 made them).
 */
export default function RaceMode({
  article,
  session,
  elapsedMs,
  redirectedFrom,
  pendingNavigationTitle,
  navigationRetrying,
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
  // MB-1 Part 2: true while the pending navigation's fetch is on its
  // automatic retry (mirrors the shipped login "Still connecting..."
  // pattern) - swaps the "Opening.../Loading next article..." copy below
  // for honest "Still loading..." instead of an unchanging spinner.
  navigationRetrying: boolean;
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

  // RC-1: owner report - the path strip's target disclosure (below) is the
  // ONLY place to check the target while racing, and that strip is plain
  // static flow (`.race-mode .path-strip`), not sticky - scroll a few
  // article-lengths down and it's gone, right when a lost player wants it
  // most. Target now also gets a compact chip in the STICKY `.race-hud`
  // (below), reusing this same targetTitle/useTargetPreview state - see
  // that chip's own comment for why the popover moved out from under
  // `.target-reference`'s old `<details>` markup.
  const targetTitle = session?.challenge.target.title ?? "Target";
  const readyTargetPreview = targetPreview.status === "ready" ? targetPreview : null;
  const [isTargetOpen, setIsTargetOpen] = useState(false);

  return (
    <section className="race-mode">
      <header className="race-hud">
        <div className="race-hud-status">
          {pendingNavigationTitle ? (
            <strong className="header-navigation-status" role="status">
              {navigationRetrying ? "Still loading..." : `Opening ${pendingNavigationTitle}...`}
            </strong>
          ) : null}
        </div>
        {session ? (
          // RC-1: Run and Target now share this one flex row as siblings
          // (not two grid areas) so they always stay on a single line - the
          // scroll-margin-top regression guard below depends on race-hud
          // never growing a second row at any width. PKG-02's original
          // single "Run" chip is untouched (App.test.tsx keys off
          // `getByLabelText(/current run/i)` unmodified). HD-1: this row's
          // own `justify-content: space-between` (styles.css) is what now
          // pins Run flush left / Target flush right in the single-row HUD -
          // no DOM change from RC-1, CSS only.
          <div className="race-hud-metrics">
            <dl className="run-metrics" aria-label="Current run">
              <div>
                <dt>Run</dt>
                <dd>{formatTimeAndClicks(elapsedMs, session.clicks)}</dd>
              </div>
            </dl>
            <button
              aria-expanded={isTargetOpen}
              aria-label={`Target: ${targetTitle}`}
              className="target-chip"
              type="button"
              onClick={() => setIsTargetOpen((open) => !open)}
            >
              <small>Target</small>
              <strong title={targetTitle}>{truncateTitle(targetTitle)}</strong>
              <span aria-hidden="true">{isTargetOpen ? "–" : "+"}</span>
            </button>
          </div>
        ) : null}

        {session && isTargetOpen ? (
          // RC-1: a plain child of `.race-hud` (not a wrapping sibling div)
          // is deliberate - an earlier version of this wrapped `.race-hud`
          // in its own parent so this popover could sit outside race-hud's
          // clip-path, but that wrapper's box was exactly race-hud's own
          // height (the popover is `position: absolute`, contributing none
          // of its own), leaving `position: sticky` no room in its
          // containing block to stick through the page - it just scrolled
          // away like a static element. Fixed instead by moving race-hud's
          // notched-corner chrome (border/background/backdrop-filter/
          // clip-path) onto a `.race-hud::before` pseudo-element in
          // styles.css, so `.race-hud` itself carries no clip-path and this
          // popover (an ordinary absolutely-positioned child of it) is free
          // to render past its bottom edge uncropped - while `.race-hud`
          // keeps its original, unwrapped parentage under `.race-mode` and
          // its original sticky behavior.
          <p className="target-preview-popover">
            {readyTargetPreview?.preview.blurb ??
              "The target preview was not ready when this run began."}
          </p>
        ) : null}
      </header>

      {session ? (
        // HD-1: End Run now renders here, not in `.race-hud` - see PathStrip's
        // own HD-1 comment below for why this is still "always reachable
        // during an active run" despite living in a plain (non-sticky) strip.
        <PathStrip
          titles={visiblePath}
          endRunDisabled={endRunDisabled}
          onRequestEndRun={onRequestEndRun}
        />
      ) : null}

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
          navigationRetrying={navigationRetrying}
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
  navigationRetrying,
}: {
  article: Article;
  acceptedPageId: number | undefined;
  challengeLabel: string;
  redirectedFrom?: string | null;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  pendingNavigationTitle: string | null;
  // MB-1 Part 2: see RaceMode's own doc comment on the field of the same
  // name. RaceResults' frozen-article render always passes false - a
  // retrospective summary never has a navigation (let alone a retry) in
  // flight.
  navigationRetrying: boolean;
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
          {navigationRetrying ? "Still loading..." : "Loading next article..."}
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

// RC-1 (owner-proxy ruling): this used to also carry a "Target ▾" disclosure
// cell (`.target-reference`) alongside the breadcrumb - that's what moved
// into the sticky `.race-hud` above, reusing the same useTargetPreview state
// (see RaceMode's own RC-1 comment for the popover-clipping detail that
// drove HOW it moved). Owner wants ONE obvious place for the target, not two
// - so rather than duplicate it here too, this strip goes back to exactly
// what it already computed as "visited": `titles` minus its trailing target
// entry, purely a path trail.
//
// HD-1 (owner report): End Run now renders here too, right-aligned against
// the breadcrumb ("the end run can be in the line with the path?") - the
// same `.end-run-button` coral hook as before, just visually compact
// (styles.css `.path-strip .end-run-button`) to fit this shorter row, still
// >=44px tall. Both props are required (not optional): RaceMode's only
// caller always passes them whenever `session` is set (i.e. whenever a run
// is genuinely active - PathStrip only ever mounts under that same gate), so
// there is no live code path where a run is active and this strip renders
// without an End Run affordance. It scrolls away with the rest of the strip
// - INTENTIONAL, owner-accepted: the player can always scroll back up to
// reach it; the always-visible sticky `.race-hud` above deliberately does
// NOT duplicate it (owner: "just the timer, click count and the [target]
// peek"). RaceRecoveryInterstitial's own "End Old Run" is a separate,
// untouched control for the pre-active recovery gate, not this strip.
export function PathStrip({
  titles,
  endRunDisabled,
  onRequestEndRun,
}: {
  titles: string[];
  endRunDisabled: boolean;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
}) {
  const visitedTitles = titles.slice(0, -1);
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
      <button
        className="end-run-button"
        disabled={endRunDisabled}
        type="button"
        onClick={onRequestEndRun}
      >
        End Run
      </button>
    </nav>
  );
}
