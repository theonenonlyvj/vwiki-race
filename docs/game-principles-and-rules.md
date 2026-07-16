# VWiki Race Game Principles and Rules

Status: v0 ranked baseline

Date: 2026-07-15

Intent: define the game contract implemented by the friend-ready v0.

## Research Basis

The core model comes from Wikiracing / The Wiki Game: players start on one
Wikipedia article and try to reach a target article only by clicking wikilinks.
The winner is usually the first finisher or the player who reaches the target in
the fewest clicks.

Sources reviewed:

- [Wikipedia: Wiki Game](https://en.wikipedia.org/wiki/Wikipedia:Wiki_Game)
- [Wikiracing](https://en.wikipedia.org/wiki/Wikiracing)
- [Wikispeedia / EPFL](https://dlab.epfl.ch/wikispeedia/play/)
- [West, Paranjape, and Leskovec, "Mining Missing Hyperlinks from Human Navigation Traces"](https://arxiv.org/abs/1503.04208)
- [Wikipedia Speedruns](https://wikispeedruns.com/)
- [Wikipedia Speedruns source repo](https://github.com/wikispeedruns/wikipedia-speedruns)
- [Wikimedia Foundation API Usage Guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
- [MediaWiki API Etiquette](https://www.mediawiki.org/wiki/API:Etiquette)
- [Wikimedia Foundation Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use)

## First-Order Principles

### 1. The Wiki Graph Is The Board

Every article is a node. Every allowed internal article link is a directed edge.
The game is not about typing, searching, guessing URLs, or asking another
system. It is about navigating the visible graph from the current node.

### 2. A Click Is A Move

A player's path is a sequence of clicked links. Each valid move must be
recoverable from the page the player was actually viewing at that moment. If a
move cannot be reconstructed from the allowed link set, it is not a valid move.

### 3. Shared Starts Make Fair Races

Competitive players need the same start article, target article, language,
snapshot policy, rule mode, and timing/counting rules. Randomness is acceptable
only when it is recorded and reproducible.

### 4. The Target Must Be Objective

A win occurs when the player reaches the canonical target article. The app
should decide this mechanically by canonical page identity, not by visual title
matching alone.

### 5. Constraints Create The Game

The fun comes from meaningful restrictions. Search, browser history, outside
tools, AI hints, uncontrolled Wikipedia UI, or broad portal links can collapse
the puzzle. Any relaxation of constraints must be explicit and mode-specific.

### 6. Difficulty Comes From Semantic Distance And Hub Access

Good prompts balance discoverability and surprise. Overpowered hub pages,
year/date pages, country pages, list pages, categories, and navigation templates
can make many prompts trivial. Banning or penalizing these should be part of
specific ranked modes.

### 7. The Path Is The Proof

Every competitive run needs a complete path log: start, each clicked source,
anchor text, destination, redirects, timestamps, and final result. Replays and
post-game analysis should be first-class features, not afterthoughts.

### 8. Live Content Must Not Decide Competitive Fairness

Wikipedia changes constantly. Competitive puzzles should use a fixed page
snapshot or cached prompt snapshot wherever possible. If live pages are used,
the app must record enough page identity/version data to explain the run later.

### 9. Modes Must Not Share Leaderboards

Fewest-click play, fastest-time play, first-link Philosophy play, hub-banned
play, and hint-assisted play are different games. They can share infrastructure,
but their results should not be ranked together.

### 10. Wikipedia Is The Source, Not The Product's Property

The app must respect Wikimedia licensing, attribution, trademarks, API usage
guidelines, rate limits, and infrastructure. VWiki Race should add a game layer
and community layer without pretending to own or replace Wikipedia content.

## Absolute Rules For Ranked Classic

These are the recommended non-negotiable rules for the first serious ranked
mode. Other modes can modify them, but only under a separate mode name and
separate leaderboard.

### Article Eligibility

1. Start and target must be article pages in the same wiki language edition.
2. Start and target must use canonical article identity, preferably page ID plus
   normalized title.
3. Start cannot equal target.
4. Start and target must be reachable under the mode's allowed link rules.
5. Ranked Classic should exclude target/start pages that are primarily:
   disambiguation pages, year/date pages, category pages, portal pages, file
   pages, special pages, talk/user pages, and pure index/list pages.
6. A generated prompt must record the source of selection: curator, community
   submission, algorithm, random seed, and snapshot/date.

### Allowed Move

1. The only valid move is clicking an app-rendered internal link from the
   current article to another eligible article page.
2. Direct URL entry, Wikipedia search, browser search, Random Article, external
   search engines, autocomplete, AI assistants, copied links, and manual page
   title entry are forbidden.
3. The app, not the raw browser, defines the clickable surface.
4. Clicking a same-page section anchor is not a move and must not count.
5. Clicking a link that resolves through a redirect counts as one move. The
   resolved canonical page is the destination.
6. Disambiguation pages are valid only if reached through a valid click, but
   should not be generated as starts or targets in Ranked Classic.
7. Revisiting an article is allowed, but every valid transition still counts.
8. The Back button is forbidden in Ranked Classic. A mode that allows backtracking
   must count it explicitly or be marked unranked.

### Allowed Link Surface

Ranked Classic should allow links that represent article content and disallow
links that represent site navigation, metadata, or bulk shortcut systems.

Allowed:

1. Lead-section article links.
2. Main prose article links.
3. Infobox links.
4. Article table/list links when the table or list is part of the article's
   substantive content.

Disallowed:

1. Search, sidebar, top navigation, footer, edit/history/talk links.
2. External links.
3. Citation/reference backlinks and bibliography-only links.
4. Category links.
5. Language links.
6. File/media/license links.
7. Template-generated navboxes and portal boxes.
8. Red links or nonexistent pages.
9. Special, Help, Wikipedia, User, Talk, Template, Module, Portal, and Category
   namespace pages.
10. "See also", references, further-reading, and external-link sections.

### Win Condition

1. A run is complete only when the current canonical page matches the canonical
   target page.
2. Redirects to the target are valid wins and count as the click that triggered
   the redirect.
3. If the target appears as a link on the current page, the player has not won
   until they click it and load the target.
4. The app should detect wins automatically and stop the player's timer/count
   immediately.

### Scoring

1. Primary score: fastest accepted active decision time.
2. Tiebreaker: fewest valid clicks.
3. If decision time and click count are equal within system precision, the
   earlier accepted completion ranks first.
4. Invalid moves void the run for ranked play.
5. Hints, escapes, backtracking, or rule exceptions must move the run to a
   separate leaderboard.

### Timing

1. The timer starts at zero only after the server accepts the run and the
   preloaded start article becomes interactive.
2. Activating a valid link freezes the timer immediately. Wikipedia fetch and
   server synchronization latency do not count as player decision time.
3. The timer resumes only after the server accepts the move and the next
   article becomes interactive.
4. A target click stops the timer when that transition is accepted by the
   server. The target must still be clicked; merely displaying its link is not
   a finish.
5. The server stores cumulative monotonic decision time on every accepted
   transition. That accepted value, not a client-only stopwatch, determines the
   leaderboard.
6. Network failures restore the last accepted article without accepting a
   move. Reloads may resume only from the server's accepted path and timing
   state.

### Fair Play

1. No external tools, second screens, direct Wikipedia browsing, prior
   page-specific lookup during a live round, AI helpers, browser find, page
   source inspection, DOM scripting, or developer console manipulation.
2. No editing Wikipedia to add or change links for a prompt. Competitive prompts
   should use snapshots or cached pages to prevent this from mattering.
3. Session state should be isolated: no useful browser history, no search
   history, no visited-link styling advantage, and no cross-round page cache that
   reveals unseen links.
4. The app must log all clicked links and page transitions for review.
5. A run can be disqualified if the path contains a transition not available in
   the allowed link set for that article version.

### Dead Ends

1. A page with no valid outgoing links under the mode rules is a dead end.
2. In Ranked Classic, a dead end does not grant a free escape.
3. The player may concede, timeout, or continue only if there is a valid move.
4. Escape mechanics belong in separate modes, such as "One Escape" or
   "Explorer."

## Variant Catalog

These are known or natural variants worth preserving as explicit modes later.

| Mode | Primary Goal | Key Rule Difference |
| --- | --- | --- |
| Ranked Classic | Fastest decision time | Time is primary; clicks break ties. |
| Click Race / WikiGolf | Fewest clicks | Separate mode and leaderboard; time breaks ties. |
| Daily Challenge | Shared puzzle of the day | One or more attempts against a daily global board. |
| Wikispeedia | Short path on fixed snapshot/subset | Uses a static article set; supports reproducible research-style play. |
| Philosophy Mode | Reach Philosophy | Often restricts each page to its first valid internal link. |
| Five Clicks To Jesus | Reach Jesus in five or fewer clicks | Golf/par framing around a fixed target. |
| WikiHitler | Reach Adolf Hitler | Fixed-target historical variant; should be treated carefully in product tone. |
| No United States / No Hubs | Avoid specific hub pages | Bans one or more high-connectivity shortcuts. |
| Grand Tour | Visit ordered targets | Requires a sequence of targets before final completion. |
| One Escape | Recover from a dead end once | Allows one category/back-to-start/escape move; separate leaderboard. |
| Team / Co-op | Shared pathfinding | Players coordinate, but the logged path remains the scoring unit. |

## Product Rules Implied By The Game

1. The app needs a controlled article renderer, not an unrestricted Wikipedia
   tab.
2. The app needs deterministic link extraction per article version.
3. Prompt generation needs validation for reachability and likely difficulty.
4. Challenge leaderboards need server-authoritative run logs, but do not need a
   realtime room: each player's accepted run begins independently.
5. Replays and path comparison should be part of the core data model.
6. Wikimedia API calls must use a meaningful User-Agent or Api-User-Agent,
   honor throttling/rate-limit responses, cache where appropriate, and follow
   content license attribution requirements.
7. If any Wikipedia text is displayed or cached, the UI must provide source
   attribution and license notice appropriate to the reused content.

## Daily Challenge Contract

1. The system eventually creates at most one immutable daily challenge for
   each `America/Chicago` calendar date after Wikipedia and the database are
   available. Its first attempt runs at 5:00 AM Central.
2. Start and target come from two separate English Wikipedia random-article
   requests, then pass the same canonical page and playable-link validation as
   manual challenges.
3. Daily creation never falls back to hard-coded pages and never inserts a
   partially validated pair.
4. Manual and daily challenges share one transactional global number sequence.
   The date never determines or resets the number: if `#15` is the latest
   accepted challenge, the next accepted daily challenge is `#16`.
5. The Central date is provenance and an idempotency key. Historical daily
   challenges remain playable at their permanent numbered challenge URLs.
6. Default selection order is an accepted resumable run, a valid direct
   challenge URL, today's daily challenge, then the first active challenge.

## Open Questions For Later Brainstorming

1. Should Ranked Classic be "content links only" as written here, or should it
   have an even stricter "body prose only" variant from launch?
2. Should daily challenges allow one official attempt or unlimited attempts with
   best score?
3. Should the first app use live Wikipedia with cached prompt snapshots, a full
   static snapshot, or an offline reduced graph?
4. Should hints ever exist in competitive play, or only in learning mode?
5. Should the product tone lean more toward party game, speedrunning community,
   educational puzzle, or serious graph-navigation sport?
