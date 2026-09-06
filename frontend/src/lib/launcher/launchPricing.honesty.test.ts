// HONESTY GUARD — a price the island did not give may not be charged, named, or attested.
//
// The failure this file exists to make impossible: the Heat oracle goes down, the pricing
// resolver has no tier, and the surface renders *something* anyway. There are exactly two
// wrong somethings, and both have shipped in this repo before in other forms:
//
//   1. An outage reading as a legitimate value. `tier: null` degrading to 'Drifter' would
//      price an unmeasured wallet at the cold rate and print the word next to it — a claim
//      about a wallet nobody read, folded into an on-chain disclosures digest forever.
//   2. An outage reading as a legitimate BENEFIT. Falling back to the warmest price would
//      hand out a permanent discount the instrument never justified.
//
// The rule is the same one the gate itself uses: the absence of a positive answer denies.
// The standard rate is the fallback, the fallback is disclosed AS a fallback, and no tier
// word appears anywhere on that path.

import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import type { HeatTier } from '../heat/heatOracle';
import { gateDecision } from '../heat/heatOracle';
import {
  HEAT_TIER_VENUE_LINE_BPS,
  STANDARD_VENUE_LINE_BPS,
  TIERS_WARMEST_FIRST,
  pricingNote,
  readLaunchPricing,
  resolveLaunchPricing,
  tierReadingFromAudit,
  tierReadingFromDecision,
  toPricingDisclosure,
  type TierReading,
} from './launchPricing';
import { resolveFeeConstitution } from './launchService';
import { buildFactSheet, type RawTokenFacts } from './gate';
import { canonicalDisclosuresJson, disclosuresDigest } from './attestation';
import type { GateAuditRow } from '../heat/gateAudit';

const CREATOR = '0x1489a1B0dF0e5F7B2C4d3E6a7b8c9D0e1F2A3456' as Address;
const TOKEN = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca' as Address;

/** A generously discounted table, so any accidental fallback to a tier is loudly visible. */
const CHEAP: Record<HeatTier, number> = {
  Elder: 100,
  Builder: 300,
  Resident: 600,
  Observer: 1000,
  Drifter: 1400,
};

const ON = { tierPricingEnabled: true as const, table: CHEAP };

/** Every reading state the gate can hand a pricer that it is NOT allowed to price on. */
const UNPRICEABLE: [string, TierReading | null][] = [
  ['the oracle was unreachable', { tier: null, state: 'STALE' }],
  ['the reading was too old to judge on', { tier: 'Elder', state: 'STALE' }],
  ['no read happened at all', null],
];

describe('an unread instrument never earns a discount', () => {
  it.each(UNPRICEABLE)('prices at the standard rate when %s', (_label, reading) => {
    const p = resolveLaunchPricing(reading, ON);
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(p.tierDiscountBps).toBe(0);
    expect(p.creatorBonusBps).toBe(0);
    // The mutation this guards: falling back to ANY tier's price rather than to standard.
    for (const tier of TIERS_WARMEST_FIRST) {
      if (CHEAP[tier] !== STANDARD_VENUE_LINE_BPS) expect(p.venueBps).not.toBe(CHEAP[tier]);
    }
  });

  it.each(UNPRICEABLE)('names no tier when %s', (_label, reading) => {
    const p = resolveLaunchPricing(reading, ON);
    expect(p.pricedAtTier).toBeNull();
    expect(p.tierReadable).toBe(false);
    for (const tier of TIERS_WARMEST_FIRST) {
      expect(pricingNote(p)).not.toContain(tier);
    }
  });

  it('says the reading was missing rather than implying the wallet is cold', () => {
    const note = pricingNote(resolveLaunchPricing({ tier: null, state: 'STALE' }, ON));
    expect(note).toMatch(/no fresh heat reading/i);
    expect(note).toMatch(/no tier is claimed/i);
    expect(note).not.toMatch(/\bDrifter\b|\bcold\b/i);
  });

  it('the constitution it produces is exactly the un-priced one', () => {
    for (const [, reading] of UNPRICEABLE) {
      const lines = resolveFeeConstitution(CREATOR, [], undefined, resolveLaunchPricing(reading, ON));
      expect(lines).toEqual(resolveFeeConstitution(CREATOR, []));
    }
  });
});

