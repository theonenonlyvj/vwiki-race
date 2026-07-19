# 2026-07-19 UX Council ROUND 2 — fresh-lens review of the shipped rebuild

15 mostly-new lenses (motion, typography, color theory, performance, retention, social dynamics, IA, edge-case QA, content curation, non-gamer usability, power user, cold critic, spec-fidelity anchor, brand, onboarding) on fresh prod screenshots after the round-1 ship. 102 findings -> 10 quickfix packages (ALL BUILT + SHIPPED same day, briefs in this directory with judge amendments + binding rulings) + a 12-item owner-decision backlog + 8 deliberate drops.

## Synthesizer verdict (verbatim)

Round 2 confirms the redesign was worth shipping: the brand/button system, Fredoka, the Wordle-style mode IA, and daily numbering now read as one designed product, and most round-1 P0s are genuinely dead. But through fresh eyes it does not yet clear the "would a stranger come back tomorrow" bar, for three compounding reasons. First, the worst funnel bug in the app survived both rounds: the identity gate defaults to a username+password Create-account form on every race start, forever, for guests — a P0 that contradicts Home's own "no account needed" promise and is even test-locked as intended behavior. Second, the drop-boundary state every player crosses daily reads unattended: "Today" showing a card titled "YESTERDAY'S DAILY," the same puzzle listed twice on Challenges, and a focused tab that never self-heals past 5 AM. Third, the daily's identity fractures the moment you leave Home — the same puzzle is "Daily #4," "Daily 7/18," and "Challenge #8" on adjacent screens, so the one portable number the ritual depends on never survives contact with actually playing it. Below those, the misses are consistent but shallow: color semantics leak (DNF rendered in go-teal, the actual Confirm End Run button not coral, coral burned on every Browse card), the You tab is ten stacked "No data yet." strings, and zero asset caching plus a full 1MB+ Wikipedia download per mid-race click quietly tax the core loop. The encouraging part is that nearly all of this is S/M copy, CSS, or one-line logic — the ten packages below are a realistic weekend and should move the build from "polished dev build" to "confident daily." One process flag: PKG-05's Results screen has zero round-2 evidence (the capture stopped at the End-Run confirm dialog), so re-shoot through a real finish AND a real DNF before calling that flagship package verified. After the quickfixes, the retention question shifts from polish to substance: content-pool quality behind the flavor badges, a share artifact worth posting, and the rivalry layer are what actually earn the return visit at friend-scale. Grade: solid B for craft, still C+ as a habit — the gap is closable this weekend.

## Owner-decision backlog

### Edge-proxy + pre-sanitized Wikipedia articles (and route-level code splitting)
Every mid-race click downloads a 0.9-1.5MB raw article (200-270KB on the wire) and sanitizes it synchronously on the main thread — this IS the core loop's latency, and it's multiple dead seconds per hop on slow mobile. All players walk the same daily graph, so a Worker-proxied, edge-cached, server-side-sanitized payload serves everyone after the first fetch and kills the client parse cost too. Separately, one 329KB bundle serves both a 10-second board check and a full race.

**Decision needed:** Green-light the L infra cycle: worker proxy route + edge cache keyed on (title, revisionId) with sanitizeWikipediaArticleHtml moved server-side, then React.lazy boundaries for RaceFlow/Boards — and approve a minimal Suspense fallback that fits the chrome-free takeover.

