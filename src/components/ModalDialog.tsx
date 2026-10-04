import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/**
 * The app's one shared dialog shell (focus trap, Escape-to-close, scroll
 * lock, return-focus-on-close) - originally private to App.tsx (the identity
 * prompt, End Run confirm), now extracted so other app-shell-level dialogs
 * (the teaching gate's "how to play" popup - UX redesign spec) reuse the
 * exact same pattern instead of re-implementing focus management.
 *
 * GX-1: `portal` (opt-in, default off) renders `.modal-backdrop` straight
 * into `document.body` instead of inline wherever the trigger happens to
 * live. Every call site relies on `position: fixed` + a high z-index alone
 * to "escape" into a full-viewport overlay - which works ONLY when no
 * ancestor between the trigger and <body> creates its own stacking context.
 * `ChallengePathGraphButton` (the graph modal) is mounted inside
 * `.leaderboard-panel`/`.board-snippet`'s panel ancestors (styles.css),
 * which carry a `clip-path` - and `clip-path: <not none>` creates a new
 * stacking context per spec, same family as transform/filter/opacity/
 * isolation. That doesn't change `.modal-backdrop`'s CONTAINING BLOCK (it's
 * still `position: fixed` against the viewport - confirmed with
 * getBoundingClientRect during diagnosis, the box geometry was correct),
 * but it DOES trap the backdrop's z-index INSIDE the panel's local stacking
 * order: the backdrop can only out-rank its OWN preceding siblings within
 * that panel, and loses outright to any later sibling elsewhere on the page
 * (e.g. Challenge Detail's "Your history" panel right below it), which
 * paints over it in normal DOM order regardless of the backdrop's
 * z-index: 80. Portaling to `document.body` makes `.modal-backdrop` a
 * direct child of body - the same level every other top-level stacking
 * context on the page competes at - so its z-index finally applies
 * globally, the way this call site already assumed it did.
 *
 * Default stays inline (no portal): the identity/End Run/teaching-gate/
 * ghost-guard dialogs aren't nested inside any clip-path'd (or otherwise
 * stacking-context-forming) ancestor today, and PKG-12's inert-siblings
 * effect below deliberately keys off `.modal-backdrop`'s OWN DOM parent so
 * it can generically background whichever app-shell-vs-RaceFlow siblings
 * are actually mounted - portaling every dialog to `<body>` would collapse
 * that down to a single `#root` sibling and break the specific
 * `.shell-topbar`/`.content-shell`/`.site-footer`/`.race-takeover`
 * assertions those dialogs' own tests already lock in. Scoping the portal
 * to an opt-in prop fixes the one call site that actually needs it without
 * touching that contract.
 */
export default function ModalDialog({
  backdropClassName,
  busy = false,
  children,
  className,
  onClose,
  portal = false,
  returnFocusRef,
  titleId,
}: {
  backdropClassName?: string;
  busy?: boolean;
  children: ReactNode;
  className: string;
  onClose: () => void;
  portal?: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  titleId: string;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const focusCycle = useRef(0);

  useEffect(() => {
    const cycle = ++focusCycle.current;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement && dialogRef.current?.contains(activeElement))) {
      const first = focusableElements(dialogRef.current)[0];
      (first ?? dialogRef.current)?.focus();
    }
    return () => {
      queueMicrotask(() => {
        if (focusCycle.current !== cycle || !returnFocusRef.current?.isConnected) return;
        // RC-10 (change 5 fallout): a dialog can be replaced by a DIFFERENT
        // ModalDialog sharing the same trigger/returnFocusRef instead of
        // genuinely closing - e.g. "Play as someone else"'s ghost-guard
        // dialog handing straight off to the identity sheet on "Start fresh
        // anyway"/Cancel. That's a real unmount+mount of two distinct
        // ModalDialog instances, so THIS instance's own cleanup still runs
        // and (deferred to a microtask, same as always) would otherwise
        // steal focus back to the trigger button a tick after the NEW
        // dialog has already put real focus on its own first field -
        // clobbering it. Only return focus to the trigger when nothing else
        // has legitimately claimed it in the meantime (the common case: the
        // dialog fully closed and focus fell back to the trigger/body).
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest('[role="dialog"]')) return;
        returnFocusRef.current.focus();
      });
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // PKG-12 (council 2026-07-19, Judge B): inert every sibling of this
  // dialog's own backdrop, generically - not a named list of app-shell
  // classes (`.shell-topbar`/`.content-shell`/`.site-footer`), because
  // those only exist while AppShell is mounted. Both real call sites can
  // also open while RaceFlow is mounted instead (End Run mid-race, the
  // identity dialog from RaceResults' "Claim your spot"), where the
  // sibling is a single `.race-takeover` div - a literal named-class list
  // would be a no-op for exactly the dialog that most needs backgrounding.
  // Walking `.modal-backdrop`'s own DOM siblings covers every mount point
  // through one shared parent, so a virtual-cursor AT can't wander into
  // nav/footer/the frozen race behind the dialog.
  useEffect(() => {
    const backdrop = backdropRef.current;
    const parent = backdrop?.parentElement;
    if (!backdrop || !parent) return;
    // `setAttribute`/`removeAttribute`, not the `.inert` IDL property - the
    // attribute is what real browsers key inert-ness off (the property is
    // just a reflection of it), and it's the only one jsdom's own test
    // environment actually implements here.
    const inerted: HTMLElement[] = [];
    for (const sibling of parent.children) {
      if (sibling === backdrop || !(sibling instanceof HTMLElement) || sibling.hasAttribute("inert")) {
        continue;
      }
      sibling.setAttribute("inert", "");
      inerted.push(sibling);
    }
    return () => {
      for (const sibling of inerted) {
        sibling.removeAttribute("inert");
      }
    };
  }, []);

  function close() {
    if (busy) return;
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    // MB-1 Part 3 (old-Safari compat): Array.prototype.at is Safari 15.4+;
    // this file's floor is ~14-15. Plain index arithmetic is identical here
    // (focusable.length is already checked > 0 above) and works everywhere.
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const dialog = (
    <div className={backdropClassName ? `modal-backdrop ${backdropClassName}` : "modal-backdrop"} ref={backdropRef} role="presentation">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={className}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );

  return portal ? createPortal(dialog, document.body) : dialog;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  ));
}
