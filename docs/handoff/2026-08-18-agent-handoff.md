# 2026-08-18 — agent handoff (cold start)

Written for an agent picking this up with no memory of the preceding sessions.
Read `docs/handoff/START_HERE.md` first for what the product *is*; this file is
the current state, the live landmines, and the open work.

Verify every fact below yourself before relying on it — the section "How to
check reality" says how. Handoffs go stale; this one will too.

## Current state (verified 2026-08-18 20:40 CDT)

- `main` = `8d767d8`, clean, matches `origin/main`.
- Live Pages bundle: `index-KtJcCDZ4.js`.
- Live API Worker: version `4e4a3cac`, deployed **2026-07-26** — unchanged since,
  because nothing since has touched `src/server/`.
- Prod D1 migration ledger: latest applied is `0007_give_up_reference_path`,
  which matches the newest file in `d1/migrations/`. Nothing pending.
- Gate: 1369 client tests, 289 worker tests, `tsc --noEmit` clean,
  `npm run build` (which runs `verify:bundle`) passes.

## ⚠️ THE LANDMINE: pushing does not deploy

**The GitHub → Cloudflare Pages auto-deploy is broken.** Pushing `main` produces
no build. This was discovered on 2026-08-18 and is NOT fixed.

How it was found: pushed `main`, waited 12 minutes, no build appeared. Checking
`wrangler pages deployment list --project-name vwikirace` showed the newest
deployment was from three days earlier — and that `31d5e84`, pushed on
2026-08-16, had **never produced a deployment either**. So the integration has
been dead since at least the 16th, and production silently ran stale code for
two days while the repo looked shipped.

Until someone repairs the GitHub App connection in the Cloudflare dashboard:

```
npm run build
npx wrangler pages deploy dist --project-name vwikirace --branch main --commit-dirty=false
```

**Then confirm the live bundle hash actually changed:**

```
curl -s https://vwikirace.pages.dev/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'
```

Never treat a successful `git push`, or even a successful deploy command, as
proof that something is live. Compare the hash.

This also means `AGENTS.md`'s ordering warning ("do not push first when
Git-connected Pages auto-deployment could reverse Worker-before-Pages") is
currently inert — but restore that discipline the moment the integration is
repaired.

## Also worth knowing

**`wrangler` is missing an OAuth scope.** `wrangler whoami` reports
`challenge-widgets.write` missing, which makes `wrangler d1 migrations list`
fail with a 403. `d1 execute`, `pages deploy` and `deployments list` all work.
To read the migration ledger around it:

```
npx wrangler d1 execute vwiki-race --remote --config wrangler.api.toml \
  --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 5"
```

`wrangler login` refreshes the token if you want the scope back.

**`account_profiles` has no `created_at`.** Its columns are `account_id`,
`public_name`, `identity_status`, `updated_at`. Order accounts by their runs'
`started_at` instead. (Cost a round-trip on 2026-08-18.)

## Open work

### 1. `kaymck` duplicate account — BLOCKED on a permission

One human, two ghost accounts, created ten minutes apart on 2026-08-13. They
started a run and abandoned it, then came back as a *new* account (probably a
fresh tab / lost session) and finished. On the boards they read as two separate
people with one race each instead of one person with two races and one finish.

```
aa98b1e6-9b2c-4026-a21e-dbacd25a5a83   1 run, 0 completed, 19:00:34   <- merge THIS
2705ec8d-f405-4e6e-9edb-f52f16698d2e   1 run, 1 completed, 19:10:14   <- INTO this
```

Both are `identity_status = ghost` with no password, so no login breaks. Vijay
approved the intent. It is blocked because the documented `/admin/merge` flow
needs `wrangler secret put ADMIN_JWT_SECRET`, and Claude Code's permission
classifier refuses that command. It needs Vijay to allow it, then:

1. set the secret (`printf '%s' "$(cat file)"` — piping `cat` stores the
   trailing newline and every signed token then 401s)
2. dry-run, then execute with `confirmNonce`
3. **delete the secret and verify it is absent** — `wrangler secret delete` has
   no `--force`, so pipe `yes |` and always re-check `secret list`; a failed
   delete prints an unrelated-looking usage error and leaves the secret live
4. write the `account_aliases` row in vwiki-race so the boards unify immediately

Six alias rows already exist, so the machinery works; only this one is stuck.

