import type { ReactNode } from "react";
import type { Challenge } from "../domain/types";
import "./RaceCard.css";

/** Shared article pair and race entry for Home and challenge details. */
export default function RaceCard({
  challenge, label, metadata, children, onRace, disabled, describedBy, routeLabel,
}: {
  challenge: Challenge;
  label: string;
  metadata: ReactNode;
  children?: ReactNode;
  onRace?: () => void;
  disabled?: boolean;
  describedBy?: string;
  routeLabel?: string;
}) {
  return (
    <div className="daily-hero challenge-route route-header race-card" aria-label={label}>
      <div className="daily-hero-copy">
        <div className="challenge-meta">{metadata}</div>
        <div className="daily-route" aria-label={routeLabel ?? `${challenge.start.title} to ${challenge.target.title}`}>
          <span className="daily-route-endpoint">
            <span className="daily-route-label">Start</span>
            <strong>{challenge.start.title}</strong>
          </span>
          <span aria-hidden="true" className="route-arrow" />
          <span className="daily-route-endpoint">
            <span className="daily-route-label">Target</span>
            <strong>{challenge.target.title}</strong>
          </span>
        </div>
        {children}
      </div>
      {onRace ? (
        <div className="player-gate">
          <button className="race-preview-button" disabled={disabled} onClick={onRace}
            aria-describedby={describedBy} type="button">▶ Race</button>
        </div>
      ) : null}
    </div>
  );
}
