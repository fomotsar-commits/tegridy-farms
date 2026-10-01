// THE PRICE, WIRED. With no env set it is today's rate exactly (same constitution, no
// disclosure, so `disclosuresDigest` is unchanged); the page cannot turn the dial on from
// code; and the page prices with no wallet, because the island rules "Same price for
// everyone." (2026-09-28). The page half reads LaunchPage.tsx as text: dropping the
// optional `pricing` argument again is not a type error and breaks no behavioural test.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { DEFAULT_FEE_CONSTITUTION } from '../lib/launcher/config';
import { resolveFeeConstitution } from '../lib/launcher/launchService';
import {
  STANDARD_VENUE_LINE_BPS,
  creatorFeeShareOfVenueBps,
  isCreatorFeeShareEnabled,
  isStandardPricing,
  resolveLaunchPricing,
  toPricingDisclosure,
} from '../lib/launcher/launchPricing';

const CREATOR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a' as Address;

describe('the shipped environment sets no pricing dial', () => {
  // Pinned as CONCRETE facts about this environment before anything is derived from them.
  // If someone publishes the dial into the test env, THIS fails first, rather than the
  // assertions below silently inverting.
  it('has no pricing env vars set', () => {
    const env = import.meta.env as Record<string, string | undefined>;
    for (const key of ['VITE_CREATOR_FEE_SHARE', 'VITE_CREATOR_FEE_SHARE_BPS']) {
      expect(env[key] ?? '', `${key} is set in this environment: read this test before changing it`).toBe('');
    }
  });

  it('reads the flag off and the creator share at zero', () => {
    expect(isCreatorFeeShareEnabled()).toBe(false);
    expect(creatorFeeShareOfVenueBps()).toBe(0);
  });

  it("derives today's rate from the shipped constitution, never typed twice", () => {
    expect(STANDARD_VENUE_LINE_BPS).toBe(
      DEFAULT_FEE_CONSTITUTION.filter((l) => l.role === 'protocol-stakers').reduce((n, l) => n + l.shareBps, 0),
    );
  });
});

describe("with no env set, the resolved price IS today's rate", () => {
  it('prices at the standard venue line, with nothing moved to the creator', () => {
    const priced = resolveLaunchPricing();
    expect(priced.venueBps).toBe(STANDARD_VENUE_LINE_BPS);
    expect(priced.creatorShareBps).toBe(0);
    expect(priced.creatorShareEnabled).toBe(false);
  });

  it('emits no pricing disclosure, so the disclosures digest is unchanged', () => {
    const priced = resolveLaunchPricing();
    expect(isStandardPricing(priced)).toBe(true);
    expect(toPricingDisclosure(priced)).toBeUndefined();
  });

  it('produces a fee constitution deep-equal to the one built with no price at all', () => {
    const withoutPricing = resolveFeeConstitution(CREATOR, []);
    expect(resolveFeeConstitution(CREATOR, [], undefined, resolveLaunchPricing())).toEqual(withoutPricing);
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

  it('prices once, with no wallet and no heat reading: the same price for everyone', () => {
    expect(code).toMatch(/\bpricing\s*=\s*useMemo\(\(\)\s*=>\s*resolveLaunchPricing\(\s*\),\s*\[\s*\]\)/);
    expect(code).not.toMatch(/readLaunchPricing|meetsHeatFloor\(/);
  });

  it('hands the SAME resolved object to the Fact Sheet and to the launch config', () => {
    expect(code).toMatch(/projectFactSheet\(w,\s*now,\s*pricing\)/);
    // The launch call site: without it the dial is inert end to end.
    expect(code).toMatch(/wizardConfigToLaunchConfig\(w,\s*\{[\s\S]*?\bpricing,[\s\S]*?\}\)/);
  });

  it('prices the previewed constitution and the disclosure from it too', () => {
    expect(code).toMatch(/resolveFeeConstitution\([\s\S]*?\bpricing,[\s\S]*?\)/);
    expect(code).toMatch(/toPricingDisclosure\(pricing\)/);
  });

  it('never turns the dial on from code: the env vars are the only input', () => {
    // `resolveLaunchPricing` accepts overrides for tests. The page must not use them: a
    // hardcoded `true` here would price launches with the flag still off.
    expect(code).not.toMatch(/creatorShareEnabled\s*:/);
    expect(code).not.toMatch(/creatorShareOfVenueBps\s*:/);
  });
});
