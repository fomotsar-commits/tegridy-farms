// DOCS ADDRESS-TRUTH GUARD.
//
// Why this test exists
// --------------------
// `CONTRACTS.md` named `0xb93264aB…` as the canonical, *Live* GaugeController.
// That address is a Wave-0 (pre-relaunch) deployment whose `pairToGauge(address)`
// REVERTS — verified on mainnet 2026-08-06:
//
//   cast call 0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb \
//     "pairToGauge(address)(address)" <weth>   -> execution reverted
//   cast call 0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054 \
//     "pairToGauge(address)(address)" <weth>   -> 0x0000…0000  (OK, no gauge yet)
//
// `VoteIncentives.setGaugeController` is a ONE-SHOT (contracts/src/VoteIncentives.sol:
// `if (gaugeController != address(0)) revert GaugeControllerAlreadySet();`) and its only
// sanity check is `code.length > 0 && code.length != 23`. The dead controller HAS code, so
// the guard passes, the setter latches forever, and every subsequent bribe deposit reverts
// inside `_requireGaugedPair` -> `IGaugeControllerPairs(gc).pairToGauge(pair)`. An operator
// following the doc bricks VoteIncentives permanently. On-chain today
// `VoteIncentives.gaugeController()` is still `address(0)`, so the hazard is live.
//
// The invariant this pins is not "the doc contains string X". It is:
//
//   **No protocol doc may present a superseded address as the canonical / live one.**
//
// The doc is the operator's runbook. A stale address in it is an on-chain action.
//
// Provenance for every address below: `contracts/broadcast/<Script>.s.sol/1/run-latest.json`
// (chain 1) cross-checked with `cast code` / `cast call` on mainnet, 2026-08-06.
// NOTE: the broadcast JSON committed in *this* tree is itself stale for the 2026-07-16
// batch (the refreshed run-latest files are still uncommitted in the operator checkout),
// which is why the expected values are pinned here rather than parsed from it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(process.cwd(), '..');
const doc = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

const DOCS: Record<string, string> = {
  'CONTRACTS.md': doc('CONTRACTS.md'),
  'FAQ.md': doc('FAQ.md'),
  'TOKENOMICS.md': doc('TOKENOMICS.md'),
  'docs/MIGRATION_HISTORY.md': doc('docs', 'MIGRATION_HISTORY.md'),
};

const constantsSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'constants.ts'), 'utf8');
const swapFeeRouterSrc = doc('contracts', 'src', 'SwapFeeRouter.sol');
const stakingSrc = doc('contracts', 'src', 'TegridyStaking.sol');

/** Reads `export const NAME = '0x…'` out of constants.ts. */
function constant(name: string): string {
  const m = constantsSrc.match(new RegExp(`export const ${name} = '(0x[0-9a-fA-F]{40})'`));
  if (!m) throw new Error(`constants.ts has no ${name}`);
  return m[1].toLowerCase();
}

