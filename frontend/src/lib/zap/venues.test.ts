import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { venueAvailability, zapVenue, zapVenues } from './venues';
import {
  LP_FARMING_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  isDeployed,
} from '../constants';

describe('the venue catalog', () => {
  it('reports each venue against the addresses this build actually has', () => {
    const byId = Object.fromEntries(
      zapVenues().map((v) => [v.available ? v.venue.id : v.id, v]),
    );
    expect(byId['staking-lock']!.available).toBe(isDeployed(TEGRIDY_STAKING_ADDRESS));
    expect(byId['lp-farm']!.available).toBe(
      isDeployed(LP_FARMING_ADDRESS) && isDeployed(TEGRIDY_LP_ADDRESS) && isDeployed(TEGRIDY_ROUTER_ADDRESS),
    );
  });

  it('gives an unavailable venue a reason, never a bare false', () => {
    for (const entry of zapVenues()) {
      if (entry.available) continue;
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(zapVenue(entry.id)).toBeNull();
    }
  });

  it('names all three contracts an LP-shaped venue needs, so a partial deployment cannot read as ready', () => {
    // Not asserted through the live constants (router and LP are both set today, so the
    // branch would never run), asserted on the source, which is what a future zeroing
    // edits.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'zap', 'venues.ts'), 'utf-8');
    expect(source).toMatch(/isDeployed\(TEGRIDY_ROUTER_ADDRESS\)/);
    expect(source).toMatch(/isDeployed\(TEGRIDY_LP_ADDRESS\)/);
    expect(source).toMatch(/isDeployed\(venue\.target\)/);
  });
});

describe('venueAvailability', () => {
  it('returns the live-address answer for a venue that is available', () => {
    const staking = venueAvailability('staking-lock');
    if (!staking.available) {
      expect(staking.reason).toBeTruthy();
      return;
    }
    expect(staking.venue.target.toLowerCase()).toBe(TEGRIDY_STAKING_ADDRESS.toLowerCase());
  });
});

describe('venueAvailability: the LP farm after its rewards ended (owner, 2026-10-14)', () => {
  const ended = {
    open: false as const,
    reason: 'ended' as const,
    endedAtSec: 1_781_493_095,
    line: 'Rewards ended Jun 15, 2026, so new stakes are closed. Withdraw and claim still work.',
  };

  it('is not offered once a read says its rewards ended, and says why', () => {
    const farm = venueAvailability('lp-farm', ended);
    expect(farm.available).toBe(false);
    if (!farm.available) expect(farm.reason).toBe(ended.line);
    const listed = zapVenues(ended).find((v) => (v.available ? v.venue.id : v.id) === 'lp-farm');
    expect(listed?.available).toBe(false);
  });

  it('is not offered while the end is unread or being checked', () => {
    expect(venueAvailability('lp-farm', { open: false, reason: 'unread', line: 'x' }).available).toBe(false);
    expect(venueAvailability('lp-farm', { open: false, reason: 'checking', line: 'y' }).available).toBe(false);
  });

  it('a paying farm is offered (negative control), and the staking lock never asks', () => {
    expect(venueAvailability('lp-farm', { open: true }).available).toBe(venueAvailability('lp-farm').available);
    expect(venueAvailability('staking-lock', ended).available).toBe(venueAvailability('staking-lock').available);
  });
});
