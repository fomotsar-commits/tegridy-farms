// DEPLOY-CLAIM PARITY GUARD.
//
// The app told visitors three different things about the same four contracts.
// /community linked them to Etherscan as live; /contracts rendered them as "awaiting
// deployment"; /risks said they "are not deployed at all". All on one site, all on
// 2026-08-12, and all after the contracts had been live and unpaused since 2026-07-16.
//
// Four pages were corrected that day. A sweep the next morning found the same claim
// still in FOURTEEN files. Correcting them one page at a time is what produced the
// contradiction in the first place, so this pins the CLASS instead.
//
// The rule: a surface may say a feature is not available HERE. It may not say a
// contract does not EXIST, unless that contract's address is genuinely absent.
//
// Three states, and the copy has to keep them apart:
//   deployed + wired    — PremiumAccess, NFT lending, pool factory, LaunchpadV2
//   deployed, NOT wired — gauge voting, vote incentives, grants, meme bounties
//                         (live on mainnet, constants.ts still 0x0 — a UI gate)
//   not deployed        — TegridyLending (oracle), Restaking (EIP-170), Pro Pass
//
// Reword any prose freely; these stay green. Assert that a deployed contract does not
// exist, or let a "0x0 therefore missing" inference back into user-facing copy, and
// they go red.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  PREMIUM_ACCESS_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  TEGRIDY_LENDING_ADDRESS,
  isDeployed,
} from '../lib/constants';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Strip `//` and block comments — correction notes quote the old wording on purpose. */
function prose(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the four governance contracts are never described as non-existent', () => {
  // SCOPED, not a blanket phrase ban. The first draft matched bare /never deployed/
  // and /contract does not exist/, and every hit was legitimate: "TOWELI is never
  // deployed on Solana" is a standing product policy, and "Target contract does not
  // exist" is a Seaport error about a stranger's NFT. A guard that fires on correct
  // text gets deleted, and then it guards nothing.
  //
  // So the assertion is narrow: a non-existence claim only counts when it is about
  // one of the four contracts that DO exist. Both halves must appear in the same
  // sentence, which is how the /risks copy read.
  const NON_EXISTENCE = /(not deployed at all|never (?:been )?deployed|do(?:es)? not exist|no such contract)/i;
  const OUR_FOUR = /(gauge (?:voting|controller)|vote incentives|community grants|meme bount)/i;

  it('no source file says one of the four DEPLOYED governance contracts does not exist', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      // Sentence-level, so an unrelated policy line elsewhere in the file is not
      // guilty by association.
      for (const sentence of prose(file).split(/(?<=[.!?])\s+/)) {
        if (NON_EXISTENCE.test(sentence) && OUR_FOUR.test(sentence)) {
          offenders.push(`${file.slice(SRC.length - 3).split(sep).join('/')} — "${sentence.trim().slice(0, 160)}"`);
        }
      }
    }
    expect(
      offenders,
      `these say a contract that IS deployed and unpaused on mainnet does not exist:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('deployment states are not collapsed into each other', () => {
  // These four are wired. If any regresses to 0x0 the app has a real problem, and the
  // "not deployed" copy sitting in their fallback branches becomes reachable again —
  // which is fine, but it must be a deliberate change, not a silent one.
  it.each([
    ['PremiumAccess (Gold Card)', PREMIUM_ACCESS_ADDRESS],
    ['NFT lending', TEGRIDY_NFT_LENDING_ADDRESS],
    ['NFT pool factory', TEGRIDY_NFT_POOL_FACTORY_ADDRESS],
    ['LaunchpadV2', TEGRIDY_LAUNCHPAD_V2_ADDRESS],
  ])('%s is wired, so its "not deployed" branch stays unreachable', (_label, addr) => {
    expect(isDeployed(addr)).toBe(true);
  });

  it('Token Lending is genuinely undeployed, so ITS wall must not be removed', () => {
    // The counterweight. Over-correcting is as bad as the original defect: this one
    // really is 0x0, gated on the TWAP oracle, and its banner is telling the truth.
    expect(isDeployed(TEGRIDY_LENDING_ADDRESS)).toBe(false);
  });
});

describe('ContractsPage distinguishes deployed-but-unwired from undeployed', () => {
  const page = readFileSync(join(SRC, 'pages', 'ContractsPage.tsx'), 'utf8');

  it('carries the unwired status and the real on-chain addresses', () => {
    expect(page).toMatch(/status\?:[^;]*'unwired'/);
    for (const addr of [
      '0x6c79522d47cf6d1051cb474e81d9b6f3996c1054', // GaugeController
      '0x6e1dcb7ebd16e09edb574f414adc664b2a5e21af', // VoteIncentives
      '0xebc3aaf48297b8ccfa8272d9e68c1545eb9cd471', // CommunityGrants
      '0x6d2c6ec29d97fe8b6d1471091deee36baf69d890', // MemeBountyBoard
    ]) {
      expect(page.toLowerCase(), `${addr} must be listed so the claim is checkable`).toContain(addr);
    }
  });

  it('does not let a zero address alone drive the pending treatment', () => {
    // The bug was `isPending = status === 'pending' || undeployed`, which collapsed
    // "no address in constants.ts" into "no contract on mainnet".
    expect(page).toMatch(/isPending\s*=\s*!isUnwired/);
  });
});
