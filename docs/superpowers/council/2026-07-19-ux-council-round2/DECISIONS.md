# Owner decisions — 2026-07-19 (Vijay, verbatim-condensed)

| # | Question | Decision |
|---|----------|----------|
| — | Brand lockup | RESTORE the coral kicker above "VWiki Race", but reading **VGames** (family brand) |
| 1 | First-time identity default | **Guest-first** for everyone ("b is fine, easy") |
| 2 | clk vs clicks | Don't care → **keep "clk"** (spec unchanged, zero churn) |
| 3 | Daily pool quality | "do whatever" → **recognizable pool = Vital 1–2**; hard keeps full breadth |
| 4 | Challenge #6 gap | **Leave gaps silently**; retiring old challenges (e.g. #1) is fine later, not yet |
| 5 | Desktop two-column Home | **Yes, but quality bar high** — mockup + sign-off before build |
| 6 | Wikipedia edge-proxy | Down, but wary of infra sprawl → scope LEAN (one worker route + edge cache, no new services) |
| 7 | Leaderboard integrity project | **Yes** |
| 8 | Rivalry slice | **DEFER** — only with a clean answer to "who gets highlighted" |
| 9 | Share artifact | Emoji-grid share text, "whatever is sexy"; keep small |
| 10 | Path comparison | **Yes** |
| 11 | Reks/sgattu merge | **Later** |
| 12 | viota 9e64e9a push | Approved (turned out already pushed) |
| D | Defaults batch | Accepted: DNF salmon, roster by races, keyboard-racing deferred, private-browsing notice YES, roster-privacy deferred |
| FB-7 | Sub-2-click DNFs | **Non-attempts everywhere** (owner: "those dont really even count"): hidden from all boards, don't tick played/streak/guard/You-tiles. Exceptions: own Results page after ending, "Your history" per-attempt list, roster racesStarted census. Amends the round-1 "DNF counts as played" ruling for clicks < 2. |
| FB-8/9/10 (07-20) | Body de-bold; Browse played-chips + reverse-chron; Stats windows | Body text ≤500/400 (chrome keeps weight). Browse: chip gate fixed (was rendering premature NEW while outcomes loaded), catalog newest-first, daily pinned. **Stats 7d/30d/Lifetime aggregate ALL challenges** (window = challenge creation date, active-only denominators, FB-7 threshold); streak stays daily-only. |
| GR-1/AC-1/PV-1/LK-1 (07-21) | Graph modal, Honest You, preview, redirects | Path graph SHIPPED as "View graph" modal (finisher-gated endpoint, best-run-per-player). "Honest You" SHIPPED: 3 session states, Log out (claimed, this-device copy), ghost-loss guards on every escape path (waiver scoped per-flow after review), amber at-risk You-dot, cross-game line. Preview blurb = first PROSE paragraph (sidebar/hatnote fragments skipped); desktop preview card composed at 680px. "(redirected from X)" under article heading — root cause of the friend's "wrong link" report (54% of clicks resolve through redirects). |
| URL policy + Back ladder + graph fix (07-21) | Routing council (5 lenses, 0 open questions) | **?challenge= is Detail's address, iff-invariant**: entry-intent honored forever (old links never break), self-sync killed, nav taps clear, expired links degrade to Home, plain-Home refresh stable, modes stay URL-less. **In-app Back ladder** via history-state DEPTH counter (Detail→Browse→Home→exit; review caught the boolean-marker poisoning + silent-press accumulation, fixed). **Graph modal fix**: leaderboard-panel clip-path created a stacking context trapping the fixed backdrop's z-index — portaled to body (opt-in ModalDialog prop); canvas height now lane-count-driven. |
| Runtime cycle (07-23/24) | Runtime teardown: tracer + 8 lenses → 10 packages RC-01..10, ALL SHIPPED | Flagship: **recovery was dead since 07-17** (8a4835f0 added click_count>=2 to findActiveRun — every mid-race reload silently ate the run); predicate removed, journey-8 re-trace PROVES silent resume. Catalog gate now has Retry (dead-end impossible). Today's board = 6 finishers + link. Structural: screen selector, shared read-cache (j2 churn 28→12 req, 11→0 dupes), stale-while-revalidate (live UI never blanks), tri-state loading/error system, click-promise + transition + mobile polish. 1110 client + 226 worker tests. |
| 08-02 owner answers | Ranking/Y/paths/login | **Beat-rate APPROVED** (building). **Y = deliberate future project** — "we have more data, be intentional": re-simulate with the larger dataset inside the integrity cycle, no ad-hoc ratification. **Path unlock = finish-or-give-up ONLY** (no day-end auto-unlock; owner wants late players still competing on old dailies). Login post-same-origin: "mostly, rare hiccup" — residual telemetry (client-error beacons + vgames_identity_call logs, CF dash) names any future stall; no action unless it recurs. |
