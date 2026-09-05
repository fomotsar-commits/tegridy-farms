// Settled-door luminance normalisation — the lock-step between
// scripts/generate-image-derivatives.mjs and what VenueDoors actually renders.
//
// Same shape of guard as artSrcSet.test.ts, and for the same reason: the script
// and the runtime encode one convention in two places, and a drift between them
// does not throw. Here it degrades silently to the exact bug this fixed — a door
// with no entry falls back to plain `grayscale(1)` and lands wherever its
// painting's own exposure puts it, which for wrestler.jpg is 0.270 against a
// 0.46 target. One tile reading as switched off in a hall of thirteen is not a
// visible failure to anyone who did not measure it.
//
// The most likely drift by far is a curator swapping a door's art, or a new
// bungalow being added, without `prebuild` being re-run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import LUMA from './doorThumbLuma.generated.json';
import { BUNGALOWS } from './bungalows';

const entries = LUMA as Record<string, number>;

const script = readFileSync(
  resolve(process.cwd(), 'scripts/generate-image-derivatives.mjs'),
  'utf8',
);
/** Pull a numeric constant out of the generator so the bounds are never retyped. */
function scriptConst(name: string): number {
  const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(script);
  if (!m) throw new Error(`could not read ${name} from the generator`);
  return Number(m[1]);
}
const LUMA_MIN = scriptConst('LUMA_MIN');
const LUMA_MAX = scriptConst('LUMA_MAX');

describe('door thumbnail luminance manifest', () => {
  it('is populated — an empty manifest silently disables the whole treatment', () => {
    expect(Object.keys(entries).length).toBeGreaterThan(0);
  });

  it('covers every bungalow thumbnail the hall renders', () => {
    // A door with no entry is not a crash, it is an un-normalised tile — so this
    // asserts coverage rather than waiting for someone to notice a dark card.
    const missing = BUNGALOWS
      .map((b) => b.thumb)
      .filter((t): t is string => typeof t === 'string')
      .filter((t) => !(t in entries));
    expect(missing, 're-run `npm run prebuild` after changing door art').toEqual([]);
  });

  it('keeps every multiplier inside the generator\'s own clamp', () => {
    // Outside the clamp means shadow noise gets lifted with the subject: the tile
    // stops being too dark and starts being ugly.
    for (const [url, k] of Object.entries(entries)) {
      expect(k, `${url} multiplier out of range`).toBeGreaterThanOrEqual(LUMA_MIN);
      expect(k, `${url} multiplier out of range`).toBeLessThanOrEqual(LUMA_MAX);
    }
  });

  it('actually corrects in both directions', () => {
    // If every multiplier landed on one side of 1, the manifest would be dimming
    // or brightening the whole hall rather than evening it out — which is the
    // blanket treatment this replaced, wearing a different number.
    const ks = Object.values(entries);
    expect(ks.some((k) => k > 1), 'nothing is being brightened').toBe(true);
    expect(ks.some((k) => k < 1), 'nothing is being darkened').toBe(true);
  });
});
