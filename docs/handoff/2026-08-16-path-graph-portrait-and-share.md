# 2026-08-16 — path graph: portrait layout, strand identity, share image

Everything below is COMMITTED LOCALLY on `main` and **not pushed, not deployed**.
Vijay was asleep; per `AGENTS.md` (local rule: no push/deploy without an explicit
ask) shipping waits for him. `main` is 8 commits ahead of `origin/main`.

Base for this work: `31d5e84` (the previous night's profile/Boards redesign).

## The problem, measured

The "View graph" modal was unusable on a phone, and quietly broken on desktop.
Rendered in Chromium against the REAL 11-strand 2026-07-20 daily
(`challenge-0011`, 5→37 clicks, 3 DNFs), at 390×844:

| | before |
|---|---|
| legend height | **638px of an 844px viewport (76%)** |
| graph top | y=742 — **below the fold** |
| graph height | 177px (18% of the sheet) |
| label size | **2.8–3.9px**, all 138 of them |
| render scale | 0.276 (a 1080px canvas squeezed into 298px) |
| "Explore path" | showed **27.6%** of the canvas per sideways swipe |

And on desktop, at the same field size:

- **87 overlapping label pairs out of 132 labels.**
- **5 of the 11 players painted the identical colour** (6-hue palette cycled by
  lane index): you/Kaleigj, reks/rnaik24, lollerskates/mattman, SunnyD/RK,
  chase3/FranTheGreat.

The graph was built for 4–6 runs and the field outgrew it.

## What shipped (8 commits)

| commit | what |
|---|---|
| `c548436` | 7 CVD-validated hues + dash for strands 8+ |
| `59a9321` | label placer: priority order, sideways slots, bounds, suppression |
| `ffcf9e9` | portrait layout on phones |
| `308321b` | "Save image" — graph + full legend to one PNG |
| `ddf6e83` | self-review pass (4 defects) |
| `3bff031` | portrait up to 900px, not just phones |
| `4a80439` | council round 1 (iOS share, dashed swatch, measurement) |
| `cb155da` | council round 2 (label contrast, export fidelity) |

### After

| 390×844, 11 strands | before | after |
|---|---|---|
| legend | 638px | **44px** |
| canvas top | y=742 | **y=144** |
| canvas height | 177px | **624px** |
| label size | 2.8–3.9px | **11–14px** |
| render scale | 0.28× | **1.00×** |
| visible labels | 0 on screen | **42, zero overlapping** |

Desktop: 96 visible labels, **0 overlapping** (was 87 pairs).

## Decisions that cost real measurement — do not silently revisit

**7 hues is the ceiling, and that is a property of vision, not of the search.**
Run through the dataviz palette validator (OKLab ΔE×100, Machado CVD simulation)
against `#061014`: at 8 hues the best achievable worst-pair separation collapses
to ΔE 5.6, under the 15 normal-vision / 8 CVD floors. Okabe-Ito — the
field-standard CVD-safe set — fails all-pairs here too. **Hand-tuning did worse
than the optimiser**: the "obviously distinct" pair `#b78cff`/`#6aa8ff` measures
ΔE **0.5** under deutan. Identity past 7 therefore needs a second channel, and
that channel is the dash. 82% of challenges to date field ≤7 strands and never
repeat a hue at all; max ever seen is 11, cap is 12.

**Composite alpha in gamma-encoded sRGB, never linear.** Solo labels at alpha
0.65 measure 2.69:1 (bronze) — a fail. The same blend computed in LINEAR space
reports 3.5:1, which reads as "marginal". I got it wrong that way first and the
council caught it. `contrastOnInk()` does it correctly; a test pins both the AA
floor and the trap.

**The dense axis must get the elastic axis.** The graph has a dense axis
(progress, up to 37 hops) and a sparse one (lanes, ≤12). Landscape gives the
dense one a fixed 1080px and the sparse one 640px of height — backwards on a
portrait phone. Rotating is not cosmetic: it converts an unsolvable packing
problem into a solvable one, because vertical room can be bought by scrolling
and horizontal room cannot.

**Portrait applies to ≤900px, not ≤480px.** The middle widths were the worst
case: at 768px the landscape canvas rendered full-size but 35% of it sat outside
the modal. Portrait there shows everything at once, 71 labels at ≥10.5px, no
sideways scroll. Not 1080 because the modal is `min(1200px, 92vw)` — a 1080
canvas needs ~1175px of window before it fits.

**Two overlapping labels are worse than one hidden label**, because the
collision destroys both. The placer suppresses instead of overprinting, and the
title stays on the node's `<title>` and the A6 focus reveal. Anchors are the one
exception — they are the frame of reference and never hide.

**Crowding outranks importance.** `revealOnly` began `!alwaysLabel && …`, so an
unplaceable SHARED label rendered anyway at its fallback position. Importance
cannot conjure space. The rule now lives in `domain/labelVisibility.ts` and is
shared by the SVG and the PNG.

**Suppressed labels must reserve boxes against each other but not against
visible ones.** They render at opacity 0, so reserving against visible labels
would crowd out things that actually render — but a focus reveal pops a whole
solo stretch in AT ONCE, and without mutual reservation they all take the same
slot and stack. Two reservation sets. The prototype had this right; I broke it
and the council caught it.

**The placer's box must be the box that gets painted.** Two separate bugs of
this shape: (a) the renderer added a `dy >= 0 ? +16 : -10` nudge AFTER collision
detection, so every label was cleared at a position it never occupied; (b) label
height was assumed flat 15px while a 14px anchor title renders ~18px, which put
"Remote control" 1.6px into "Technology" at 360×640. Offsets are now final and
height is per-candidate at 1.35× font size. Same doctrine as the existing
`CHAR_WIDTH_PX` note: over-estimating leaves slack, under-estimating is a bug.

**`navigator.share()` must be reached without an intervening `await`.** iOS only
honours it while the page holds transient activation from the tap. The export is
therefore synchronous end to end — `toDataURL` plus inline base64 decode, not
`await canvas.toBlob()`. Getting this wrong makes Save image silently do nothing
on the one device the feature exists for. Pinned by a test asserting the encode
throws rather than rejecting.

**Butt caps on short dashed swatches.** A round cap extends half the line width
past each dash end, which on a 16px legend swatch bridges the gaps entirely — so
the dashed 8th player printed identical to the 1st in the shared PNG, defeating
the whole point of the dash.

**Canvas2D, not SVG serialisation, for the export.** An SVG rasterised through
`new Image()` is its own document and cannot see the page's webfonts, so every
label would fall back to a default serif. Canvas2D `fillText` uses the document's
loaded fonts, and `new Path2D(d)` accepts SVG path syntax so the bezier edges are
reused verbatim.

## Verification

- **1344 client tests, 289 worker tests**, `tsc --noEmit` clean,
  `npm run build` + `verify:bundle` pass. Bundle 398KB / 121KB gzip.
- **Edge matrix, 4 field sizes × 4 viewports = 16/16 clean**: 1 run, 2 runs, 12
  (the server cap), pathological 74-char titles × 390/360/768/1440. Zero
  overlapping visible labels, nothing off-canvas, no non-finite coordinates, no
  horizontal page overflow, no console errors.
- Export verified end to end by driving the real button in Chromium and writing
  the captured bytes to disk: 894×2790 phone, 3240×2448 desktop.
- Share-fallback branches confirmed by **mutation runs** — removing the
  AbortError guard, the `canShare` check, or the butt caps each fails exactly
  the test that should catch it.

## Tooling

Screenshot harness (real component, real prod data, chosen viewport) is in
`agents-shared/scratch/2026-08-15-vwiki-viewgraph/harness/` with restore
instructions. It lives in the repo only while in use and is git-excluded via
`.git/info/exclude`. Real payloads come from prod D1 via `./dump-paths.sh
<challenge-id>` — read-only SELECTs replicating `getChallengePaths`' ranking.

Playwright browsers are at `~/Library/Caches/ms-playwright`; the binary is
`chrome-mac-arm64/Google Chrome for Testing.app/…` on this machine, NOT the
`chrome-mac/Chromium.app` path older notes assume — discover it, don't hardcode.

## OPEN

1. **Not pushed, not deployed.** 8 commits ahead of `origin/main`. Per this
   repo's "ship it" definition: commit → verify D1 migration ledger → deploy the
   API Worker → push `main` / let Pages deploy → prod smoke. No server or D1
   changes are in this batch, so it is a Pages-only deploy.
2. **`kaymck` duplicate merge — still BLOCKED on permission.** Two ghosts, same
   display name, 11 minutes apart 2026-08-13, neither claimed. Merge
   `aa98b1e6-9b2c-4026-a21e-dbacd25a5a83` INTO
   `2705ec8d-f405-4e6e-9edb-f52f16698d2e`. The Claude Code permission classifier
   blocks `wrangler secret put`, which the documented `/admin/merge` flow needs.
3. **Old-challenge navigation — designed, not built.** Vijay: "looking at old
   challenges to look at the graph is kind of a navigation nightmare (or maybe
   i'm overthinking)". He is not overthinking: the graph button exists only on
   Boards' Today/Yesterday and Home, and there is no date-ordered archive at all
   — Browse is a flat title-searchable catalog mixing dailies with user-created
   challenges. **Key finding: this needs NO server work.** `Challenge.dailyDate`
   already exists client-side and `GET /api/v2/account/challenge-outcomes`
   already says which challenges the viewer has played, so a "past dailies I
   played" list — or ←/→ day-stepping inside the graph modal — is a pure client
   change. Held back because he was ambivalent about the problem and it adds a
   new UI surface; it wants his call, not an overnight decision.
4. **Landing page** — still wants to be "sleeker"; untouched.
5. `truncateTitle` collisions: two different articles can share a truncated
   label ("Semiconductor d…" appears twice in the 11-strand export). Cosmetic.
6. Pre-existing `npm audit --omit=dev`: nanoid (high), postcss (moderate).
   Untouched; no dependency changes in this batch.
