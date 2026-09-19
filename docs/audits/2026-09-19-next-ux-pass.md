---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: unimplemented UX recommendations in the August handoff where live UI differs
---
# Next UX pass: returning players and discovery

Owner requested further UX/UI improvements after the remembered-login release. This is a proposal, not shipped functionality. Reviewed live Home and Challenges and current Home, Browse, BoardSnippet and You source. Player identity audit stays in ignored local-only files; no individual account data belongs in this proposal.

Recommended focused pass:

1. Help guests keep one identity: after a meaningful first finish, offer a small nonblocking “Keep your name and stats” invitation with existing-account login and account creation clearly distinct. Before creating another identity, explain that an existing VGames login brings history back. Never auto-link accounts by name. Remembered sessions just shipped; measure future fragmentation rather than claiming this alone repairs all lost-device cases.
2. Past dailies: a date-based filter/archive, played/unfinished/unplayed states, and direct board/path access when already unlocked. Existing Challenges has daily date badges, but still presents a single large mixed catalog and no dedicated date navigation. Existing dailyDate and viewer challenge-outcome data support this without a new identity system.
3. Explain hidden results once instead of columns of dashes. Retain finish-or-give-up spoiler rules. Live Home recap still shows DNF plus a bare dash; distinguish “did not finish” from a hidden valid score. Browse currently renders “best time / clicks” for unplayed challenges: reconcile that disclosure with the existing intended spoiler rule before redesigning the cards.
4. Move Create challenge into a clear secondary action rather than putting its fields beneath the full challenge list. Keep today’s race the main CTA. No new top-level navigation item needed.
5. Make finishing satisfying: emphasize the saved result and existing Share/Challenge a friend affordance, then offer another race. Avoid inventing rankings or social claims; respect reduced-motion preference for any animation.

Alternatives: cosmetic-only styling is smaller but leaves identity and navigation friction; a full redesign is unnecessary and risks disrupting the daily ritual. Recommend the focused pass above, with identity continuity and archive navigation first.

No code or production data changed. Implementation requires agreement on the proposed behavior; the user has not yet selected this next pass. Account consolidation requires confirmed ownership, truthful agent audit attribution, preserved run history and merge reconciliation across shared identity and game data.
