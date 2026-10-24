// @vitest-environment node
//
// `findProgramAddressSync` throws "Unable to find a viable program address nonce" under
// this project's jsdom default, as in every other derivation test in the repo.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Website release 2 (branch ship/solana-launch-on) points every page at the restart
// programs and records, in scripts/addresses.json, the accounts their deploy creates:
// both ProgramData accounts, `global`, cp-swap's AmmConfig and Permission, and the
// migration authority. Those addresses were first written into the go-live checklist by
// hand. A registry row that names the wrong ProgramData account is worse than none: the
// daily chain read would watch an account that has nothing to do with the program.
// So every row here is re-derived from the code's own seeds and compared, and the
// default ids the pages use are pinned to the registered ones.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  CP_SWAP_PROGRAM_ID,
  PLATFORM_TREASURY_VAULT,
  PROGRAM_ID,
  REGISTERED_CP_SWAP_PROGRAM_ID,
  REGISTERED_PROGRAM_ID,
  cpAmmConfigPda,
  cpPermissionPda,
  globalPda,
  migrationAuthorityPda,
} from './curve/program';
import { LIVE_PROGRAM_ID, REGISTERED_PROGRAM_ID as CPSWAP_REGISTERED } from '../../solana/cpswap/program';

interface Entry { id?: string; address?: string; expect?: { type?: string }; onchain?: boolean }

const registry = JSON.parse(
  readFileSync(new URL('../../../../scripts/addresses.json', import.meta.url), 'utf8'),
) as { solana?: Entry[] };

const entry = (id: string): Entry => {
  const e = (registry.solana ?? []).find((x) => x?.id === id);
  // A missing row would make every comparison below vacuous: fail loudly instead.
  if (!e?.address) throw new Error(`${id} is not in scripts/addresses.json`);
  return e;
};

const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programData = (program: PublicKey) =>
  PublicKey.findProgramAddressSync([program.toBytes()], UPGRADEABLE_LOADER)[0].toBase58();

describe('the pages default to the registered restart programs', () => {
  it('PROGRAM_ID and CP_SWAP_PROGRAM_ID are the registered ids, and the registry lists them as programs', () => {
    expect(PROGRAM_ID.toBase58()).toBe(REGISTERED_PROGRAM_ID.toBase58());
    expect(CP_SWAP_PROGRAM_ID.toBase58()).toBe(REGISTERED_CP_SWAP_PROGRAM_ID.toBase58());
    expect(entry('tegridy-launch-program-restart').address).toBe(PROGRAM_ID.toBase58());
    expect(entry('cp-swap-program-restart').address).toBe(CP_SWAP_PROGRAM_ID.toBase58());
    expect(entry('tegridy-launch-program-restart').expect?.type).toBe('executable');
    expect(entry('cp-swap-program-restart').expect?.type).toBe('executable');
  });

  it('the pool client (cpswap/program.ts) talks to the same cp-swap program when no env names another', () => {
    expect(CPSWAP_REGISTERED.toBase58()).toBe(REGISTERED_CP_SWAP_PROGRAM_ID.toBase58());
    expect(LIVE_PROGRAM_ID?.toBase58()).toBe(REGISTERED_CP_SWAP_PROGRAM_ID.toBase58());
  });
});

describe('every account the deploy creates is registered at the address the code derives', () => {
  it.each([
    ['tegridy-launch-programdata-restart', () => programData(PROGRAM_ID), 'program-owned'],
    ['cp-swap-programdata-restart', () => programData(CP_SWAP_PROGRAM_ID), 'program-owned'],
    ['tegridy-launch-global-restart', () => globalPda().toBase58(), 'program-owned'],
    ['cp-swap-amm-config-restart', () => cpAmmConfigPda(0).toBase58(), 'program-owned'],
    ['cp-swap-permission-restart', () => cpPermissionPda(migrationAuthorityPda()).toBase58(), 'program-owned'],
    // Data-less and swept to zero by every migrate (lib.rs:1625-1636): absent at rest.
    ['tegridy-launch-migauth-restart', () => migrationAuthorityPda().toBase58(), 'absent'],
  ] as const)('%s', (id, derive, type) => {
    expect(entry(id).address).toBe(derive());
    expect(entry(id).expect?.type).toBe(type);
  });

  it('the deployer is registered, and its balance is not asserted (the owner may sweep it after the handover)', () => {
    const d = entry('tegridy-launch-deployer');
    expect(d.address).toBe('CqcVvaMvesrSKrUSbqBqr9mLjKLJuYqhaXg1gXpR41cg');
    expect(d.onchain).toBe(false);
  });

  it('the treasury the pages name is the registered Squads vault', () => {
    expect(entry('squads-vault').address).toBe(PLATFORM_TREASURY_VAULT.toBase58());
  });
});
