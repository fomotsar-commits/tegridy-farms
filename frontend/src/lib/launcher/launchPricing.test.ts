// Two dials that permanently move real money, so the properties pinned here are the ones
// that cannot be recovered from after a launch mines: the total, the Doppler floor, the
// direction of the discount, and the fact that neither dial does anything until an
// operator turns it on.

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Address } from 'viem';
import type { HeatTier } from '../heat/heatOracle';
import {
  HEAT_TIER_VENUE_LINE_BPS,
  MAX_CREATOR_FEE_SHARE_BPS,
  STANDARD_VENUE_LINE_BPS,
  TIERS_WARMEST_FIRST,
  creatorFeeShareOfVenueBps,
  heatTierVenueTable,
  isCreatorFeeShareEnabled,
  isHeatTierPricingEnabled,
  isPriceableReading,
  isStandardPricing,
  parseTierTable,
  pricingNote,
  pricingRefusal,
  resolveLaunchPricing,
  standardLaunchPricing,
  tierTableFault,
  toPricingDisclosure,
  venueLineBps,
  type TierReading,
} from './launchPricing';
import { resolveFeeConstitution } from './launchService';
import { feeConstitutionToBeneficiaries } from './airlock';

const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
const KOL = '0x00000000000000000000000000000000000000AA' as Address;

const warm = (tier: HeatTier): TierReading => ({ tier, state: 'WARM' });
const sum = (lines: { shareBps: number }[]) => lines.reduce((n, l) => n + l.shareBps, 0);
const share = (lines: { role: string; shareBps: number }[], role: string) =>
  lines.filter((l) => l.role === role).reduce((n, l) => n + l.shareBps, 0);

afterEach(() => vi.unstubAllEnvs());

describe('the shipped default is today, unchanged', () => {
  it('both dials are OFF with no env set', () => {
    expect(isHeatTierPricingEnabled()).toBe(false);
    expect(isCreatorFeeShareEnabled()).toBe(false);
    expect(creatorFeeShareOfVenueBps()).toBe(0);
  });

  it('the table is flat at the rate the shipped constitution already charges', () => {
    for (const tier of TIERS_WARMEST_FIRST) {
      expect(HEAT_TIER_VENUE_LINE_BPS[tier]).toBe(STANDARD_VENUE_LINE_BPS);
    }
    expect(STANDARD_VENUE_LINE_BPS).toBe(1500);
    expect(tierTableFault(HEAT_TIER_VENUE_LINE_BPS)).toBeNull();
  });

  it('the default price moves nothing and discloses nothing', () => {
    const p = standardLaunchPricing();
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(p.creatorBonusBps).toBe(0);
    expect(isStandardPricing(p)).toBe(true);
    expect(toPricingDisclosure(p)).toBeUndefined();
  });

  it('the resolved constitution is byte-identical to the un-priced one', () => {
    const before = resolveFeeConstitution(CREATOR, [{ address: KOL, shareBps: 1500 }]);
    const after = resolveFeeConstitution(CREATOR, [{ address: KOL, shareBps: 1500 }], undefined, standardLaunchPricing());
    expect(after).toEqual(before);
    expect(share(before, 'protocol-stakers')).toBe(1500);
    expect(share(before, 'creator')).toBe(6500);
  });

  it('a warm wallet gets no discount while the dial is off', () => {
    const p = resolveLaunchPricing(warm('Elder'), { table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 500 } });
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(p.creatorBonusBps).toBe(0);
  });
});

describe('heat-tier pricing — warmer wallets launch cheaper', () => {
  const table: Record<HeatTier, number> = {
    Elder: 500,
    Builder: 800,
    Resident: 1100,
    Observer: 1500,
    Drifter: 1500,
  };
  const priced = (tier: HeatTier) => resolveLaunchPricing(warm(tier), { tierPricingEnabled: true, table });

  it('prices each tier off the table and hands the difference to the creator', () => {
    expect(priced('Elder').venueBps).toBe(500);
    expect(priced('Elder').tierDiscountBps).toBe(1000);
    expect(priced('Elder').creatorBonusBps).toBe(1000);
    expect(priced('Drifter').venueBps).toBe(1500);
    expect(priced('Drifter').creatorBonusBps).toBe(0);
  });

  it('is monotone: no colder tier ever pays less than a warmer one', () => {
    let previous = -1;
    for (const tier of TIERS_WARMEST_FIRST) {
      const bps = priced(tier).venueBps;
      expect(bps).toBeGreaterThanOrEqual(previous);
      previous = bps;
    }
  });

  it('the constitution still sums to 10000 with the Doppler floor intact', () => {
    for (const tier of TIERS_WARMEST_FIRST) {
      const lines = resolveFeeConstitution(CREATOR, [], undefined, priced(tier));
      expect(sum(lines)).toBe(10_000);
      expect(share(lines, 'doppler')).toBe(500);
      expect(share(lines, 'protocol-stakers')).toBe(priced(tier).venueBps);
      expect(share(lines, 'creator')).toBe(8000 + priced(tier).creatorBonusBps);
      // The locker is the real acceptance test: it rejects anything that is not exactly 1e18.
      expect(() => feeConstitutionToBeneficiaries(lines)).not.toThrow();
    }
  });

  it('a venue line priced to zero leaves no empty beneficiary in the locker set', () => {
    const free = resolveLaunchPricing(warm('Elder'), {
      tierPricingEnabled: true,
      table: { ...table, Elder: 0 },
    });
    const lines = resolveFeeConstitution(CREATOR, [], undefined, free);
    expect(share(lines, 'protocol-stakers')).toBe(0);
    expect(lines.some((l) => l.shareBps === 0)).toBe(false);
    expect(sum(lines)).toBe(10_000);
    expect(() => feeConstitutionToBeneficiaries(lines)).not.toThrow();
  });
});

