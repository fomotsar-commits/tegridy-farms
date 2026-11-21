// Owner ruling 2026-11-15: every EVM venue fee lands in that chain's treasury Safe. The owner's pack
// re-points all six SwapFeeRouters' payee there; this site goes live after its read-back shows it.
// From then no swap fee reaches a staker or a Gold Card holder, so no surface may say one does,
// and the registry's fee address on each chain is that chain's treasury Safe.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { CHAINS, CONFIGURED_CHAIN_IDS } from './chains/registry';
import { TREASURY_ADDRESS } from './constants';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

// Comments explain old wording and no visitor reads them; a sentence JSX wraps over lines is rejoined.
const rendered = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\s*\n\s*/g, ' ');

// The launch rail's LockerClaimer is immutable and still pays the stakers' contract; the changelog
// is a record; an event title renders only for a payout the chain actually made.
const EXEMPT = ['/lib/launcher/', '/pages/ChangelogPage.tsx', '/lib/protocolEvents/onchainDeltas.ts'];

// A gap that crosses ordinary words but never a negator, so "not to stakers" stays legal.
const G = String.raw`(?:(?!\b(?:not|never|no|none)\b)[^.;:?!])`;

const SHAPES: { id: string; re: RegExp }[] = [
  // "swap fees route on-chain, after a referral share, to stakers", "the fee is earmarked for stakers"
  { id: 'FEE_ROUTED_TO_STAKERS', re: new RegExp(String.raw`\bfees?\b${G}{0,70}?\b(?:routes?|routed|flows?|earmarked|distributed|goes|go)\b${G}{0,45}?\b(?:to|toward|towards|for)\s+(?:the\s+)?(?:TOWELI\s+)?stakers\b`, 'i') },
  // "fees → referral share, then stakers", "Fees route to stakers"
  { id: 'FEE_ARROW_TO_STAKERS', re: /\bfees?\s*(?:→|->|route to)[^.;]{0,40}\bstakers\b/i },
  // "a referral share, the rest toward stakers"
  { id: 'REST_TO_STAKERS', re: /\bthe rest\b[^.;]{0,20}\b(?:to|toward|towards)\s+(?:TOWELI\s+)?stakers\b/i },
  // the farm's fee-share chip, "80% to stakers"
  { id: 'PERCENT_TO_STAKERS', re: /%\s*to stakers\b/i },
  // "earn ETH from protocol swap fees", "ETH from protocol fees, distributed to stakers"
  { id: 'ETH_FROM_FEES', re: /\bETH from (?:protocol |the )?(?:swap )?fees\b/i },
  // "in line for ETH", "a share of swap fees", "the ETH swap-fee share / revenue / rail"
  { id: 'IN_LINE_FOR_ETH', re: /\bin line for ETH\b/i },
  { id: 'SHARE_OF_SWAP_FEES', re: /\b(?:for a|an ETH) share of (?:the )?(?:protocol(?:'s|’s)? )?(?:ETH )?swap[- ]fees?\b/i },
  { id: 'ETH_SWAP_FEE_YIELD', re: /\bETH swap[- ]fee (?:share|revenue|rail|rewards?)\b/i },
  // "Real ETH yield", "ETH yield, not yet paid", "The farm (real ETH yield)"
  { id: 'ETH_YIELD', re: /\b(?:real )?ETH yield\b/i },
  // "a bigger slice of the ETH" for a longer lock
  { id: 'SLICE_OF_THE_ETH', re: /\bslice of the ETH\b/i },
  // "The ETH fee-share is wired on-chain", "An ETH payout round needs 1 ETH of fees first"
  { id: 'ETH_FEE_SHARE', re: /\bETH fee[- ]share\b/i },
  { id: 'PAYOUT_ROUND_PROMISE', re: /\b(?:ETH payout round|payout round needs|a round needs 1 ETH)\b/i },
];

describe('no surface sends the swap fee to stakers', () => {
  it('walks every source file and finds none of the shapes', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.split(sep).join('/');
      if (EXEMPT.some((x) => rel.includes(x))) continue;
      const text = rendered(file);
      for (const s of SHAPES) {
        const hit = s.re.exec(text);
        if (hit) offenders.push(`${rel.slice(rel.indexOf('/src/') + 1)} [${s.id}] ...${text.slice(Math.max(0, hit.index - 30), hit.index + hit[0].length + 20)}...`);
      }
    }
    expect(offenders, `the swap fee goes to the treasury Safe, not to stakers:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the walker reaches the files that made the claim', () => {
    const files = walk(SRC).map((f) => f.split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    for (const must of [
      'components/RealYieldProof.tsx',
      'components/swap/EvmSwapPanel.tsx',
      'components/farm/IncentivesStrip.tsx',
      'components/layout/Footer.tsx',
      'components/ui/OnboardingModal.tsx',
      'lib/premiumBenefits.ts',
      'lib/towelieKnowledge.ts',
      'lib/faqData.ts',
      'pages/HomePage.tsx',
      'pages/TreasuryPage.tsx',
    ]) {
      expect(files.some((f) => f.endsWith(must)), `${must} is not being scanned`).toBe(true);
    }
  });

  it('every shape fires on the wording it was written for, and lets the true wording through', () => {
    const samples: Record<string, string> = {
      FEE_ROUTED_TO_STAKERS: 'protocol swap fees route on-chain, after a referral share, to stakers in ETH',
      FEE_ARROW_TO_STAKERS: 'fees → referral share, then stakers, in ETH',
      REST_TO_STAKERS: 'a referral share, the rest toward stakers',
      PERCENT_TO_STAKERS: '80% to stakers',
      ETH_FROM_FEES: 'Holders earn ETH from protocol swap fees',
      IN_LINE_FOR_ETH: 'holders are in line for ETH',
      SHARE_OF_SWAP_FEES: 'Lock TOWELI up to 4 years for a share of swap fees.',
      ETH_SWAP_FEE_YIELD: 'The ETH swap-fee share is wired on-chain',
      ETH_YIELD: 'The farm (real ETH yield)',
      SLICE_OF_THE_ETH: 'Longer lock, bigger slice of the ETH',
      ETH_FEE_SHARE: 'The ETH fee-share is wired on-chain',
      PAYOUT_ROUND_PROMISE: 'fee rail live · a round needs 1 ETH of fees',
    };
    for (const s of SHAPES) {
      expect(samples[s.id], `no sample written for ${s.id}`).toBeTruthy();
      expect(s.re.test(samples[s.id]!), `${s.id} no longer fires on its own shape`).toBe(true);
    }
    const legal = [
      "After a referral share, the venue's swap fee goes to its treasury.",
      'A swap through our pools pays the venue its fee, which goes to the venue’s treasury on Base.',
      'Stake TOWELI and earn TOWELI rewards.',
      'Daily Emissions 1,000/day to stakers',
      'Stakers were never paid any ETH from the stakers’ payout contract.',
      'Swap fees go to the treasury, not to stakers.',
    ];
    for (const line of legal) {
      const hit = SHAPES.find((s) => s.re.test(line));
      expect(hit?.id, `true wording rejected by ${hit?.id}: ${line}`).toBeUndefined();
    }
  });
});

describe('every chain names its treasury Safe as the place the venue fee lands', () => {
  // The pack's two Safes: Ethereum's, and the one address Base and Robinhood share.
  const TREASURY_SAFE: Record<number, string> = {
    1: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d',
    8453: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0',
    4663: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0',
  };

  it('covers every configured chain', () => {
    expect([...CONFIGURED_CHAIN_IDS].sort()).toEqual(Object.keys(TREASURY_SAFE).map(Number).sort());
  });

  for (const [id, safe] of Object.entries(TREASURY_SAFE)) {
    it(`chain ${id}: the fee address is the treasury Safe`, () => {
      const config = CHAINS[Number(id)]!;
      expect(config.contracts.feeSink.toLowerCase()).toBe(safe.toLowerCase());
      expect(config.contracts.treasury.toLowerCase()).toBe(safe.toLowerCase());
    });
  }

  it("Ethereum's treasury Safe is the constant the rest of the site reads", () => {
    expect(TREASURY_ADDRESS.toLowerCase()).toBe(TREASURY_SAFE[1]!.toLowerCase());
  });

  it('no chain still claims staker yield', () => {
    for (const id of CONFIGURED_CHAIN_IDS) {
      const config = CHAINS[id]! as unknown as Record<string, unknown> & { capabilities: Record<string, unknown> };
      expect(config.feeSink, `chain ${id} still carries a fee-sink kind`).toBeUndefined();
      expect(config.capabilities.stakerYield, `chain ${id} still carries stakerYield`).toBeUndefined();
    }
  });
});
