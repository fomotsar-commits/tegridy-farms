/**
 * LAW 1, WHERE THE E2E CANNOT REACH.
 *
 * The NFT owner panel renders only for a collection's owner (no collection exists),
 * and the LP farm's ended line, held stake and position card only for a connected
 * wallet on mainnet. e2e/em-dash-zero.spec.ts walks neither. So this reads their
 * source: no line of copy carries U+2014 or `&mdash;`. Comments may. The bare '—'
 * a failed read renders is the unreadable placeholder and passes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'components/launchpad/OwnerAdminPanelV2.tsx',
  'components/farm/LPFarmingSection.tsx',
  'lib/rewardsEnded.ts',
];
const DASH = '—';
const PLACEHOLDER = new RegExp(`(['"\`])${DASH}\\1`, 'g');

function proseDashLines(rel: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  readFileSync(join(SRC, rel), 'utf8')
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
      const code = line.replace(PLACEHOLDER, '').replace(/\s\/\/.*$/, '');
      if (code.includes(DASH) || code.includes('&mdash;')) out.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
    });
  return out;
}

describe('no em dash in the owner panel or the LP farm copy', () => {
  it.each(FILES)('%s', (rel) => {
    expect(proseDashLines(rel)).toEqual([]);
  });
});
