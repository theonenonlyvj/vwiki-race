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
 * the same way) rather than execute one. The one real, verified gap was the
 * missing reassurance footer line the spec calls for right under the strip.
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
        <br />
        No account needed to look around.
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
      // PKG-12 (council 2026-07-19, judge A/owner-proxy): this used to also
      // carry `identity-dialog` so it could borrow that class's box styling
      // - but `.modal-backdrop:has(.identity-dialog)` (styles.css) is an
      // iOS-keyboard-bug fix scoped to the real "Save your stats" dialog,
      // and matching it here top-anchored this 3-line quick-dismiss popup
      // with a half-viewport dead zone below it on mobile (mockup-02-howto
      // vs mobile-02-howto). `.teaching-gate-dialog` now has its own,
      // lighter rules (styles.css, modeled on `.recovery-notice`) instead
      // of wearing the signup-form dialog's full chrome.
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

      {pairChallenge ? (
        <p>
          e.g. get from <strong>{pairChallenge.start.title}</strong> to{" "}
          <strong>{pairChallenge.target.title}</strong>.
        </p>
      ) : null}
      <p>Only links inside the article count — no search, no back button cheese.</p>
      <p>Fastest time wins; fewest clicks breaks ties.</p>
      {/* PKG-07 (council 2026-07-19, owner-proxy ruling (b)): the popup
          never established cadence at all - a first-time reader had no way
          to learn there even IS a daily rhythm to keep up with, distinct
          from the already-shipped Results-screen ritual hook (RaceResults'
          "Day 1 · New daily drops 5:00 AM — come defend your spot", a
          first-finish-only trigger, not persistent teaching copy). */}
      <p>A new pair drops every day at 5:00 AM Central — keep your streak alive.</p>
      {/* QF-05: the flavor badge ("Recognizable"/"Weird"/"Hard") shows up
          everywhere a daily does (Home, Boards, Browse, Preview, in-race/
          Results kicker) with zero explanation of what it means until now -
          wording matches `dailyFlavorLabel`'s actual output
          (domain/dailyEditorial.ts), not a synonym. */}
      <p>Recognizable picks Monday–Friday, Hard weekends — the badge tells you which.</p>
    </ModalDialog>
  );
}
