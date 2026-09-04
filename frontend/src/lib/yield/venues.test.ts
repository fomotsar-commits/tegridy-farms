// THE CATALOGUE'S TWO PROMISES, pinned.
//
// First: exactly the verified rows route, and every other row says why it does
// not. The routable set is written out as a CONCRETE list rather than as
// `expect(routable).toBe(routable)`, which would pass for any implementation —
// including one that wired an address nobody verified. Adding or dropping a
// destination is meant to break this file first.
//
// Second: every row can say whose risk the depositor is taking. A yield table
// whose rate column is populated and whose counterparty column is not is the
// exact shape of the thing this slice was written to avoid.

import { describe, it, expect } from 'vitest';
import {
  hasRoutableYieldVenue,
  routableYieldVenues,
  yieldVenue,
  yieldVenueAvailability,
  yieldVenues,
  type YieldVenueAvailability,
} from './venues';

describe('the catalogue is a comparison, not a router', () => {
  it('has venues at all — a zero-length table would pass everything below vacuously', () => {
    expect(yieldVenues().length).toBeGreaterThan(4);
  });

  it('routes exactly the venues whose deposit path was verified on-chain', () => {
    expect(routableYieldVenues().map((v) => v.id)).toEqual([
      'lido-steth',
      'rocketpool-reth',
      'etherfi-weeth',
      'renzo-ezeth',
      'aave-v3-usdc',
      'compound-v3-usdc',
      'sky-susds',
    ]);
  });

  it('requires BOTH an address and a route before it calls a row routable', () => {
    // Either half alone is a lie: an address with no route renders an enabled
    // button with nothing behind it, and a route with no address is a call to
    // nowhere.
    for (const venue of routableYieldVenues()) {
      expect(venue.route.kind, `${venue.id} is routable with no route`).not.toBe('none');
      expect(venue.depositTarget, `${venue.id} is routable with no address`).not.toBe(
        '0x0000000000000000000000000000000000000000',
      );
      expect(venue.depositTarget).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('keeps cbETH as a comparison for a reason no operator can wire away', () => {
    // The generic "this build carries no deposit address" sentence would tell a
    // reader an operator could fix this. Nobody can: there is no public mint.
    const availability = yieldVenueAvailability('coinbase-cbeth');
    expect(availability!.routable).toBe(false);
    const refused = availability as Extract<YieldVenueAvailability, { routable: false }>;
    expect(refused.reason).toMatch(/Coinbase/);
    expect(refused.reason).toMatch(/no public contract/);
    expect(refused.reason).not.toMatch(/carries no deposit address/);
    expect(refused.venue.id).toBe('coinbase-cbeth');
  });

  it('keeps the venue attached to every refusal, so the comparison survives the gate', () => {
    for (const venue of yieldVenues()) {
      const availability = yieldVenueAvailability(venue.id);
      expect(availability, `${venue.id} is missing from availability`).not.toBeNull();
      if (availability!.routable) continue;
      const refused = availability as Extract<YieldVenueAvailability, { routable: false }>;
      expect(refused.venue.id).toBe(venue.id);
      expect(refused.reason.length).toBeGreaterThan(40);
    }
  });

  it('agrees with itself: something routes, so the nav pill comes off', () => {
    expect(routableYieldVenues().length).toBeGreaterThan(0);
    expect(hasRoutableYieldVenue()).toBe(true);
  });

  it('names the moving asset and the receipt token on every button, and never says "Route"', () => {
    // "Route into stETH" told a visitor nothing about what leaves their wallet.
    for (const venue of routableYieldVenues()) {
      const route = venue.route;
      if (route.kind === 'none') throw new Error('unreachable');
      const moving = route.kind === 'erc20-supply' ? route.asset.symbol : 'ETH';
      expect(route.cta, `${venue.id} does not name the asset that moves`).toContain(moving);
      expect(route.cta, `${venue.id} does not name its receipt token`).toContain(venue.symbol);
      expect(route.cta, `${venue.id} still says "Route"`).not.toMatch(/Route/);
    }
  });
});

describe('every row can name the risk before it names a rate', () => {
  it('gives each venue a counterparty and a specific loss mode', () => {
    for (const venue of yieldVenues()) {
      expect(venue.counterparty.trim().length, `${venue.id} names no counterparty`).toBeGreaterThan(30);
      expect(venue.riskNote.trim().length, `${venue.id} states no loss mode`).toBeGreaterThan(60);
    }
  });

  it('refuses to compress risk into a score, a grade or a tier', () => {
    // A number beside a protocol's name is read as a rating, and this venue is
    // in no position to rate anybody. The disclosure is prose or it is nothing.
    for (const venue of yieldVenues()) {
      expect(
        /\b(risk (score|rating|grade)|score:|rated?\s+[A-F]\b|\b[1-9]\s*\/\s*10\b)/i.test(
          `${venue.counterparty} ${venue.riskNote}`,
        ),
        `${venue.id} compresses its risk into a score`,
      ).toBe(false);
    }
  });

  it('gives each venue a unique id and a peg reference its column can use', () => {
    const ids = yieldVenues().map((v) => v.id);
    expect(new Set(ids).size, `duplicate venue id: ${ids.join(', ')}`).toBe(ids.length);
    for (const venue of yieldVenues()) {
      expect(['ETH', 'USD']).toContain(venue.pegReference);
    }
  });

  it('carries both halves of the brief: staking venues AND third-party stable markets', () => {
    expect(yieldVenues(['lst', 'lrt']).length).toBeGreaterThan(2);
    expect(yieldVenues('stable-lending').length).toBeGreaterThan(1);
    // The one claim the stablecoin panel exists to make: the venue issues none of
    // them. Every stable row is somebody else's market, by somebody else's name.
    for (const venue of yieldVenues('stable-lending')) {
      expect(venue.issuer.toLowerCase()).not.toContain('tegridy');
      expect(venue.issuer.toLowerCase()).not.toContain('toweli');
    }
  });
});

describe('lookups do not invent rows', () => {
  it('returns null for an id the catalogue does not carry', () => {
    expect(yieldVenue('not-a-venue')).toBeNull();
    expect(yieldVenueAvailability('not-a-venue')).toBeNull();
  });

  it('filters by kind without leaking other kinds in', () => {
    for (const venue of yieldVenues('lrt')) expect(venue.kind).toBe('lrt');
    for (const venue of yieldVenues(['lst', 'lrt'])) expect(venue.kind).not.toBe('stable-lending');
  });
});
