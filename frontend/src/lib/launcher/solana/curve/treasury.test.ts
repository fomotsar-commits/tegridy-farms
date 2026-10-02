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
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { deriveSquadsVaultPda } from '../squads';
import { BONDING_CURVE_SIZE, PLATFORM_TREASURY_MULTISIG, PLATFORM_TREASURY_VAULT, TOKEN_PROGRAM_ID } from './program';
import { associatedTokenAddress } from './ix';
import { describeReserveRecipient, describeTreasury } from './format';
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

// update_global can change fee_recipient after launches exist. A past payment is
// named from the launch's own create transaction, never from today's config.
describe('describeReserveRecipient', () => {
  it('names the recorded recipient, and a multisig only when THAT key is the vault', () => {
    const other = new PublicKey(new Uint8Array(32).fill(4));
    expect(describeReserveRecipient(PLATFORM_TREASURY_VAULT)).toEqual(describeTreasury(PLATFORM_TREASURY_VAULT));
    expect(describeReserveRecipient(other)).toEqual({ multisig: false, name: `the platform treasury (${other.toBase58()})` });
  });

  it('not read: no address and no multisig claim, and never borrowed from the live config', () => {
    expect(describeReserveRecipient(null)).toEqual({ multisig: false, name: 'the platform treasury at the time' });
  });
});

describe('readCreateLaunchCost', () => {
  const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const RECIPIENT = PLATFORM_TREASURY_VAULT;
  // Mainnet on 2026-09-26: (bytes + 128) × 5,080.
  const rent = (len: number) => (len + 128) * 5_080;

  /** What sits at the treasury's token-account address. A real token account is owned by the token program. */
  type AtaAccount = { data: Uint8Array; lamports: number; owner: PublicKey };
  const TOKEN_ACCOUNT: AtaAccount = { data: new Uint8Array(165), lamports: rent(165), owner: TOKEN_PROGRAM_ID };

  function rpc(opts: { ataExists?: boolean; ata?: AtaAccount; rentThrows?: boolean; rentValue?: unknown } = {}) {
    const rentAsked: number[] = [];
    const accountsAsked: string[] = [];
    const r: CurveRpc = {
      async getAccountInfo(a: PublicKey) {
        accountsAsked.push(a.toBase58());
        return opts.ata ?? (opts.ataExists ? TOKEN_ACCOUNT : null);
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

  // Anyone can send SOL to ATA(mint, fee_recipient) before the launch. The address
  // then holds an empty System Program account, init_if_needed still creates the
  // token account, and the associated token program charges the creator the rent
  // minus what is already there. That is not "already exists, you pay nothing".
  it('an address someone only sent SOL to does not count as an existing token account', async () => {
    const funded = (lamports: number) =>
      readCreateLaunchCost(rpc({ ata: { data: new Uint8Array(0), lamports, owner: SystemProgram.programId } }).r, MINT, RECIPIENT);
    const some = await funded(1_000);
    expect(some.kind === 'ok' && some.value.treasuryTokenExists).toBe(false);
    expect(some.kind === 'ok' && some.value.treasuryToken).toBe(1_488_440n - 1_000n);
    expect(some.kind === 'ok' && some.value.total).toBe(1_559_560n + 1_488_440n + 1_487_440n);
    // Already holding the full rent: nothing more is charged, but the account is still created.
    const all = await funded(2_000_000);
    expect(all.kind === 'ok' && all.value.treasuryTokenExists).toBe(false);
    expect(all.kind === 'ok' && all.value.treasuryToken).toBe(0n);
  });

  it('any other account at that address is not priced as a token account', async () => {
    for (const ata of [
      { data: new Uint8Array(165), lamports: 1, owner: RECIPIENT },
      { data: new Uint8Array(82), lamports: rent(82), owner: TOKEN_PROGRAM_ID },
      { data: new Uint8Array(8), lamports: 1, owner: SystemProgram.programId },
    ]) {
      const got = await readCreateLaunchCost(rpc({ ata }).r, MINT, RECIPIENT);
      expect(got.kind).toBe('unreadable');
    }
  });

  it('reports a failed or malformed read as unreadable, never as a cost', async () => {
    expect((await readCreateLaunchCost(rpc({ rentThrows: true }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
    expect((await readCreateLaunchCost(rpc({ rentValue: 'lots' }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
    expect((await readCreateLaunchCost(rpc({ rentValue: -1 }).r, MINT, RECIPIENT)).kind).toBe('unreadable');
  });
});
