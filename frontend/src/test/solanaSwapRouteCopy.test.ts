// @vitest-environment node
//
// Since #759 a Solana swap goes to one of our own pools when that pool pays at least as much
// as Jupiter, and through Jupiter otherwise. These visitor-facing lines, outside the swap's own
// route line, said every Solana swap goes through Jupiter, or that nothing sends trades to our
// pools. None may say so again, and each place names both routes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ownPoolSwapsOn } from '../lib/solana/swap/ownPoolSwapFlag';
import { TOWELI_FAQ_DATA, venueFaq } from '../lib/faqData';
import { KNOWLEDGE_BASE, answerQuestion } from '../lib/towelieKnowledge';
import { ONBOARDING_SURFACES } from '../components/onboarding/onboardingSteps';
import { feeSplit } from '../lib/solana/cpswap/venue';
import { pctText } from '../lib/solana/lp/format';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Source text with every run of whitespace as one space, so a re-wrapped line still matches. */
const read = (p: string) => readFileSync(join(FRONTEND, p), 'utf-8').replace(/\s+/g, ' ');

const PLACES: { file: string; gone: string[]; says: string }[] = [
  { file: 'src/lib/faqData.ts', gone: ['swaps SPL tokens through Jupiter.'], says: 'in our own pools or through Jupiter' },
  {
    file: 'src/lib/towelieKnowledge.ts',
    gone: ['routes SPL trades through Jupiter', 'swaps SPL tokens through Jupiter,', 'Jupiter is the router behind /solana'],
    says: 'our own pools',
  },
  { file: 'src/components/onboarding/onboardingSteps.ts', gone: ['Swap Solana tokens through Jupiter from'], says: 'in our own pools or through Jupiter' },
  { file: 'src/components/ui/OnboardingModal.tsx', gone: ['on Solana, swap through Jupiter and'], says: 'swap in our own pools or through Jupiter' },
  { file: 'src/components/layout/Footer.tsx', gone: ['On Solana, swap through Jupiter.'], says: 'swap in our own pools or through Jupiter' },
  { file: 'src/components/swap/ChainSwitch.tsx', gone: ['· Jupiter`', ": 'Jupiter'"], says: 'Our pools + Jupiter' },
  {
    file: 'src/pages/HomePage.tsx',
    gone: ['Swap Solana tokens via Jupiter', 'On Solana we swap through Jupiter', 'routed through Jupiter', "stat: 'Jupiter'", 'Jupiter-routed swap'],
    says: 'our own pools or through Jupiter',
  },
  { file: 'src/pages/SolanaSwapPage.tsx', gone: ['fee applies on the SOL buy', 'our pools add none on top'], says: 'fee applies when the buy goes through Jupiter. A buy in one of our pools pays that pool' },
  {
    file: 'src/components/solana/lp/LpDisclosures.tsx',
    gone: ['Jupiter does not send trades to these pools yet, so the trades'],
    says: "This site's own swap sends a trade to this pool only when it pays the trader at least as much as Jupiter does",
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    gone: ['Aggregators such as Jupiter do not send trades to these pools yet, so most trades'],
    says: 'a pool earns fees only from trades sent to it by this site’s own swap',
  },
];

describe('no line outside the swap says every Solana swap goes through Jupiter', () => {
  it.each(PLACES)('$file', ({ file, gone, says }) => {
    const text = read(file);
    for (const g of gone) expect(text.includes(g), `still says: ${g}`).toBe(false);
    expect(text.includes(says), `does not say: ${says}`).toBe(true);
  });
});

// Sentence by sentence, comments taken out: a new line anywhere in these surfaces is held too.
/** A file's text with its comments taken out and every run of whitespace as one space. */
const shown = (p: string) =>
  readFileSync(join(FRONTEND, p), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\s+/g, ' ');

const SAYS_JUPITER = /\b(?:swaps?|routes?|routed|trades?)\b[^.]*\b(?:through|via) Jupiter\b|Jupiter is the router\b/i;
const SAYS_OURS = /\bour (?:own )?pools?\b|\bown swap\b/i;
/** Each sentence that sends Solana swaps through Jupiter and never names our pools. */
const jupiterOnly = (text: string) =>
  text.split(/(?<=[.;!?])\s+/).filter((s) => SAYS_JUPITER.test(s) && !SAYS_OURS.test(s));

