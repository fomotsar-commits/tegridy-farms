// WHAT THE ISLAND HAS ACTUALLY CONFIRMED ABOUT THE INSTRUMENT — Wave 3, phase 06(b).
//
// The venue published a number the island never gave it. `heatOracle.ts` carried
// `TWAB_WINDOW_DAYS = 180` under the header "CONFIRMED BY THE ISLAND 2026-08-07", and
// an explainer built a whole mechanic on top of it: that the window ROLLS, so "a wallet
// that sells decays out of the average over the following 180 days". Both were rendered
// to users on /leaderboard.
//
// Wave 3 says plainly: that constant is not island-confirmed, and the decay story built
// on it is untrue. The instrument's confirmed properties are exactly three —
//
//     continuous · zero-anchored from first hold · velocity-blind
//
// — and wallets should be shown HELD TIME SINCE FIRST HOLD. No calendar. No decay
// schedule. Exact window semantics arrive from the island when they are published.
//
// This is the same defect class as the fee claims: an unknown published as a confident
// value. It is worse here, because the number was attributed to a third party who never
// said it. So these tests pin the RULE, not the wording: the venue may describe the
// three properties, and may not state a window length or a decay mechanic anywhere a
// user can read it.
//
// When the island publishes the window, delete the guard in `does not state an averaging
// window` and nothing else — the three properties stay true either way.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as oracle from './heatOracle';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Comments carry the correction notes, which quote the retired wording on purpose. */
function prose(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('the venue does not publish an averaging window the island has not given it', () => {
  it('exports no TWAB window constant', () => {
    // The number itself is the defect. While it exists, something will render it.
    expect(
      'TWAB_WINDOW_DAYS' in oracle,
      'heatOracle must not export a window length until the island publishes one',
    ).toBe(false);
  });

  it('states no averaging-window length in any user-facing source', () => {
    // Catches BOTH a literal ("over the last 180 days") and the interpolated constant
    // ("over the last {TWAB_WINDOW_DAYS} days"). The JSX form is how it actually
    // shipped, so a literal-only pattern would have passed on the live defect.
    const WINDOW_CLAIM =
      /(averaged over the last|averaging window|measurement window)[^.]{0,80}(\b\d+\s*days?\b|TWAB_WINDOW_DAYS)|\b\d+\s*[- ]day (?:averaging )?window|TWAB_WINDOW_DAYS/i;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const m = WINDOW_CLAIM.exec(prose(file));
      if (m) offenders.push(`${file.slice(SRC.length + 1)} — "${m[0]}"`);
    }
    expect(offenders, `an unpublished window length is stated here:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('describes no decay or roll-off mechanic', () => {
    // "Warmth is not banked; a wallet that sells decays out of the average" is a
    // mechanic the island never described. Velocity-blind is confirmed; decay is not.
    const DECAY = /(decays? out of|rolls? off|warmth is not banked|window\s+(?:that\s+)?rolls)/i;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const m = DECAY.exec(prose(file));
      if (m) offenders.push(`${file.slice(SRC.length + 1)} — "${m[0]}"`);
    }
    expect(offenders, `an unconfirmed decay mechanic is described here:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the three confirmed properties survive', () => {
  // The correction must not strip the instrument's real guarantees along with the
  // invented ones. Over-correcting is the failure mode on the other side.
  const heatCard = readFileSync(join(SRC, 'components', 'HeatCard.tsx'), 'utf8');

  it('still explains zero-anchoring from first hold', () => {
    expect(heatCard).toMatch(/before you first held counts as zero|zero[- ]anchored/i);
  });

  it('still explains velocity-blindness', () => {
    expect(heatCard).toMatch(/churn earns nothing|velocity[- ]blind/i);
  });

  it('still explains that it is continuous, not a snapshot', () => {
    expect(heatCard).toMatch(/balance at every\s+moment|continuous/i);
  });
});

describe('the launch floor is the island word, unchanged', () => {
  it('is 80 — Resident', () => {
    // Confirmed in writing by the island in Wave 3. Recorded so a future "tidy-up"
    // cannot drift it without failing here.
    expect(oracle.LAUNCH_FLOOR).toBe(80);
    const resident = oracle.TIER_FLOORS.find((t) => t.tier === 'Resident');
    expect(resident?.floor).toBe(80);
  });
});
