// GHOST-CODE GUARD.
//
// `useAutoRefreshBoost` was written in April, announced in the changelog, and
// imported by nothing until August. For four months the app claimed a behaviour
// no code path could reach, and every test in the suite was green the whole
// time, because a hook nobody mounts is a hook nobody's tests exercise either.
//
// The rule this pins: a hook in src/hooks is either reachable from the app, or
// it is listed below with the reason it is not. Neither is optional. Deleting a
// hook is also a legitimate way to make this pass — an unreachable hook that
// nobody will claim is dead weight, not an asset.
//
// This checks REACHABILITY, not correctness. Being imported proves only that the
// code can run; whether it runs correctly is what each hook's own test file is
// for, and this guard is worthless without those.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const HOOKS = join(SRC, 'hooks');

/**
 * Hooks that are deliberately not mounted, each with the boundary that stops it.
 * A regex, so a family of files can be exempted by the reason they share rather
 * than by name-by-name churn.
 *
 * Adding an entry here is a claim someone can check. Adding one without a real
 * boundary is how the thing this file exists to prevent comes back.
 */
const UNMOUNTED_BY_DESIGN: Array<{ pattern: RegExp; because: string }> = [
  {
    pattern: /^useIndexed/,
    because:
      'F1 indexer consumers: there is no hosted GraphQL endpoint yet (VITE_INDEXER_URL unset), ' +
      'so wiring them to a page would render an unconditional no-data state.',
  },
  {
    pattern: /^useOneClickLaunchBuy$/,
    because:
      'EIP-5792 launch-buy: needs the Doppler SDK-encoded V4 UniversalRouter swap call, which no ' +
      'module produces yet, AND a launch-buy surface, which cannot exist while isLauncherEnabled() ' +
      'is false. Mounting it would ship a button that cannot build its own calldata.',
  },
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

const hookNames = readdirSync(HOOKS)
  .filter((f) => /^use[A-Z].*\.tsx?$/.test(f) && !/\.test\./.test(f))
  .map((f) => f.replace(/\.tsx?$/, ''));

const allSources = walk(SRC);

/** Every non-test module that imports `name` from anywhere, excluding itself. */
function importersOf(name: string): string[] {
  const spec = new RegExp(`from\\s+['"][^'"]*\\b${name}['"]`);
  return allSources.filter((f) => {
    if (f.endsWith(join('hooks', `${name}.ts`)) || f.endsWith(join('hooks', `${name}.tsx`))) return false;
    return spec.test(readFileSync(f, 'utf-8'));
  });
}

describe('every hook is reachable from the app, or says why not', () => {
  it('found the hooks directory — a zero-length list would pass vacuously', () => {
    expect(hookNames.length).toBeGreaterThan(30);
  });

  for (const name of hookNames) {
    const exemption = UNMOUNTED_BY_DESIGN.find((e) => e.pattern.test(name));

    if (exemption) {
      it(`${name} is exempt and stays honest about it`, () => {
        // The exemption is not a licence to stay dark forever. One exempt hook
        // importing another is still unreachable from the app; a PAGE or
        // COMPONENT importing it means it shipped, and the exemption is stale.
        const reachable = importersOf(name).filter((f) => !f.startsWith(HOOKS));
        expect(
          reachable,
          `${name} is imported outside src/hooks, so its exemption ("${exemption.because}") is stale — remove it`,
        ).toEqual([]);
      });
      continue;
    }

    it(`${name} is imported by something that is not a test`, () => {
      expect(
        importersOf(name).length,
        `${name} is mounted nowhere. Wire it up, delete it, or add it to UNMOUNTED_BY_DESIGN with the boundary that blocks it.`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('the two hooks this guard was written for', () => {
  it('useAutoRefreshBoost reaches the surfaces that display the boosted figure', () => {
    const importers = importersOf('useAutoRefreshBoost').map((f) => f.replace(SRC, ''));
    expect(importers.some((f) => /FarmPage/.test(f))).toBe(true);
    expect(importers.some((f) => /DashboardPage/.test(f))).toBe(true);
  });

  it('useOneClickStake reaches the staking surface', () => {
    const importers = importersOf('useOneClickStake').map((f) => f.replace(SRC, ''));
    expect(importers.some((f) => /FarmPage/.test(f))).toBe(true);
  });
});
