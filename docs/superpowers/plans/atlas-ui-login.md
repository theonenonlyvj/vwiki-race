# Atlas interface and login implementation plan

**Goal:** Give the game an expressive identity outside the article surface and make existing-account login the ordinary account entry.

**Architecture:** Keep the current React application, navigation, race controller, API, and shared identity contracts. Introduce an original, decorative SVG connection atlas and a coherent CSS visual layer. Change only account entry selection and explanatory copy, preserving session renewal and guest-history safeguards. Gate initial entry until cookie restoration settles. Give result summaries focus before their optional frozen article.

**Design:** Ink blue `#101b36`, raised blue `#172747`, turquoise `#79e6d0`, soft lavender `#c6cfff`, pale text `#f5f7ff`; coral retains its existing race-action meaning. Manrope for controls and headings, existing wordmark for recognition. Artwork lives on Home and never overlays the Wikipedia article. Desktop has an asymmetrical introduction followed by the route; mobile compresses the illustration without hiding race controls. Decorative SVG is hidden from accessibility APIs.

## Constraints

- Preserve timer/click semantics, active-run recovery, ranking, path disclosure and same-origin API routing.
- Login-first does not mean mandatory registration. Explicit guest and creation paths remain; fresh-name switching remains a guest action.
- Reuse remembered sessions. No identity migrations, provider changes, account merges or token-lifetime changes.
- Honor reduced motion, keyboard focus, dialog scrolling and safe-area navigation.
- Keep private evidence outside the repository. Inspect exact staged paths before any commit.

## Execution

- [x] Account behavior: in `src/App.test.tsx`, assert that opening the ordinary Start identity prompt exposes username/password login without creating a guest or starting a run; verify explicit Guest still works. Observe failure, change `src/App.tsx` default and mode-specific copy, adapt previous default-dependent test setup, run App and remembered-session tests.
- [x] Visual shell: add `src/components/ConnectionAtlas.tsx` (pure decorative SVG), update `src/modes/Home.tsx` and `Home.css`, import local Manrope font, and add `src/atlas.css` after base styles. Existing callbacks and semantic route endpoints remain intact. Keep Wikipedia content styling and sticky HUD structure unchanged.
- [x] Verify: run client and Worker suites, TypeScript/build/bundle verification, dependency audit. Inspect actual browser screenshots for Home, account forms, Challenges, Stats, You, pre-race, active race, and results; include narrow mobile and long titles. Exercise session restore and account transitions with synthetic isolated data, never real player writes.
- [x] Independent review: identity correctness, visual/accessibility review, and adversarial gameplay/preservation review. Resolve findings and rerun affected checks.
- [x] Finish: record exact scope, checks and limitations; provide reviewable screenshots. Publication follows applicable explicit release authorization.
