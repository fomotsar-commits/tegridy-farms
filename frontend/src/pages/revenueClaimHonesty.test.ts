// REVENUE-CLAIM PARITY GUARD.
//
// Four surfaces asserted, in the present tense, that the protocol pays ETH yield.
//
// ⚠ CORRECTED 2026-08-12. This header said `SwapFeeRouter.totalETHFees()` is 0. It is
// 3000000000000 wei — the rail HAS fired. What is still true is the part that matters:
// `RevenueDistributor` holds 0 wei and has distributed 0, because 20% of that fee was
// carved by ReferralSplitter and the remaining 2400000000000 wei sits in
// callerCredit[SwapFeeRouter], reachable only via the permissionless
// recoverCallerCredit(), which nothing had ever called.
//
// Worth noting how this survived: the walker below strips `//` lines before scanning,
// so this guard is structurally incapable of catching a false claim in its own header.
// A guard exempt from itself is the same defect class it was written to prevent.
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
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { revenueSharingSubhead, goldCardSubhead } from '../lib/premiumBenefits';

const page = (f: string) => readFileSync(join(process.cwd(), 'src', 'pages', f), 'utf8');

describe('revenueSharingSubhead — conditioned on the live read', () => {
  it('does not claim a distribution when nothing has been distributed', () => {
    const s = revenueSharingSubhead({ ethDistributed: 0, isLoading: false });
    expect(s).toMatch(/none have been distributed yet/i);
    // The policy is still stated — the fix is tense, not deletion.
    //
    // ⚠ This used to require /100% of protocol fees/, i.e. the guard against dishonest
    // revenue claims was ENFORCING one. #258 corrected the tense of that sentence and
    // left its arithmetic alone. It is false in the present tense too:
    // ReferralSplitter.referralFeeBps is 2000, carved off the top before anything is
    // credited, so the staker ceiling is ~80%. stakerShareBps IS 10000, but that is
    // 100% of what REACHES the distributor — the elision the old string traded on.
    expect(s).toMatch(/20% referral carve/i);
    expect(s, 'the guard must not re-admit the totality claim it exists to catch')
      .not.toMatch(/100% of protocol fees/i);
  });

  it('states the distribution plainly once it is real', () => {
    const s = revenueSharingSubhead({ ethDistributed: 1.5, isLoading: false });
    expect(s).toMatch(/is distributed to stakers/i);
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

// ── BREADTH GUARD ──────────────────────────────────────────────────────────
//
// The original version of this file checked a hardcoded list of PAGES. That is
// only ever able to catch what someone already thought to look at, and it
// missed two live surfaces making the same claim: Footer.tsx (on EVERY page)
// and OnboardingModal.tsx (the first thing a new visitor reads). Both were
// found by driving the live site, not by this suite.
//
// So this walks the whole of src/ instead of trusting a list. A new component
// cannot make the claim without failing here.
describe('no surface anywhere in src/ claims fees ARE paid', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
    }
    return acc;
  }

  // Present-tense assertions that fees HAVE reached stakers. `routed`/`route`
  // are deliberately absent — describing the mechanism is true and allowed.
  const CLAIMS = [
    /\bfees go to (?:TOWELI )?stakers\b/i,
    /\bfees flow to stakers\b/i,
    /\bfees (?:are )?distributed to stakers\b/i,
    /\breal yield, paid in\b/i,
  ];

  // Occurrences that are CORRECT because they render only when a distribution
  // has actually happened. Both were checked by hand; neither is a literal.
  // ⚠ MAY ONLY SHRINK — a new entry needs the same justification.
  const CONDITIONAL_AND_CHECKED = [
    // the `paid` branch of revenueSharingSubhead(), gated on ethDistributed > 0
    'lib/premiumBenefits.ts',
    // an event title rendered only when nEpochs distributions exist on-chain
    'lib/protocolEvents/onchainDeltas.ts',
  ];

  it('walks every source file and finds no paid-yield claim', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      // Strip line comments — the correction notes quote the old wording.
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const rel = file.split(sep).join('/');
      if (CONDITIONAL_AND_CHECKED.some((x) => rel.endsWith(x))) continue;
      for (const re of CLAIMS) {
        if (re.test(code)) offenders.push(`${rel.slice(rel.indexOf('/src/') + 1)} :: ${re}`);
      }
    }
    expect(offenders, `paid-yield claims found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the walker actually reaches the files that were missed', () => {
    // Guard the guard: if walk() silently returned nothing, the test above
    // would pass having checked zero files — the exact defect it exists for.
    const files = walk(SRC).map((f) => f.split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('components/layout/Footer.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('components/ui/OnboardingModal.tsx'))).toBe(true);
  });
});
