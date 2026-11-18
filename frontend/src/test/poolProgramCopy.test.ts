// @vitest-environment node
//
// Three sentences on the site are about the pool program RUNNING on mainnet. Until its upgrade
// they said "only its admin keys changed" and "built before that instruction was added". The
// local harness pins the binary mainnet runs, so this ties the wording to that pin: the old
// lines stand while it is the old binary, and once it is anything else none may stand and
// each place names what the upgrade added (the instruction, and the launch-tier check).
//
// The upgrade of 2026-11 added the fee limits and the swap guard, and the same three places
// name them. That wording is tied the same way: it must stand under the build that has the
// guard, and it may not stand under either build from before it (a roll-back too).
//
// The upgrade after it added the keeper's fee: a fee tier's named keeper swaps free of the
// trade and creator fees. The three places, and the Rates card's small print, say so, name
// the keeper's wallet and say that everyone else pays as before. Tied the same way again.

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
    after: ['one added instruction', 'one added check'],
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    says: 'we changed only its admin keys',
    after: ['one added instruction', 'one added check'],
  },
  {
    file: 'src/components/solana/VenueProgramCard.tsx',
    says: 'The program on Solana today was built before that instruction and that check were added.',
    after: ['one added check'],
  },
] as const;

/** The build of the first upgrade: it has the instruction and the check, and neither the fee limits nor the swap guard. */
const BINARY_BEFORE_THE_SWAP_GUARD = '1e55bcdcb10c39ee9678efb697b453cb23415621bded4968c01950629de4fd22';
const BINARIES_WITHOUT_THE_SWAP_GUARD: readonly string[] = [BINARY_WITHOUT_THE_INSTRUCTION, BINARY_BEFORE_THE_SWAP_GUARD];

/** What each place says only of a build that has the fee limits and the swap guard. */
const TRUE_ONLY_WITH_THE_SWAP_GUARD = [
  {
    file: 'src/components/solana/lp/LpDisclosures.tsx',
    says: ['added fee limits', 'an added swap guard', 'refuses one that another program makes'],
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    says: ['added fee limits', 'an added swap guard', 'While the swap guard is on', 'It can switch the swap guard on or off for a fee tier'],
  },
  {
    file: 'src/components/solana/VenueProgramCard.tsx',
    says: ['a swap guard', 'The fee limits:', 'A swap that another program makes is refused'],
  },
] as const;
const guardSays = (file: string, phrase: string) => `${file}: mainnet runs the build with the swap guard, so it must say "${phrase}"`;
const guardMustNotSay = (file: string, phrase: string) => `${file}: mainnet runs a build without the swap guard, so it must not say "${phrase}"`;

/** The swap-guard upgrade's build (proposal #32): the fee limits and the guard, and no keeper's fee. */
const BINARY_BEFORE_THE_KEEPER_FEE = '01fe923bd9ba3435212d015c2b0d7549592a601ab5707c6222bd0252166e9938';
const BINARIES_WITHOUT_THE_KEEPER_FEE: readonly string[] = [...BINARIES_WITHOUT_THE_SWAP_GUARD, BINARY_BEFORE_THE_KEEPER_FEE];
/** The keeper the vault names on both fee tiers (proposal #34): the venue's price robot, said whole. */
const PRICE_ROBOT = '9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz';
const RATES_CARD = 'src/components/solana/lp/RatesAndRoutes.tsx';

