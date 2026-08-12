// PUBLISHED-DOCS CLAIM GUARD — the doc half of `pages/revenueClaimHonesty.test.ts`.
//
// That guard walks `frontend/src/**` and nothing else. Every claim it bans survived
// untouched in README.md, FAQ.md, CONTRACTS.md, TOKENOMICS.md, docs/ and the social
// banner, because a reader of the repo is not a reader of the app. README.md carried
// the exact phrase the app guard forbids; docs/banner.svg renders "100% OF SWAP FEES /
// flow to stakers in ETH" at the top of the README; docs/COMMUNITY_LAUNCH.md ships it
// as copy-paste bio and tweet text — the worst case, because a stranger posts that
// under their own name and it outlives any correction made here.
//
// Read on mainnet 2026-08-12 with `cast`, and re-derived from the deployed source:
//
//   SwapFeeRouter  0x6d5791A6…5956E  totalETHFees()   = 3e12 wei   (NOT zero)
//                                    accumulatedETHFees() = 0
//   ReferralSplitter 0x6B3442dA…7e4c  callerCredit(router) = 2.4e12 (80% of the fee)
//                                    accumulatedTreasuryETH = 6e11 (20%, treasury-bound)
//   RevenueDistributor 0xF993316E…3E17 totalDistributed() = 0, balance = 0
//
// So the rail HAS earned; `_recordReferralFee` forwards 100% of it to the splitter;
// `referralFeeBps` (2000) is taken off the top and can never reach stakers; the 80%
// remainder parks as `callerCredit` until someone calls the permissionless
// `recoverCallerCredit()`, which nobody ever has. The 20% is structural, not a setting:
// `ReferralSplitter.proposeReferralFee` rejects 0 (`FEE_CANNOT_BE_ZERO`) and
// `SwapFeeRouter.applyReferralSplitter(address(0))` reverts `ReferralFeeNonZero()` while
// the share is above zero — so the splitter cannot be unwired either.
//
// The rules pinned below are CLAIM SHAPES, not sentences. Each shape is a family of
// surface encodings for one invariant, so a reword lands on a different encoding of the
// same shape rather than slipping through:
//
//   1. No totality claim about the swap fee. "100% / every basis point" reaching
//      stakers, the RevenueDistributor, or anything downstream is false while a
//      non-zero, non-removable referral share sits in front of them.
//   2. No unconditioned present-tense claim that fees DO reach stakers. Describing the
//      route ("routed to", "earmarked for") stays legal — that is design, true before
//      and after the first payment. Claiming arrival is history, and history must be
//      conditioned on the read that backs it.
//   3. No claim that the rail has never EARNED. Denying accrual is now false; denying
//      DISTRIBUTION is still true and stays legal, which is the whole point of splitting
//      the two — a doc should state the mechanism (captured, parked, never distributed)
//      rather than a balance that goes stale on the next swap.
//   4. No capability claim about the live TOWELI that its bytecode contradicts.
//
// Unlike the app guard, this one does NOT exempt correction notes that quote the old
// wording. The app guard strips `//` lines because a comment is invisible to a user;
// prose has no such channel, so a correction that restates the false sentence verbatim
// is still a false sentence a reader can screenshot. Correction notes here describe what
// was wrong instead of reproducing it — which also denies a future writer the loophole of
// wrapping a live claim in quotation marks.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, sep } from 'node:path';