describe('a price table may only ever discount, and only in the right direction', () => {
  it('rejects a tier priced above the standard line — these dials are not a fee raise', () => {
    const raised = { ...HEAT_TIER_VENUE_LINE_BPS, Drifter: STANDARD_VENUE_LINE_BPS + 100 };
    expect(tierTableFault(raised)).toMatch(/exceeds the standard/);
    // ...and a rejected table is never applied, even when injected directly.
    const p = resolveLaunchPricing(warm('Drifter'), { tierPricingEnabled: true, table: raised });
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
  });

  it('rejects an inverted table where a colder tier is cheaper than a warmer one', () => {
    expect(tierTableFault({ ...HEAT_TIER_VENUE_LINE_BPS, Elder: 1500, Drifter: 500 })).toMatch(/colder tier/);
  });

  it('rejects fractional bps', () => {
    expect(tierTableFault({ ...HEAT_TIER_VENUE_LINE_BPS, Elder: 999.5 })).toMatch(/whole number/);
  });
});

describe('an operator override is honoured whole or ignored whole', () => {
  it('parses a complete, well-ordered table', () => {
    expect(parseTierTable('Elder:500,Builder:800,Resident:1100,Observer:1500,Drifter:1500')).toEqual({
      Elder: 500,
      Builder: 800,
      Resident: 1100,
      Observer: 1500,
      Drifter: 1500,
    });
  });

  it.each([
    ['a missing tier', 'Elder:500,Builder:800,Resident:1100,Observer:1500'],
    ['an unknown tier word', 'Elder:500,Builder:800,Resident:1100,Observer:1500,Drifter:1500,Legend:0'],
    ['a duplicate tier', 'Elder:500,Elder:900,Builder:800,Resident:1100,Observer:1500,Drifter:1500'],
    ['a raise above the standard line', 'Elder:9000,Builder:9000,Resident:9000,Observer:9000,Drifter:9000'],
    ['an inverted table', 'Elder:1500,Builder:1400,Resident:1300,Observer:1200,Drifter:1100'],
    ['garbage', 'cheap for my friends'],
  ])('discards %s entirely rather than applying part of it', (_label, raw) => {
    expect(parseTierTable(raw)).toBeNull();
    vi.stubEnv('VITE_LAUNCH_TIER_VENUE_BPS', raw);
    expect(heatTierVenueTable()).toEqual(HEAT_TIER_VENUE_LINE_BPS);
  });

  it('a valid override reaches the resolver', () => {
    vi.stubEnv('VITE_LAUNCH_TIER_PRICING', 'on');
    vi.stubEnv('VITE_LAUNCH_TIER_VENUE_BPS', 'Elder:600,Builder:900,Resident:1200,Observer:1500,Drifter:1500');
    expect(resolveLaunchPricing(warm('Elder')).venueBps).toBe(600);
  });
});

