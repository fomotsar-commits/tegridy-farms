// The partner-fee DISCLOSURE, and the one distinction it exists to hold open.
//
// An unset dial is not a fee of zero. This module cannot read the provider dashboard where
// the fee is actually configured, so "we were not told" and "the venue takes nothing" are
// different facts and must not render as the same sentence. `0` is spelled `0` by an
// operator who means it; absence stays absence.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_ONRAMP_PARTNER_FEE_BPS,
  formatPartnerFeeBps,
  onrampPartnerFeeDisclosure,
} from './partnerFee';

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('an unset dial discloses nothing, and never a zero', () => {
  it('is undeclared when the variable is absent', () => {
    expect(onrampPartnerFeeDisclosure()).toEqual({ declared: false });
  });

  it('is undeclared when the variable is blank', () => {
    vi.stubEnv('VITE_ONRAMP_PARTNER_FEE_BPS', '   ');
    expect(onrampPartnerFeeDisclosure()).toEqual({ declared: false });
  });

  it('distinguishes an explicit zero from an absent value', () => {
    vi.stubEnv('VITE_ONRAMP_PARTNER_FEE_BPS', '0');
    expect(onrampPartnerFeeDisclosure()).toEqual({ declared: true, bps: 0 });
  });
});

describe('a value that cannot be disclosed truthfully is not disclosed', () => {
  for (const bad of ['abc', '12.5', '-25', 'NaN', 'Infinity', '1e2x']) {
    it(`refuses ${bad}`, () => {
      vi.stubEnv('VITE_ONRAMP_PARTNER_FEE_BPS', bad);
      expect(onrampPartnerFeeDisclosure()).toEqual({ declared: false });
    });
  }

  it('clamps an over-max value rather than falling silent — under-disclosure is the worse failure', () => {
    vi.stubEnv('VITE_ONRAMP_PARTNER_FEE_BPS', '5000');
    expect(onrampPartnerFeeDisclosure()).toEqual({ declared: true, bps: MAX_ONRAMP_PARTNER_FEE_BPS });
  });
});

describe('formatting', () => {
  it('renders the plan’s 0.5-1% band and the edges without trailing noise', () => {
    expect(formatPartnerFeeBps(0)).toBe('0%');
    expect(formatPartnerFeeBps(50)).toBe('0.5%');
    expect(formatPartnerFeeBps(75)).toBe('0.75%');
    expect(formatPartnerFeeBps(100)).toBe('1%');
    expect(formatPartnerFeeBps(125)).toBe('1.25%');
    expect(formatPartnerFeeBps(MAX_ONRAMP_PARTNER_FEE_BPS)).toBe('2%');
  });
});

describe('this module is a disclosure, not a mechanism', () => {
  // The header explains at length WHY lib/fees does not apply, so the prose names
  // swapFeePolicy on purpose. What must not exist is an import: pulling the swap policy in
  // here would attach the swap rate to a rail that never charges it.
  it('imports nothing from lib/fees — a ramp has no request parameter to attach a rate to', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Resolved from the vitest root (frontend/) rather than import.meta.url — under jsdom
    // that URL is an http one, and reading it throws before the assertion is reached.
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'onramp', 'partnerFee.ts'), 'utf-8');
    expect(src.split('\n').filter((l) => /^\s*import\b/.test(l))).toEqual([]);
  });
});
