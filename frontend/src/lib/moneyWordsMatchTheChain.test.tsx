// THE ETHEREUM-SIDE MONEY SENTENCES, PINNED AS CLAIM SHAPES.
//
// Three lines of site copy disagreed with the chain, and each had siblings. Read on
// mainnet 2026-10-10 with `cast` against eth.drpc.org, blocks 26,163,075 to 26,163,112:
//
//   TegridyPair        0x5587…a481  kLast() = 0. harvest() simulated from a stranger reverts
//                                   HARVEST_BOOTSTRAP_GATED; from the factory's feeToSetter
//                                   (the owner wallet) it succeeds. So the venue's one-sixth
//                                   LP mint has never started, and one key can start it.
//   TegridyFactory     0xa24C…7a52  feeTo() = the treasury Safe, which holds 0 LP.
//   SwapFeeRouter      0x6d57…956E  feeBps() = 50, MAX_FEE_BPS = 100, totalETHFees() = 3e12 wei,
//                                   lastCallerCreditAt() = 0 (recoverCallerCredit never called).
//   ReferralSplitter   0x6B34…7e4c  referralFeeBps() = 2000; it holds the whole 3e12 wei.
//   RevenueDistributor 0xF993…3E17  totalETHReceived() = 0, totalDistributed() = 0,
//                                   MIN_DISTRIBUTE_AMOUNT() = 1e18.
//
// The shapes, each a family of wordings for one false claim:
//   1. The staker ETH does not wait on the pool. The pool is live and the rail has taken
//      fees; what a payout round waits on is a full ether in the distributor.
//   2. Liquidity providers are not on five sixths. They keep the whole 0.3% until the
//      owner wallet starts the venue's cut, so copy may describe the cut only as a switch.
//   3. The router fee does not all reach stakers. A referral share comes off first.
//   4. A static answer cannot read the chain, so a figure that can move carries the date
//      it was read, or the answer points at the page that reads it live.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { KNOWLEDGE_BASE } from './towelieKnowledge';
import { TOWELI_FAQ_DATA } from './faqData';
import { LiquidityPrimer } from '../components/liquidity/LiquidityPrimer';

afterEach(cleanup);

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

// Comments quote the old wording to explain why it went, and no visitor reads them.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SHAPES: { id: string; re: RegExp }[] = [
  // "activates once the native pool is live", "opens with the native pool", "kicks in when…"
  { id: 'WAITS_ON_THE_POOL', re: /\b(?:activate|start|begin|open|kick|switch|turn)\w*\b[^.;]{0,60}\bnative[- ]pool\b/i },
  // "…route to stakers once the native pool is live"
  { id: 'WAITS_ON_THE_POOL_STATE', re: /\bnative[- ]pool (?:launches|goes live|is live|is trading|opens|comes online)\b/i },
  // "five sixths of it accrues into the reserves", "swap fees split 5/6 to LPs"
  { id: 'LPS_ON_FIVE_SIXTHS', re: /\bfive[- ]sixths\b|\b5\/6 (?:to|goes to|stays? with|for) (?:the )?(?:LPs?|liquidity|pool)/i },
  // "a 0.5% protocol fee that flows to TOWELI stakers"
  { id: 'FEE_FLOWS_TO_STAKERS', re: /\bfees?\b[^.]{0,40}\bflows? to (?:TOWELI )?stakers\b/i },
];

/** A file as a visitor could be shown it: comments out, and a sentence that JSX wraps
 *  over several lines put back on one, so a line break cannot hide a claim. */
const rendered = (file: string) => stripComments(readFileSync(file, 'utf8')).replace(/\s*\n\s*/g, ' ');

