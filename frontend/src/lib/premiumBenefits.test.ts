import { describe, it, expect } from 'vitest';
import { goldCardBenefits, goldCardSubhead } from './premiumBenefits';

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

  it('does not let the HERO line promise what the benefit card refuses to', () => {
    // The 2026-07-31 pass conditioned the card and left the hero subhead — the first
    // sentence on the page — reading "earn real ETH from swap fees, like every
    // staker." Verified on-chain 2026-08-01: SwapFeeRouter.totalETHFees() is 0 and
    // always has been. Pin the two surfaces AGREEING, so neither can drift alone.
    const unpaid = { ethDistributed: 0, isLoading: false };
    expect(goldCardSubhead(unpaid)).not.toMatch(/earn real ETH/i);
    expect(goldCardSubhead(unpaid)).toMatch(/distributed nothing yet/i);
    expect(goldCardBenefits(unpaid)[0]!.title).not.toBe('Real ETH yield');
  });

  it('lets the hero make the claim once a distribution has actually landed', () => {
    const paid = { ethDistributed: 0.25, isLoading: false };
    expect(goldCardSubhead(paid)).toMatch(/earn real ETH/i);
    expect(goldCardBenefits(paid)[0]!.title).toBe('Real ETH yield');
  });

  it('asserts neither way in the hero while the read is in flight', () => {
    const loading = { ethDistributed: 0, isLoading: true };
    expect(goldCardSubhead(loading)).not.toMatch(/earn real ETH/i);
    expect(goldCardSubhead(loading)).not.toMatch(/distributed nothing yet/i);
  });

  it('treats a NaN read as unpaid in the hero too', () => {
    expect(goldCardSubhead({ ethDistributed: Number.NaN, isLoading: false })).not.toMatch(/earn real ETH/i);
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