/** Reads a `uint256 public constant NAME = 1_234;` out of a Solidity source. */
function solConstant(src: string, name: string): number {
  const m = src.match(new RegExp(`constant ${name}\\s*=\\s*([0-9_]+)`));
  if (!m) throw new Error(`no Solidity constant ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

// Pre-relaunch / superseded deployments. Each one still has bytecode on mainnet, so
// nothing on-chain stops an operator from wiring it — only the docs do.
const SUPERSEDED: Record<string, string> = {
  // Governance — the brick.
  '0xb93264ab0af377f7c0485e64406be9a9b1df0fdb': 'Wave-0 GaugeController; pairToGauge REVERTS',
  '0xb6e4cfcb83d846af159b9c653240426841aeb414': 'pre-commit-reveal GaugeController',
  '0x417f44aee21cc709262e71a7fdf6028cc17ecf1a': 'Wave-0 VoteIncentives',
  // Community / access.
  '0x3457c2210be35ba7af6f382a76247ecd782bf0c9': 'pre-relaunch MemeBountyBoard',
  '0x8f1ba1ec97a932ee1332ba0f366bc6adf60b3032': 'pre-relaunch CommunityGrants',
  '0xaa16df3dc66c7a6ad7db153711329955519422ad': 'pre-relaunch PremiumAccess (V1)',
  // Staking / farming.
  '0x626644523d34b84818df602c991b4a06789c4819': 'legacy staking — WITHDRAW-ONLY (constants.ts LEGACY_STAKING_ADDRESSES)',
  '0xa5ab522c99f86ded9f429766872101c75517d77c': 'pre-C-01 TegridyLPFarming',
  '0xa7ef711be3662b9557634502032f98944ec69ec1': 'Wave-0 TegridyLPFarming',
  // Core / DEX / revenue — all superseded by the 2026-06-06 DeployMVP relaunch.
  '0x8b786163aa3beb97822d480a0c306dfd6debdcb6': 'pre-relaunch TegridyFactory',
  '0xcbcf6acc4697ca3a7d7658cd2051606a09c9863f': 'pre-relaunch TegridyRouter',
  '0xed01d5f52ebe97360133bdef77305ee24d5f26f6': 'pre-relaunch TOWELI/WETH pair',
  '0xea13cd47a37cc5b59675bfd52bfc8ff8691937a0': 'pre-relaunch SwapFeeRouter',
  '0x332aae555b1164ea45c2291fd7edfa97aaa264d8': 'pre-relaunch RevenueDistributor',
  '0x17215f0dfa5e97c33c025e0560eeddffad87b7ca': 'pre-relaunch POLAccumulator',
  '0xd3d46c0d25ef1f4eadb58b9218aa23ed4c2f2c16': 'pre-relaunch ReferralSplitter',
  '0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995': 'pre-relaunch TegridyTWAP',
  '0xfec9aea42ea966c9382eeb03f63a784579841eb2': 'pre-relaunch TegridyTokenURIReader',
  '0x05409880adfea888f2c93568b8d88c7b4aadb139': 'pre-relaunch TegridyNFTLending',
  '0x1c0e1771943fbb299f4e19dad0faa4fa4e6c04f0': 'pre-relaunch TegridyNFTPoolFactory',
  // Treasury: live treasury is SwapFeeRouter.treasury() == TegridyStaking.treasury()
  // == 0x7D26…Bd7d (a 2-of-2 Safe). 0xE9B7… is one of that Safe's two owners — an EOA
  // carrying an EIP-7702 delegation designator (code == 0xef0100…), not the treasury.
  '0xe9b7ab8e367be5ac0e0c865136f1907bd73df53e': 'pre-relaunch treasury EOA',
};

// The GaugeController that actually answers `pairToGauge(address)` (2026-07-16 batch;
// mainnet read 2026-08-06 returns 0x0…0 normally, while the Wave-0 one REVERTS).
const LIVE_GAUGE_CONTROLLER = '0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054';

// A line "claims currency" if it presents the address as the one to use.
const CLAIMS_CURRENT = /\bCANONICAL\b|\bLive\b|\bcanonical\b/;
// …unless the same line explicitly retires it.
const RETIRES = /deprecated|superseded|retired|legacy|withdraw-only|do not (interact|use)|paused|pre-relaunch|stale|dead|bricks?\b|REVERTS/i;

const ADDR_RE = /0x[0-9a-fA-F]{40}/g;

describe('docs never present a superseded address as canonical', () => {
  for (const [name, body] of Object.entries(DOCS)) {
    it(`${name}`, () => {
      const offenders: string[] = [];
      body.split('\n').forEach((line, i) => {
        if (!CLAIMS_CURRENT.test(line) || RETIRES.test(line)) return;
        for (const a of line.match(ADDR_RE) ?? []) {
          const why = SUPERSEDED[a.toLowerCase()];
          if (why) offenders.push(`${name}:${i + 1} presents ${a} as current (${why})`);
        }
      });
      expect(offenders).toEqual([]);
    });
  }
});

describe('TOKENOMICS.md links only current addresses', () => {
  // TOKENOMICS has no "deprecated" section — every address in it is presented as a
  // place to go and look right now ("Verify on-chain", "contracts of record"). So the
  // word "Live" is not the tell here; being present at all is.
  it('links no superseded deployment', () => {
    const offenders: string[] = [];
    DOCS['TOKENOMICS.md'].split('\n').forEach((line, i) => {
      for (const a of line.match(ADDR_RE) ?? []) {
        const why = SUPERSEDED[a.toLowerCase()];
        if (why) offenders.push(`TOKENOMICS.md:${i + 1} links ${a} (${why})`);
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe('CONTRACTS.md names the addresses that are actually deployed', () => {
  // Deployed 2026-07-16, verified on mainnet 2026-08-06: all five have bytecode,
  // `paused() == false`, and `owner() == 0x1489…456E`.
  const LIVE_GATED_BATCH: Record<string, string> = {
    GaugeController: LIVE_GAUGE_CONTROLLER,
    VoteIncentives: '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF',
    MemeBountyBoard: '0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890',
    CommunityGrants: '0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471',
    PremiumAccess: '0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5',
  };

  for (const [label, addr] of Object.entries(LIVE_GATED_BATCH)) {
    it(`lists the live ${label}`, () => {
      expect(DOCS['CONTRACTS.md'].toLowerCase()).toContain(addr.toLowerCase());
    });
  }

  // These come from constants.ts, so the doc can never drift from the app's own wiring.
  const FROM_CONSTANTS: Array<[string, string]> = [
    ['TegridyStaking', 'TEGRIDY_STAKING_ADDRESS'],
    ['TegridyFactory', 'TEGRIDY_FACTORY_ADDRESS'],
    ['TegridyRouter', 'TEGRIDY_ROUTER_ADDRESS'],
    ['TegridyLP', 'TEGRIDY_LP_ADDRESS'],
    ['SwapFeeRouter', 'SWAP_FEE_ROUTER_ADDRESS'],
    ['RevenueDistributor', 'REVENUE_DISTRIBUTOR_ADDRESS'],
    ['POLAccumulator', 'POL_ACCUMULATOR_ADDRESS'],
    ['ReferralSplitter', 'REFERRAL_SPLITTER_ADDRESS'],
    ['TegridyLPFarming', 'LP_FARMING_ADDRESS'],
    ['TegridyTWAP', 'TEGRIDY_TWAP_ADDRESS'],
    ['TegridyTokenURIReader', 'TEGRIDY_TOKEN_URI_READER_ADDRESS'],
    ['TegridyNFTLending', 'TEGRIDY_NFT_LENDING_ADDRESS'],
    ['TegridyNFTPoolFactory', 'TEGRIDY_NFT_POOL_FACTORY_ADDRESS'],
    ['TegridyLaunchpadV2', 'TEGRIDY_LAUNCHPAD_V2_ADDRESS'],
    ['Treasury', 'TREASURY_ADDRESS'],
  ];

  for (const [label, key] of FROM_CONSTANTS) {
    it(`lists the ${label} address that constants.ts wires`, () => {
      expect(DOCS['CONTRACTS.md'].toLowerCase()).toContain(constant(key));
    });
  }
});

describe('early-exit penalty is described the way the contract behaves', () => {
  // contracts/src/TegridyStaking.sol: `EARLY_WITHDRAWAL_PENALTY_BPS = 2500` and
  // `rewardToken.safeTransfer(treasury, penalty)` — a FLAT penalty, paid to the
  // treasury. It is not time-decaying and it is not redistributed to stakers.
  const pct = solConstant(stakingSrc, 'EARLY_WITHDRAWAL_PENALTY_BPS') / 100;

  const sections: Array<[string, string]> = [
    ['FAQ.md', (DOCS['FAQ.md'].split(/^## What happens if I unstake early\?$/m)[1] ?? '').split(/^## /m)[0]],
    ['TOKENOMICS.md', (DOCS['TOKENOMICS.md'].split(/^### 2\. Early-withdrawal penalty.*$/m)[1] ?? '').split(/^## /m)[0]],
  ];

  for (const [name, section] of sections) {
    it(`${name} states the flat ${pct}% penalty and its destination`, () => {
      expect(section.length).toBeGreaterThan(0);
      expect(section).toContain(`${pct}%`);
      expect(section).toMatch(/treasury/i);
    });

    it(`${name} does not claim the penalty is recycled to stakers`, () => {
      expect(section).not.toMatch(/redistribut/i);
      expect(section).not.toMatch(/compound\w*\s+the\s+reward\s+pool/i);
      expect(section).not.toMatch(/route[sd]?\s+to\s+the\s+RevenueDistributor/i);
    });

    it(`${name} does not claim the penalty decays toward maturity`, () => {
      expect(section).not.toMatch(/linear penalty|decreases? as|scales? down|prorata|pro-rata/i);
    });
  }
});

describe('TOKENOMICS fee-split ceilings match SwapFeeRouter', () => {
  const minStaker = solConstant(swapFeeRouterSrc, 'MIN_STAKER_SHARE_BPS') / 100; // 50
  const maxPol = solConstant(swapFeeRouterSrc, 'MAX_POL_SHARE_BPS') / 100; // 25
  const maxTreasury = 100 - minStaker - 0; // remainder is the treasury leg

  // Anchor on the section heading, not on a sentence — prose gets reworded, headings don't.
  const levers = (DOCS['TOKENOMICS.md'].split(/^## Yield flow.*$/m)[1] ?? '').split(/^## /m)[0];

  it('quotes the staker floor the contract actually enforces', () => {
    expect(levers.length).toBeGreaterThan(0);
    expect(levers).toContain(`${minStaker}%`);
  });

  it('quotes the POL cap the contract actually enforces', () => {
    expect(levers).toContain(`${maxPol}%`);
  });

  it('does not understate the treasury ceiling', () => {
    expect(levers).toContain(`${maxTreasury}%`);
  });
});

describe('the one-shot setGaugeController argument is a live controller', () => {
  // The "superseded presented as canonical" scan above CANNOT see this instruction:
  // the line carries no `Live`/`CANONICAL` marker, so swapping the Wave-0 controller
  // back in passes every other assertion in this file (verified — 36/36 still green
  // with the address poisoned). `setGaugeController` has no unset path, so whatever
  // address the runbook names IS an irreversible on-chain action; it needs its own pin.
  const ARG_LINE = /only correct argument/i;
  const argLines = (name: string) =>
    DOCS[name].split('\n').filter((l) => ARG_LINE.test(l));

  it('the runbook still states the argument (anchor exists)', () => {
    // If this fails the instruction was reworded — re-anchor the assertions below
    // rather than deleting them.
    expect(argLines('docs/MIGRATION_HISTORY.md').length).toBeGreaterThan(0);
  });

  for (const name of Object.keys(DOCS)) {
    it(`${name} never names a superseded controller as the argument`, () => {
      for (const line of argLines(name)) {
        // Annotated so the no-match fallback is `string[]` and not `never[]`:
        // `RegExpMatchArray | never[]` gives `.filter` a `never` callback
        // parameter, and every string method on it is an error.
        const matches: string[] = line.match(ADDR_RE) ?? [];
        const bad = matches.filter((a) => SUPERSEDED[a.toLowerCase()]);
        expect(bad, `${name}: ${bad.join(', ')} is superseded`).toEqual([]);
        // Tolerates the elided form `0x6c79522D…1054` used in table cells.
        expect(line.toLowerCase()).toContain(LIVE_GAUGE_CONTROLLER.slice(0, 10).toLowerCase());
      }
    });
  }
});

describe('FAQ does not describe shipped things in the future tense', () => {
  it('does not treat mainnet launch as upcoming', () => {
    // constants.ts wires a live, non-zero mainnet staking contract: mainnet shipped.
    expect(constant('TEGRIDY_STAKING_ADDRESS')).not.toBe(`0x${'0'.repeat(40)}`);
    expect(DOCS['FAQ.md']).not.toMatch(/pre-mainnet|post-mainnet|before mainnet|after ethereum mainnet launch/i);
  });

  it('does not assert a fee split the router does not implement', () => {
    // Live read 2026-08-06: stakerShareBps 10000, polShareBps 0 -> treasury 0.
    // There is no 70/20/10 split anywhere in the system.
    expect(DOCS['FAQ.md']).not.toMatch(/70\s*\/\s*20\s*\/\s*10/);
    expect(DOCS['FAQ.md']).not.toMatch(/70%\s+to\s+stakers/i);
  });
});
