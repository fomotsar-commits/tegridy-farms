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
  {
    file: 'src/pages/HomePage.tsx',
    gone: ['Swap Solana tokens via Jupiter', 'On Solana we swap through Jupiter', 'routed through Jupiter', "stat: 'Jupiter'", 'Jupiter-routed swap'],
    says: 'our own pools or through Jupiter',
  },
  { file: 'src/pages/SolanaSwapPage.tsx', gone: ['fee applies on the SOL buy'], says: 'when the buy goes through Jupiter; our pools add none on top' },
  {
    file: 'src/components/solana/lp/LpDisclosures.tsx',
    gone: ['Jupiter does not send trades to these pools yet, so the trades'],
    says: "This site's own swap sends a trade to one of these pools when it pays at least as much as Jupiter",
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    gone: ['Aggregators such as Jupiter do not send trades to these pools yet, so most trades'],
    says: 'own swap sends a trade to one of these pools when it pays at least as much as Jupiter',
  },
];

describe('no line outside the swap says every Solana swap goes through Jupiter', () => {
  it.each(PLACES)('$file', ({ file, gone, says }) => {
    const text = read(file);
    for (const g of gone) expect(text.includes(g), `still says: ${g}`).toBe(false);
    expect(text.includes(says), `does not say: ${says}`).toBe(true);
  });
});
