// The Ethereum-side money sentences, pinned as claim shapes (the reads are in the commit).
// 1. Nothing about ETH waits on the native pool going live.
// 2. The venue's one-sixth cut of the pool fee is a switch the owner wallet flips pool by
//    pool, on for TOWELI/WETH since 2026-10-16, so copy may not call the Ethereum cut off.
// 3. The router fee goes to the treasury Safe after a referral share (owner ruling 2026-11-15).
// 4. A static answer cannot read the chain: a figure that can move is dated or points live.

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
  // "…route to stakers once the native pool is live", "first at native-pool launch"
  { id: 'WAITS_ON_THE_POOL_STATE', re: /\bnative[- ]pool (?:launch(?:es)?|goes live|is live|is trading|opens|comes online)\b/i },
  // "five sixths of it accrues into the reserves", "swap fees split 5/6 to LPs"
  { id: 'LPS_ON_FIVE_SIXTHS', re: /\bfive[- ]sixths\b|\b5\/6 (?:to|goes to|stays? with|for) (?:the )?(?:LPs?|liquidity|pool)/i },
  // "Venue cut: off", "the optional cut was off", "the cut had never been switched on",
  // "kLast is 0": all true on 2026-10-10, all false for TOWELI/WETH since 2026-10-16
  { id: 'ETH_CUT_STILL_OFF', re: /\bvenue cut: off\b|\boptional cut was off\b|\bcut (?:had |has )?never (?:been )?switched on\b|\bkLast is 0\b/i },
  // "a 0.5% protocol fee that flows to TOWELI stakers"
  { id: 'FEE_FLOWS_TO_STAKERS', re: /\bfees?\b[^.]{0,40}\bflows? to (?:TOWELI )?stakers\b/i },
  // "to stakers, the liquidity engine, and operations", "fees → stakers, liquidity & ops":
  // the liquidity share of fees is 0 on chain (polShareBps() = 0, read 2026-10-10)
  { id: 'FEES_TO_LIQUIDITY', re: /\bliquidity (?:engine|&(?:amp;)? ops)\b|\bstakers, (?:the )?liquidity\b/i },
  // "swap fees route on-chain to stakers in ETH" with no word of the 20% referral share
  { id: 'STAKERS_WITHOUT_REFERRAL', re: /\broutes? on-?chain to stakers\b(?![^.]{0,80}\breferral)/i },
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
      'components/layout/Footer.tsx',
      'components/ProtocolStats.tsx',
      'components/ui/OnboardingModal.tsx',
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
      ETH_CUT_STILL_OFF: 'on that date the cut had never been switched on',
      FEE_FLOWS_TO_STAKERS: 'the fee on each swap flows to stakers',
      FEES_TO_LIQUIDITY: 'every fee is split between stakers, the liquidity reserve and the team',
      STAKERS_WITHOUT_REFERRAL: 'all swap fees route onchain to stakers as ETH',
    };
    for (const s of SHAPES) {
      expect(samples[s.id], `no sample written for ${s.id}`).toBeTruthy();
      expect(s.re.test(samples[s.id]!), `${s.id} no longer fires on its own shape`).toBe(true);
    }
    const legal = [
      'a payout round can open only after 1 ETH has arrived',
      'The pair contract lets the venue take one sixth of that fee as newly minted pool shares.',
      "The rest goes to the venue's treasury; none of it goes to stakers.",
      'limit orders executed on our thin native pool',
      'it stays undeployed until the native pool is deep enough to support it',
      "protocol swap fees go on-chain, after a referral share, to the venue's treasury",
      'Protocol fees go on-chain to the treasury, after the referral share.',
      'add liquidity, stake LP tokens, earn rewards',
      'Swap fee 0.3%, all to providers until the venue switches on its one-sixth cut for that pool',
      'To check a pool today, read kLast on its pair contract: 0 means its cut is not on.',
    ];
    for (const line of legal) {
      const hit = SHAPES.find((s) => s.re.test(line));
      expect(hit?.id, `true wording rejected by ${hit?.id}: ${line}`).toBeUndefined();
    }
  });
});

