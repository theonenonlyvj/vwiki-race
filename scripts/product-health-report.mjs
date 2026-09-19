import { createHash } from 'node:crypto';
const ZONE = 'America/Chicago';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const centralDate = value => dateFormat.format(new Date(value));
const addDays = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const weekday = date => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const rate = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const hash = value => createHash('sha256').update(value).digest('hex');
const nameKey = value => String(value ?? '').trim().toLocaleLowerCase('en-US');
const fields = ['startedPlayers', 'matureStartedPlayers', 'finishedPlayers', 'countedDnfs', 'expiredActiveEngaged', 'earlyBails', 'pendingPlayers', 'uncountedMatureStarts'];
function counts() { return Object.fromEntries(fields.map(key => [key, 0])); }
function addRates(row) {
  row.matureStartedCompletion = rate(row.finishedPlayers, row.matureStartedPlayers);
  row.engagedFinishRate = rate(row.finishedPlayers, row.finishedPlayers + row.countedDnfs + row.expiredActiveEngaged);
  return row;
}
export function buildProductHealthReport(source, { asOf = source.capturedAt ?? new Date().toISOString(), days = 28, previousSnapshot } = {}) {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff) || !Number.isInteger(days) || days < 1 || days > 366) throw new Error('Invalid asOf or days');
  for (const field of ['profiles', 'aliases', 'runs', 'dailyFeatures']) if (!Array.isArray(source[field])) throw new Error(`Missing ${field} array`);
  const currentPartialCentralDate = centralDate(cutoff);
  const endCentralDate = addDays(currentPartialCentralDate, -1);
  const startCentralDate = addDays(currentPartialCentralDate, -days);
  const window = { days, startCentralDate, endCentralDate, currentPartialCentralDate };
  const aliases = new Map(source.aliases.map(row => [row.alias_account_id, row.canonical_account_id]));
  const canonical = id => {
    if (typeof id !== 'string' || !id) throw new Error('Missing account identity');
    const seen = new Set();
    while (aliases.has(id)) {
      if (seen.has(id)) throw new Error('Alias cycle');
      seen.add(id); id = aliases.get(id);
    }
    return id;
  };
  for (const id of aliases.keys()) canonical(id);
  const profiles = new Map(source.profiles.map(row => [row.account_id, row]));
  const synthetic = new Set(source.profiles.filter(row => nameKey(row.public_name).startsWith('zz')).map(row => canonical(row.account_id)));
  const dataQuality = { excludedBoardRuns: 0, excludedSyntheticRuns: 0, excludedFutureStarts: 0, postAsOfTerminalRows: 0 };
  const runs = [];
  source.runs.forEach((row, index) => {
    if (!['active', 'completed', 'abandoned'].includes(row.status)) throw new Error(`runs[${index}].status is invalid`);
    const started = Date.parse(row.started_at);
    if (!Number.isFinite(started) || !row.challenge_id || !Number.isInteger(row.click_count) || row.click_count < 0) throw new Error(`runs[${index}] is malformed`);
    const id = canonical(row.canonical_account_id || row.account_id);
    if (Number(row.board_excluded) === 1) { dataQuality.excludedBoardRuns++; return; }
    if (synthetic.has(id) || synthetic.has(canonical(row.account_id))) { dataQuality.excludedSyntheticRuns++; return; }
    if (started > cutoff) { dataQuality.excludedFutureStarts++; return; }
    let status = row.status;
    const terminal = status === 'completed' ? Date.parse(row.completed_at) : status === 'abandoned' ? Date.parse(row.abandoned_at) : null;
    if (status !== 'active' && (!Number.isFinite(terminal) || terminal < started)) throw new Error(`runs[${index}] terminal timestamp is invalid`);
    if (terminal > cutoff) { status = 'active'; dataQuality.postAsOfTerminalRows++; }
    const expiry = Date.parse(row.expires_at);
    const engaged = row.click_count >= 2;
    let outcome;
    if (status === 'completed') outcome = Number(row.protocol_version) === 1 || Number(row.ranked_eligible) === 1 ? 'finishedPlayers' : 'uncountedMatureStarts';
    else if (status === 'abandoned') outcome = engaged ? 'countedDnfs' : 'earlyBails';
    else if (Number.isFinite(expiry) && expiry <= cutoff) outcome = engaged ? 'expiredActiveEngaged' : 'earlyBails';
    else outcome = 'pendingPlayers';
    runs.push({ id, challenge: row.challenge_id, date: centralDate(started), outcome });
  });
  // One canonical player per challenge. A finish is permanent; otherwise an open replay keeps that player's result pending.
  const precedence = ['finishedPlayers', 'pendingPlayers', 'countedDnfs', 'expiredActiveEngaged', 'earlyBails', 'uncountedMatureStarts'];
  const byChallenge = new Map();
  for (const run of runs) {
    if (!byChallenge.has(run.challenge)) byChallenge.set(run.challenge, new Map());
    const players = byChallenge.get(run.challenge);
    const prior = players.get(run.id);
    if (!prior || precedence.indexOf(run.outcome) < precedence.indexOf(prior)) players.set(run.id, run.outcome);
  }
  const dailyCohorts = source.dailyFeatures.filter(row => row.daily_date >= startCentralDate && row.daily_date <= endCentralDate).sort((a, b) => a.daily_date.localeCompare(b.daily_date)).map(row => {
    const result = { dailyDate: row.daily_date, weekday: weekday(row.daily_date), flavor: row.flavor, ...counts() };
    for (const outcome of (byChallenge.get(row.challenge_id) ?? new Map()).values()) {
      result.startedPlayers++;
      result[outcome]++;
      if (outcome !== 'pendingPlayers') result.matureStartedPlayers++;
    }
    return addRates(result);
  });
  const completionByWeekday = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => {
    const result = { weekday: day, dailyCount: 0, ...counts() };
    for (const row of dailyCohorts.filter(row => row.weekday === day)) {
      result.dailyCount++;
      for (const field of fields) result[field] += row[field];
    }
    return addRates(result);
  });
  const activity = new Map();
  for (const run of runs) {
    if (!['finishedPlayers', 'countedDnfs', 'expiredActiveEngaged'].includes(run.outcome) || run.date > endCentralDate) continue;
    if (!activity.has(run.id)) activity.set(run.id, new Set());
    activity.get(run.id).add(run.date);
  }
  let activePlayers = 0, returning = 0, newPlayers = 0, repeatPlayers = 0;
  const cohortDates = new Set();
  for (const dates of activity.values()) {
    const sorted = [...dates].sort();
    const first = sorted[0];
    if (sorted.some(date => date >= startCentralDate && date <= endCentralDate)) {
      activePlayers++;
      if (first < startCentralDate) returning++;
    }
    if (first >= startCentralDate && addDays(first, 7) <= endCentralDate) {
      cohortDates.add(first); newPlayers++;
      if (sorted.some(date => date > first && date <= addDays(first, 7))) repeatPlayers++;
    }
  }
  const returningPlayers = { activePlayers, returningPlayers: returning, firstObservedInWindow: activePlayers - returning, returnRate: rate(returning, activePlayers) };
  const sevenDayRepeat = { eligibleCohortDates: cohortDates.size, newPlayers, repeatPlayers, repeatRate: rate(repeatPlayers, newPlayers) };
  const accountIds = [...new Set(source.profiles.map(row => canonical(row.account_id)))].filter(id => !synthetic.has(id));
  const names = new Map();
  for (const id of accountIds) {
    const profile = profiles.get(id);
    const key = nameKey(profile?.public_name);
    if (!key) continue;
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(hash(id));
  }
  const nameGroups = [...names].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ nameHash: hash(key), accountHashes: ids.sort() })).sort((a, b) => a.nameHash.localeCompare(b.nameHash));
  const snapshot = { version: 1, asOf: new Date(cutoff).toISOString(), accountHashes: accountIds.map(hash).sort(), nameGroups };
  if (previousSnapshot && (previousSnapshot.version !== 1 || !Array.isArray(previousSnapshot.nameGroups) || !Array.isArray(previousSnapshot.accountHashes))) throw new Error('Invalid previous snapshot');
  const oldNames = new Set(previousSnapshot?.nameGroups.map(row => row.nameHash) ?? []);
  const oldAccounts = new Set(previousSnapshot?.accountHashes ?? []);
  const oldGroupSizes = new Map(previousSnapshot?.nameGroups.map(row => [row.nameHash, row.accountHashes.length]) ?? []);
  const newNames = new Set(nameGroups.map(row => row.nameHash));
  const candidates = new Set(nameGroups.flatMap(row => row.accountHashes));
  const duplicateCandidates = {
    comparedWithPreviousSnapshot: Boolean(previousSnapshot), currentGroups: nameGroups.length, currentCandidateAccounts: candidates.size,
    newGroups: previousSnapshot ? nameGroups.filter(row => !oldNames.has(row.nameHash)).length : null,
    grownGroups: previousSnapshot ? nameGroups.filter(row => oldGroupSizes.has(row.nameHash) && row.accountHashes.length > oldGroupSizes.get(row.nameHash)).length : null,
    newCandidateAccounts: previousSnapshot ? [...candidates].filter(id => !oldAccounts.has(id)).length : null,
    resolvedGroups: previousSnapshot ? [...oldNames].filter(key => !newNames.has(key)).length : null,
  };
  const report = {
    asOf: new Date(cutoff).toISOString(), window, dailyCohorts, completionByWeekday, returningPlayers, sevenDayRepeat, duplicateCandidates, dataQuality,
    definitions: [
      'Daily cohorts use assigned Central daily dates in the complete-day window. All observed attempts of those challenges through as-of, including later archive replays, contribute; this is challenge difficulty, not same-day conversion.',
      'One canonical player per challenge, resolving alias chains. Finish takes precedence; otherwise an unexpired replay is pending. Mature start completion includes early bails and unranked completions; engaged finish rate includes eligible finishes and failures with at least two clicks.',
      'Counted play for returning/repeat metrics means eligible completion or a terminal/expired run with at least two clicks. Activity is attributed to the start Central date; quick exits and pending runs are excluded.',
      'Returning players are current-window active players with earlier observed counted play. Seven-day repeats use first-observed counted-play cohorts in the window with seven complete follow-up days; repeat requires play on a later Central date from +1 through +7.',
      'Duplicate names are trimmed, case-folded canonical profile names, not proof of shared ownership. New candidate accounts means IDs newly observed since the prior snapshot that now belong to duplicate groups, not registration dates. Profile updated_at is not account creation time.',
      'Board-excluded runs and synthetic zz identity components are excluded. Snapshot hashes remain private pseudonyms, not anonymized public data.',
    ],
    limitations: [
      'Existing records measure play, not visits or abandoned pre-start screens. These observational rates cannot establish that a UI or schedule change caused improvement.',
      'This is a mutable snapshot, not historical event reconstruction. Current aliases, profile names, click counts and moderation state can revise old cohorts. Known future starts/terminal events are excluded or classified by expiry; earlier as-of values cannot reconstruct historical click counts or identity state.',
      'Partial Central days are excluded from activity/cohort windows. Later replays can revise historical daily outcomes. Missing expiry stays pending. Small samples and unavailable denominators must remain visible.',
      'The first snapshot establishes a baseline; duplicate-name trend changes require a subsequent snapshot. No automatic monitoring or account merging occurs.',
    ],
  };
  return { report, snapshot };
}
const displayRate = result => result.value === null ? 'unavailable (0/0)' : `${(result.value * 100).toFixed(1)}% (${result.numerator}/${result.denominator})`;
export function renderProductHealthMarkdown(report) {
  const lines = ['# VWiki Race product health', '', `As of ${report.asOf}. Complete Central days: ${report.window.startCentralDate} through ${report.window.endCentralDate}.`, '', '## Daily challenge completion by assigned weekday', '', '| Weekday | Starts | Pending | Early bails | Counted DNFs | Expired active | Uncounted terminal | Finishes | Mature start completion | Engaged finish rate |', '|---|---:|---:|---:|---:|---:|---:|---:|---|---|'];
  for (const row of report.completionByWeekday) lines.push(`| ${row.weekday} | ${row.startedPlayers} | ${row.pendingPlayers} | ${row.earlyBails} | ${row.countedDnfs} | ${row.expiredActiveEngaged} | ${row.uncountedMatureStarts} | ${row.finishedPlayers} | ${displayRate(row.matureStartedCompletion)} | ${displayRate(row.engagedFinishRate)} |`);
  lines.push('', '## Returning players', '', `Returning share of active players: ${displayRate(report.returningPlayers.returnRate)}. First observed in window: ${report.returningPlayers.firstObservedInWindow}.`, `Seven-day repeat: ${displayRate(report.sevenDayRepeat.repeatRate)} across ${report.sevenDayRepeat.eligibleCohortDates} eligible first-play dates.`, '', '## Duplicate-name candidates', '', `Current groups: ${report.duplicateCandidates.currentGroups}; candidate accounts: ${report.duplicateCandidates.currentCandidateAccounts}.`);
  const dup = report.duplicateCandidates;
  lines.push(dup.comparedWithPreviousSnapshot ? `Compared with previous snapshot: ${dup.newGroups} new groups, ${dup.grownGroups} grown groups, ${dup.newCandidateAccounts} newly observed candidate accounts, ${dup.resolvedGroups} resolved groups.` : 'Baseline only: trend unavailable until a later snapshot comparison.', '', '## Definitions', '', ...report.definitions.map(text => '- ' + text), '', '## Limitations', '', ...report.limitations.map(text => '- ' + text), '', '## Data quality', '', ...Object.entries(report.dataQuality).map(([key, value]) => `- ${key}: ${value}`), '');
  return lines.join('\n');
}
