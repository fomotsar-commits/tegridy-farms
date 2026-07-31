// The fee copy on the screen a creator SIGNS on must not conflate the two pool fees.
//
// A launch has two different fees, and only one of them is what the published constitution
// divides:
//   LAUNCH_FEE_TIER  = 10_000 (1%)   the AUCTION pool. The protocol takes a third-party
//                                    integrator fee here; no split is enforced on-chain.
//   MIGRATION_POOL.fee = 3000 (0.3%) the GRADUATED pool. THIS is what 80/15/5 divides.
//
// LaunchPage read "1% total trade fee" directly above the constitution table on both the
// explainer and the pre-signature panel. TermsPage §7 had always stated it correctly, so
// the app contradicted itself and the accurate version was on the page nobody reads.
//
// termsLauncherCoverage.test.ts guards the same class of claim — but only scans
// TermsPage.tsx, which is why it never fired on this. This is the missing half.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LAUNCH_FEE_TIER } from '../lib/launcher/config';
import { MIGRATION_POOL } from '../lib/launcher/airlock';

const RAW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'LaunchPage.tsx'),
  'utf-8',
);

// Comments are stripped before the copy assertions below. This guard is about what a
// creator READS on screen, and the file legitimately quotes the old wrong string in a
// comment explaining why it was removed — scanning raw source flagged that explanation
// as the defect it documents.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the two launch fees are distinct', () => {
  it('the auction fee is not the graduated fee — the premise of this whole file', () => {
    expect(LAUNCH_FEE_TIER).toBe(10_000); // 1%
    expect(MIGRATION_POOL.fee).toBe(3000); // 0.3%
    expect(LAUNCH_FEE_TIER).not.toBe(MIGRATION_POOL.fee);
  });
});

describe('LaunchPage fee copy', () => {
  it('never claims the constitution divides a "total trade fee"', () => {
    // The exact phrasing that shipped, plus the near-misses it could come back as.
    expect(SRC).not.toMatch(/total trade fee/i);
    expect(SRC).not.toMatch(/1%\s*(total\s*)?trade fee/i);
  });

  it('renders both percentages from the constants instead of hardcoding them', () => {
    // If someone re-types a literal, the derivation stops being load-bearing and this
    // test stops protecting anything — so require the derivation itself to be present.
    expect(SRC).toMatch(/const feePct\s*=/);
    expect(SRC).toMatch(/feePct\(LAUNCH_FEE_TIER\)/);
    expect(SRC).toMatch(/feePct\(MIGRATION_POOL\.fee\)/);
    expect(SRC).toMatch(/\{GRADUATED_FEE_PCT\}%/);
    expect(SRC).toMatch(/\{AUCTION_FEE_PCT\}%/);
  });

  it('tells the creator the auction fee is NOT theirs, and points at Terms §7', () => {
    // The substantive disclosure, not just the absence of the wrong number.
    expect(SRC).toMatch(/integrator fee/i);
    expect(SRC).toMatch(/Terms §7/);
    expect(SRC).toMatch(/graduated pool/i);
  });
});