/** What each place says only of a build with the keeper's fee: that it exists, who swaps free, and that everyone else pays. */
const TRUE_ONLY_WITH_THE_KEEPER_FEE = [
  {
    file: 'src/components/solana/lp/LpDisclosures.tsx',
    says: ["a fee exemption for a fee tier's keeper", 'pays no trade fee and no creator fee on its own swaps', 'Everyone else pays as before.', PRICE_ROBOT],
  },
  {
    file: 'src/components/solana/lp/SolanaLpSection.tsx',
    says: ['a fee exemption for a fee tier’s keeper', 'name a fee tier’s keeper', 'pays no trade fee and no creator fee on its own swaps', 'Everyone else pays as before.', PRICE_ROBOT],
  },
  {
    file: 'src/components/solana/VenueProgramCard.tsx',
    says: ['a fee exemption for a fee tier&rsquo;s keeper', 'pays no trade fee and no creator fee on its own swaps', 'Everyone else pays as before.', PRICE_ROBOT],
  },
  {
    file: RATES_CARD,
    says: ['pays no trade fee and no creator fee on its own swaps', 'Everyone else pays as before.', PRICE_ROBOT],
  },
] as const;
const keeperSays = (file: string, phrase: string) => `${file}: mainnet runs the build with the keeper's fee, so it must say "${phrase}"`;
const keeperMustNotSay = (file: string, phrase: string) => `${file}: mainnet runs a build without the keeper's fee, so it must not say "${phrase}"`;

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
    for (const after of upgraded ? line.after : []) {
      if (!text.includes(after)) out.push(`${line.file}: after the upgrade it must say "${after}"`);
    }
  }
  const guarded = !BINARIES_WITHOUT_THE_SWAP_GUARD.includes(deployedBinary);
  for (const line of TRUE_ONLY_WITH_THE_SWAP_GUARD) {
    const text = source(line.file);
    for (const phrase of line.says) {
      const present = text.includes(phrase);
      if (guarded && !present) out.push(guardSays(line.file, phrase));
      if (!guarded && present) out.push(guardMustNotSay(line.file, phrase));
    }
  }
  const keeperFree = !BINARIES_WITHOUT_THE_KEEPER_FEE.includes(deployedBinary);
  for (const line of TRUE_ONLY_WITH_THE_KEEPER_FEE) {
    const text = source(line.file);
    for (const phrase of line.says) {
      const present = text.includes(phrase);
      if (keeperFree && !present) out.push(keeperSays(line.file, phrase));
      if (!keeperFree && present) out.push(keeperMustNotSay(line.file, phrase));
    }
  }
  return out;
}

/** The wording before the upgrade, and the wording that shipped with it, one sample per file. */
const BEFORE_UPGRADE: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx': "Our pool program is Raydium's, with only its admin keys changed.",
  'src/components/solana/lp/SolanaLpSection.tsx': 'Our pool program is Raydium’s constant-product pool; we changed only its admin keys',
  'src/components/solana/VenueProgramCard.tsx': 'The program on Solana today was built before that instruction and that check were added. It gets them only through a program upgrade.',
};
const AFTER_UPGRADE: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx':
    "Our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens and one added check that keeps the launch fee tier for launches.",
  'src/components/solana/lp/SolanaLpSection.tsx':
    'Our pool program is Raydium’s constant-product pool, with its admin keys changed, one added instruction that names pool share tokens and one added check that keeps the launch fee tier for launches',
  'src/components/solana/VenueProgramCard.tsx': 'comments, one added instruction and one added check.',
};

/** The wording that ships with the swap-guard upgrade, one sample per file. */
const WITH_THE_SWAP_GUARD: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx':
    "Our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens, one added check that keeps the launch fee tier for launches, added fee limits and an added swap guard. While our vault has the guard switched on, a pool takes a swap only when a wallet sends it directly, and refuses one that another program makes.",
  'src/components/solana/lp/SolanaLpSection.tsx':
    'Our pool program is Raydium’s constant-product pool, with its admin keys changed, one added instruction that names pool share tokens, one added check that keeps the launch fee tier for launches, added fee limits and an added swap guard. It can switch the swap guard on or off for a fee tier. While the swap guard is on, directly means sent by the wallet itself.',
  'src/components/solana/VenueProgramCard.tsx':
    'comments, one added instruction, one added check, fee limits and a swap guard. The fee limits: a fee tier charges a trader more than nothing. A swap that another program makes is refused.',
};
const everyGuardPhrase = (message: (file: string, phrase: string) => string) =>
  TRUE_ONLY_WITH_THE_SWAP_GUARD.flatMap((line) => line.says.map((phrase) => message(line.file, phrase)));

