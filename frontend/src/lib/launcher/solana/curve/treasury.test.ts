// @vitest-environment node
// PDA / ATA derivation under jsdom fails on a realm mismatch inside web3.js's sync
// sha256 (see program.test.ts), so this file runs in node.
//
// The platform reserve is paid to `global.fee_recipient` inside `create_launch`
// (owner decision 2026-09-26). Two things the page says about that are pinned here:
//
//   1. "The platform treasury is a multisig." The program does not check that; it
//      pays whatever key the config holds. So the page may say "multisig" only when
//      that key is the known Squads vault, and the vault constant must itself be
//      DERIVED from the registered multisig, not trusted as a literal.
//   2. What the creator pays. The creator now also pays rent for the treasury's
//      token account (when it does not exist yet), read from the cluster.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { deriveSquadsVaultPda } from '../squads';
import { BONDING_CURVE_SIZE, PLATFORM_TREASURY_MULTISIG, PLATFORM_TREASURY_VAULT } from './program';
import { associatedTokenAddress } from './ix';
import { describeTreasury } from './format';
import { SPL_TOKEN_ACCOUNT_SIZE, readCreateLaunchCost, type CurveRpc } from './read';

const registry = JSON.parse(
  readFileSync(new URL('../../../../../scripts/addresses.json', import.meta.url), 'utf8'),
) as { solana?: { id?: string; address?: string }[] };
const registered = (id: string) => (registry.solana ?? []).find((e) => e.id === id)?.address;

describe('the platform treasury constant', () => {
  it('is vault 0 of the registered Squads multisig, derived rather than trusted', () => {
    expect(PLATFORM_TREASURY_MULTISIG.toBase58()).toBe(registered('squads-multisig'));
    expect(PLATFORM_TREASURY_VAULT.toBase58()).toBe(registered('squads-vault'));
    expect(deriveSquadsVaultPda(PLATFORM_TREASURY_MULTISIG.toBase58(), 0)).toBe(PLATFORM_TREASURY_VAULT.toBase58());
  });

  it('is the vault, never the multisig account (which cannot sign or hold the reserve)', () => {
    expect(PLATFORM_TREASURY_VAULT.equals(PLATFORM_TREASURY_MULTISIG)).toBe(false);
  });
});

describe('describeTreasury', () => {
  it('calls the recipient a multisig only when it is the known Squads vault', () => {
    expect(describeTreasury(PLATFORM_TREASURY_VAULT)).toEqual({
      multisig: true,
      name: 'the platform treasury (a multisig)',
    });
  });

  it('names any other recipient by address, with no multisig claim', () => {
    const other = new PublicKey(new Uint8Array(32).fill(4));
    const d = describeTreasury(other);
    expect(d.multisig).toBe(false);
    expect(d.name).toBe(`the platform treasury (${other.toBase58()})`);
    expect(d.name).not.toMatch(/multisig/);
    // The multisig ACCOUNT is not the vault: the claim must not extend to it either.
    expect(describeTreasury(PLATFORM_TREASURY_MULTISIG).multisig).toBe(false);
  });

  it('says nothing about the recipient when it has not been read', () => {
    expect(describeTreasury(null)).toEqual({ multisig: false, name: 'the platform treasury' });
  });
});

describe('readCreateLaunchCost', () => {
  const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const RECIPIENT = PLATFORM_TREASURY_VAULT;
  // Mainnet on 2026-09-26: (bytes + 128) × 5,080.
  const rent = (len: number) => (len + 128) * 5_080;

  function rpc(opts: { ataExists?: boolean; rentThrows?: boolean; rentValue?: unknown } = {}) {
    const rentAsked: number[] = [];
    const accountsAsked: string[] = [];
    const r: CurveRpc = {
      async getAccountInfo(a: PublicKey) {
        accountsAsked.push(a.toBase58());
        return opts.ataExists ? { data: new Uint8Array(165), lamports: 1, owner: RECIPIENT } : null;
      },
      async getMinimumBalanceForRentExemption(len: number) {
        rentAsked.push(len);
        if (opts.rentThrows) throw new Error('rpc down');
        return (opts.rentValue ?? rent(len)) as number;
      },
    };
    return { r, rentAsked, accountsAsked };
  }

  it("adds the treasury token account's rent when that account does not exist yet", async () => {
    const { r, rentAsked, accountsAsked } = rpc();
    const got = await readCreateLaunchCost(r, MINT, RECIPIENT);
    expect(rentAsked.sort()).toEqual([SPL_TOKEN_ACCOUNT_SIZE, BONDING_CURVE_SIZE].sort());
    // It looks for exactly the account the program pays the reserve into.
    expect(accountsAsked).toEqual([associatedTokenAddress(MINT, RECIPIENT).toBase58()]);
    expect(got).toEqual({
      kind: 'ok',
      value: {
        curve: 1_559_560n,
        vault: 1_488_440n,
        treasuryToken: 1_488_440n,
        treasuryTokenExists: false,
        total: 4_536_440n,
      },
    });
  });

  it('charges nothing for the treasury token account when it already exists', async () => {
    const got = await readCreateLaunchCost(rpc({ ataExists: true }).r, MINT, RECIPIENT);
    expect(got.kind === 'ok' && got.value.treasuryToken).toBe(0n);
    expect(got.kind === 'ok' && got.value.treasuryTokenExists).toBe(true);
    expect(got.kind === 'ok' && got.value.total).toBe(1_559_560n + 1_488_440n);
  });

  it('reports a failed or malformed read as unreadable, never as a cost', async () => {
    expect((await readCreateLaunchCost(rpc({ rentThrows: true }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
    expect((await readCreateLaunchCost(rpc({ rentValue: 'lots' }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
    expect((await readCreateLaunchCost(rpc({ rentValue: -1 }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
  });
});
