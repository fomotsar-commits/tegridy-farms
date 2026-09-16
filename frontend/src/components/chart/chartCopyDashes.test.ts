/**
 * ELEMENT I, WHERE THE E2E CANNOT REACH.
 *
 * /chart's status lines, tooltips and table rows render only once a candle source
 * answers, a state CI never reaches: the e2e aborts the GeckoTerminal feed and the
 * CI build has no VITE_INDEXER_URL, so neither source can answer there. So
 * e2e/em-dash-zero.spec.ts held /chart at zero in CI while production, where the
 * indexer answers, showed 36 prose-dash nodes (walked 2026-09-11).
 *
 * This reads the chart's own source instead: its components, lib/chart, and the
 * four hooks whose strings reach the page (the three the chart imports and the
 * shared indexed query under them). No line of copy in those files carries U+2014.
 * Comments may, because they are not copy. The bare '—' a failed read renders is
 * the unreadable placeholder and passes, exactly as it does in the e2e.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'lib', 'chart');
const HOOKS_DIR = join(HERE, '..', '..', 'hooks');
// The chart imports the first three; they read through the fourth. A rename must
// red here rather than quietly shrink what this guard reads.
const HOOKS = ['useChartCandles.ts', 'useGeckoCandles.ts', 'useTerminalFeed.ts', 'useIndexedQuery.ts'].map((f) =>
  join(HOOKS_DIR, f),
);
const DASH = '—';
const PLACEHOLDER = new RegExp(`(['"\`])${DASH}\\1`, 'g');

function sources(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
    .map((f) => join(dir, f));
}

/** Every line of copy carrying U+2014: not a comment, and not the bare placeholder. */
function proseDashLines(file: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        return;
      }
      if (t.startsWith('/*') || t.startsWith('{/*')) {
        if (!t.includes('*/')) inBlock = true;
        return;
      }
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (!line.includes(DASH)) return;
      const code = line.replace(PLACEHOLDER, '').replace(/\s\/\/.*$/, '');
      if (code.includes(DASH)) out.push(`${file.split(/[\\/]/).slice(-2).join('/')}:${i + 1}: ${t.slice(0, 100)}`);
    });
  return out;
}

describe('the chart speaks without prose em dashes, in every branch its source renders', () => {
  const files = [...sources(HERE), ...sources(LIB), ...HOOKS];

  it('reads the chart source at all (guards the guard)', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.some((f) => f.endsWith('ChartStatus.tsx'))).toBe(true);
    for (const hook of HOOKS) expect(existsSync(hook), `${hook} moved; this guard no longer reads it`).toBe(true);
  });

  it('carries no U+2014 in any line of copy', () => {
    const hits = files.flatMap(proseDashLines);
    expect(hits, `prose em dashes in chart copy:\n${hits.join('\n')}`).toEqual([]);
  });
});