describe('creator revenue share — carved from the venue line, never from the pool', () => {
  it('routes a share of the venue take to the creator', () => {
    const p = resolveLaunchPricing(warm('Resident'), {
      creatorShareEnabled: true,
      creatorShareOfVenueBps: 4000, // 40% of the venue's line, the battle plan's band
    });
    expect(p.creatorShareBps).toBe(600); // 40% of 1500
    expect(p.venueBps).toBe(900);
    expect(p.creatorBonusBps).toBe(600);

    const lines = resolveFeeConstitution(CREATOR, [], undefined, p);
    expect(share(lines, 'creator')).toBe(8600);
    expect(share(lines, 'protocol-stakers')).toBe(900);
    expect(share(lines, 'doppler')).toBe(500);
    expect(sum(lines)).toBe(10_000);
  });

  it('stacks with a tier discount without ever exceeding the venue line', () => {
    const p = resolveLaunchPricing(warm('Elder'), {
      tierPricingEnabled: true,
      table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 1000, Builder: 1200 },
      creatorShareEnabled: true,
      creatorShareOfVenueBps: 5000,
    });
    expect(p.tierDiscountBps).toBe(500);
    expect(p.creatorShareBps).toBe(500); // 50% of the TIERED 1000, not of the standard 1500
    expect(p.venueBps).toBe(500);
    expect(p.creatorBonusBps).toBe(1000);
    expect(p.creatorBonusBps + p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
  });

  it('ignores an out-of-band share rather than obeying it', () => {
    const over = resolveLaunchPricing(warm('Elder'), {
      creatorShareEnabled: true,
      creatorShareOfVenueBps: MAX_CREATOR_FEE_SHARE_BPS + 1,
    });
    expect(over.creatorShareBps).toBe(0);
    expect(over.venueBps).toBe(STANDARD_VENUE_LINE_BPS);

    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', '99999');
    expect(creatorFeeShareOfVenueBps()).toBe(0);
    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', 'half');
    expect(creatorFeeShareOfVenueBps()).toBe(0);
    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', '4000');
    expect(creatorFeeShareOfVenueBps()).toBe(4000);
  });

  it('the flag alone moves nothing — a flag and a price are two decisions', () => {
    vi.stubEnv('VITE_CREATOR_FEE_SHARE', 'on');
    expect(isCreatorFeeShareEnabled()).toBe(true);
    expect(resolveLaunchPricing(warm('Elder')).venueBps).toBe(STANDARD_VENUE_LINE_BPS);
  });

  it('rounds the odd basis point to the venue, never to the creator', () => {
    const p = resolveLaunchPricing(warm('Elder'), {
      creatorShareEnabled: true,
      creatorShareOfVenueBps: 3333, // 1500 * 0.3333 = 499.95
    });
    expect(p.creatorShareBps).toBe(499);
    expect(p.venueBps).toBe(1001);
  });
});

describe('the published split is the deployed split', () => {
  const priced = resolveLaunchPricing(warm('Elder'), {
    tierPricingEnabled: true,
    table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 900, Builder: 1200 },
  });

  it('reads the venue line back out of a resolved constitution', () => {
    const lines = resolveFeeConstitution(CREATOR, [], undefined, priced);
    expect(venueLineBps(lines)).toBe(priced.venueBps);
  });

  it('lets a launch through when it keeps at least what the live reading prices', () => {
    expect(pricingRefusal(1500, priced)).toBeNull(); // shown a worse price than live: their choice
    expect(pricingRefusal(900, priced)).toBeNull();
  });

  it('refuses a deeper discount than the live reading supports', () => {
    // The direction that matters: a stale screen minting a permanent price nobody earned.
    expect(pricingRefusal(500, priced)).toMatch(/Re-review/);
    expect(pricingRefusal(500, standardLaunchPricing())).toMatch(/Re-review/);
  });
});

describe('pricing disclosure', () => {
  it('publishes the resolved numbers, not the template', () => {
    const p = resolveLaunchPricing(warm('Builder'), {
      tierPricingEnabled: true,
      table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 700, Builder: 1000, Resident: 1200 },
      creatorShareEnabled: true,
      creatorShareOfVenueBps: 3000,
    });
    const d = toPricingDisclosure(p)!;
    expect(d.venueShareBps).toBe(p.venueBps);
    expect(d.standardVenueShareBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(d.tierDiscountBps).toBe(500);
    expect(d.creatorRevenueShareBps).toBe(300);
    expect(d.pricedAtTier).toBe('Builder');
    expect(d.tierReadable).toBeUndefined(); // absent means read
    expect(d.note).toContain('Builder');
  });

  it('always states that the split cannot be changed after launch', () => {
    const p = resolveLaunchPricing(warm('Elder'), { tierPricingEnabled: true });
    expect(pricingNote(p)).toMatch(/cannot be changed afterwards/i);
  });

  it('never projects earnings', () => {
    const p = resolveLaunchPricing(warm('Elder'), {
      tierPricingEnabled: true,
      creatorShareEnabled: true,
      creatorShareOfVenueBps: 5000,
    });
    expect(pricingNote(p)).not.toMatch(/will earn|expected|projected|estimate/i);
  });
});

describe('isPriceableReading', () => {
  it('accepts a fresh reading, warm or cold', () => {
    expect(isPriceableReading({ tier: 'Elder', state: 'WARM' })).toBe(true);
    expect(isPriceableReading({ tier: 'Drifter', state: 'COLD' })).toBe(true);
  });

  it('rejects everything the gate refuses to judge on', () => {
    expect(isPriceableReading({ tier: 'Elder', state: 'STALE' })).toBe(false);
    expect(isPriceableReading({ tier: null, state: 'STALE' })).toBe(false);
    expect(isPriceableReading(null)).toBe(false);
    expect(isPriceableReading(undefined)).toBe(false);
  });
});
