// @vitest-environment node
//
// Three sentences on the site are about the pool program RUNNING on mainnet: two risk lines a
// person reads before depositing ("only its admin keys changed") and one paragraph on "The
// program" card ("built before that instruction was added"). All three are true of the binary
// deployed on 2026-09-29 and all three go false the day the program is upgraded to the build
// that has create_lp_metadata. Nothing tied them to that day, so this does: the local harness
// pins the binary mainnet runs, and the upgrade's release moves that pin (MAINNET_RUNBOOK.md,
// "The create_lp_metadata upgrade"). While the pin is the old binary the three lines must
// stand; once it is anything else, none of them may.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Source text with every run of whitespace as one space, so a re-wrapped line still matches. */
const read = (p: string) => readFileSync(join(FRONTEND, p), 'utf-8').replace(/\s+/g, ' ');

/** The pool program built BEFORE create_lp_metadata was added: the 2026-09-26 release, live since 2026-09-29. */
const BINARY_WITHOUT_THE_INSTRUCTION = '88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882';

/** Each line that is only true of that binary, and what the same place must say after the upgrade. */
const TRUE_ONLY_BEFORE_THE_UPGRADE = [
  {
    file: 'src/components/solana/lp/LpDisclosures.tsx',
    says: "Our pool program is Raydium's, with only its admin keys changed.",
    after: 'one added instruction',
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    says: 'we changed only its admin keys',
    after: 'one added instruction',
  },
  {
    file: 'src/components/solana/VenueProgramCard.tsx',
    says: 'The program on Solana today was built before that instruction was added.',
    after: null,
  },
] as const;

/** The two places the local harness pins the pool binary that mainnet runs. */
function harnessPins(): { genesis: string | undefined; validator: string | undefined } {
  return {
    genesis: /'cp_swap\.mainnet\.so': '([0-9a-f]{64})'/.exec(read('scripts/solana-localnet/genesis-accounts.mjs'))?.[1],
    validator: /\bPIN_CPSWAP=([0-9a-f]{64})\b/.exec(read('scripts/solana-localnet/start-validator.sh'))?.[1],
  };
}

/** What is wrong with the three lines, given the binary the harness says mainnet runs. */
function problems(deployedBinary: string, source: (file: string) => string): string[] {
  const upgraded = deployedBinary !== BINARY_WITHOUT_THE_INSTRUCTION;
  const out: string[] = [];
  for (const line of TRUE_ONLY_BEFORE_THE_UPGRADE) {
    const text = source(line.file);
    const present = text.includes(line.says);
    if (!upgraded && !present) out.push(`${line.file}: mainnet still runs the binary without the instruction, so it must say "${line.says}"`);
    if (upgraded && present) out.push(`${line.file}: mainnet no longer runs the binary without the instruction, so it must not say "${line.says}"`);
    if (upgraded && line.after && !text.includes(line.after)) out.push(`${line.file}: after the upgrade the risk line must name the "${line.after}"`);
  }
  return out;
}

describe('site copy about the pool program on mainnet follows the binary the harness pins', () => {
  it('the harness pins one pool binary, in both places', () => {
    const { genesis, validator } = harnessPins();
    expect(genesis, 'genesis-accounts.mjs PINNED_SHA256').toMatch(/^[0-9a-f]{64}$/);
    expect(validator, 'start-validator.sh PIN_CPSWAP').toBe(genesis);
  });

  it('the three lines agree with that binary', () => {
    expect(problems(harnessPins().genesis ?? '', read)).toEqual([]);
  });

  // The upgrade-day half, run today: with any other binary pinned, today's wording is refused,
  // line by line. Without this the check above would only ever have been seen passing.
  it('refuses all three of today\'s lines once another binary is pinned', () => {
    const another = 'f'.repeat(64);
    const found = problems(another, read);
    for (const line of TRUE_ONLY_BEFORE_THE_UPGRADE) {
      expect(found).toContain(`${line.file}: mainnet no longer runs the binary without the instruction, so it must not say "${line.says}"`);
    }
  });

  it('accepts the wording written for upgrade day, and refuses a risk line that leaves the instruction out', () => {
    const another = 'f'.repeat(64);
    const afterUpgrade: Record<string, string> = {
      'src/components/solana/lp/LpDisclosures.tsx':
        "Our pool program is Raydium's, with its admin keys changed and one added instruction that names pool share tokens.",
      'src/components/solana/lp/SolanaLpSection.tsx':
        'Our pool program is Raydium’s constant-product pool, with its admin keys changed and one added instruction that names pool share tokens',
      'src/components/solana/VenueProgramCard.tsx': 'which lets a pool’s share token carry a name and a picture in wallets.',
    };
    expect(problems(another, (f) => afterUpgrade[f] ?? '')).toEqual([]);
    const silent: Record<string, string> = { ...afterUpgrade, 'src/components/solana/lp/LpDisclosures.tsx': "Our pool program is Raydium's." };
    expect(problems(another, (f) => silent[f] ?? '')).toEqual([
      'src/components/solana/lp/LpDisclosures.tsx: after the upgrade the risk line must name the "one added instruction"',
    ]);
  });
});