const SHOWN_FILES = ['src/components/layout/Footer.tsx', 'src/components/ui/OnboardingModal.tsx', 'src/pages/HomePage.tsx'] as const;

describe('the site says where a Solana swap goes', () => {
  it('a trade may go to our own pool in this build', () => {
    expect(ownPoolSwapsOn()).toBe(true);
  });

  it('the FAQ, Towelie and onboarding never say Jupiter alone', () => {
    const faq = [...venueFaq(80), ...TOWELI_FAQ_DATA].flatMap((s) => s.items).map((i) => i.a);
    const towelie = KNOWLEDGE_BASE.map((e) => e.answer);
    const onboarding = ONBOARDING_SURFACES.map((s) => s.blurb);
    expect([...faq, ...towelie, ...onboarding].flatMap(jupiterOnly)).toEqual([]);
  });

  it('Towelie says our pools add no platform fee, and adds no em dash', () => {
    for (const q of ['jupiter', 'solana swap', 'swap solana']) {
      const a = answerQuestion(q);
      expect(a, q).toMatch(SAYS_OURS);
      expect(a, q).toMatch(/no (?:platform |site )?fee|add(?:s)? no/i);
      expect(a, q).not.toContain('—');
    }
  });

  // "Our pools add none on top" is true of a platform fee and reads as "our pools charge
  // nothing". A swap in our pool pays the pool's own fee, and the venue keeps part of it.
  it('where our pools are said to add no platform fee, the pool’s own fee is said too, and what the venue keeps of it', () => {
    // The public fee tier as mainnet holds it (the tier every pool of ours is on today).
    const tier = feeSplit({ tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n });
    const a = answerQuestion('jupiter');
    expect(a).toContain(`pays that pool's own fee inside the quote: ${pctText(tier.tradeFeePct)} of the trade on a public pool, with ${pctText(tier.venueTakesPct)} of the trade going to the venue.`);
    expect(a).toContain('No platform fee is added on top.');
    const page = shown('src/pages/SolanaSwapPage.tsx');
    const rail = page.slice(page.indexOf('function EarnRail('), page.indexOf('function ActivityRail('));
    expect(rail).toContain("A buy in one of our pools pays that pool's own fee inside the quote, and no platform fee on top.");
    for (const text of [a, rail]) expect(text).not.toMatch(/add none on top/);
  });

  it('the assistant’s rule for where a swap goes names the one case where our pool is offered at less', () => {
    const rule = KNOWLEDGE_BASE.map((e) => e.answer).filter((x) => x.includes('at least as much as Jupiter, and through Jupiter otherwise'));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toContain("and through Jupiter otherwise. If Jupiter's transaction would fail its test run, the page offers the trade in our pool and says how much less it pays. /curve-launch is");
  });

  it('the home page, the footer and the welcome never say Jupiter alone', () => {
    const found = SHOWN_FILES.flatMap((f) => jupiterOnly(shown(f)).map((s) => `${f}: ${s.slice(0, 90)}`));
    expect(found).toEqual([]);
  });

  it('the earn rail says the fee is on Jupiter’s route, not on every SOL buy', () => {
    const page = shown('src/pages/SolanaSwapPage.tsx');
    const rail = page.slice(page.indexOf('function EarnRail('), page.indexOf('function ActivityRail('));
    const feeLines = rail.split(/(?<=[.;!?])\s+/).filter((x) => /fee applies/.test(x));
    expect(feeLines.length).toBeGreaterThan(0);
    for (const line of feeLines) expect(line.slice(Math.max(0, line.indexOf('fee applies') - 60))).toMatch(/Jupiter/);
  });

  it('the pool lines say the site’s own swap sends trades to a pool that pays as much as Jupiter', () => {
    const silent = ['src/components/solana/lp/LpDisclosures.tsx', 'src/components/solana/lp/SolanaLpSection.tsx'].flatMap((f) => {
      const text = shown(f);
      return [...text.matchAll(/do(?:es)? not send trades to these pools/g)]
        .map((m) => text.slice(m.index, m.index + 300))
        .filter((after) => !/\bown swap\b/i.test(after))
        .map((after) => `${f}: ${after.slice(0, 110)}`);
    });
    expect(silent).toEqual([]);
  });
});