// The static answers a visitor is given about swap fees: the assistant's and the TOWELI
// room's FAQ. Found by subject, so a new answer on the subject is held too.
const STATIC_ANSWERS: { where: string; text: string }[] = [
  ...KNOWLEDGE_BASE.map((e) => ({ where: `towelie [${e.keywords.join(', ')}]`, text: e.answer })),
  ...TOWELI_FAQ_DATA.flatMap((s) => s.items.map((i) => ({ where: `faq "${i.q}"`, text: i.a }))),
];
const A_DATE = /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d\b/;

describe('what a static answer may say about swap fees', () => {
  const aboutSwapFees = STATIC_ANSWERS.filter((a) => /swap[- ]fee|swap fees|venue fee/i.test(a.text));

  it('finds the answers on the subject', () => {
    // The assistant's token, project, supply, fee and Gold Card answers, and three FAQ answers.
    expect(aboutSwapFees.length).toBeGreaterThanOrEqual(8);
  });

  it('each one sends the swap fee to the treasury, and none to stakers or holders', () => {
    // Owner ruling 2026-11-15: every router pays the treasury Safe.
    for (const a of aboutSwapFees) {
      expect(a.text, a.where).toMatch(/treasury/i);
      expect(a.text, a.where).not.toMatch(/routed toward|in line for ETH|payout round|ETH swap-fee|earn ETH/i);
    }
  });

  it('an answer that gives the router fee as a figure names the referral share and dates the rate', () => {
    const withRate = STATIC_ANSWERS.filter((a) => /0\.5%/.test(a.text) && /\bfee\b/i.test(a.text));
    expect(withRate.length).toBeGreaterThanOrEqual(2);
    for (const a of withRate) {
      expect(a.text, a.where).toMatch(/referral share/i);
      expect(a.text, a.where).toMatch(/goes to the venue's treasury/);
      // The rate is a setting the owner can move: it is dated, never stated as timeless.
      expect(a.text, a.where).toMatch(A_DATE);
    }
  });

  it('the answers about swap fees carry no em dash', () => {
    for (const a of aboutSwapFees) expect(a.text, a.where).not.toContain('—');
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

  it('the venue fee row names the referral share, and sends the rest to the treasury', () => {
    expect(row('Protocol fee')).toMatch(/referral share comes off first/i);
    expect(row('Protocol fee')).toMatch(/goes to the venue's treasury/i);
    expect(row('Protocol fee')).not.toMatch(/revenue to stakers/i);
  });

  it('the pool fee row says who keeps it, and that the venue holds a switch', () => {
    expect(row('Pool trading fee')).toMatch(/0\.3%/);
    expect(row('Pool trading fee')).toMatch(/can switch on a one-sixth cut/i);
    // The switch is per pool: conditional for a pool not yet switched on...
    expect(row('Pool trading fee')).toMatch(/pool by pool; until it does, liquidity providers keep/i);
    // ...and dated where the owner has used it.
    expect(row('Pool trading fee')).toMatch(/On TOWELI\/ETH it has been on since 16 October 2026/);
  });
});

describe('the liquidity primer says what a liquidity provider is paid today', () => {
  const answer = () => {
    render(<LiquidityPrimer />);
    return screen.getByTestId('primer-how-paid').textContent ?? '';
  };

  it('names the pool fee, and what a provider keeps with the venue’s cut on and without it', () => {
    const text = answer();
    expect(text).toMatch(/0\.3% fee/);
    // TOWELI/WETH since 2026-10-16: the cut is on, so its providers keep about 0.25%.
    expect(text).toMatch(/On TOWELI\/ETH it has been on since 16 October 2026, so providers there keep about 0\.25%/);
    // A pool not yet switched on.
    expect(text).toMatch(/where it is not on keeps the whole 0\.3%/);
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
