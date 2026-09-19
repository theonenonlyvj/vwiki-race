import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dirs = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  mkdirSync('.private', { recursive: true });
  const directory = mkdtempSync(path.resolve('.private', 'health-cli-test-'));
  dirs.push(directory);
  const input = path.join(directory, 'source.json');
  writeFileSync(input, JSON.stringify({ capturedAt: '2026-09-19T20:00:00.000Z', profiles: [], aliases: [], runs: [], dailyFeatures: [] }));
  return { directory, input };
}
describe('product health CLI', () => {
  it('writes an offline report privately and refuses to overwrite its baseline', () => {
    const { directory, input } = fixture();
    const output = path.join(directory, 'report');
    const args = ['scripts/product-health.mjs', '--input', input, '--output', output];
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' });
    expect(stdout).toContain('Read-only report complete');
    const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
    expect(report.window.currentPartialCentralDate).toBe('2026-09-19');
    expect(readFileSync(path.join(output, 'report.md'), 'utf8')).toContain('unavailable');
    expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).not.toBe(0);
  });
  it('refuses output outside the ignored private directory before collection', () => {
    const result = spawnSync(process.execPath, ['scripts/product-health.mjs', '--output', 'docs/not-a-report'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--output must be a directory beneath .private/');
  });
});