// cwd-independent: vitest runs from frontend/, but a repo-root run must reach the same
// files rather than silently scanning nothing.
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'README.md')) && existsSync(join(d, 'docs'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate the repo root from ' + import.meta.url);
}

const ROOT = repoRoot();

// Point-in-time audit reports quote the very claims corrected here; rewriting them to
// satisfy a guard would destroy the trail that proves when each was found.
// ⚠ MAY ONLY SHRINK — a new entry needs the same justification.
const HISTORICAL_RECORD = [
  /^docs\/audits\//,
  // THIRD-PARTY RESEARCH, not a claim about this protocol. These shapes match any
  // sentence of the form "<audience> earn 100% of <fees>", which is exactly how you
  // correctly DESCRIBE Aerodrome/Velodrome's ve(3,3) model — and describing someone
  // else's mechanism accurately is not a false claim about ours.
  //
  // Excluded by FILE only because this one contains zero references to TOWELI,
  // Tegridy or memetic.fun (verified: 0 matches) — it is a survey of other
  // protocols end to end. Do NOT reach for this list to silence a shape that fires
  // on a doc which DOES talk about us; narrowing the shape or fixing the sentence is
  // the answer there. Adding a file here is a claim that the file makes no claims.
  /^novel-defi-yield-mechanisms\.md$/,
];

// A tempered gap: crosses ordinary words but refuses to step over a negator, so the
// corrected wording ("the live bytecode has no permit") is not itself an offence.
const G = String.raw`(?:(?!\b(?:no|not|never|lacks?|without|absent|missing)\b)[^.\n])`;
// "lockers" and "veTOWELI holders" are the same audience under a different noun; a
// correction that only renamed the recipient would otherwise be a clean escape.
const STAKERS = String.raw`(?:the\s+)?(?:ve-?)?(?:TOWELI\s+)?(?:stakers|lockers|holders\s+who\s+lock)`;

type Shape = { id: string; re: RegExp; why: string };

const SHAPES: Shape[] = [
  // ── 1. totality ─────────────────────────────────────────────────────────────
  {
    id: 'TOTALITY_OF_FEES',
    re: /\b(?:100\s?%|every\s+basis\s+point)\s+of\s+(?:the\s+|any\s+|its\s+)?(?:[\w/-]+\s+)?(?:protocol|swap|trading|dex)\s+fees?\b/i,
    why: 'a 20% referral share is taken off the top and cannot be set to zero',
  },
  {
    id: 'TOTALITY_TO_STAKERS',
    re: new RegExp(String.raw`\b(?:100\s?%|every\s+basis\s+point)[\s*,]+(?:of\s+(?:it|that)\s+)?(?:to|for)\s+${STAKERS}\b`, 'i'),
    why: 'the staker share is 100% OF WHAT ARRIVES, which is at most 80% of the fee',
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
    why: 'no fee has ever reached a staker — say routed/earmarked, not flows',
  },
  {
    id: 'FEES_REACH_STAKERS_ELIDED',
    re: new RegExp(String.raw`\b(?:stream|streams|pay|pays|distribute|distributes|send|sends|push|pushes)\s+(?:it|them|that|this|the\s+fee|those\s+fees?)\s+to\s+${STAKERS}\b`, 'i'),
    why: 'same claim with the subject elided ("…and streams it to stakers")',
  },

  // ── 3. the rail has never earned ────────────────────────────────────────────
  {
    id: 'TOTAL_ETH_FEES_IS_ZERO',
    re: /totalETHFees\(\)[^\n]{0,70}?(?:is|==|=|reads?|read|returns?|returned)\s*[`*"']{0,2}\s*0\b/i,
    why: 'totalETHFees() is 3e12 wei — state the mechanism, never a balance',
  },
  {
    id: 'NEVER_EARNED',
    re: /\bnever\s+(?:earned|accrued)\b/i,
    why: 'the rail has earned; it is the DISTRIBUTION that has never happened',
  },
  {
    id: 'NOTHING_HAS_EVER_ACCRUED',
    re: /\bhas\s+ever\s+accrued\b/i,
    why: 'accrual happened — deny distribution instead, which is still true',
  },

  // ── 4. live-token capability ledger ─────────────────────────────────────────
  // Selector scan of `cast code` at 0x420698…78F9D, 2026-08-12:
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

/** Every published surface a reader of the repo can reach, minus the audit archive. */
function publishedDocs(): string[] {
  // ENUMERATED, NOT LISTED. This was `['README.md','FAQ.md','CONTRACTS.md','TOKENOMICS.md']`,
  // and the two worst offenders in the repo sat just outside it: REVENUE_ANALYSIS.md
  // ("We send 100% to stakers, zero to treasury") and WORKORDER_V2.md — both tracked,
  // both published, and REVENUE_ANALYSIS.md is CITED AS THE AUTHORITY by the very
  // sentences that were corrected in README/TOKENOMICS/ARCHITECTURE. A guard whose
  // scope is a hardcoded list only ever proves things about that list; the sibling
  // guard's own BREADTH GUARD note records being burned by this once already.
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

describe('published docs make no revenue claim the chain contradicts', () => {
  it('carries no banned claim shape', () => {
    const offenders: string[] = [];
    for (const file of publishedDocs()) {
      const rel = file.slice(ROOT.length + 1);
      readable(file).split('\n').forEach((line, i) => {
        for (const s of SHAPES) {
          if (s.re.test(line)) offenders.push(`${rel}:${i + 1} [${s.id}] ${s.why}\n    ${line.trim().slice(0, 140)}`);
        }
      });
    }
    expect(offenders, `false published claims:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reaches the surfaces that made the claims', () => {
    // Guard the guard. A walker that silently returns nothing passes the test above
    // having checked zero files — the exact defect this file exists to close.
    const files = publishedDocs().map((f) => f.slice(ROOT.length + 1));
    expect(files.length).toBeGreaterThan(40);
    for (const must of [
      'README.md',
      'FAQ.md',
      'CONTRACTS.md',
      'TOKENOMICS.md',
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

  it('every shape still fires on the wording it was written for', () => {
    // A regex that matches nothing is indistinguishable from a clean repo. Each sample
    // is the shape, not a quote — reworded on purpose so the shape is what is pinned.
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
    };
    for (const s of SHAPES) {
      expect(samples[s.id], `no sample written for ${s.id}`).toBeTruthy();
      expect(s.re.test(samples[s.id]), `${s.id} no longer fires on its own shape`).toBe(true);
    }
    // …and the corrected wording must survive, or the guard just forces a new lie.
    const legal = [
      'the front-door fee is routed toward stakers, and none has ever been distributed',
      'stakerShareBps() reads 10000, applied to whatever reaches the router',
      'RevenueDistributor.totalDistributed() is 0 — nothing has ever been distributed',
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
    // A live GitHub Sponsors button is money in a stranger's hands: getting this wrong
    // misdirects donations with no recovery. 0xE9B7…f53e reads as an EOA carrying an
    // EIP-7702 delegation designator and is one of the Safe's two owners — never the
    // treasury. Comments may explain that; an active key may not assert it.
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
