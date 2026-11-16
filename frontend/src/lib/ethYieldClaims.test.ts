// The /premium surface must never promise ETH income the chain has not paid.
//
// Verified read-only on mainnet 2026-09-05:
//   SwapFeeRouter      0x6d57…5956E  totalETHFees() = 3_000_000_000_000 wei (0.000003 ETH)
//                                    - a lifetime counter, only ever +=
//   RevenueDistributor 0xF993…3E17   MIN_DISTRIBUTE_AMOUNT() = 1e18, so an epoch cannot
//                                    open until the router captures a FULL ether. Current
//                                    capture is ~0.0003% of that.
//   PremiumAccess      0x9DC2…a3f5   monthlyFeeToweli() = 1e22 (10,000 TOWELI) - a REAL charge
// The rail has now moved a trace amount (it read exactly 0 through 2026-08-02), but no epoch
// has ever opened, so no holder has ever received ETH. A page charging real TOWELI must not
// promise income the chain has not paid.
//
// The 2026-07-31 honesty pass (f85e4c0a) conditioned the Gold Card BENEFIT CARD on
// RevenueDistributor.totalDistributed and tested it in premiumBenefits.test.ts — but that
// test asserts against the module's own return value, so it cannot see a literal string
// sitting in a JSX node or a static data array. Three sibling copy sites kept making the
// flat claim: the /premium hero, the FAQ Gold Card answer, and Towelie's premium answer.
// This file is the missing half — it scans SOURCE, the way launchFeeCopy.test.ts does.
//
// Since 2026-11-15 every venue fee goes to the treasury Safe (owner ruling), so the Gold Card
// promises no ETH in any state; src/lib/premiumBenefits.ts is pinned by its own test.
//
// Comments are stripped before every assertion: these files legitimately QUOTE the old
// wrong strings in comments explaining why they were removed, and scanning raw source
// would flag each explanation as the defect it documents.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KNOWLEDGE_BASE } from './towelieKnowledge';

const HERE = dirname(fileURLToPath(import.meta.url));

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (...seg: string[]) => stripComments(readFileSync(join(HERE, ...seg), 'utf-8'));

const PREMIUM_PAGE = read('..', 'pages', 'PremiumPage.tsx');
// The FAQ's words live in lib/faqData.ts since wave seven row Q; the Gold
// Card answer moved there, word for word, in the TOWELI room's list.
const FAQ_PAGE = read('faqData.ts');
const TOWELIE = read('towelieKnowledge.ts');

describe('no ETH-earnings promise ships as a flat literal', () => {
  it('the /premium hero does not promise ETH income', () => {
    // Shipped as: "Back the protocol in TOWELI — and earn real ETH from swap fees, like
    // every staker." — rendered ~100px above a card reading "ETH yield — not yet paid …
    // it has distributed 0 ETH so far". The hero must come from goldCardHeroSubtitle(),
    // which reads the same distributor the card does.
    expect(PREMIUM_PAGE).not.toMatch(/earns? real ETH/i);
  });

  it('the FAQ Gold Card answer does not promise ETH income', () => {
    expect(FAQ_PAGE).not.toMatch(/holders earn ETH/i);
  });

  it("Towelie's premium answer does not promise ETH income", () => {
    expect(TOWELIE).not.toMatch(/holders earn ETH/i);
  });
});

describe('the mechanism is still explained after the promise is removed', () => {
  // Removing the claim must not remove the disclosure — an empty answer would pass the
  // negative assertions above while telling the reader nothing.
  it('the /premium hero comes from the shared Gold Card copy, which names the treasury', () => {
    // Owner ruling 2026-11-15: swap fees go to the treasury Safe, so the hero states that
    // the card carries no fee share; the line lives in premiumBenefits.ts, pinned there.
    expect(PREMIUM_PAGE).toMatch(/from '\.\.\/lib\/premiumBenefits'/);
    expect(PREMIUM_PAGE).toContain('{GOLD_CARD_SUBHEAD}');
  });

  it('the FAQ Gold Card answer still describes the swap-fee share', () => {
    const entry = FAQ_PAGE.split('\n').filter((l) => l.includes('What is the Gold Card?'));
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatch(/swap[- ]fee/i);
  });

  it("Towelie's premium answer still describes the swap-fee share", () => {
    const entries = KNOWLEDGE_BASE.filter((e) => e.keywords.includes('premium'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.answer).toMatch(/swap[- ]fee/i);
  });
});
