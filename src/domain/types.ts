export type AccountStatus = "ghost" | "claimed" | "merged";
export type ChallengeMode = "solo" | "daily";
export type Ruleset = "ranked_classic";
export type RunStatus = "active" | "completed" | "abandoned";

export interface VGamesAccount {
  accountId: string;
  displayName: string;
  status: AccountStatus;
  token: string;
}

export interface ArticleRef {
  title: string;
  pageId?: number;
}

export interface ChallengeCreator {
  accountId: string;
  displayName: string;
  identityStatus: AccountStatus;
}

export interface Challenge {
  id: string;
  label?: string;
  sortOrder?: number;
  isActive?: boolean;
  dateKey?: string;
  mode: ChallengeMode;
  start: ArticleRef;
  target: ArticleRef;
  ruleset: Ruleset;
  source: "curated";
  createdBy?: ChallengeCreator;
}

export interface ArticleLink {
  href: string;
  title: string;
  pageId?: number;
  anchorText: string;
  sourceSection?: string;
}

export interface Article {
  pageId: number;
  canonicalTitle: string;
  revisionId?: number;
  html: string;
  links: ArticleLink[];
  attribution?: string;
}

export interface PathPage {
  pageId?: number;
  canonicalTitle: string;
}

export interface PathEntry {
  sourcePage: PathPage;
  clickedAnchorText: string;
  requestedTitle: string;
  resolvedDestination: PathPage;
  timestamp: number;
  clickNumber: number;
}

export interface RunResult {
  challenge: Challenge;
  accountId: string;
  clicks: number;
  elapsedMs: number;
  path: PathEntry[];
  status: Extract<RunStatus, "completed" | "abandoned">;
}

export interface LeaderboardEntry {
  accountId: string;
  displayName: string;
  challengeId: string;
  clicks: number;
  elapsedMs: number;
  submittedAt: number;
  pathHash: string;
  pendingSync?: boolean;
}

export interface RunRecord {
  id: string;
  accountId: string;
  challengeId: string;
  mode: ChallengeMode;
  status: Extract<RunStatus, "completed" | "abandoned">;
  start: PathPage;
  target: PathPage;
  clicks: number;
  elapsedMs: number;
  createdAt: number;
  completedAt?: number;
  abandonedAt?: number;
  path: PathEntry[];
}

export interface CountStat {
  title: string;
  count: number;
}

export interface JumpStat {
  sourceTitle: string;
  destinationTitle: string;
  count: number;
}

export interface StatsSummary {
  totals: {
    runs: number;
    completed: number;
    abandoned: number;
    bestClicks: number | null;
    averageClicks: number;
    averageElapsedMs: number;
  };
  topStarts: CountStat[];
  topTargets: CountStat[];
  mostVisited: CountStat[];
  bridgePages: CountStat[];
  commonJumps: JumpStat[];
}

export interface ServerPathStep {
  stepNumber: number;
  sourceTitle: string;
  clickedAnchorText: string;
  destinationTitle: string;
  destinationPageId?: number;
  elapsedSinceStartMs?: number;
  createdAt: string;
}

export interface ServerLeaderboardRow {
  runId: string;
  challengeId: string;
  accountId: string;
  displayName: string;
  elapsedMs: number;
  clickCount: number;
  completedAt: string;
  pathPreview: ServerPathStep[];
}

export interface RankedLeaderboardRow extends ServerLeaderboardRow {
  rank: number;
}
