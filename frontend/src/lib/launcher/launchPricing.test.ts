// The creator revenue share moves real money permanently, so the properties pinned here are
// the ones a mined launch cannot recover from: the total, the Doppler floor, the cap, and
// that the dial does nothing until an operator turns it on. Above them sits the island's
// law of 2026-09-28, "Same price for everyone.": no wallet's heat reaches the price.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import {
  MAX_CREATOR_FEE_SHARE_BPS,
  STANDARD_VENUE_LINE_BPS,
  creatorFeeShareOfVenueBps,
  isCreatorFeeShareEnabled,
  isStandardPricing,
  pricingNote,
  resolveLaunchPricing,
  standardLaunchPricing,
  toPricingDisclosure,
  type ResolvedLaunchPricing,
} from './launchPricing';
import { resolveFeeConstitution, wizardConfigToLaunchConfig, type LaunchWizardInput } from './launchService';
import { feeConstitutionToBeneficiaries } from './airlock';
import { buildFactSheet, type RawTokenFacts } from './gate';
import { canonicalDisclosuresJson, disclosuresDigest } from './attestation';

const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
const KOL = '0x00000000000000000000000000000000000000AA' as Address;
const TOKEN = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca' as Address;

const sum = (lines: { shareBps: number }[]) => lines.reduce((n, l) => n + l.shareBps, 0);
const share = (lines: { role: string; shareBps: number }[], role: string) =>
  lines.filter((l) => l.role === role).reduce((n, l) => n + l.shareBps, 0);

/** A price with the creator revenue share on, at `creatorShareOfVenueBps` of the venue's line. */
const withShare = (creatorShareOfVenueBps: number) =>
  resolveLaunchPricing({ creatorShareEnabled: true, creatorShareOfVenueBps });

afterEach(() => vi.unstubAllEnvs());

describe('Same price for everyone', () => {
  // The island: "Same price for everyone." and "Heat says who. $BAYLA says how much."
  // Heat decides who may launch (the gate); it never decides what a launch costs.
  it('the launch price does not depend on heat', () => {
    // The pricing module cannot read heat at all: nothing from lib/heat, static or dynamic.
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'launcher', 'launchPricing.ts'), 'utf8');
    expect(src).not.toMatch(/(?:from|import\()\s*['"][^'"]*\/heat(?:\/|['"])/);

    // And nothing a caller hands in about a wallet's heat can move the price, even with the
    // deleted dial's env vars set to a steep table.
    vi.stubEnv('VITE_LAUNCH_TIER_PRICING', 'on');
    vi.stubEnv('VITE_LAUNCH_TIER_VENUE_BPS', 'Elder:100,Builder:300,Resident:600,Observer:1000,Drifter:1400');
    const price = resolveLaunchPricing as (...args: unknown[]) => ResolvedLaunchPricing;
    const everyone = price();
    expect(everyone.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    for (const tier of ['Elder', 'Builder', 'Resident', 'Observer', 'Drifter']) {
      for (const state of ['WARM', 'COLD', 'STALE']) {
        expect(price({ tier, state }), `${tier} ${state} changed the price`).toEqual(everyone);
      }
    }
  });
});

