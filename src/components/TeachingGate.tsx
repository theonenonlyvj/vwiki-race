import { useRef, useState, type RefObject } from "react";
import type { Challenge } from "../domain/types";
import ModalDialog from "./ModalDialog";

/**
 * First-visit teaching gate (UX redesign spec, Home §First-visit teaching
 * gate). App-shell level, not Home-specific - mounted by AppShell wherever
 * the account has zero completed races (see shouldShowTeachingGate),
 * whichever of Home/Challenge Detail it's currently showing. The
 * parenthetical opens a quick-dismiss popup reusing the app's existing
 * dialog pattern (ModalDialog - the same shell the identity/End Run dialogs
 * use).
 *
 * PKG-06 (council 2026-07-19, owner-proxy ruling): the spec's exact one-
 * liner + popup copy is what ships - NOT the numbered 3-step strip an
 * earlier, superseded exploratory mockup proposed; that would silently
 * un-ratify a documented simplification (the spec cuts the rivalry strip
 * the same way) rather than execute one. The account reassurance was later
 * removed to keep this strip focused on gameplay.
 */
export default function TeachingGate({ pairChallenge }: { pairChallenge: Challenge | null }) {
  const [popupOpen, setPopupOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <p className="teaching-gate-strip muted" role="note">
        Two articles. Links only. Beat the clock.{" "}
        <button
          className="link-button"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setPopupOpen(true);
          }}
          type="button"
        >
          (how to play)
        </button>
      </p>

      {popupOpen ? (
        <TeachingGatePopup
          pairChallenge={pairChallenge}
          onClose={() => setPopupOpen(false)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  );
}

/**
 * QF-05: exported so a permanent "How to play" link (AppShell's footer -
 * the rules otherwise vanish for good once `shouldShowTeachingGate` stops
 * showing the strip above, after an account's first completed race) can
 * reuse this exact popup rather than forking a second copy of the rules.
 */
export function TeachingGatePopup({
  pairChallenge,
  onClose,
  returnFocusRef,
}: {
  pairChallenge: Challenge | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <ModalDialog
      // Keep rules separate from the identity form; the body scrolls while
      // the heading and close control remain available.
      className="teaching-gate-dialog"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      titleId="teaching-gate-title"
    >
      <div className="identity-dialog-heading">
        <h2 id="teaching-gate-title">How to play</h2>
        <button
          aria-label="Close how to play"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          x
        </button>
      </div>

      <div className="rules-content" role="region" aria-label="Game rules" tabIndex={0}>
        <section>
          <h3>The goal</h3>
          {pairChallenge ? (
            <p>Get from <strong>{pairChallenge.start.title}</strong> to{" "}
              <strong>{pairChallenge.target.title}</strong> by following article links.</p>
          ) : <p>Get from the start article to the target by following article links.</p>}
          <p>Preview the target before you start. Browsing and previews do not start the clock.
            Choose Start race when you are ready. You finish when you click through to the target;
            spotting its name on a page is not enough. A link that redirects to the target counts.</p>
        </section>
        <section>
          <h3>Allowed moves</h3>
          <p>Use the clickable Wikipedia article links shown inside the game: the lead, main text,
            infoboxes, and tables or lists within the article. Each accepted article-to-article
            move adds a click, including a redirect.</p>
          <p>No search, browser Back or Forward, or typing a different article address.
            You may revisit an article only by following a valid link from your current page.</p>
          <p>External links, categories, language links, files, citations, navigation boxes,
            and the See also, References, Further reading, and External links sections are
            outside the playable surface. Jumping to a heading within your current article
            does not count as a move.</p>
        </section>
        <section>
          <h3>Time and ranking</h3>
          <p>Fastest time wins; fewest clicks breaks ties. If both match, the earlier accepted
            finish ranks first. The challenge board uses your best eligible finish. Players can
            start at different times.</p>
          <p>The clock measures time spent choosing your next link. It starts when the start
            article is ready and pauses while a move is processed. Loading and saving moves
            do not count. The next article resumes the clock; reaching the target stops it.</p>
        </section>
        <section>
          <h3>Fair play</h3>
          <p>Fair play uses the honor system. Find the route yourself. During a run, do not
            use browser Find, search engines,
            other Wikipedia tabs, outside help, AI hints, scripts, or developer tools.
            Do not edit Wikipedia to create a shortcut. Opening a source article in another tab
            does not count as a race move or pause your clock.</p>
        </section>
        <section>
          <h3>Ending a run</h3>
          <p>Stuck at a dead end? There is no free jump or backtrack. Keep looking for a valid
            link, or choose End Run. An ended run is a DNF (did not finish) and cannot be resumed.
            Try again starts a fresh attempt with a new clock. If you end before making two
            accepted clicks, it does not count as an attempt or appear on the board.</p>
          <p>If you reload, the game can recover a still-active run from its last saved move.
            A failed move adds no accepted click. You can retry a challenge and compare your
            attempts in your history.</p>
        </section>
        <section>
          <h3>Dailies and results</h3>
          <p>The daily is scheduled for 5:00 AM Central. Recognizable picks run Monday through
            Friday, with Hard picks on weekends. You can also play older challenges or create
            a start-and-target pair to share.</p>
          <p>Rankings, names, and your own times and clicks remain visible before you finish. Other players'
            times, clicks, and routes unlock when you finish the challenge.
            After an eligible unfinished attempt, you can instead choose Show me the answers and confirm to reveal
            the solution and routes. That choice makes your future runs on that challenge unranked. Log in to keep your history across devices, or
            choose Guest and secure that guest account later to keep its history.</p>
        </section>
      </div>
    </ModalDialog>
  );
}