describe('no surface in src/ makes a money claim the chain contradicts', () => {
  it('walks every source file and finds none of the shapes', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.split(sep).join('/');
      const text = rendered(file);
      for (const s of SHAPES) {
        const hit = s.re.exec(text);
        if (hit) offenders.push(`${rel.slice(rel.indexOf('/src/') + 1)} [${s.id}] …${text.slice(Math.max(0, hit.index - 30), hit.index + hit[0].length + 30)}…`);
      }
    }
    expect(offenders, `money claims the chain contradicts:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the walker reaches the files that made the claims', () => {
    const files = walk(SRC).map((f) => f.split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    for (const must of [
      'lib/faqData.ts',
      'lib/towelieKnowledge.ts',
      'components/liquidity/LiquidityPrimer.tsx',
      'components/RealYieldProof.tsx',
      'pages/TokenomicsPage.tsx',
      'pages/HomePage.tsx',
      'pages/RisksPage.tsx',
    ]) {
      expect(files.some((f) => f.endsWith(must)), `${must} is not being scanned`).toBe(true);
    }
  });

  it('every shape still fires on the wording it was written for, and lets the true wording through', () => {
    // Reworded on purpose: the shape is what is pinned, never a sentence.
    const samples: Record<string, string> = {
      WAITS_ON_THE_POOL: 'the ETH share begins flowing with the native pool',
      WAITS_ON_THE_POOL_STATE: 'fees reach stakers as soon as the native pool goes live',
      LPS_ON_FIVE_SIXTHS: 'providers earn five sixths of every fee',
      FEE_FLOWS_TO_STAKERS: 'the fee on each swap flows to stakers',
    };
    for (const s of SHAPES) {
      expect(samples[s.id], `no sample written for ${s.id}`).toBeTruthy();
      expect(s.re.test(samples[s.id]!), `${s.id} no longer fires on its own shape`).toBe(true);
    }
    const legal = [
      'a payout round can open only after 1 ETH has arrived',
      'The pair contract lets the venue take one sixth of that fee as newly minted pool shares.',
      'The other 80% is routed toward TOWELI stakers as ETH.',
      'limit orders executed on our thin native pool',
      'it stays undeployed until the native pool is deep enough to support it',
    ];
    for (const line of legal) {
      const hit = SHAPES.find((s) => s.re.test(line));
      expect(hit?.id, `true wording rejected by ${hit?.id}: ${line}`).toBeUndefined();
    }
  });
});

// The static answers a visitor is given about ETH for stakers: the assistant's and the
// TOWELI room's FAQ. Found by subject, so a new answer on the subject is held too.
const STATIC_ANSWERS: { where: string; text: string }[] = [
  ...KNOWLEDGE_BASE.map((e) => ({ where: `towelie [${e.keywords.join(', ')}]`, text: e.answer })),
  ...TOWELI_FAQ_DATA.flatMap((s) => s.items.map((i) => ({ where: `faq "${i.q}"`, text: i.a }))),
];
const A_DATE = /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d\b/;
const A_LIVE_READ = /\/premium\b|Premium page|shows the live (?:number|total|rate)/i;
/** The fixed floor of a payout round: design, true before and after the first payment. */
const THE_ROUND_FLOOR = /\b1 ETH\b/;
/** A statement that nothing has been paid: history, true only as of a reading. */
const NOTHING_PAID = /none has been distributed yet|had been paid none/;

describe('what a static answer may say about ETH for stakers', () => {
  const aboutSwapFeeEth = STATIC_ANSWERS.filter((a) => /swap[- ]fee|swap fees|venue fee/i.test(a.text) && /\bETH\b/.test(a.text) && /stak/i.test(a.text));

  it('finds the answers on the subject', () => {
    // Two FAQ answers, four of the assistant's, and the two Gold Card answers.
    expect(aboutSwapFeeEth.length).toBeGreaterThanOrEqual(8);
  });

  it('each one says what a payout round waits on, or that nothing has been paid', () => {
    for (const a of aboutSwapFeeEth) {
      expect(THE_ROUND_FLOOR.test(a.text) || NOTHING_PAID.test(a.text), a.where).toBe(true);
    }
  });

  it('one that says nothing has been paid dates it or points at the live figure', () => {
    const history = aboutSwapFeeEth.filter((a) => NOTHING_PAID.test(a.text));
    expect(history.length).toBeGreaterThanOrEqual(4);
    for (const a of history) {
      expect(A_LIVE_READ.test(a.text) || A_DATE.test(a.text), a.where).toBe(true);
    }
  });

  it('an answer that gives the router fee as a figure names the referral share and does not hand stakers the whole fee', () => {
    const withRate = STATIC_ANSWERS.filter((a) => /0\.5%/.test(a.text) && /\bfee\b/i.test(a.text) && /staker/i.test(a.text));
    expect(withRate.length).toBeGreaterThanOrEqual(2);
    for (const a of withRate) {
      expect(a.text, a.where).toMatch(/referral share/i);
      // The staker share is the remainder, stated as a route, never as an arrival.
      expect(a.text, a.where).toMatch(/routed toward (?:TOWELI )?stakers/);
      // The rate is a setting the owner can move: it is dated, never stated as timeless.
      expect(a.text, a.where).toMatch(A_DATE);
    }
  });

  it('a measured amount of ETH in a static answer carries the date it was read', () => {
    // "1 ETH" is the distributor's fixed floor, a constant in the deployed bytecode.
    const withAmount = STATIC_ANSWERS.filter((a) => /\b\d+(?:\.\d+)? ETH\b/.test(a.text.replace(/\b1 ETH\b/g, '')));
    expect(withAmount.length).toBeGreaterThanOrEqual(2);
    for (const a of withAmount) expect(a.text, a.where).toMatch(A_DATE);
  });

  it('the answers written on 2026-10-10 carry no em dash', () => {
    const rewritten = aboutSwapFeeEth.filter((x) => THE_ROUND_FLOOR.test(x.text) || /had been paid none/.test(x.text));
    expect(rewritten.length).toBeGreaterThanOrEqual(6);
    for (const a of rewritten) expect(a.text, a.where).not.toContain('—');
  });
});

describe('the limits table on /risks says where each swap fee goes', () => {
  // The rows are a private constant of the page, so each is read by its label.
  const rows = stripComments(readFileSync(join(SRC, 'pages', 'RisksPage.tsx'), 'utf8')).split('\n');
  const row = (label: string) => {
    const found = rows.filter((l) => l.includes(`label: '${label}'`));
    expect(found, label).toHaveLength(1);
    return found[0]!;
  };

  it('the venue fee row names the referral share, and routes the rest instead of delivering it', () => {
    expect(row('Protocol fee')).toMatch(/referral share comes off first/i);
    expect(row('Protocol fee')).toMatch(/routed toward stakers/i);
    expect(row('Protocol fee')).not.toMatch(/revenue to stakers/i);
  });

  it('the pool fee row says who keeps it, and that the venue holds a switch', () => {
    expect(row('Pool trading fee')).toMatch(/0\.3%/);
    expect(row('Pool trading fee')).toMatch(/can switch on a one-sixth cut/i);
    // Conditional on the switch, so it is true before and after the owner uses it.
    expect(row('Pool trading fee')).toMatch(/until it does, liquidity providers keep/i);
  });
});

describe('the liquidity primer says what a liquidity provider is paid today', () => {
  const answer = () => {
    render(<LiquidityPrimer />);
    return screen.getByTestId('primer-how-paid').textContent ?? '';
  };

  it('names the pool fee, and does not shrink the provider’s share to a part of it', () => {
    const text = answer();
    expect(text).toMatch(/0\.3% fee/);
    expect(text).toMatch(/kept the whole 0\.3%|keep the whole 0\.3%/);
    expect(text).not.toMatch(/0\.25%/);
  });

  it('describes the venue’s cut as a switch: who holds it, how fast, and how to check it', () => {
    const text = answer();
    expect(text).toMatch(/one sixth/i);
    expect(text).toMatch(/owner wallet/i);
    expect(text).toMatch(/no waiting period/i);
    expect(text).toMatch(/kLast/);
    // The state of the switch is a reading, so it carries its date.
    expect(text).toMatch(A_DATE);
  });

  it('says how the venue earns, in the same answer', () => {
    expect(answer()).toMatch(/venue earns[^.]*venue fee/i);
  });

  it('carries no em dash', () => {
    expect(answer()).not.toContain('—');
  });
});
