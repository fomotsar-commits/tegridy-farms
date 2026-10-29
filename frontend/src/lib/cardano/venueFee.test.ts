import { describe, expect, it } from 'vitest';
import { CARDANO_VENUE_FEE_ADDRESS, CARDANO_VENUE_FEE_BPS, venueFeeAddress, venueFeeBps, venueFeeFor, venueFeeText } from './venueFee';
import { composeAddress } from './address';

const venue = composeAddress({ kind: 'key', hash: '9c'.repeat(28) }, { kind: 'key', hash: '93'.repeat(28) });

describe('the venue fee', () => {
  it('ships with no fee address, so no fee is charged until the owner registers one', () => {
    expect(CARDANO_VENUE_FEE_ADDRESS).toBeNull();
    expect(venueFeeFor(1_000_000_000n, 1_000_000n)).toEqual({ kind: 'none', reason: 'no-address' });
  });

  it('is 0.5% of the ADA side, rounded down', () => {
    expect(CARDANO_VENUE_FEE_BPS).toBe(50);
    expect(venueFeeFor(1_000_000_001n, 1_000_000n, { address: venue })).toEqual({ kind: 'charged', lovelace: 5_000_000n, bps: 50, address: venue });
  });

  it('is not charged when it would be under the least an output can hold', () => {
    expect(venueFeeFor(199_000_000n, 1_000_000n, { address: venue })).toEqual({ kind: 'none', reason: 'below-minimum' });
  });

  it('is not charged on a pair with no ADA side', () => {
    expect(venueFeeFor(null, 1_000_000n, { address: venue })).toEqual({ kind: 'none', reason: 'no-ada-side' });
  });

  it('turns off, never on, for a bad rate', () => {
    expect(venueFeeBps(101)).toBe(0);
    expect(venueFeeBps(-1)).toBe(0);
    expect(venueFeeBps(0.5)).toBe(0);
    expect(venueFeeBps(Number.NaN)).toBe(0);
    expect(venueFeeFor(1_000_000_000n, 1_000_000n, { address: venue, bps: 500 })).toEqual({ kind: 'none', reason: 'off' });
  });

  it('accepts only a mainnet address as the fee address', () => {
    expect(venueFeeAddress(venue.bech32)?.hex).toBe(venue.hex);
    expect(venueFeeAddress('addr_test1qz0000')).toBeNull();
    expect(venueFeeAddress('not an address')).toBeNull();
  });

  it('says the basis and who gets it, or why there is none', () => {
    expect(venueFeeText({ kind: 'charged', lovelace: 1n, bps: 50, address: venue })).toBe('0.5% of the ADA side · to the venue');
    expect(venueFeeText({ kind: 'none', reason: 'no-address' })).toMatch(/no Cardano fee address/);
    expect(venueFeeText({ kind: 'none', reason: 'below-minimum' })).toMatch(/on this size/);
  });
});