/** The wording that ships with the keeper-fee upgrade, one sample per file. */
const WITH_THE_KEEPER_FEE: Record<string, string> = {
  'src/components/solana/lp/LpDisclosures.tsx': `Our pool program is Raydium's, with its admin keys changed, one added instruction that names pool share tokens, one added check that keeps the launch fee tier for launches, added fee limits, an added swap guard and a fee exemption for a fee tier's keeper. While our vault has the guard switched on, a pool takes a swap only when a wallet sends it directly, and refuses one that another program makes. A fee tier's named keeper, the venue's own price robot (wallet ${PRICE_ROBOT}), pays no trade fee and no creator fee on its own swaps, so those swaps earn liquidity providers nothing. Everyone else pays as before.`,
  'src/components/solana/lp/SolanaLpSection.tsx': `Our pool program is Raydium’s constant-product pool, with its admin keys changed, one added instruction that names pool share tokens, one added check that keeps the launch fee tier for launches, added fee limits, an added swap guard and a fee exemption for a fee tier’s keeper. It can switch the swap guard on or off for a fee tier, name a fee tier’s keeper, add fee tiers. A fee tier’s named keeper pays no trade fee and no creator fee on its own swaps. On both fee tiers open today the vault names the venue’s own price robot, wallet ${PRICE_ROBOT}. Everyone else pays as before. While the swap guard is on, directly means sent by the wallet itself.`,
  'src/components/solana/VenueProgramCard.tsx': `comments, one added instruction, one added check, fee limits, a swap guard and a fee exemption for a fee tier&rsquo;s keeper. The fee limits: a fee tier charges a trader more than nothing. A swap that another program makes is refused. The keeper is one wallet our vault names for a fee tier. It pays no trade fee and no creator fee on its own swaps. Everyone else pays as before. On both fee tiers open today the keeper is the venue&rsquo;s own price robot, wallet ${PRICE_ROBOT}.`,
  [RATES_CARD]: `A fee tier&rsquo;s named keeper, the venue&rsquo;s own price robot (wallet ${PRICE_ROBOT}), pays no trade fee and no creator fee on its own swaps, so those swaps pay nothing to LPs, the venue or the island. Everyone else pays as before.`,
};
const everyKeeperPhrase = (message: (file: string, phrase: string) => string) =>
  TRUE_ONLY_WITH_THE_KEEPER_FEE.flatMap((line) => line.says.map((phrase) => message(line.file, phrase)));

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

  it('the three lines agree with that binary', () => {
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

  // The swap-guard wording, the same two ways. Pin the build from before the guard (a
  // roll-back) and every phrase about the fee limits and the guard is asked to go; under any
  // build that is neither earlier one, every phrase is asked for.
  it('refuses the swap-guard wording in the source once a build without the guard is pinned, and asks for it otherwise', () => {
    const pinned = harnessPins().genesis ?? '';
    const guarded = !BINARIES_WITHOUT_THE_SWAP_GUARD.includes(pinned);
    if (guarded) {
      // Under the first upgrade's build the rest of the wording is still right, so this is the
      // whole list: the guard's phrases, and the keeper fee's while the source has them.
      const keeperFree = !BINARIES_WITHOUT_THE_KEEPER_FEE.includes(pinned);
      expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, read)).toEqual([
        ...everyGuardPhrase(guardMustNotSay),
        ...(keeperFree ? everyKeeperPhrase(keeperMustNotSay) : []),
      ]);
    } else {
      expect(problems('f'.repeat(64), read)).toEqual(expect.arrayContaining(everyGuardPhrase(guardSays)));
    }
  });

  // The keeper-fee wording, the same two ways. Pin the swap-guard build (a roll-back) and
  // every phrase about the keeper's fee is asked to go, and nothing else; under any build
  // that is none of the earlier ones, every phrase is asked for.
  it('refuses the keeper-fee wording in the source once a build without it is pinned, and asks for it otherwise', () => {
    const pinned = harnessPins().genesis ?? '';
    if (!BINARIES_WITHOUT_THE_KEEPER_FEE.includes(pinned)) {
      expect(problems(BINARY_BEFORE_THE_KEEPER_FEE, read)).toEqual(everyKeeperPhrase(keeperMustNotSay));
    } else {
      expect(problems('f'.repeat(64), read)).toEqual(expect.arrayContaining(everyKeeperPhrase(keeperSays)));
    }
  });

  it('accepts each wording under its own binary only, and refuses a line that leaves out what an upgrade added', () => {
    const another = 'f'.repeat(64);
    expect(problems(BINARY_WITHOUT_THE_INSTRUCTION, (f) => BEFORE_UPGRADE[f] ?? '')).toEqual([]);
    expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, (f) => AFTER_UPGRADE[f] ?? '')).toEqual([]);
    expect(problems(BINARY_BEFORE_THE_KEEPER_FEE, (f) => WITH_THE_SWAP_GUARD[f] ?? '')).toEqual([]);
    expect(problems(another, (f) => WITH_THE_KEEPER_FEE[f] ?? '')).toEqual([]);
    // Each wording under the other binary: every line is named.
    expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, (f) => BEFORE_UPGRADE[f] ?? '').filter((p) => p.includes('must not say'))).toHaveLength(TRUE_ONLY_BEFORE_THE_UPGRADE.length);
    expect(problems(BINARY_WITHOUT_THE_INSTRUCTION, (f) => AFTER_UPGRADE[f] ?? '')).toHaveLength(TRUE_ONLY_BEFORE_THE_UPGRADE.length);
    // The first upgrade's wording under the build with the guard: every guard phrase is asked for.
    expect(problems(BINARY_BEFORE_THE_KEEPER_FEE, (f) => AFTER_UPGRADE[f] ?? '')).toEqual(everyGuardPhrase(guardSays));
    // The swap-guard wording under either build from before it: every guard phrase is refused.
    expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, (f) => WITH_THE_SWAP_GUARD[f] ?? '')).toEqual(everyGuardPhrase(guardMustNotSay));
    expect(problems(BINARY_WITHOUT_THE_INSTRUCTION, (f) => WITH_THE_SWAP_GUARD[f] ?? '')).toEqual(expect.arrayContaining(everyGuardPhrase(guardMustNotSay)));
    // The swap-guard wording under the build with the keeper's fee: every keeper phrase is asked for, and only those.
    expect(problems(another, (f) => WITH_THE_SWAP_GUARD[f] ?? '')).toEqual(everyKeeperPhrase(keeperSays));
    // The keeper-fee wording under any build from before it: every keeper phrase is refused.
    expect(problems(BINARY_BEFORE_THE_KEEPER_FEE, (f) => WITH_THE_KEEPER_FEE[f] ?? '')).toEqual(everyKeeperPhrase(keeperMustNotSay));
    for (const earlier of BINARIES_WITHOUT_THE_SWAP_GUARD) {
      expect(problems(earlier, (f) => WITH_THE_KEEPER_FEE[f] ?? '')).toEqual(expect.arrayContaining(everyKeeperPhrase(keeperMustNotSay)));
    }
    // A line that says who swaps free without the wallet, and one that leaves out that everyone else pays.
    const noWallet: Record<string, string> = { ...WITH_THE_KEEPER_FEE, [RATES_CARD]: WITH_THE_KEEPER_FEE[RATES_CARD]!.replace(PRICE_ROBOT, 'the robot') };
    expect(problems(another, (f) => noWallet[f] ?? '')).toEqual([keeperSays(RATES_CARD, PRICE_ROBOT)]);
    const noOneElse: Record<string, string> = { ...WITH_THE_KEEPER_FEE, [RATES_CARD]: WITH_THE_KEEPER_FEE[RATES_CARD]!.replace(' Everyone else pays as before.', '') };
    expect(problems(another, (f) => noOneElse[f] ?? '')).toEqual([keeperSays(RATES_CARD, 'Everyone else pays as before.')]);
    // A line that names the guard and not what it refuses.
    const noRefusal: Record<string, string> = {
      ...WITH_THE_SWAP_GUARD,
      'src/components/solana/VenueProgramCard.tsx': 'comments, one added instruction, one added check, fee limits and a swap guard. The fee limits: a fee tier charges a trader more than nothing.',
    };
    expect(problems(BINARY_BEFORE_THE_KEEPER_FEE, (f) => noRefusal[f] ?? '')).toEqual([guardSays('src/components/solana/VenueProgramCard.tsx', 'A swap that another program makes is refused')]);
    const silent: Record<string, string> = { ...AFTER_UPGRADE, 'src/components/solana/lp/LpDisclosures.tsx': "Our pool program is Raydium's." };
    expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, (f) => silent[f] ?? '')).toEqual([
      'src/components/solana/lp/LpDisclosures.tsx: after the upgrade it must say "one added instruction"',
      'src/components/solana/lp/LpDisclosures.tsx: after the upgrade it must say "one added check"',
    ]);
    // The wording that named the instruction alone: true of no build the harness pins now.
    const noCheck: Record<string, string> = {
      ...AFTER_UPGRADE,
      'src/components/solana/VenueProgramCard.tsx': 'comments and one added instruction, which lets a pool’s share token carry a name',
    };
    expect(problems(BINARY_BEFORE_THE_SWAP_GUARD, (f) => noCheck[f] ?? '')).toEqual(['src/components/solana/VenueProgramCard.tsx: after the upgrade it must say "one added check"']);
  });
});
