// @vitest-environment node
//
// The signer's wrapped-SOL account, as every builder that uses it plans it (pool
// swaps and both liquidity kinds). Wrapped SOL is native: whoever holds its close
// authority can close it with SOL inside and keep every lamport. So an account
// someone else can close is never used, kept or empty, and a kept account an approved
// spender can still draw from is not either.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { encodeTokenAccountWith } from './testkit.fixture';
import { wsolPlanFrom } from './wsol';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const ATA = associatedTokenAddress(WSOL_MINT, ME);
const account = (amount: bigint, o: Parameters<typeof encodeTokenAccountWith>[3] = {}) => ({ data: encodeTokenAccountWith(WSOL_MINT, ME, amount, o) });

describe('wsolPlanFrom', () => {
  it('absent or empty: closed at the end; holding wrapped SOL: kept', () => {
    expect(wsolPlanFrom(ME, null)).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
    expect(wsolPlanFrom(ME, account(0n))).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
    expect(wsolPlanFrom(ME, account(7n))).toEqual({ ata: ATA, closeAfter: false, heldBefore: 7n });
  });

  it('someone else can close it: refused whether it would be kept or closed, naming them', () => {
    // Kept: they could take what this transaction leaves in it. Empty: the token program
    // would refuse our close (only they may sign it), so the transaction would fail.
    for (const held of [0n, 7n]) {
      const r = wsolPlanFrom(ME, account(held, { closeAuthority: STRANGER }));
      expect(typeof r).toBe('string');
      expect(r).toBe(
        `${STRANGER.toBase58()} can close your wrapped-SOL account (${ATA.toBase58()}) and take what is in it, and only that key can change that. This site will not use that account, so nothing was built.`,
      );
    }
    // The signer as its own close authority is no one else.
    expect(wsolPlanFrom(ME, account(7n, { closeAuthority: ME }))).toEqual({ ata: ATA, closeAfter: false, heldBefore: 7n });
  });

  it('kept with a spender who can still draw from it: refused; empty, or nothing left to spend: planned', () => {
    expect(wsolPlanFrom(ME, account(7n, { delegate: STRANGER, delegatedAmount: 1_500_000_000n }))).toBe(
      `An approved spender (${STRANGER.toBase58()}) can move up to 1.5 wrapped SOL out of your wrapped-SOL account, and this would leave SOL in it. Revoke that approval in your wallet, then try again.`,
    );
    // Empty: filled, used and closed inside one transaction; a spender can take nothing.
    expect(wsolPlanFrom(ME, account(0n, { delegate: STRANGER, delegatedAmount: 5n }))).toMatchObject({ closeAfter: true });
    expect(wsolPlanFrom(ME, account(7n, { delegate: STRANGER, delegatedAmount: 0n }))).toMatchObject({ closeAfter: false });
  });

  it('an account too short to be a token account is unreadable, never planned', () => {
    expect(wsolPlanFrom(ME, { data: new Uint8Array(72) })).toBe('Your wrapped-SOL account could not be read.');
  });
});
