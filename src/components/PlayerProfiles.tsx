import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AllPlayersRosterEntry } from "../domain/types";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { BoardsTrendsResponse } from "../server/contracts";
import { apiErrorCode, type ErrorReporter } from "../services/errorReporting";
import ModalDialog from "./ModalDialog";
import "./PlayerProfiles.css";

type Player = { accountId: string; displayName: string };
type OpenProfile = (player: Player, trigger: HTMLElement) => void;
const ProfileContext = createContext<OpenProfile | null>(null);

/** Names always use canonical account IDs; display names need not be unique. */
export function PlayerName({ accountId, displayName, className = "" }: { accountId?: string; displayName: string | null; className?: string }) {
  const open = useContext(ProfileContext);
  const name = displayName ?? "Unknown";
  if (!open || !accountId) return <span className={className || undefined}>{name}</span>;
  return <button className={`player-profile-link ${className}`} type="button" aria-label={`View ${name}'s profile`}
    onClick={event => open({ accountId, displayName: name }, event.currentTarget)}>{name}</button>;
}

/** Public aggregates already published on Lifetime. Never requests private
 * account history, credentials, per-challenge metrics or spoiler paths. */
export function PlayerProfiles({ apiClient, children, refreshKey = "", errorReporter }: {
  apiClient: Pick<VWikiRaceApiClient, "getBoardsTrends">;
  children: ReactNode;
  refreshKey?: string;
  errorReporter?: Pick<ErrorReporter, "reportVisibleError">;
}) {
  const [player, setPlayer] = useState<Player | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const cache = useRef<{ client: typeof apiClient; key: string; expires: number; data: BoardsTrendsResponse } | null>(null);
  const requestVersion = useRef(0);
  const loadStats = useCallback(async () => {
    const cached = cache.current;
    if (cached && cached.client === apiClient && cached.key === refreshKey && cached.expires > Date.now()) return cached.data;
    const version = ++requestVersion.current;
    const data = await apiClient.getBoardsTrends("lifetime");
    if (version === requestVersion.current) cache.current = { client: apiClient, key: refreshKey, expires: Date.now() + 30_000, data };
    return data;
  }, [apiClient, refreshKey]);
  const open = useCallback<OpenProfile>((next, element) => {
    trigger.current = element;
    setPlayer(next);
  }, []);
  return <ProfileContext.Provider value={open}>
    {children}
    {player ? <ProfileDialog key={player.accountId} loadStats={loadStats} errorReporter={errorReporter} player={player}
      trigger={trigger} onClose={() => setPlayer(null)} /> : null}
  </ProfileContext.Provider>;
}

function ProfileDialog({ loadStats, errorReporter, player, trigger, onClose }: {
  loadStats: () => Promise<BoardsTrendsResponse>;
  errorReporter?: Pick<ErrorReporter, "reportVisibleError">;
  player: Player;
  trigger: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const [result, setResult] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; row: AllPlayersRosterEntry | null }>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult({ status: "loading" });
    void loadStats().then(response => {
      if (!cancelled) setResult({ status: "ready", row: response.roster?.find(row => row.accountId === player.accountId) ?? null });
    }).catch(caught => {
      if (!cancelled) {
        setResult({ status: "error" });
        errorReporter?.reportVisibleError("player-profile", apiErrorCode(caught), "Couldn't load this player's stats.", { accountId: player.accountId });
      }
    });
    return () => { cancelled = true; };
  }, [loadStats, player.accountId, retry, errorReporter]);

  return <ModalDialog className="player-profile-dialog" titleId="player-profile-title" portal
    returnFocusRef={trigger} onClose={onClose}>
    <header className="player-profile-heading">
      <h2 id="player-profile-title">{result.status === "ready" ? result.row?.displayName ?? player.displayName : player.displayName}</h2>
      <button className="link-button" type="button" aria-label="Close player profile" onClick={onClose}>Close</button>
    </header>
    <p className="muted">VWiki Race public profile</p>
    {result.status === "loading" ? <p role="status">Loading player stats…</p> :
      result.status === "error" ? <>
        <p role="alert">Couldn't load this player's stats.</p>
        <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>
      </> : result.row ? <>
        <h3>All-time activity</h3>
        <dl className="player-profile-totals">
          <div><dt>Races started</dt><dd>{result.row.racesStarted}</dd></div>
          <div><dt>Finishes</dt><dd>{result.row.finishes}</dd></div>
          <div><dt>Wins</dt><dd>{result.row.wins}</dd></div>
        </dl>
        <p className="muted">Starts and finishes include repeat attempts. Wins count challenges where this player holds the top spot.</p>
      </> : <p>No public stats are available for this player yet.</p>}
  </ModalDialog>;
}