describe('the disclosure declares its own limit', () => {
  it('emits tierReadable: false, the third state, only when the tier was unread', () => {
    const unread = toPricingDisclosure(resolveLaunchPricing({ tier: null, state: 'STALE' }, ON))!;
    expect(unread.tierReadable).toBe(false);
    expect(unread.pricedAtTier).toBeNull();

    const read = toPricingDisclosure(resolveLaunchPricing({ tier: 'Elder', state: 'WARM' }, ON))!;
    expect(read.tierReadable).toBeUndefined();
    expect(read.pricedAtTier).toBe('Elder');
  });

  it('a cold-but-fresh wallet is priced and named — it was actually measured', () => {
    // COLD is a real reading of a real wallet, distinct from STALE. Refusing to price it
    // would be the mirror error: treating a measured wallet as an unmeasured one.
    const p = resolveLaunchPricing({ tier: 'Drifter', state: 'COLD' }, ON);
    expect(p.pricedAtTier).toBe('Drifter');
    expect(p.tierReadable).toBe(true);
    expect(p.venueBps).toBe(CHEAP.Drifter);
  });
});

describe('readLaunchPricing — the async entry point reads the door, and nothing else', () => {
  it('a dark oracle prices at the standard rate rather than throwing or discounting', async () => {
    // No fetch in this environment: the door's own read fails, `meetsHeatFloor` returns
    // STALE rather than raising, and the price falls back the same way every other
    // unreadable state does.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const p = await readLaunchPricing(CREATOR, ON);
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(p.pricedAtTier).toBeNull();
    expect(p.tierReadable).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('the gate decision is the only source of the tier', () => {
  it('carries the gate primitive’s own STALE verdict straight through', () => {
    // Built from the real rule, not a hand-made shape: if gateDecision ever started
    // emitting a tier on an unreadable oracle, this would fail here first.
    const d = gateDecision(CREATOR, null, 1_800_000_000);
    expect(d.state).toBe('STALE');
    const p = resolveLaunchPricing(tierReadingFromDecision(d), ON);
    expect(p.pricedAtTier).toBeNull();
    expect(p.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
  });

  it('the audit row and the decision price identically', () => {
    const d = gateDecision(
      CREATOR,
      {
        address: CREATOR,
        degrees: 260,
        tier: 'Elder',
        isCold: false,
        heldSinceUnix: 1_700_000_000,
        asOfUnix: 1_800_000_000,
        tokenCount: 3,
        breakdown: [],
        observedAt: 1_800_000_000,
        xHandle: null,
      },
      1_800_000_000,
    );
    const row: GateAuditRow = {
      id: 'gd_test',
      address: d.address,
      degrees: d.degrees,
      tier: d.tier,
      as_of: d.asOfUnix,
      floor: d.floor,
      verdict: d.state,
      reason: d.reason,
      decided_at: d.decidedAt,
    };
    expect(resolveLaunchPricing(tierReadingFromAudit(row), ON)).toEqual(
      resolveLaunchPricing(tierReadingFromDecision(d), ON),
    );
  });
});

// The digest is published on-chain and is permanent. A sheet priced at the standard rate
// with both dials off must hash to exactly what it hashed before pricing existed, or every
// prior attestation is orphaned; a sheet that WAS priced must hash differently, or the
// price is a claim outside the thing that commits to it.
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
    const undisclosed = buildFactSheet(
      raw({ pricing: toPricingDisclosure(resolveLaunchPricing({ tier: 'Elder', state: 'WARM' })) }),
    );
    expect(disclosuresDigest(undisclosed)).toBe(disclosuresDigest(standard));
  });

  it('commits to a price when there was one', () => {
    const priced = buildFactSheet(raw({ pricing: toPricingDisclosure(resolveLaunchPricing({ tier: 'Elder', state: 'WARM' }, ON)) }));
    expect(priced.pricing?.pricedAtTier).toBe('Elder');
    expect(canonicalDisclosuresJson(priced)).toContain('Elder');
    expect(disclosuresDigest(priced)).not.toBe(disclosuresDigest(buildFactSheet(raw())));
  });

  it('commits to the ADMISSION that a tier was unread, so it cannot be forged out later', () => {
    const sheet = buildFactSheet(raw({ pricing: toPricingDisclosure(resolveLaunchPricing(null, ON)) }));
    expect(canonicalDisclosuresJson(sheet)).toContain('tierReadable');
    expect(disclosuresDigest(sheet)).not.toBe(
      disclosuresDigest(buildFactSheet(raw({ pricing: toPricingDisclosure(resolveLaunchPricing({ tier: 'Observer', state: 'WARM' }, ON)) }))),
    );
  });

  it('the flat default table never produces a disclosure at all', () => {
    for (const [, reading] of UNPRICEABLE) {
      expect(toPricingDisclosure(resolveLaunchPricing(reading, { table: HEAT_TIER_VENUE_LINE_BPS }))).toBeUndefined();
    }
  });
});
