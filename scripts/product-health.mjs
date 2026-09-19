#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProductHealthReport, renderProductHealthMarkdown } from './product-health-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') {
    console.log('npm run report:health -- [--input source.json] [--previous snapshot.json] [--days 28] [--as-of ISO_TIMESTAMP] [--output .private/report-directory]\nWithout --input, reads existing production D1 data using Wrangler SELECT queries. Outputs stay under ignored .private/. No database writes.');
    process.exit(0);
  }
  if (!['--input', '--previous', '--days', '--as-of', '--output'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${key}`);
  options[key.slice(2)] = process.argv[++i];
}
const days = Number(options.days ?? 28);
if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('--days must be an integer from 1 to 366');
const requestedAsOf = options['as-of'];
if (requestedAsOf && !Number.isFinite(Date.parse(requestedAsOf))) throw new Error('--as-of must be an ISO timestamp');
const privateRoot = path.join(root, '.private');
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const output = path.resolve(root, options.output ?? `.private/product-health/${new Date().toISOString().replaceAll(':', '-')}`);
if (!output.startsWith(privateRoot + path.sep)) throw new Error('--output must be a directory beneath .private/');
// Resolve existing ancestors before creating anything: a symlink must not move a report outside the private directory.
let ancestor = output;
while (true) {
  try {
    const real = realpathSync(ancestor);
    const realPrivate = realpathSync(privateRoot);
    if (real !== realPrivate && !real.startsWith(realPrivate + path.sep)) throw new Error('Output path escapes .private/ through a symlink');
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ancestor = path.dirname(ancestor);
  }
}
let source;
if (options.input) {
  source = JSON.parse(readFileSync(path.resolve(root, options.input), 'utf8'));
} else {
  const sql = `SELECT account_id,public_name,identity_status,updated_at FROM account_profiles;
SELECT alias_account_id,canonical_account_id FROM account_aliases;
SELECT challenge_id,account_id,canonical_account_id,status,started_at,completed_at,abandoned_at,expires_at,elapsed_ms,click_count,ranked_eligible,protocol_version,board_excluded FROM runs;
SELECT daily_date,challenge_id,flavor FROM daily_features;`;
  let results;
  try {
    results = JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'vwiki-race', '--remote', '--config', 'wrangler.api.toml', '--command', sql, '--json'], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/private/tmp/vwiki-product-health-wrangler.log' },
    }));
  } catch {
    throw new Error('Read-only Wrangler collection failed. Check Cloudflare authorization; raw query output was withheld.');
  }
  if (results.length !== 4 || results.some(result => result.success !== true || !Array.isArray(result.results))) throw new Error('Incomplete read-only D1 collection');
  const [profiles, aliases, runs, dailyFeatures] = results.map(result => result.results);
  source = { capturedAt: new Date().toISOString(), profiles, aliases, runs, dailyFeatures };
}
const asOf = requestedAsOf ?? source.capturedAt ?? new Date().toISOString();
const previousSnapshot = options.previous ? JSON.parse(readFileSync(path.resolve(root, options.previous), 'utf8')) : undefined;
const { report, snapshot } = buildProductHealthReport(source, { asOf, days, previousSnapshot });
mkdirSync(output, { recursive: true, mode: 0o700 });
for (const [name, contents] of [
  ['report.json', JSON.stringify(report, null, 2) + '\n'],
  ['snapshot.json', JSON.stringify(snapshot, null, 2) + '\n'],
  ['report.md', renderProductHealthMarkdown(report)],
]) writeFileSync(path.join(output, name), contents, { mode: 0o600, flag: 'wx' });
console.log(`Product health report saved to ${path.relative(root, output)}/report.md`);
console.log('Read-only report complete. No gameplay or account records changed.');
