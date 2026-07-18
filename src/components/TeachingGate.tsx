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

function TeachingGatePopup({
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
      className="identity-dialog teaching-gate-dialog"
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
    </ModalDialog>
  );
}
