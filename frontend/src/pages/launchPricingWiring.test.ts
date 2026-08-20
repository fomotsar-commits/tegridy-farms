// THE PRICE, WIRED — and the wiring proven to be a no-op today.
//
// launchPricing.ts and its two suites were written before anything called them: the
// resolver, the honesty guard and the constitution rewriter all existed, and
// LaunchPage.tsx built its config without ever mentioning a price. So both dials were
// inert END TO END no matter what an operator set, and no test would have noticed either
// way. This file is the join.
//
// It asserts two things that have to be true at the same time:
//
//   1. THE DEFAULT IS TODAY'S RATE, EXACTLY. With no env var set, the price this page
//      resolves is the standard venue line, the fee constitution it produces is deep-equal
//      to the one produced with no price at all, and no pricing disclosure is emitted — so
//      `disclosuresDigest` is byte-identical to every sheet computed before pricing
//      existed. Wiring the call site is NOT enabling a fee.
//
//   2. THE PAGE CANNOT ENABLE EITHER DIAL FROM CODE. The only inputs are the env vars, so
//      turning one on stays a config change with a record. A `tierPricingEnabled: true`
//      override appearing in the page would make the flag decorative.
//
// The behavioural half is asserted against the resolver rather than by rendering the
// wizard (which needs a wallet, a chain and an oracle). The structural half is a text
// assertion on LaunchPage.tsx, for the same reason launchPriceWiring.test.ts is one: the
// defect it catches — the `pricing` argument quietly dropped again — is not a type error
// and breaks no behavioural test, because the parameter is optional by design so that
// every pre-existing caller keeps today's economics.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import type { GateState, HeatTier } from '../lib/heat/heatOracle';
import { DEFAULT_FEE_CONSTITUTION } from '../lib/launcher/config';
import { resolveFeeConstitution } from '../lib/launcher/launchService';
import {
  HEAT_TIER_VENUE_LINE_BPS,
  STANDARD_VENUE_LINE_BPS,
  TIERS_WARMEST_FIRST,
  creatorFeeShareOfVenueBps,
  heatTierVenueTable,
  isCreatorFeeShareEnabled,
  isHeatTierPricingEnabled,
  isStandardPricing,
  resolveLaunchPricing,
  standardLaunchPricing,
  toPricingDisclosure,
} from '../lib/launcher/launchPricing';

const CREATOR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a' as Address;

/** Every reading the island can hand the pricer, warmest first, plus the unread ones. */
const READINGS: { label: string; reading: { tier: HeatTier | null; state: GateState } | null }[] = [
  ...TIERS_WARMEST_FIRST.map((tier) => ({ label: `${tier} / WARM`, reading: { tier, state: 'WARM' as GateState } })),
  ...TIERS_WARMEST_FIRST.map((tier) => ({ label: `${tier} / COLD`, reading: { tier, state: 'COLD' as GateState } })),
  { label: 'stale reading', reading: { tier: 'Elder' as HeatTier, state: 'STALE' as GateState } },
  { label: 'no reading at all', reading: null },
];

describe('the shipped environment sets neither dial', () => {
  // Pinned as CONCRETE facts about this environment before anything is derived from
  // them. If someone publishes a dial into the test env, THIS fails — loudly, and first —
  // rather than the assertions below silently inverting into "the discount is correct".
  it('has no pricing env vars set', () => {
    const env = import.meta.env as Record<string, string | undefined>;
    for (const key of [
      'VITE_LAUNCH_TIER_PRICING',
      'VITE_LAUNCH_TIER_VENUE_BPS',
      'VITE_CREATOR_FEE_SHARE',
      'VITE_CREATOR_FEE_SHARE_BPS',
    ]) {
      expect(env[key] ?? '', `${key} is set in this environment — read this test before changing it`).toBe('');
    }
  });

  it('reads both flags off and the creator share at zero', () => {
    expect(isHeatTierPricingEnabled()).toBe(false);
    expect(isCreatorFeeShareEnabled()).toBe(false);
    expect(creatorFeeShareOfVenueBps()).toBe(0);
  });

  it('uses the flat table, priced at the standard line on every tier', () => {
    expect(heatTierVenueTable()).toEqual(HEAT_TIER_VENUE_LINE_BPS);
    for (const tier of TIERS_WARMEST_FIRST) {
      expect(HEAT_TIER_VENUE_LINE_BPS[tier], `${tier} is not at today's rate`).toBe(STANDARD_VENUE_LINE_BPS);
    }
    // "Today's rate" is DERIVED from the shipped constitution, never typed twice, so this
    // assertion moves with the constitution instead of pinning a stale literal.
    expect(STANDARD_VENUE_LINE_BPS).toBe(
      DEFAULT_FEE_CONSTITUTION.filter((l) => l.role === 'protocol-stakers').reduce((n, l) => n + l.shareBps, 0),
    );
  });
});

