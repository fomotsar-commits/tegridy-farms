// Published docs (root *.md, docs/, .github/) may not make a revenue or token claim the chain
// contradicts. Each SHAPE is a family of wordings for one false claim, pinned by a sample; the
// legal list pins the honest wording. Since the owner's ruling of 2026-11-15 every EVM venue fee
// lands in its chain's treasury Safe (on Ethereum after a 20% referral share) and stakers earn
// TOWELI only. Prose is read a paragraph at a time, quotes included: a correction describes the
// old claim, it does not repeat it. The app's half is `pages/revenueClaimHonesty.test.ts`.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, sep } from 'node:path';

// cwd-independent: a run from frontend/ and one from the repo root must scan the same files.
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'README.md')) && existsSync(join(d, 'docs'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate the repo root from ' + import.meta.url);
}

const ROOT = repoRoot();

// Audit reports quote the claims they found, and the yield survey describes other protocols,
// never ours. May only shrink: a new entry is a claim that the file makes no claim.
const HISTORICAL_RECORD = [
  /^docs\/audits\//,
  /^docs\/archive\/novel-defi-yield-mechanisms\.md$/,
];

// A claim the 2026-11-15 ruling made false was true before it: old plans and changelog lines keep it.
const BEFORE_RULING = [/^docs\/archive\//, /^(?:docs\/)?CHANGELOG(?:_EARLIER)?\.md$/];

// A gap that crosses ordinary words but not a negator, so "has no permit" is not an offence.
const G = String.raw`(?:(?!\b(?:no|not|never|lacks?|without|absent|missing)\b)[^.\n])`;
// "lockers" and "veTOWELI holders" are the same audience under another noun.
const STAKERS = String.raw`(?:the\s+)?(?:ve-?)?(?:TOWELI\s+)?(?:stakers|lockers|holders\s+who\s+lock)`;
// The venue's swap fee, named or as "the rest" of it after the referral share.
const SWAP_FEE = String.raw`(?:(?:swap|venue(?:'s)?|dex|trading|router(?:'s)?|front-door)\s+(?:swap\s+)?fees?|the\s+(?:rest|remainder))`;
// From the start of a sentence, with no negator before the claim.
const SENTENCE = String.raw`(?:^|[.;:!?]\s+)${G}*?`;

type Shape = { id: string; re: RegExp; why: string; ruling?: true };

const SHAPES: Shape[] = [
  // ── 1. totality ─────────────────────────────────────────────────────────────
  {
    id: 'TOTALITY_OF_FEES',
    re: /\b(?:100\s?%|every\s+basis\s+point)\s+of\s+(?:the\s+|any\s+|its\s+)?(?:[\w/-]+\s+)?(?:protocol|swap|trading|dex)\s+fees?\b/i,
    why: 'on Ethereum a 20% referral share is taken off the top and cannot be set to zero',
  },
  {
    id: 'TOTALITY_TO_STAKERS',
    re: new RegExp(String.raw`\b(?:100\s?%|every\s+basis\s+point)[\s*,]+(?:of\s+(?:it|that)\s+)?(?:to|for)\s+${STAKERS}\b`, 'i'),
    why: 'no swap fee goes to stakers: the routers pay the treasury Safe',
  },
  {
    id: 'TOTALITY_TO_REVENUE_DISTRIBUTOR',
    re: /\b(?:RevenueDistributor|RevDist)\b[^.\n]{0,30}\b(?:receives?|gets?)\b[^.\n]{0,15}\b100\s?%/i,
    why: 'RevenueDistributor has received nothing; totalDistributed() is 0',
  },

  // ── 2. arrival asserted as fact ─────────────────────────────────────────────
  {
    id: 'FEES_REACH_STAKERS',
    re: new RegExp(String.raw`\bfees?\s+(?:\w+\s+){0,2}?(?:flow|flows|go|goes|stream|streams|accrue|accrues|are\s+(?:distributed|paid|streamed|sent))\s+to\s+${STAKERS}\b`, 'i'),
    why: 'no fee has ever reached a staker, and swap fees now go to the treasury Safe',
  },
  {
    id: 'FEES_REACH_STAKERS_ELIDED',
    re: new RegExp(String.raw`\b(?:stream|streams|pay|pays|distribute|distributes|send|sends|push|pushes)\s+(?:it|them|that|this|the\s+fee|those\s+fees?)\s+to\s+${STAKERS}\b`, 'i'),
    why: 'same claim with the subject elided ("...and streams it to stakers")',
  },

  // ── 3. the rail has never earned ────────────────────────────────────────────
  {
    id: 'TOTAL_ETH_FEES_IS_ZERO',
    re: /totalETHFees\(\)[^\n]{0,70}?(?:is|==|=|reads?|read|returns?|returned)\s*[`*"']{0,2}\s*0\b/i,
    why: 'totalETHFees() is above zero: state the mechanism, never a balance',
  },
  {
    id: 'NEVER_EARNED',
    re: /\bnever\s+(?:earned|accrued)\b/i,
    why: 'the rail has earned; it is the DISTRIBUTION that has never happened',
  },
  {
    id: 'NOTHING_HAS_EVER_ACCRUED',
    re: /\bhas\s+ever\s+accrued\b/i,
    why: 'accrual happened: deny distribution instead, which is still true',
  },

  // ── 4. live-token capability ledger ─────────────────────────────────────────
  // Selector scan of the live TOWELI 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D, 2026-08-12:
  //   PRESENT burn(uint256), burnFrom(address,uint256), Ownable2Step (owner() == 0x0)
  //   ABSENT  permit(...), DOMAIN_SEPARATOR(), nonces(address), mint(address,uint256)
  {
    id: 'TOKEN_CLAIMS_PERMIT_AS_STANDARD',
    re: /\*{0,2}Standards?\*{0,2}\s*[:|][^|\n]{0,90}\b(?:ERC|EIP)-?2612\b/i,
    why: 'the live bytecode has no permit/DOMAIN_SEPARATOR/nonces',
  },
  {
    id: 'TOKEN_CLAIMS_OZ_PERMIT_EXTENSION',
    re: /\bERC20Permit\b/,
    why: 'the live token is not the OZ permit extension; only the repo source is',
  },
  {
    id: 'TOKEN_CLAIMS_PERMIT_CAPABILITY',
    re: new RegExp(String.raw`\bTOWELI\b${G}{0,40}\b(?:already\s+)?(?:has|have|implements?|supports?)\b${G}{0,60}\b(?:ERC|EIP)-?2612\b`, 'i'),
    why: 'TOWELI does not implement EIP-2612 on mainnet',
  },
  {
    id: 'TOKEN_CLAIMS_PERMIT_CAPABILITY_REVERSED',
    re: new RegExp(String.raw`\b(?:ERC|EIP)-?2612\b${G}{0,90}\bTOWELI\b${G}{0,30}\b(?:already\s+)?(?:has|have|implements?|supports?)\b`, 'i'),
    why: 'same claim with the standard named first',
  },
  {
    id: 'TOKEN_LIVE_CODE_IS_PERMIT',
    re: new RegExp(String.raw`\b(?:live|deployed|mainnet)\s+(?:bytecode|address|token|contract)\b${G}{0,80}\b(?:ERC|EIP)-?2612\b`, 'i'),
    why: 'the deployed code is a generator template, not OZ ERC-20 + ERC-2612',
  },
  {
    id: 'TOKEN_CLAIMS_NO_BURN',
    re: /\bno(?:\s+\w+){0,2}[\s`]*burn(?:\(\))?[\s`]*(?:entrypoint|function|path|mechanism)\b/i,
    why: 'burn(uint256) and burnFrom(address,uint256) are both in the live bytecode',
  },
  {
    id: 'TOKEN_LIVE_ADDRESS_ATTRIBUTED_TO_REPO_SOURCE',
    re: /0x420698CFdEDdEa6bc78D59bC17798113ad278F9D[^\n]{0,220}Toweli\.sol/i,
    why: 'contracts/src/Toweli.sol is not the bytecode at that address',
  },
  {
    id: 'TOKEN_REPO_SOURCE_CLAIMED_LIVE',
    re: /Toweli\.sol\b[^\n]{0,140}?\b(?:matches|is\s+the\s+(?:live|deployed|verified|canonical))\b/i,
    why: 'the repo source and the live bytecode disagree on permit, burn and ownership',
  },

  // ── 5. the swap fee goes to stakers (false since the ruling of 2026-11-15) ──
  {
    id: 'SWAP_FEE_ROUTED_TO_STAKERS',
    re: new RegExp(String.raw`${SENTENCE}\b${SWAP_FEE}\b${G}{0,120}?\b(?:routed|routes?|earmarked|set\s+aside|aimed|wired|bound|destined|in\s+line|owed|paid(?:\s+out)?|sent|credited|distributed|go|goes|flow|flows|accrues?)\b${G}{0,30}?\b(?:to|toward|towards|for|at)\s+${STAKERS}\b`, 'i'),
    why: "the venue's swap fee goes to the treasury Safe, not to stakers",
    ruling: true,
  },
  {
    id: 'SWAP_FEE_TO_PAYOUT_CONTRACT',
    re: new RegExp(String.raw`${SENTENCE}\b${SWAP_FEE}\b${G}{0,120}?\b(?:to|toward|towards|through|via|into)\s+\x60?RevenueDistributor\b`, 'i'),
    why: "every fee router pays the treasury Safe; the stakers' payout contract gets no swap fee",
    ruling: true,
  },
  {
    id: 'STAKERS_EARN_SWAP_FEES',
    re: new RegExp(String.raw`${SENTENCE}\b(?:stakers?|lockers|TOWELI\s+holders|(?:lock|stake)\s+TOWELI)\b${G}{0,60}?\b(?:earn|earns|get|gets|receive|receives|in\s+line\s+for|share\s+of|paid\s+in)\b${G}{0,40}?\b(?:from|of)\s+(?:the\s+)?(?:protocol\s+|venue(?:'s)?\s+)?swap[-\s]fees?\b`, 'i'),
    why: 'stakers earn TOWELI only; swap fees go to the treasury Safe',
    ruling: true,
  },
  {
    id: 'STAKER_LEVER_LABEL',
    re: /\bstakers?\b[*_]*\s*[:|][*_\s]*`?10,?000`?\s*bps\b/i,
    why: "stakerShareBps is what a router pays its revenueDistributor address, the treasury Safe",
    ruling: true,
  },
];

const TREASURY = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, acc);
    } else if (/\.(md|svg|ya?ml)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Every published surface a reader of the repo can reach, minus the historical record. */
function publishedDocs(): string[] {
  // Enumerated, not listed: a hardcoded list only proves things about that list.
  const roots = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(md|markdown)$/i.test(e.name))
    .map((e) => join(ROOT, e.name));
  return [...roots, ...walk(join(ROOT, 'docs')), ...walk(join(ROOT, '.github'))]
    .map((f) => f.split(sep).join('/'))
    .filter((f) => !HISTORICAL_RECORD.some((r) => r.test(f.slice(ROOT.length + 1))));
}

/** SVG carries its claims in text nodes; the markup between them is not prose. */
function readable(file: string): string {
  const raw = readFileSync(file, 'utf8');
  return /\.svg$/i.test(file) ? raw.replace(/<[^>]*>/g, ' ') : raw;
}

// A wrapped paragraph is one claim. Table rows, headings, list items and fences start a new one.
const BLOCK_START = /^\s*(?:\||#|```|[-*+]\s|\d+[.)]\s|$)/;
type Paragraph = { line: number; text: string };

function paragraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s*>\s?/, '');
    if (cur && !BLOCK_START.test(line) && !/^(?:\||#|```)/.test(cur.text)) {
      cur.text += ' ' + line.trim();
      continue;
    }
    if (cur) out.push(cur);
    cur = line.trim() === '' ? null : { line: i + 1, text: line.trim() };
  }
  if (cur) out.push(cur);
  return out;
}

describe('published docs make no revenue claim the chain contradicts', () => {
  it('carries no banned claim shape', () => {
    const offenders: string[] = [];
    for (const file of publishedDocs()) {
      const rel = file.slice(ROOT.length + 1);
      const history = BEFORE_RULING.some((r) => r.test(rel));
      for (const p of paragraphs(readable(file))) {
        for (const s of SHAPES) {
          if (s.ruling && history) continue;
          const m = p.text.match(s.re);
          if (m) offenders.push(`${rel}:${p.line} [${s.id}] ${s.why}\n    ...${m[0].slice(-140)}`);
        }
      }
    }
    expect(offenders, `false published claims:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reaches the surfaces that made the claims', () => {
    // A walker that returns nothing passes the scan above having checked zero files.
    const files = publishedDocs().map((f) => f.slice(ROOT.length + 1));
    expect(files.length).toBeGreaterThan(40);
    for (const must of [
      'README.md',
      'docs/FAQ.md',
      'docs/CONTRACTS.md',
      'docs/TOKENOMICS.md',
      'docs/banner.svg',
      'docs/COMMUNITY_LAUNCH.md',
      'docs/ARCHITECTURE.md',
      'docs/TOKEN_DEPLOY.md',
      'docs/USER_VALUE_ROADMAP.md',
      'docs/GOLIVE_CORELOOP.md',
      '.github/FUNDING.yml',
    ]) {
      expect(files, `${must} is not being scanned`).toContain(must);
    }
  });

  it('reads a wrapped paragraph as one claim', () => {
    const [p] = paragraphs('- the rest is set aside for TOWELI\n  stakers, paid out later');
    expect(p.text).toBe('- the rest is set aside for TOWELI stakers, paid out later');
    expect(paragraphs('| a | b |\n| c | d |')).toHaveLength(2);
  });

  it('every shape still fires on the wording it was written for', () => {
    // A regex that matches nothing is indistinguishable from a clean repo. Samples are the
    // shape reworded, not quotes.
    const samples: Record<string, string> = {
      TOTALITY_OF_FEES: 'stakers collect 100% of protocol swap fees',
      TOTALITY_TO_STAKERS: 'the fee is earmarked 100% for stakers',
      TOTALITY_TO_REVENUE_DISTRIBUTOR: 'the RevenueDistributor receives 100% of it',
      FEES_REACH_STAKERS: 'front-door fees flow to stakers in ETH',
      FEES_REACH_STAKERS_ELIDED: 'the router converts the fee and streams it to stakers',
      TOTAL_ETH_FEES_IS_ZERO: 'SwapFeeRouter.totalETHFees() is 0 today',
      NEVER_EARNED: 'the router has never earned a wei',
      NOTHING_HAS_EVER_ACCRUED: 'no swap fee has ever accrued on that rail',
      TOKEN_CLAIMS_PERMIT_AS_STANDARD: '- **Standards:** ERC-20, ERC-2612 (permit)',
      TOKEN_CLAIMS_OZ_PERMIT_EXTENSION: 'plain OpenZeppelin ERC20 + ERC20Permit',
      TOKEN_CLAIMS_PERMIT_CAPABILITY: 'TOWELI supports ERC-2612 signatures',
      TOKEN_CLAIMS_PERMIT_CAPABILITY_REVERSED: 'EIP-2612 is redundant here because TOWELI already has it',
      TOKEN_LIVE_CODE_IS_PERMIT: 'the deployed bytecode is a stock ERC-20 with EIP-2612 folded in',
      TOKEN_CLAIMS_NO_BURN: 'fixed supply, no burn entrypoint',
      TOKEN_LIVE_ADDRESS_ATTRIBUTED_TO_REPO_SOURCE:
        '| TOWELI | 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D | contracts/src/Toweli.sol | Live |',
      TOKEN_REPO_SOURCE_CLAIMED_LIVE: 'Toweli.sol in this repo matches what is on mainnet',
      SWAP_FEE_ROUTED_TO_STAKERS: 'the front-door fee is routed toward stakers, and none has been paid yet',
      SWAP_FEE_TO_PAYOUT_CONTRACT: 'Routes DEX swap fees to RevenueDistributor + POLAccumulator',
      STAKERS_EARN_SWAP_FEES: 'Lock TOWELI, earn a share of swap fees in ETH',
      STAKER_LEVER_LABEL: '- **Stakers:** `10000` bps of what the router pays out',
    };
    for (const s of SHAPES) {
      expect(samples[s.id], `no sample written for ${s.id}`).toBeTruthy();
      expect(s.re.test(samples[s.id]), `${s.id} no longer fires on its own shape`).toBe(true);
    }
    // ...and the honest wording must survive, or the guard just forces a new lie.
    const legal = [
      "after a 20% referral share, the venue's swap fee goes to the treasury Safe, not to stakers",
      'no swap fee is routed to stakers or through RevenueDistributor',
      'stakers earn TOWELI, not a share of swap fees',
      'LockerClaimer forwards a launch fee to RevenueDistributor',
      'stakerShareBps() reads 10000: what the router pays its revenueDistributor address, the treasury Safe',
      'RevenueDistributor.totalDistributed() is 0: nothing has ever been distributed',
      'the live bytecode exposes burn(uint256) and burnFrom, and has no permit entrypoint',
    ];
    for (const line of legal) {
      const hit = SHAPES.find((s) => s.re.test(line));
      expect(hit?.id, `honest wording rejected by ${hit?.id}: ${line}`).toBeUndefined();
    }
  });
});

describe('the sponsorship button cannot point away from the treasury', () => {
  it('names no address other than the treasury Safe in an active key', () => {
    // A sponsor button is money in a stranger's hands. 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e
    // is one of the Safe's two owners, never the treasury. A comment may say so; a key may not.
    const yml = readFileSync(join(ROOT, '.github', 'FUNDING.yml'), 'utf8');
    const active = yml
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
      .join('\n');
    const addresses = active.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    for (const a of addresses) {
      expect(a.toLowerCase(), 'FUNDING.yml solicits funds at a non-treasury address').toBe(
        TREASURY.toLowerCase(),
      );
    }
  });
});
