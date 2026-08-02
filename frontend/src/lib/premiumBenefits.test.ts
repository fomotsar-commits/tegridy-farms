import { describe, it, expect } from 'vitest';
import { goldCardBenefits, goldCardHeroSubtitle } from './premiumBenefits';

const ethYield = (state: { ethDistributed: number; isLoading: boolean }) => goldCardBenefits(state)[0]!;

describe('goldCardBenefits', () => {
  it('does NOT claim holders earn ETH while the distributor has paid nothing', () => {
    // Verified on mainnet 2026-07-31: RevenueDistributor 0xF993…3E17 returns 0 for
    // totalDistributed / totalClaimed / totalETHReceived. The page charges a real
    // monthly TOWELI fee, so "holders earn ETH from protocol swap fees" was a promise
    // the chain did not back. Pin the absence of the claim, not the wording.
    const b = ethYield({ ethDistributed: 0, isLoading: false });
    expect(b.desc).not.toMatch(/holders earn ETH/i);
    expect(b.desc).toMatch(/0 ETH/);
    expect(b.title).not.toBe('Real ETH yield');
  });

  it('makes the plain claim once a distribution has actually landed', () => {
    const b = ethYield({ ethDistributed: 0.25, isLoading: false });
    expect(b.title).toBe('Real ETH yield');
    expect(b.desc).toMatch(/holders earn ETH/i);
  });

  it('asserts neither way while the read is still in flight', () => {
    const b = ethYield({ ethDistributed: 0, isLoading: true });
    expect(b.desc).not.toMatch(/holders earn ETH from protocol swap fees — real revenue/);
    expect(b.desc).not.toMatch(/0 ETH/);
  });

  it('treats a NaN read as unpaid, never as paid', () => {
    expect(ethYield({ ethDistributed: Number.NaN, isLoading: false }).title).not.toBe('Real ETH yield');
  });

  it('keeps the JBAC lifetime-access benefit in every state', () => {
    for (const state of [
      { ethDistributed: 0, isLoading: false },
      { ethDistributed: 1, isLoading: false },
      { ethDistributed: 0, isLoading: true },
    ]) {
      expect(goldCardBenefits(state).map((b) => b.title)).toContain('JBAC Lifetime Access');
    }
  });
});

describe('goldCardHeroSubtitle', () => {
  // The hero sits ~100px above the benefit card and used to be a flat literal, so the
  // page promised income ("earn real ETH from swap fees") directly above the card's
  // retraction ("ETH yield — not yet paid … 0 ETH so far"). Both now read the same
  // distributor. Pin the ABSENCE of the earnings claim when unpaid and its PRESENCE
  // when paid — never an exact sentence, so rewording is free but re-promising is not.
  it('does NOT promise ETH income while the distributor has paid nothing', () => {
    const s = goldCardHeroSubtitle({ ethDistributed: 0, isLoading: false });
    expect(s).not.toMatch(/earn real ETH/i);
    expect(s).toMatch(/0 ETH/);
  });

  it('makes the plain claim once a distribution has actually landed', () => {
    expect(goldCardHeroSubtitle({ ethDistributed: 0.25, isLoading: false }))
      .toMatch(/earn real ETH from swap fees/i);
  });

  it('asserts neither way while the read is still in flight', () => {
    const s = goldCardHeroSubtitle({ ethDistributed: 0, isLoading: true });
    expect(s).not.toMatch(/earn real ETH/i);
    expect(s).not.toMatch(/0 ETH/);
  });

  it('treats a NaN read as unpaid, never as paid', () => {
    expect(goldCardHeroSubtitle({ ethDistributed: Number.NaN, isLoading: false }))
      .not.toMatch(/earn real ETH/i);
  });

  it('explains the swap-fee mechanism in every state', () => {
    for (const state of [
      { ethDistributed: 0, isLoading: false },
      { ethDistributed: 1, isLoading: false },
      { ethDistributed: 0, isLoading: true },
    ]) {
      expect(goldCardHeroSubtitle(state)).toMatch(/swap[- ]fee/i);
    }
  });
});