### Daily content quality: the pools behind the badges
'Recognizable' is ~99% Vital-Level-3 (vital ≠ famous — see 7/15's Hilda Lizarazu → an obscure Scottish peer), starts are raw random Wikipedia (Tappeh Lori, Ravansar), 'Hard' is just a no-2-click filter over the same pool, and Hard lands Sat+Sun back-to-back while Weird never touches the weekend. The badges promise a curated calendar the pipeline can't reliably keep — the highest-frequency content-trust risk in the game.

**Decision needed:** Pick the recognizable-pool strategy (restrict to Vital L1-2 vs reweight the level bonus vs pageview floor); decide whether starts get a familiarity floor or a curated pool; keep or reshuffle the double-Hard weekend.

### Path comparison inside the daily flow
Finishing today's daily routes 'View leaderboard' to Boards, which by this increment's explicit design carries no runId or path disclosure — so 'how did #1 do it in 3 clicks?' has no answer without leaving the ritual flow, even though Challenge Detail's LeaderboardList already ships 'View winning path'. This is the single most natural post-race curiosity and the best retry trigger.

**Decision needed:** Revisit Boards' deliberate no-path scoping: thread runId + the existing disclosure affordance into BoardSnippet, or reroute post-daily View-leaderboard to Challenge Detail like every non-daily already does.

### Desktop Home Stage 2 + modal/loading composition
PKG-09 Stage 2 (two-column 1440px Home) never shipped — desktop Home is still one centered column over ~35% black void, short of PKG-09's own acceptance bar and correctly gated on your sign-off. Mobile modals leave 40-70% dead backdrop, and the pre-race preview can strand on a bare 'Loading target preview…' string on the last screen before the clock.

**Decision needed:** Sign off a two-column composition from one mockup (content-left + board-rail-right ~60/40); approve content-hugging bottom-sheet sizing for dialogs and a skeleton for the target preview.

### Rivalry + personal-progress layer
At 5 named friends the sharpest hooks are 'You beat Reks by 0:04' on Results, a PB delta ('New best! −0:06'), 'Your best: 0:38 · 5 clicks' on Preview, and a deeper own-row drilldown (currently hard-capped at 3 dailies) — the board data is mostly already fetched, and this aligns with the ratified VGames-wide rivalry build-out. Bridge-pages/common-jumps analytics are fully computed dead code with no data source.

**Decision needed:** Green-light the minimal slice first (one-line head-to-head + a per-challenge my-best field in the board response); decide whether bridge-pages/common-jumps gets rebuilt server-side or deleted.

### Retention infrastructure: share artifact + installability
The share line is well-composed but visually inert — nothing pattern-matches like Wordle's grid, so shares don't catch a scrolling eye, and every share matters at ~5 players. Beyond that, the comeback loop is 100% player memory: no PWA manifest, no opt-in drop-time reminder.

**Decision needed:** Pick the first bet: emoji-glyph/generated-image share artifact, PWA manifest for home-screen install, or a single opt-in web-push at drop time.

### Small-community visibility & privacy defaults
The 'everyone who's played' roster sorts races-then-wins, rendering a de facto skill ranking that puts a named friend (vinay, 0 finishes) visibly last; full win/loss history is public to anonymous visitors under a permanent cross-VGames handle with no opt-out; 'Not yet ranked' names one friend's partial progress on three tabs. Harmless today, but these defaults harden as the circle grows.

**Decision needed:** Choose roster sort (alphabetical or recent-activity), whether to add a per-account 'visible on boards' toggle before VGames scales, and whether unranked callouts aggregate ('1 racer is close') instead of naming.

### First-race identity weight + VGames brand framing
Even after QF-01, a first-timer's gate is a full account-management dialog pitching 'every VGames title' before they've seen one article; 'More VGames' links to a personal bio site titled 'theonenonlyvj'; and guests are never told their stats/streak are device-local until they lose them. The account moments that fire AFTER a run (Results/You claim CTAs) are already well-scoped — the pre-run one isn't.

**Decision needed:** Approve a slim fresh-visitor gate (name field + Race, full pitch deferred to post-run claim moments); decide where/how the VGames umbrella gets introduced and what 'More VGames' should actually point at; approve one honest 'guest stats live on this device only' line.

### Keyboard-parity link finder in race
Ctrl/Cmd+F is deliberately blocked mid-race (sound anti-cheat call) with no substitute, so a keyboard-only player faces sequential Tab through 100-300 links per article — structurally unable to compete on time. Real accessibility gap, but the remedy shapes competitive fairness.

**Decision needed:** Decide how much assistance is fair — type-to-filter scoped to the article's outbound race links vs arrow-key link cycling — then scope the build.

### Design-token + transition-system pass
Two unreconciled teals (#18e3cf token vs hand-typed #0debd7 in ~6 rules), four different DNF colors, full-saturation --cyan on 26 rules from the Race CTA down to footer links, no eyebrow/heading-scale tokens, near-indistinguishable ink steps, and zero screen-to-screen motion (mode nav and Start-race are hard cuts). The copy-paste drift round 1 flagged systemically is still accreting; QF-04/07/08 patch the worst instances but not the system.

**Decision needed:** Pick DNF's one meaning (coral-alarm vs grey-neutral) so all four renderers converge on one token; schedule the token consolidation pass; choose the transition direction (View Transitions API vs a shared crossfade wrapper).

### Archive trust: the Challenge #6 gap and numbering permanence
The public catalog runs #1-#5, #7, #8 — a successfully-assigned number that later vanished (deactivated, not a failed insert). Wordle-style numbered archives lean on stable numbers for legitimacy; a silent hole reads as data loss to any attentive player.

**Decision needed:** Confirm what actually happened to #6, then choose: placeholder rows ('Challenge #6 — no longer available') vs dropping the sequential framing for aged-out entries.

### Private-browsing / blocked-storage disclosure
In Safari private mode a mid-race reload silently drops the run AND the guest identity — no recovery interstitial, no error, indistinguishable from data loss. readBrowserStorage already detects the condition; only the UX is missing.

**Decision needed:** Approve a one-time dismissible notice ('Your browser is blocking storage — progress won't survive a reload') for storage-blocked sessions, and its copy.

## Deliberately dropped

- **Race HUD timer ghost + the not-yet-dropped 07-19 daily (as existence findings)** — Both are explicitly in-flight fixes per the brief; only the presentation of the boundary state was judged (carried into QF-06). Several lenses correctly avoided them; the few grazing mentions were folded out.
- **'flow-05-results.png is mislabeled' as a standalone finding** — It's an evidence gap, not a product defect. The consequence that matters — PKG-05's Results rework has zero round-2 verification — is called out in the verdict and the re-capture is baked into QF-04's acceptance criteria rather than carried as a bug.
- **'#4 means two things' (daily number vs leaderboard rank)** — A coordinated change across the shared badge formatter, the Results rank line, and copy-locked tests, for confusion no lens could evidence in a real player — the rank line already carries disambiguating words ('#1 today'). Revisit only if actual players report misreading it.
- **Restyling the Guest/Create/Log-in three-button mode switch** — Superseded: QF-01 makes Guest the default and the backlog's slim-gate decision may remove the tab strip from the first-race moment entirely. Polishing a control that's likely to be redesigned is wasted motion.
- **Path-strip scroll/auto-compress redesign + per-hop entrance motion** — QF-07's ellipsis fix removes the visible mid-word clip that made this look broken. The L-effort layout redesign (scroll vs compress-to-last-N) waits for evidence the strip is still confusing after the truncation reads as intentional.
- **Piecemeal social softenings (roster row-chrome differentiation, renaming the 'Not yet ranked' callout)** — Tiny-N taste calls that only make sense decided together with the roster-sort and visibility-toggle questions — bundled into the privacy backlog conversation instead of shipping three uncoordinated tweaks to a 5-person social surface.
- **Moderation/solvability gate for user-created challenges** — Explicitly premature: the ~5-player trusted circle is a stated design constraint, the lens itself rated it 'not urgent now,' and the admin moderation surface it would reuse already exists for when sharing widens. Tracked as scale debt, not carried as a finding.
- **Cold-critic's global 'I would not return' meta-finding** — Not actionable as a package — it's the review's thesis. Its verdict is synthesized into the overall grade, and all five of its ranked gaps are individually covered by QF-01/03/06/09 and the desktop-composition backlog item.
