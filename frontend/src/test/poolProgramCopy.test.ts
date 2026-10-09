// @vitest-environment node
//
// Four sentences on the site are about the pool program RUNNING on mainnet: three risk lines
// a person reads before depositing and one paragraph on "The program" card. Until the pool
// program was upgraded they said "only its admin keys changed" and "built before that
// instruction was added", which was true of the binary deployed on 2026-09-29 and went false
// the moment mainnet took the build that has create_lp_metadata. Nothing tied them to that
// moment, so this does: the local harness pins the binary mainnet runs, and the release that
// shipped with the upgrade moved that pin and the wording in one commit (MAINNET_RUNBOOK.md,
// "The create_lp_metadata upgrade"). While the pin is the old binary the old lines must
// stand; once it is anything else, none of them may. A roll-back moves the pin back, and
// this then asks for the old lines back with it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Source text with every run of whitespace as one space, so a re-wrapped line still matches. */
const read = (p: string) => readFileSync(join(FRONTEND, p), 'utf-8').replace(/\s+/g, ' ');

/** The pool program built BEFORE create_lp_metadata was added: the 2026-09-26 release, on mainnet from 2026-09-29 until the upgrade. */
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
    // The short risk line above the finder. It named the admin keys as the only change.
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    says: 'a pool program whose admin-key changes have not had',
    after: 'a pool program whose changes from Raydium’s have not had',
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
    // The key is the file's name in the artifacts folder: `cp_swap.mainnet.so` for the
    // 2026-09-26 release, `cp_swap.upgrade-<hash>.mainnet.so` for an upgrade's build.
    genesis: /'cp_swap\.[\w.-]*mainnet\.so': '([0-9a-f]{64})'/.exec(read('scripts/solana-localnet/genesis-accounts.mjs'))?.[1],
    validator: /\bPIN_CPSWAP=([0-9a-f]{64})\b/.exec(read('scripts/solana-localnet/start-validator.sh'))?.[1],
  };
}

/**
 * The build the address registry tells its chain check to look for on mainnet: the hash on
 * the pool program's data account row. `verify-addresses.mjs --onchain` fetches the program
 * bytes and fails unless they hash to it, so this is the one pin that mainnet itself has to
 * satisfy. The wording and the harness pins are only as true as their tie to it.
 */
function registryExpects(): string | undefined {
  const registry = JSON.parse(readFileSync(join(FRONTEND, 'scripts', 'addresses.json'), 'utf-8')) as {
    solana?: { id?: string; expect?: { holdsProgram?: { sha256?: string } } }[];
  };
  return registry.solana?.find((row) => row.id === 'cp-swap-programdata-restart')?.expect?.holdsProgram?.sha256;
}

/** What is wrong with the lines, given the binary the harness says mainnet runs. */
function problems(deployedBinary: string, source: (file: string) => string): string[] {
  const upgraded = deployedBinary !== BINARY_WITHOUT_THE_INSTRUCTION;
  const out: string[] = [];
  for (const line of TRUE_ONLY_BEFORE_THE_UPGRADE) {
    const text = source(line.file);
    const present = text.includes(line.says);
    if (!upgraded && !present) out.push(`${line.file}: mainnet still runs the binary without the instruction, so it must say "${line.says}"`);
    if (upgraded && present) out.push(`${line.file}: mainnet no longer runs the binary without the instruction, so it must not say "${line.says}"`);
    if (upgraded && line.after && !text.includes(line.after)) out.push(`${line.file}: after the upgrade the risk line must say "${line.after}"`);
  }
  return out;
}

