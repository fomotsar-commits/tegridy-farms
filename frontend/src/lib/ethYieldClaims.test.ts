// The /premium surface must never promise ETH income the chain has not paid.
//
// Verified read-only on mainnet at block 25664357 (2026-08-01):
//   SwapFeeRouter      0x6d57…5956E  totalETHFees()     = 0   (lifetime counter, only ever +=)
//   RevenueDistributor 0xF993…3E17   totalDistributed() = 0, epochCount() = 0
//                                    MIN_DISTRIBUTE_AMOUNT() = 1e18 — no epoch can even open
//                                    until the router captures a full ETH
//   PremiumAccess      0x9DC2…a3f5   monthlyFeeToweli() = 1e22 (10,000 TOWELI) — a REAL charge
// So the rail has never moved a single wei, while the page charging for it promised income.
//
// The 2026-07-31 honesty pass (f85e4c0a) conditioned the Gold Card BENEFIT CARD on
// RevenueDistributor.totalDistributed and tested it in premiumBenefits.test.ts — but that
// test asserts against the module's own return value, so it cannot see a literal string
// sitting in a JSX node or a static data array. Three sibling copy sites kept making the
// flat claim: the /premium hero, the FAQ Gold Card answer, and Towelie's premium answer.
// This file is the missing half — it scans SOURCE, the way launchFeeCopy.test.ts does.
//
// NOT SCANNED, DELIBERATELY: src/lib/premiumBenefits.ts. It is the one place the plain
// claim is legitimate, because it lives behind the paid branch (`hasPaid()`), and that
// branching is already pinned by premiumBenefits.test.ts. Scanning it here would force
// the honest paid-day copy to be deleted to make a guard green — exactly backwards.
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
const FAQ_PAGE = read('..', 'pages', 'FAQPage.tsx');
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
  it('the /premium hero is wired to the distributor read, not to a literal', () => {
    expect(PREMIUM_PAGE).toMatch(/goldCardHeroSubtitle\(/);
    expect(PREMIUM_PAGE).toMatch(/ethDistributed:\s*revenue\.totalDistributed/);
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