describe('with no env set, the resolved price IS today’s flat rate', () => {
  const standard = standardLaunchPricing();

  it.each(READINGS.map((r) => [r.label, r.reading] as const))(
    'prices %s at the standard venue line, with nothing moved to the creator',
    (_label, reading) => {
      const priced = resolveLaunchPricing(reading);
      // The four numbers that move money. `pricedAtTier` / `tierReadable` legitimately
      // differ from `standardLaunchPricing()` — they describe the READING, not the price —
      // and the next test proves neither can reach a disclosure while the dials are off.
      expect(priced.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
      expect(priced.venueBps).toBe(standard.venueBps);
      expect(priced.tierDiscountBps).toBe(0);
      expect(priced.creatorShareBps).toBe(0);
      expect(priced.creatorBonusBps).toBe(0);
      expect(priced.tierPricingEnabled).toBe(false);
      expect(priced.creatorShareEnabled).toBe(false);
    },
  );

  it.each(READINGS.map((r) => [r.label, r.reading] as const))(
    'emits no pricing disclosure for %s, so the disclosures digest is unchanged',
    (_label, reading) => {
      const priced = resolveLaunchPricing(reading);
      expect(isStandardPricing(priced)).toBe(true);
      expect(toPricingDisclosure(priced)).toBeUndefined();
    },
  );

  it('produces a fee constitution deep-equal to the one built with no price at all', () => {
    // The strongest form of "equals today's flat rate exactly": the deployed split, line
    // for line, address for address, against the same call made the way every caller made
    // it before `pricing` existed.
    const withoutPricing = resolveFeeConstitution(CREATOR, []);
    for (const { label, reading } of READINGS) {
      expect(
        resolveFeeConstitution(CREATOR, [], undefined, resolveLaunchPricing(reading)),
        `${label} changed the deployed constitution`,
      ).toEqual(withoutPricing);
    }
    // And the venue's line in it is still the constitution's own protocol-stakers line.
    expect(
      withoutPricing.filter((l) => l.role === 'protocol-stakers').reduce((n, l) => n + l.shareBps, 0),
    ).toBe(STANDARD_VENUE_LINE_BPS);
    expect(withoutPricing.reduce((n, l) => n + l.shareBps, 0)).toBe(10_000);
  });
});

describe('LaunchPage actually threads the price it resolved', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'pages', 'LaunchPage.tsx'), 'utf8');
  /** Strip comments so prose about pricing never satisfies (or trips) a check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('resolves the price through the launcher’s own entry point, not its own oracle read', () => {
    expect(code).toMatch(/readLaunchPricing\(\s*address/);
    // The gate primitive belongs to launchPricing/launchGate; a page-level call would be a
    // second read that could disagree with the one the price was set from.
    expect(code).not.toMatch(/meetsHeatFloor\(/);
  });

  it('falls back to today’s rate, so a page that never read anything prices at standard', () => {
    expect(code).toMatch(/useMemo\(\(\) => standardLaunchPricing\(\),\s*\[\]\)/);
    // The ternary IS the fallback: anything other than a usable read resolves to the
    // standard line. Pinned because deleting the guard would silently make the last
    // reading the default.
    // Widened from {0,80} on 2026-08-20: the guard grew an explicit null test and
    // an address-defined test, so the conditional is longer than it was. The
    // assertion still pins what matters — the chain starts at pricingDialsOn and
    // every path that is not a usable read ends at standardPricing.
    expect(code).toMatch(/pricingDialsOn\s*&&[\s\S]{0,200}\?[\s\S]{0,80}:\s*standardPricing/);
  });

  it('never prices one wallet from another wallet’s reading', () => {
    // The stored reading carries the address it was taken for, and is used only while the
    // two still match — so switching accounts falls back to standard rather than leaving
    // the previous wallet's (possibly discounted) price on screen.
    expect(code).toMatch(/setPricingRead\(\{\s*address,\s*pricing:\s*next\s*\}\)/);
    // The comparison must survive, but the optional-chain form did not: it does
    // not narrow the later property access, and with no wallet connected BOTH
    // sides were undefined — so `pricingRead?.address === address` was true on a
    // null read, and the branch reached into it. It is now an explicit null test,
    // an address-defined test, and the same equality. Assert the equality and the
    // two guards rather than one exact spelling.
    expect(code).toMatch(/pricingRead\.address === address/);
    expect(code).toMatch(/pricingRead !== null/);
    expect(code).toMatch(/address !== undefined/);
  });

  it('hands the SAME resolved object to the Fact Sheet and to the launch config', () => {
    expect(code).toMatch(/projectFactSheet\(w,\s*now,\s*pricing\)/);
    // The launch call site — the line whose absence made both dials inert end to end.
    expect(code).toMatch(/wizardConfigToLaunchConfig\(w,\s*\{[\s\S]*?\bpricing,[\s\S]*?\}\)/);
  });

  it('prices the previewed constitution and the disclosure from it too', () => {
    expect(code).toMatch(/resolveFeeConstitution\([\s\S]*?\bpricing,[\s\S]*?\)/);
    expect(code).toMatch(/toPricingDisclosure\(pricing\)/);
  });

  it('never turns a dial on from code — the env vars are the only input', () => {
    // `resolveLaunchPricing`/`readLaunchPricing` accept overrides for tests and for a
    // caller that already resolved the dials. The page must not use them: a hardcoded
    // `true` here would price launches with the flag still off.
    expect(code).not.toMatch(/tierPricingEnabled\s*:/);
    expect(code).not.toMatch(/creatorShareEnabled\s*:/);
    expect(code).not.toMatch(/creatorShareOfVenueBps\s*:/);
  });
});
