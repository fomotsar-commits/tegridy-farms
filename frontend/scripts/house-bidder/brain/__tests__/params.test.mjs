// @vitest-environment node
//
// Defaults that encode something measured on the live market, so a later "tidy-up" cannot quietly
// undo the reason they were chosen.
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from '../params.mjs';

describe('the loop reads enough of the book', () => {
  it('reads at least 200 cheapest listings each tick', () => {
    // On 2026-11-15 the cheapest 165 GNSS listings were 11-to-15-minute bot relists, too young to
    // count toward the listing check (each must be 30 minutes old). Reading 50 or 100 left GNSS with
    // no listing check at all, and the cheapest REAL listing out of the arbitrage line's sight.
    // OpenSea returns 200 in one read, so this costs no extra call.
    expect(DEFAULT_PARAMS.listingsLimit).toBeGreaterThanOrEqual(200);
  });
});
