/**
 * The single shared renderer for a disclosed run path (Challenge Detail's
 * "Your history" strip and main Leaderboard panel via `LeaderboardList`,
 * Boards' own board-snippet disclosure, and Results' `PathRecap`). Owner
 * feedback on a Challenge Detail screenshot (2026-07-20): the old
 * per-surface markup rendered hop PAIRS ("Pizza → Latin", "Latin → Roman
 * Empire", ...), so every interim article appeared twice. This renders the
 * ordered `titles` chain (start first - see `pathStepsToChain` for the
 * server `ServerPathStep[]` shape, or RaceResults' own already-chained
 * `pathTitles`) as one line per article instead: the start plain, every
 * following line prefixed with the arrow ("→ Latin"), each article
 * appearing exactly once.
 *
 * Three call sites used to hand-duplicate this `<ol className="winning-path">`
 * markup independently (Boards.tsx's own doc comment even called the
 * duplication out as a deliberate, pre-existing precedent) - unified here so
 * a future surface can't drift back to the pair format. Deliberately dumb:
 * no truncation/compression logic lives here (that's `compressPathForStrip`,
 * shared with the live in-race PathStrip HUD and left untouched by this
 * fix) - just the finished chain, one `<li>` per title.
 */
export default function WinningPathChain({ titles }: { titles: string[] }) {
  return (
    <ol className="winning-path">
      {titles.map((title, index) => (
        <li key={`${index}-${title}`}>
          {index === 0 ? title : <>{"→"} {title}</>}
        </li>
      ))}
    </ol>
  );
}
