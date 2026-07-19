# Proposal: Desktop composition beyond scale-up (PKG-09b)

Date: 2026-07-19 · Status: PROPOSED, not built · Split off PKG-09's Stage 2 per
the PKG-09 owner-proxy ruling (`docs/superpowers/council/2026-07-19-ux-council/PKG-09.md`)

## Open spec question first

`docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md` line 23 states
the design's own north-star priority order: "mobile-first (thumb-reach,
full-height screens; **desktop is a scale-up**)." Every mockup in
`council-shots/` (mockup-home-stateful-v2, mockup-boards-trends,
mockup-browse-detail, etc.) is a ~780px-wide phone-frame composite — there is
no ratified desktop composition anywhere in the mockup set.

**Before any work here starts, the question is: should that line be amended?**
Real multi-column desktop layouts (content-left + rail-right, 2-up card
grids) are a reversal of "desktop is a scale-up," not an extension of it. This
proposal does not answer that question — it exists to make the choice
explicit rather than let a P1/L ticket quietly re-decide it as a side effect
of a "layout pass" bug-fix package.

## What prompted this

PKG-09's original brief (Stage 2) asked for real ≥880px compositions per
mode — Home/You as content-left + rail-right (~60/40: board/streak peek
beside the hero; stats beside top-starts/targets), Challenges as a 2-up card
grid — instead of the current single ~820px centered column that every mode
scales up to today. The owner's actual complaint that motivated PKG-09
(buttons/CTAs not docking consistently across screens) is fully addressed by
PKG-09's Stage 1 (shipped separately, same day) and does not require this.

Both council judges on PKG-09 independently flagged the same tension:
Stage 2 is legitimate-looking desktop-UX work, but it contradicts a
council-ratified document rather than fixing a diagnosed bug, and no mockup
or explicit owner ask backs the specific "rail" composition proposed.

## If the line is amended and this proceeds

Suggested shape, unchanged from the original Stage 1 write-up, in case it's
useful as a starting point once (or if) the spec question is resolved:

- **Home / You**: content-left + rail-right (~60/40) — board/streak peek
  beside the hero on Home; stats beside top-starts/targets on You.
- **Challenges (Browse)**: a 2-up card grid instead of a single scaled-up
  column.
- Boards and Challenge Detail were not part of the original Stage 2 ask
  (they're single-focus screens — leaderboard, detail — where a second
  column has less obvious content to fill) and would need their own design
  pass, not a mechanical copy of the Home/You pattern.

## Precondition before opening real implementation work

Per both judges: a one-screenshot owner sign-off on Home's new composition
specifically (not a verbal go-ahead) before rolling any rail/grid pattern to
other modes — and per Judge B, that sign-off should take the form of a short
spec addendum to the 2026-07-18 design doc (amending or annotating line 23),
not just an informal screenshot approval, so the spec stays the single source
of truth instead of drifting out of sync with what actually ships.

## Non-goals for this proposal

- This document does not implement anything.
- This document does not amend the spec itself — that's a decision for
  Vijay, informed by this write-up.
- PKG-09's Stage 1 (footer anchor, shared `.route-header` CTA docking,
  stat-grid fix, Browse search cap) already shipped independently and does
  not depend on this proposal in any way.
