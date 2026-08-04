// REVENUE-CLAIM PARITY GUARD.
//
// Four surfaces asserted, in the present tense, that the protocol pays ETH yield.
// Verified on-chain 2026-08-04, as on every prior check: `RevenueDistributor` holds
// 0 wei and `SwapFeeRouter.totalETHFees()` is 0. Nothing has ever been distributed
// to anyone.
//
// This has now been corrected four separate times on four different surfaces
// (#199 timelock, #215 gold card, #216 deployer graph, and this pass) — which is the
// argument for a test rather than another careful edit. Copy drifts back; a red suite
// does not.
//
// The rule these pin: a claim about HISTORY must be conditioned on the read that
// backs it. A claim about DESIGN may be a literal, because it is true before and
// after the first payment.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revenueSharingSubhead, goldCardSubhead } from '../lib/premiumBenefits';

const page = (f: string) => readFileSync(join(process.cwd(), 'src', 'pages', f), 'utf8');

describe('revenueSharingSubhead — conditioned on the live read', () => {
  it('does not claim a distribution when nothing has been distributed', () => {
    const s = revenueSharingSubhead({ ethDistributed: 0, isLoading: false });
    expect(s).toMatch(/none have been distributed yet/i);
    // The policy is still stated — the fix is tense, not deletion.
    expect(s).toMatch(/100% of protocol fees/i);
  });

  it('states the distribution plainly once it is real', () => {
    const s = revenueSharingSubhead({ ethDistributed: 1.5, isLoading: false });
    expect(s).toMatch(/are distributed to stakers/i);
    expect(s).not.toMatch(/none have been distributed/i);
  });

  it('says it is still reading rather than guessing, while loading', () => {
    expect(revenueSharingSubhead({ ethDistributed: 0, isLoading: true })).toMatch(/reading/i);
  });

  it('treats a non-finite read as unpaid — never as paid', () => {
    // A NaN from a failed multicall must not read as "yield is flowing".
    expect(revenueSharingSubhead({ ethDistributed: NaN, isLoading: false }))
      .toMatch(/none have been distributed yet/i);
    expect(goldCardSubhead({ ethDistributed: NaN, isLoading: false }))
      .toMatch(/distributed nothing yet/i);
  });
});

describe('no surface hardcodes a paid-yield claim', () => {
  it('/premium does not carry the flat "distributed to stakers" literal', () => {
    // It must come from the helper, so it follows the chain read.
    const src = page('PremiumPage.tsx');
    expect(src).not.toMatch(/100% of protocol fees distributed to stakers/);
    expect(src).toContain('revenueSharingSubhead(');
  });

  it('the prewritten share tweet does not make the VISITOR claim paid yield', () => {
    // This is the one a stranger posts under their own name, so it outlives any
    // correction we make to the site.
    const src = page('HomePage.tsx');
    const tweet = src.match(/intent\/tweet\?text=\$\{encodeURIComponent\(\s*'([^']+)'/);
    expect(tweet, 'could not locate the share-tweet literal').not.toBeNull();
    expect(tweet![1]).not.toMatch(/real yield/i);
    expect(tweet![1]).not.toMatch(/\bpaid\b/i);
  });

  it('the core-loop diagram describes the route, not a payment history', () => {
    const src = page('HomePage.tsx');
    expect(src).not.toMatch(/sub: 'on-chain, paid in ETH'/);
  });
});

describe('the timelock claim agrees across every page that makes it', () => {
  // #199 corrected /security and /risks and missed /faq, leaving the FAQ as the most
  // REASSURING of the three. A reader who checks two pages believes the softer one.
  const PAGES = ['FAQPage.tsx', 'RisksPage.tsx', 'SecurityPage.tsx'];

  for (const f of PAGES) {
    it(`${f} does not claim a blanket timelock over EVERY parameter`, () => {
      const src = page(f);
      expect(src).not.toMatch(/every parameter change goes through a 24-48 hour timelock/i);
      expect(src).not.toMatch(/every parameter change goes through a 24–48 hour timelock/i);
    });
  }

  it('the FAQ names what the timelock does NOT cover', () => {
    const src = page('FAQPage.tsx');
    // Matching /risks: sensitive params are delayed; some setters and pause are not.
    expect(src).toMatch(/immediately/i);
    expect(src).toMatch(/emergency pause/i);
  });
});