**Open question for Vijay, do not act on it alone:** a ghost named **`Kayden`**
(`bc994b57-b351-4be1-afc8-fe3fcb6540d8`) played and finished on 2026-08-18
19:33. The name is close enough that it may be the same person on a third
account, or a completely different player. The data cannot distinguish them.
Ask; do not merge on a hunch.

### 2. Old-challenge navigation — designed, not built, needs Vijay's call

Vijay: *"the today/yesterday view graph thing but then looking at old challenges
to look at the graph is kind of a navigation nightmare (or maybe i'm
overthinking)"*. He is not overthinking: the graph button exists only on Boards'
Today/Yesterday and Home, and there is **no date-ordered archive at all** —
Browse is a flat title-searchable catalog mixing dailies with user-created
challenges. To reach Tuesday's graph you must remember its title.

**Key finding: this needs ZERO server work.** `Challenge.dailyDate` already
exists client-side (`src/domain/types.ts`) and
`GET /api/v2/account/challenge-outcomes` already reports which challenges the
viewer has played. So a "past dailies I played" list, or ←/→ day-stepping inside
the graph modal, is a pure client change.

Not built because it adds a new UI surface and he was ambivalent about the
problem. Get a decision before building.

### 3. Landing page — diagnosed, untouched

Vijay wants it "sleeker". Measured on the live site:

- **Desktop wastes about a third of the first screen**: real content ends around
  y=515 and the footer sits at ~730. This is the void he described. **The phone
  layout does not have this problem** and reads well as-is — it is a
  desktop-only complaint.
- A column of four bare em-dashes where yesterday's times should be. *Not a
  bug* — it is the deliberate spoiler mask (`pathsUnlocked ? times : "—"`,
  `Boards.tsx`). But it renders as missing data rather than "hidden until you
  play". Saying it once and dropping the column would read better. His copy
  call, not an agent's.
- "Start your streak today" floats between two cards with no container.
- The hero title truncates on phone.

Screenshots: `agents-shared/scratch/2026-08-15-vwiki-viewgraph/shots/prod-landing-{phone,desktop}.png`.

**Note: you cannot render the landing page from local dev.** The API's
`ALLOWED_ORIGINS` is the Pages origin only, so a dev-server load shows the CORS
error state, not the page. Screenshot the live site, or intercept the API
responses in Playwright.

### 4. Pre-existing, untouched

`npm audit --omit=dev`: nanoid (high), postcss (moderate). No dependency changes
have been made in any recent session.

## How to check reality

```
git -C . log --oneline -5 && git status --short
curl -s https://vwikirace.pages.dev/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'
npx wrangler deployments list --config wrangler.api.toml | head
npx wrangler pages deployment list --project-name vwikirace | head
npm test && npm run test:worker && npm run build
```

Real prod path data for any challenge, read-only:
`agents-shared/scratch/2026-08-15-vwiki-viewgraph/dump-paths.sh <challenge-id>`.

A screenshot harness that renders the real graph component at any viewport with
real data lives in that same scratch folder under `harness/`, with restore
instructions. It goes into the repo only while in use and is git-excluded via
`.git/info/exclude`; **delete the three in-repo paths before any build or
commit.**

Playwright browsers are at `~/Library/Caches/ms-playwright`. On this machine the
binary is under `chrome-mac-arm64/Google Chrome for Testing.app/…`, NOT the
`chrome-mac/Chromium.app` path older notes assume — discover it, do not hardcode
it. The npm package is in no project; `npm install --no-save playwright-core` in
scratch and pass `executablePath`.

## The lesson from 2026-08-16, worth keeping

Across one session I wrote a test that passed against broken code **three
separate times**, each because the fixture never reached the state the bug lives
in: a landscape fixture for a portrait-only bug; a `matchMedia` stub that
returned true for *any* `max-width`, so eight portrait tests passed with the
portrait layout switched off entirely; and an unbounded 70-rung ladder for a bug
that only appears once the ladder runs out.

Every one was caught by **mutating the source and re-running**, never by
re-reading the test. After writing a guard, change the line it claims to protect
and confirm that exact test fails. The guards checked this way were all real;
the ones not checked were all lying.

Deeper detail on the graph work — the measurements behind each decision, and why
7 strand hues is a hard ceiling — is in
`docs/handoff/2026-08-16-path-graph-portrait-and-share.md`.