/** The wording before the upgrade, and the wording that shipped with it, one sample per file. */
const BEFORE_UPGRADE: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx': "Our pool program is Raydium's, with only its admin keys changed.",
  'src/components/solana/lp/SolanaLpSection.tsx':
    'These pools run on a pool program whose admin-key changes have not had their own independent review yet. Our pool program is Raydium’s constant-product pool; we changed only its admin keys',
  'src/components/solana/VenueProgramCard.tsx': 'The program on Solana today was built before that instruction was added. It gets it only through a program upgrade.',
};
const AFTER_UPGRADE: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx':
    "Our pool program is Raydium's, with its admin keys changed and one added instruction that names pool share tokens.",
  'src/components/solana/lp/SolanaLpSection.tsx':
    'These pools run on a pool program whose changes from Raydium’s have not had their own independent review yet. Our pool program is Raydium’s constant-product pool, with its admin keys changed and one added instruction that names pool share tokens',
  'src/components/solana/VenueProgramCard.tsx': 'which lets a pool’s share token carry a name and a picture in wallets.',
};

describe('site copy about the pool program on mainnet follows the binary the harness pins', () => {
  it('the harness pins one pool binary, in both places', () => {
    const { genesis, validator } = harnessPins();
    expect(genesis, 'genesis-accounts.mjs PINNED_SHA256').toMatch(/^[0-9a-f]{64}$/);
    expect(validator, 'start-validator.sh PIN_CPSWAP').toBe(genesis);
  });

  // The harness pins are typed by hand, and so is the wording. This is what makes them answer
  // to the chain: the registry's chain check hashes the program on mainnet against this same
  // value. Move the wording and the pins without mainnet holding that build and "registry vs
  // chain" is red. Take the hash off the registry row to get it green and this fails.
  it('the address registry sends its chain check looking for that same binary', () => {
    expect(registryExpects(), 'addresses.json, cp-swap-programdata-restart, expect.holdsProgram.sha256').toBe(harnessPins().genesis);
  });

  it('the four lines agree with that binary', () => {
    expect(problems(harnessPins().genesis ?? '', read)).toEqual([]);
  });

  // The other half, run on every commit: whichever binary is NOT pinned today, the wording in
  // the source is refused under it, line by line. Without this the check above would only
  // ever have been seen passing. It is also what a roll-back meets: pin the old binary again
  // and every line is asked to go back.
  it('refuses the wording in the source once the other binary is pinned', () => {
    const pinned = harnessPins().genesis ?? '';
    const upgraded = pinned !== BINARY_WITHOUT_THE_INSTRUCTION;
    const other = upgraded ? BINARY_WITHOUT_THE_INSTRUCTION : 'f'.repeat(64);
    const found = problems(other, read);
    for (const line of TRUE_ONLY_BEFORE_THE_UPGRADE) {
      expect(found).toContain(
        upgraded
          ? `${line.file}: mainnet still runs the binary without the instruction, so it must say "${line.says}"`
          : `${line.file}: mainnet no longer runs the binary without the instruction, so it must not say "${line.says}"`,
      );
    }
  });

  it('accepts each wording under its own binary only, and refuses a risk line that leaves the instruction out', () => {
    const another = 'f'.repeat(64);
    expect(problems(BINARY_WITHOUT_THE_INSTRUCTION, (f) => BEFORE_UPGRADE[f] ?? '')).toEqual([]);
    expect(problems(another, (f) => AFTER_UPGRADE[f] ?? '')).toEqual([]);
    // Each wording under the other binary: every line is named.
    expect(problems(another, (f) => BEFORE_UPGRADE[f] ?? '').filter((p) => p.includes('must not say'))).toHaveLength(TRUE_ONLY_BEFORE_THE_UPGRADE.length);
    expect(problems(BINARY_WITHOUT_THE_INSTRUCTION, (f) => AFTER_UPGRADE[f] ?? '')).toHaveLength(TRUE_ONLY_BEFORE_THE_UPGRADE.length);
    const silent: Record<string, string> = { ...AFTER_UPGRADE, 'src/components/solana/lp/LpDisclosures.tsx': "Our pool program is Raydium's." };
    expect(problems(another, (f) => silent[f] ?? '')).toEqual([
      'src/components/solana/lp/LpDisclosures.tsx: after the upgrade the risk line must say "one added instruction"',
    ]);
  });
});