describe('the shipped default is today, unchanged', () => {
  it('the dial is OFF with no env set', () => {
    expect(isCreatorFeeShareEnabled()).toBe(false);
    expect(creatorFeeShareOfVenueBps()).toBe(0);
  });

  it('the standard venue line is the one the shipped constitution charges', () => {
    expect(STANDARD_VENUE_LINE_BPS).toBe(1500);
  });

  it('the default price moves nothing and discloses nothing', () => {
    const p = standardLaunchPricing();
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(p.creatorShareBps).toBe(0);
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
});

describe('creator revenue share: carved from the venue line, never from the pool', () => {
  it('routes a share of the venue take to the creator', () => {
    const p = withShare(4000);
    expect(p.creatorShareBps).toBe(600); // 40% of 1500
    expect(p.venueBps).toBe(900);
    expect(p.creatorShareBps + p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);

    const lines = resolveFeeConstitution(CREATOR, [], undefined, p);
    expect(share(lines, 'creator')).toBe(8600);
    expect(share(lines, 'protocol-stakers')).toBe(900);
    expect(share(lines, 'doppler')).toBe(500);
    expect(sum(lines)).toBe(10_000);
    // The locker is the real acceptance test: it rejects anything that is not exactly 1e18.
    expect(() => feeConstitutionToBeneficiaries(lines)).not.toThrow();
  });

  it('the largest share still leaves a set the locker accepts', () => {
    const lines = resolveFeeConstitution(CREATOR, [], undefined, withShare(MAX_CREATOR_FEE_SHARE_BPS));
    expect(share(lines, 'protocol-stakers')).toBe(750);
    expect(sum(lines)).toBe(10_000);
    expect(() => feeConstitutionToBeneficiaries(lines)).not.toThrow();
  });

  it('ignores an out-of-band share rather than obeying it', () => {
    const over = withShare(MAX_CREATOR_FEE_SHARE_BPS + 1);
    expect(over.creatorShareBps).toBe(0);
    expect(over.venueBps).toBe(STANDARD_VENUE_LINE_BPS);

    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', '99999');
    expect(creatorFeeShareOfVenueBps()).toBe(0);
    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', 'half');
    expect(creatorFeeShareOfVenueBps()).toBe(0);
    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', '4000');
    expect(creatorFeeShareOfVenueBps()).toBe(4000);
  });

  it('the flag alone moves nothing: a flag and a price are two decisions', () => {
    vi.stubEnv('VITE_CREATOR_FEE_SHARE', 'on');
    expect(isCreatorFeeShareEnabled()).toBe(true);
    expect(resolveLaunchPricing().venueBps).toBe(STANDARD_VENUE_LINE_BPS);
  });

  it('both env vars together reach the resolver', () => {
    vi.stubEnv('VITE_CREATOR_FEE_SHARE', 'on');
    vi.stubEnv('VITE_CREATOR_FEE_SHARE_BPS', '4000');
    expect(resolveLaunchPricing().creatorShareBps).toBe(600);
  });

  it('rounds the odd basis point to the venue, never to the creator', () => {
    const p = withShare(3333); // 1500 * 0.3333 = 499.95
    expect(p.creatorShareBps).toBe(499);
    expect(p.venueBps).toBe(1001);
  });
});

describe('the published split is the deployed split', () => {
  const wizard = (): LaunchWizardInput => ({
    tier: 'listable',
    name: 'Test Coin',
    symbol: 'TEST',
    tokenURI: 'ipfs://meta',
    totalSupply: '1000000',
    premineBps: 0,
    vestMonths: 0,
    lpLockMonths: 1,
    mcapStartK: 100,
    mcapFloorK: 10,
  });
  const cfg = (pricing?: ResolvedLaunchPricing) =>
    wizardConfigToLaunchConfig(wizard(), {
      userAddress: CREATOR,
      attentionSplits: [],
      numerairePriceUsd: 3000,
      ...(pricing ? { pricing } : {}),
    });

  it('the launch config carries the priced constitution, and it still sums to 10000', () => {
    const lines = cfg(withShare(4000)).feeConstitution;
    expect(sum(lines)).toBe(10_000);
    expect(share(lines, 'protocol-stakers')).toBe(900);
    expect(share(lines, 'creator')).toBe(8600);
    expect(share(lines, 'doppler')).toBe(500);
  });

  it('omitting the price yields exactly the split every launch ships with today', () => {
    expect(cfg(standardLaunchPricing()).feeConstitution).toEqual(cfg().feeConstitution);
  });
});

describe('pricing disclosure', () => {
  it('publishes the resolved numbers, not the template', () => {
    const p = withShare(3000);
    const d = toPricingDisclosure(p)!;
    expect(d.venueShareBps).toBe(1050);
    expect(d.standardVenueShareBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(d.creatorRevenueShareBps).toBe(450);
  });

  it('always states that the split cannot be changed after launch', () => {
    expect(pricingNote(withShare(4000))).toMatch(/cannot be changed afterwards/i);
    expect(pricingNote(standardLaunchPricing())).toMatch(/cannot be changed afterwards/i);
  });

  it('never projects earnings', () => {
    expect(pricingNote(withShare(5000))).not.toMatch(/will earn|expected|projected|estimate/i);
  });
});

// The digest is published on-chain and is permanent. A standard-rate sheet must hash exactly
// as a sheet without pricing, or every earlier attestation is orphaned; a priced sheet must
// hash differently, or the price is a claim outside the thing that commits to it.
describe('the on-chain digest', () => {
  function raw(over: Partial<RawTokenFacts> = {}): RawTokenFacts {
    return {
      token: TOKEN,
      chainId: 1,
      name: 'Test Coin',
      symbol: 'TEST',
      totalSupply: 1_000_000n * 10n ** 18n,
      owner: null,
      ownerRenounced: true,
      ownerIsTimelock: false,
      tokenFactory: null,
      templateCodehash: null,
      powers: { mint: false, pause: false, blacklist: false, feeOnTransfer: false, upgrade: false, balanceLimit: false },
      liquidity: { locked: true, locker: null, unlockAt: 1_900_000_000 },
      feeConstitution: [],
      vesting: [],
      teamAllocationBps: 0,
      teamAllocationVestedBps: 0,
      observedAt: 1_786_104_024,
      ...over,
    } as RawTokenFacts;
  }

  it('is unmoved by a standard-rate launch', () => {
    const standard = buildFactSheet(raw());
    expect(standard.pricing).toBeUndefined();
    expect(canonicalDisclosuresJson(standard)).not.toContain('pricing');
    const undisclosed = buildFactSheet(raw({ pricing: toPricingDisclosure(standardLaunchPricing()) }));
    expect(disclosuresDigest(undisclosed)).toBe(disclosuresDigest(standard));
  });

  it('commits to a price when there was one', () => {
    const priced = buildFactSheet(raw({ pricing: toPricingDisclosure(withShare(4000)) }));
    expect(canonicalDisclosuresJson(priced)).toContain('creatorRevenueShareBps');
    expect(disclosuresDigest(priced)).not.toBe(disclosuresDigest(buildFactSheet(raw())));
  });
});
