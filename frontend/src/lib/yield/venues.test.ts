// THE CATALOGUE'S TWO PROMISES, pinned.
//
// First: nothing here routes. Every deposit target is the zero address, so the
// page compares and cannot deposit — and the assertion is written as a CONCRETE
// value read out of the table rather than as `expect(routable).toBe(routable)`,
// which would pass for any implementation including one that wired a live
// address. Wiring a destination is meant to break this file first.
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

  it('carries no deposit address on any row', () => {
    for (const venue of yieldVenues()) {
      expect(venue.depositTarget, `${venue.id} has a wired deposit target`).toBe(
        '0x0000000000000000000000000000000000000000',
      );
    }
  });

  it('reports every row unroutable, with a reason a reader can act on', () => {
    for (const venue of yieldVenues()) {
      const availability = yieldVenueAvailability(venue.id);
      expect(availability, `${venue.id} is missing from availability`).not.toBeNull();
      expect(availability!.routable, `${venue.id} claims to be routable`).toBe(false);
      const refused = availability as Extract<YieldVenueAvailability, { routable: false }>;
      // The venue travels WITH the refusal: the row still renders its
      // counterparty and its risk note, so the comparison survives the gate.
      expect(refused.venue.id).toBe(venue.id);
      expect(refused.reason.length).toBeGreaterThan(40);
    }
  });

  it('agrees with itself: nothing routable, so the nav pill stays on', () => {
    expect(routableYieldVenues()).toEqual([]);
    expect(hasRoutableYieldVenue()).toBe(false);
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
