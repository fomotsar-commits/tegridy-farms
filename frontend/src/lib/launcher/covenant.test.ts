// The covenant is DORMANT. These tests exist to keep it that way, and to make an
// accidental activation loud.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COVENANT_SPLIT, covenantTotalBps, isCovenantActive, covenantFeeConstitution } from './covenant';

describe('the split as the island published it', () => {
  it('is 50/20/15/10/5', () => {
    expect(COVENANT_SPLIT.map((s) => s.shareBps)).toEqual([5000, 2000, 1500, 1000, 500]);
  });

  it('sums to 100% — a slice edited alone breaks this rather than rebalancing silently', () => {
    expect(covenantTotalBps()).toBe(10_000);
  });

  it('survives the round-trip into the venue’s own fee-line shape', () => {
    expect(covenantFeeConstitution().reduce((a, l) => a + l.shareBps, 0)).toBe(10_000);
  });
});

describe('dormancy', () => {
  it('is inactive', () => {
    expect(isCovenantActive()).toBe(false);
  });

  it('cannot be switched on by an env var — certified pools do not exist yet', () => {
    // Deliberately setting every plausible flag name. None of them may do anything:
    // an env-flippable fee split could be activated for pools that cannot be certified.
    const before = isCovenantActive();
    (import.meta.env as Record<string, unknown>).VITE_COVENANT = 'on';
    (import.meta.env as Record<string, unknown>).VITE_COVENANT_ACTIVE = 'true';
    (import.meta.env as Record<string, unknown>).VITE_COVENANT_SPLIT = '1';
    expect(isCovenantActive()).toBe(before);
    expect(isCovenantActive()).toBe(false);
  });
});

/**
 * The real guard: nothing on a launch path may import this module.
 *
 * "Covenant math active nowhere" is the directive's done-means, and a comment saying so
 * is not enforcement. This walks the launcher and heat trees and fails if anything other
 * than a display surface or this test reaches for it.
 */
describe('covenant math is active NOWHERE', () => {
  const ROOT = join(__dirname, '..', '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  }

  it('no launch-path module imports the covenant', () => {
    // The modules that actually build or submit a launch. If one of these grows an
    // import of covenant.ts, the split has stopped being dormant.
    const LAUNCH_PATH = [
      join(ROOT, 'lib', 'launcher', 'launchService.ts'),
      join(ROOT, 'lib', 'launcher', 'airlock.ts'),
      join(ROOT, 'lib', 'launcher', 'gate.ts'),
      join(ROOT, 'lib', 'launcher', 'config.ts'),
      join(ROOT, 'lib', 'launcher', 'solana', 'submitLaunch.ts'),
      join(ROOT, 'lib', 'launcher', 'solana', 'dbc.ts'),
    ];
    for (const f of LAUNCH_PATH) {
      expect(readFileSync(f, 'utf8'), `${f} imports covenant.ts`).not.toMatch(/from ['"].*covenant['"]/);
    }
  });

  it('the only importers anywhere are display code or this test', () => {
    const importers = walk(ROOT)
      .filter((f) => /from ['"][^'"]*\/covenant['"]|from ['"]\.\/covenant['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(ROOT, '').replace(/\\/g, '/'));
    // Today: nobody but this test. When a disclosure panel is built it may join this
    // list — a submit path may not.
    for (const f of importers) {
      expect(f, `${f} imports covenant.ts and is not display code`).toMatch(/covenant\.test\.ts$|components\//);
    }
  });
});
